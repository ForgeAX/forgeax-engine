import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { defineSystem, Time, Update } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import physics3d from '@forgeax/engine/physics-rapier3d';
import {
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  ANTIALIAS_TSR,
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  DynamicResolution,
  type FrameReceipt,
  MeshFilter,
  MeshRenderer,
  perspective,
  ScreenSpaceReflection,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import {
  WATER_SCENE_STATUS_RESOURCE,
  WATER_SYSTEM_RESOURCE,
  type WaterSceneStatus,
  waterSceneMeshView,
  waterSceneSnapshot,
} from '@forgeax/engine/runtime';
import {
  Transform,
  WaterBodyInstance,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import { type AssetHandle, err, ok } from '@forgeax/engine/types';
import type { WaterSystem } from '@forgeax/engine/water';
import {
  type WaterCausticsMode as CausticsMode,
  createWaterCausticsReceiverFeature,
  createWaterGerstnerCausticsFeature,
} from '@forgeax/engine/water/caustics';
import causticsCopyShader from '@forgeax/engine-water/caustics/shaders/copy.wgsl';
import causticsReceiverShader from '../assets/shaders/caustics-receiver.wgsl';
import { type CameraPose, createWaterCameraControls } from '../../camera-controls';
import { dressWaterStage, stageRuntimePanel } from '../../presentation';
import { requireDemoValue } from '../../runtime-input';
import { arrangeWaterSettings, waterQualityControl } from '../../settings-panel';
import { waterStageNavigation } from '../../stage-catalog';
import {
  CAUSTICS_FIELD,
  CAUSTICS_PLANE_Y,
  CAUSTICS_SUN_DIRECTION,
  CAUSTICS_SUN_INTENSITY,
} from './caustics-policy';
import { causticsTextureWaveSet, createCausticsTextureClock } from './caustics-texture-clock';
import { WATER_R3_PACKAGE } from './identity';
import { createMaterialPanel } from './material-panel';
import { createSceneControls } from './scene-controls';
import './style.css';
import '../../settings-panel.css';

const element = <T extends HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Missing authored scene value');
  return value;
};
type BodyType = 'lake' | 'river' | 'ocean' | 'custom';
type ViewPreset = 'overview' | 'surface' | 'waterline' | 'underwater';
type View = ViewPreset | 'manual';
type Scenario = 'baseline' | 'river-lake' | 'river-ocean' | 'shared' | 'caustics';
const bodyLabels: Record<BodyType, string> = {
  lake: '湖畔',
  river: '河道',
  ocean: '近海',
  custom: '自定义',
};
const viewLabels: Record<View, string> = {
  overview: '全景',
  surface: '水面',
  waterline: '水线',
  underwater: '水下',
  manual: '自由',
};
const poses: Record<ViewPreset, CameraPose> = {
  overview: { eye: [20, 10, 27], target: [0, -0.2, -2] },
  surface: { eye: [12, 2.3, 19], target: [-1, 0.5, -4] },
  waterline: { eye: [0, 0.04, 10], target: [0, 0.04, -8] },
  underwater: { eye: [0, -1.8, 10], target: [0, -1.1, -8] },
};
const SSR_SETTINGS = {
  maxDistance: 60,
  thickness: 0.25,
  maxRoughness: 0.6,
} as const;

function waterDemoAntialias(mode: string | null) {
  switch (mode) {
    case 'none':
      return ANTIALIAS_NONE;
    case 'msaa':
      return ANTIALIAS_MSAA;
    case 'tsr':
      return ANTIALIAS_TSR;
    default:
      return ANTIALIAS_TAA;
  }
}

function waterDemoOptions(search: string) {
  const query = new URLSearchParams(search);
  const initialAa = waterDemoAntialias(query.get('aa'));
  return {
    initialAa,
    temporal: initialAa === ANTIALIAS_TAA || initialAa === ANTIALIAS_TSR,
    reflections: query.get('ssr') !== 'off',
    renderPath: query.get('pipeline') === 'forward' ? 'forward' : 'deferred',
    startView: query.get('view') === 'surface' ? 'surface' : 'overview',
  } as const;
}

async function main() {
  const canvas = element<HTMLCanvasElement>('#scene');
  const panel = element<HTMLElement>('#controls-panel');
  const panelToggle = element<HTMLButtonElement>('#panel-toggle');
  const { initialAa, temporal, reflections, renderPath, startView } = waterDemoOptions(
    location.search,
  );
  element<HTMLInputElement>('#taa').checked = temporal;
  element<HTMLInputElement>('#ssr').checked = reflections;
  const caustics = createWaterGerstnerCausticsFeature({
    identity: 'water-r3-caustics',
    field: CAUSTICS_FIELD,
  });
  const causticsReceivers = createWaterCausticsReceiverFeature({
    producerIdentity: 'water-r3-caustics',
    field: CAUSTICS_FIELD.name,
    shaders: { composite: causticsReceiverShader.wgsl, copy: causticsCopyShader.wgsl },
  });
  const createStageApp = () =>
    createApp(
      canvas,
      {
        plugins: [physics3d],
        features: [caustics.feature, causticsReceivers.feature],
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath },
        uiRoot: panel,
        pointerLockAllowed: () => false,
        ...(__WATER_R3_SSR_IDENTITY__ === null ? {} : { ssrIdentity: __WATER_R3_SSR_IDENTITY__ }),
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
      },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    );
  const app = (await createStageApp()).unwrap();
  const assets = app.assets;
  if (!assets) throw new Error('Asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R3_PACKAGE, key));
  const meshHandles = Object.fromEntries(
    await Promise.all(
      ['box', 'sphere', 'ring'].map(async (key) => [
        key,
        (await assets.load(guid(`mesh/${key}`), 'mesh')).unwrap(),
      ]),
    ),
  ) as Record<string, AssetHandle<'mesh'>>;
  const materialHandles = Object.fromEntries(
    await Promise.all(
      ['ground', 'stone', 'pier', 'red', 'yellow', 'teal', 'white', 'mirror'].map(async (key) => [
        key,
        (await assets.load(guid(`material/${key}`), 'material')).unwrap(),
      ]),
    ),
  ) as Record<string, AssetHandle<'material'>>;
  const spawn = (
    mesh: string,
    material: string,
    pos: [number, number, number],
    scale: [number, number, number],
    rotation = [0, 0, 0, 1],
  ) =>
    world
      .spawn(
        { component: Transform, data: { pos, scale, quat: rotation } },
        { component: MeshFilter, data: { assetHandle: required(meshHandles[mesh]) } },
        { component: MeshRenderer, data: { materials: [required(materialHandles[material])] } },
      )
      .unwrap();
  const terrain = (await assets.load(guid('terrain/coast/terrain'), 'terrain')).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [-40, 0, -40] } },
      { component: Terrain, data: { asset: terrain } },
      { component: WaterTerrainProvider, data: { terrain } },
    )
    .unwrap();
  const spawnReceiverCalibration = () => {
    for (let i = 0; i < 11; i++) {
      spawn('box', 'white', [-14 + i * 2.8, -4.05, 0], [0.045, 0.025, 28]);
      spawn('box', 'white', [0, -4.05, -14 + i * 2.8], [28, 0.025, 0.045]);
    }
    for (let j = 0; j < 48; j++) spawn('box', 'pier', [15, 0.6, -9.75 + j * 0.5], [4, 0.25, 0.44]);
    for (const side of [-1, 1]) {
      spawn('box', 'mirror', [15 + side * 1.8, 1.65, 2], [0.07, 0.07, 24]);
      for (let j = 0; j < 7; j++)
        spawn('box', 'pier', [15 + side * 1.8, 1.15, -9 + j * 3.6], [0.14, 1.2, 0.14]);
    }
    for (const x of [13.6, 16.4])
      for (const z of [-7, 0, 9]) spawn('box', 'stone', [x, -1.7, z], [0.35, 4.4, 0.35]);
    const sphereReceivers: { entity: ReturnType<typeof spawn>; base: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const x = -8 + i * 3.7;
      spawn('box', 'stone', [x, -0.6, -7 - (i % 2)], [2.15, 0.7, 2.15]);
      for (const side of [-1, 1])
        spawn('box', 'mirror', [x + side * 0.83, 1.2, -7 - (i % 2)], [0.1, 6.2, 0.28]);
      spawn(
        'box',
        required(['red', 'yellow', 'white', 'teal', 'red'][i]),
        [x, 1.2, -7 - (i % 2)],
        [1.5, 6, 0.12],
      );
      // Retain optical calibration faces, with a substantial instrument frame and divided backing.
      for (const y of [-1.5, 0, 1.5, 3, 4.1]) {
        spawn('box', 'stone', [x, y, -7 - (i % 2) - 0.13], [1.65, 0.08, 0.12]);
        spawn('box', 'mirror', [x + 0.56, y + 0.12, -7 - (i % 2) + 0.075], [0.22, 0.035, 0.02]);
      }
      spawn('box', 'stone', [x, 4.28, -7 - (i % 2)], [2, 0.24, 0.5]);
      spawn('box', 'pier', [x, -1.8, -7 - (i % 2)], [2.1, 0.18, 2.1]);
      const base = required(['yellow', 'red', 'teal', 'white', 'yellow'][i]);
      const sphere = spawn('sphere', base, [x, -2.6, 0], [0.8, 0.8, 0.8]);
      sphereReceivers.push({ entity: sphere, base });
    }
    return sphereReceivers;
  };
  const sphereReceivers = spawnReceiverCalibration();
  const moving = spawn('ring', 'yellow', [1, 1.6, -2], [1.7, 1.7, 1.7]);
  spawn('box', 'mirror', [-6, 0.9, 2], [3, 0.25, 3]);
  const zoneGuid = guid('zone/main');
  const zoneHandle = (await assets.load(zoneGuid, 'water-zone')).unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: WaterZoneInstance, data: { zone: zoneHandle } },
    )
    .unwrap();
  const bodies = await Promise.all(
    (['lake', 'river', 'ocean', 'custom'] as const).map(async (type) => {
      const handle = (await assets.load(guid(`body/${type}`), 'water-body')).unwrap();
      const entity = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap();
      if (type === 'lake')
        world
          .addComponent(entity, { component: WaterBodyInstance, data: { body: handle } })
          .unwrap();
      return { type, handle, entity, guid: guid(`body/${type}`) };
    }),
  );
  const causticsHandle = (await assets.load(guid('body/caustics'), 'water-body')).unwrap();
  const opticalLake = {
    type: 'lake' as const,
    handle: causticsHandle,
    guid: guid('body/caustics'),
    entity: world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap(),
  };
  const fieldMaterial = (await assets.load(guid('material/caustics-field'), 'material')).unwrap();
  const peerHandle = (await assets.load(guid('body/lake-peer'), 'water-body')).unwrap();
  const peer = {
    type: 'lake' as const,
    handle: peerHandle,
    guid: guid('body/lake-peer'),
    entity: world.spawn({ component: Transform, data: { pos: [32, 0, 0] } }).unwrap(),
  };
  const sunlight = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: CAUSTICS_SUN_DIRECTION,
        color: [1, 0.96, 0.88],
        intensity: CAUSTICS_SUN_INTENSITY,
        castShadow: false,
      },
    })
    .unwrap();
  world
    .spawn({ component: Skylight, data: { color: [0.65, 0.82, 0.92], intensity: 1.3 } })
    .unwrap();
  let selectedBody: BodyType = 'lake';
  let scenario: Scenario =
    new URLSearchParams(location.search).get('scenario') === 'caustics' ? 'caustics' : 'baseline';
  let causticsMode: CausticsMode =
    new URLSearchParams(location.search).get('caustics') === 'texture' ? 'texture' : 'dynamic';
  let causticsStrength = 0.7;
  let causticsDiagnostic = false;
  const causticsParameters = { scale: 1, width: 0.25, softness: 0.25, distanceM: 40, depthM: 6 };
  const sunParameters = {
    azimuth: (Math.atan2(0.3, 0.45) * 180) / Math.PI,
    elevation: (Math.atan2(0.8, Math.hypot(0.45, 0.3)) * 180) / Math.PI,
    intensity: CAUSTICS_SUN_INTENSITY,
  };
  const applySun = () => {
    const active = scenario === 'caustics' && causticsMode !== 'off';
    const azimuth = (sunParameters.azimuth * Math.PI) / 180;
    const elevation = (sunParameters.elevation * Math.PI) / 180;
    const direction = active
      ? [
          -Math.cos(elevation) * Math.cos(azimuth),
          -Math.sin(elevation),
          -Math.cos(elevation) * Math.sin(azimuth),
        ]
      : [...CAUSTICS_SUN_DIRECTION];
    world
      .set(sunlight, DirectionalLight, {
        direction,
        intensity: active ? sunParameters.intensity : CAUSTICS_SUN_INTENSITY,
        castShadow: active,
      })
      .unwrap();
    const light = world.get(sunlight, DirectionalLight).unwrap();
    assets
      .update(fieldMaterial, {
        values: {
          ...assets.read(fieldMaterial).unwrap().values,
          causticsIncident: [...light.direction],
          causticsLight: light.intensity,
          causticsPlaneY: CAUSTICS_PLANE_Y,
          causticsMode: causticsMode === 'texture' ? 1 : 2,
        },
      })
      .unwrap();
    element<HTMLOutputElement>('#caustics-sun-direction').value = [...light.direction]
      .map((value) => value.toFixed(2))
      .join(', ');
  };
  const syncCausticsWaves = () => {
    const active = scenario === 'caustics' && causticsMode !== 'off';
    const waveSetGuid = guid(active ? 'waves/caustics' : 'waves/basin');
    const source = assets.read(causticsHandle).unwrap();
    if (source.waveSetGuid !== waveSetGuid) assets.update(causticsHandle, { waveSetGuid }).unwrap();
  };
  caustics.configure({
    assets,
    material: fieldMaterial,
    body: (context) =>
      scenario === 'caustics'
        ? waterSceneSnapshot(context.world, Number(opticalLake.entity))
        : undefined,
    mode: () => causticsMode,
    sunActive: () => {
      const light = world.get(sunlight, DirectionalLight).unwrap();
      return light.intensity > 0 && (light.direction[1] ?? 0) < -0.01;
    },
  });
  const textureClock = createCausticsTextureClock();
  causticsReceivers.configure(() => {
    if (scenario !== 'caustics' || causticsMode === 'off') return undefined;
    const light = world.get(sunlight, DirectionalLight).unwrap();
    const timeSeconds = world.getResource(Time).elapsed;
    const phase = textureClock.sample(
      causticsTextureWaveSet(waterSceneSnapshot(world, Number(opticalLake.entity))),
      timeSeconds,
    );
    return {
      mode: causticsMode,
      gain: causticsStrength,
      scale: causticsParameters.scale,
      lineWidth: causticsParameters.width,
      softness: causticsParameters.softness,
      visibleDistanceM: causticsParameters.distanceM,
      maximumDepthM: causticsParameters.depthM,
      incidentDirection: light.direction,
      lightIntensity: light.intensity,
      referencePlaneY: CAUSTICS_PLANE_Y,
      // This R3-supplied shader owns the scalar slot: texture phase, otherwise scene time.
      timeSeconds: causticsMode === 'texture' ? phase : timeSeconds,
      visibilityDiagnostic: causticsDiagnostic,
    };
  });
  const currentBody = () =>
    scenario === 'caustics'
      ? opticalLake
      : scenario === 'shared' && element<HTMLSelectElement>('#body-instance').value === 'peer'
        ? peer
        : required(bodies.find((body) => body.type === selectedBody));
  let selectedView: View = startView;
  let pose = {
    eye: [...poses[startView].eye] as [number, number, number],
    target: [...poses[startView].target] as [number, number, number],
  };
  const camera = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: pose.eye,
          quat: quat.fromLookAt(quat.create(), pose.eye, pose.target, [0, 1, 0]),
        },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: Math.PI / 3.2,
            aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
            near: 0.08,
            far: 400,
          }),
          clearColor: [0.68, 0.81, 0.83, 1],
          antialias: initialAa,
          tonemap: TONEMAP_ACES_FILMIC,
        },
      },
    )
    .unwrap();
  if (reflections)
    world.addComponent(camera, { component: ScreenSpaceReflection, data: SSR_SETTINGS }).unwrap();
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const materialPanel = await createMaterialPanel({
    assets,
    world,
    selectedBody: currentBody,
    zone: zoneHandle,
    zoneGuid,
    water,
    guid,
  });
  const sceneControls = createSceneControls({
    assets,
    world,
    selectedBody: currentBody,
    zone: zoneHandle,
    water,
    eye: () => pose.eye,
  });
  const viewIdentity = `camera:${camera}`;
  let completedFrames = 0;
  let animate = true;
  let time = 0;
  const errors: unknown[] = [];
  let errorCount = 0;
  let completedReceipt:
    | Pick<FrameReceipt, 'frameId' | 'deviceGeneration' | 'graphGeneration'>
    | undefined;
  const completionSamples: number[] = [];
  let completedFps: number | undefined;
  let lastFpsPaint = 0;
  const clearFps = () => {
    completionSamples.length = 0;
    completedFps = undefined;
    element('#fps').textContent = '-- FPS';
  };
  const sampleCompletedFrame = () => {
    if (document.visibilityState !== 'visible') {
      clearFps();
      return;
    }
    const now = performance.now();
    if (now - (completionSamples.at(-1) ?? now) > 1000) clearFps();
    completionSamples.push(now);
    while ((completionSamples[0] ?? now) < now - 1000) completionSamples.shift();
    const span = now - (completionSamples[0] ?? now);
    completedFps = span >= 400 ? ((completionSamples.length - 1) * 1000) / span : undefined;
    if (now - lastFpsPaint >= 250) {
      element('#fps').textContent =
        completedFps === undefined ? '-- FPS' : `${completedFps.toFixed(1)} FPS`;
      lastFpsPaint = now;
    }
  };
  document.addEventListener('visibilitychange', clearFps);
  const fpsExpiry = window.setInterval(() => {
    if (performance.now() - (completionSamples.at(-1) ?? 0) > 1000) clearFps();
  }, 250);
  const applyCamera = () => {
    world
      .set(camera, Transform, {
        pos: pose.eye,
        quat: quat.fromLookAt(quat.create(), pose.eye, pose.target, [0, 1, 0]),
      })
      .unwrap();
    const height = element<HTMLInputElement>('#height');
    height.min = String(Math.min(-4, Math.floor(pose.eye[1])));
    height.max = String(Math.max(30, Math.ceil(pose.eye[1])));
    height.value = String(pose.eye[1]);
    element('#height-value').textContent = `${pose.eye[1].toFixed(2)} m`;
    element('#camera-label').textContent =
      `${bodyLabels[selectedBody]} · ${viewLabels[selectedView]}`;
    sceneControls.updateExclusion();
  };
  const refreshViewButtons = () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
      button.setAttribute('aria-pressed', String(button.dataset.view === selectedView));
  };
  const cameraControls = createWaterCameraControls({
    app,
    canvas,
    readPose: () => pose,
    writePose: (next) => {
      pose = { eye: [...next.eye], target: [...next.target] };
      if (selectedView !== 'manual') {
        selectedView = 'manual';
        refreshViewButtons();
      }
      applyCamera();
    },
  });
  const setCameraPose = (next: CameraPose) => {
    if (
      ![...next.eye, ...next.target].every(Number.isFinite) ||
      Math.hypot(next.target[0] - next.eye[0], next.target[2] - next.eye[2]) < 0.0001
    )
      return err({
        code: 'water-r3-invalid-camera-pose' as const,
        expected: 'Finite eye and target coordinates with a nonvertical view direction',
        hint: 'Provide finite coordinates and distinct horizontal eye/target positions.',
      });
    cameraControls.reset();
    pose = { eye: [...next.eye], target: [...next.target] };
    selectedView = 'manual';
    refreshViewButtons();
    applyCamera();
    return ok(undefined);
  };
  app.pluginContext.effect(() => {
    const listeners = new AbortController();
    const releaseCameraInput = () => {
      cameraControls.reset();
      if (document.activeElement === canvas) canvas.blur();
    };
    panel.addEventListener('pointerdown', releaseCameraInput, { signal: listeners.signal });
    panel.addEventListener('wheel', releaseCameraInput, {
      passive: true,
      signal: listeners.signal,
    });
    panelToggle.addEventListener(
      'click',
      () => {
        panel.hidden = !panel.hidden;
        panelToggle.setAttribute('aria-expanded', String(!panel.hidden));
        const label = panel.hidden ? '显示面板' : '收起面板';
        panelToggle.setAttribute('aria-label', label);
        panelToggle.title = label;
        const icon = panelToggle.querySelector('span');
        if (icon) icon.textContent = panel.hidden ? '\u2630' : '\u203a';
        cameraControls.reset();
      },
      { signal: listeners.signal },
    );
    return () => listeners.abort();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
    button.addEventListener('click', () => {
      const view = button.dataset.view as ViewPreset;
      selectedView = view;
      pose = { eye: [...poses[view].eye], target: [...poses[view].target] };
      cameraControls.reset();
      refreshViewButtons();
      applyCamera();
    });
  const mountScenario = () => {
    syncCausticsWaves();
    const types: readonly BodyType[] =
      scenario === 'river-lake'
        ? ['river', 'lake']
        : scenario === 'river-ocean'
          ? ['river', 'ocean']
          : scenario === 'shared'
            ? ['lake']
            : [selectedBody];
    if (!types.includes(selectedBody)) selectedBody = required(types[0]);
    for (const body of [...bodies, peer, opticalLake]) {
      const mounted =
        body === opticalLake
          ? scenario === 'caustics'
          : scenario === 'caustics'
            ? false
            : body === peer
              ? scenario === 'shared'
              : types.includes(body.type);
      if (mounted && !world.hasComponent(body.entity, WaterBodyInstance))
        world
          .addComponent(body.entity, { component: WaterBodyInstance, data: { body: body.handle } })
          .unwrap();
      if (!mounted && world.hasComponent(body.entity, WaterBodyInstance))
        world.removeComponent(body.entity, WaterBodyInstance).unwrap();
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-body]')) {
      button.setAttribute('aria-pressed', String(button.dataset.body === selectedBody));
      button.disabled = scenario !== 'baseline' && !types.includes(button.dataset.body as BodyType);
    }
    element<HTMLElement>('#body-instance-field').hidden = scenario !== 'shared';
    element<HTMLSelectElement>('#scenario').value = scenario;
    element<HTMLElement>('#caustics-controls').hidden = scenario !== 'caustics';
    applyCaustics();
    materialPanel.refresh();
    sceneControls.selectedChanged();
    applyCamera();
  };
  const applyCaustics = () => {
    syncCausticsWaves();
    applySun();
    element<HTMLSelectElement>('#caustics-mode').value = causticsMode;
    element<HTMLOutputElement>('#caustics-strength-value').value = causticsStrength.toFixed(2);
  };
  element<HTMLSelectElement>('#caustics-mode').addEventListener('change', (event) => {
    causticsMode = (event.currentTarget as HTMLSelectElement).value as CausticsMode;
    applyCaustics();
  });
  element<HTMLInputElement>('#caustics-strength').addEventListener('input', (event) => {
    causticsStrength = Number((event.currentTarget as HTMLInputElement).value);
    applyCaustics();
  });
  for (const [id, key] of [
    ['caustics-scale', 'scale'],
    ['caustics-width', 'width'],
    ['caustics-softness', 'softness'],
    ['caustics-distance', 'distanceM'],
    ['caustics-depth', 'depthM'],
  ] as const)
    element<HTMLInputElement>(`#${id}`).addEventListener('input', (event) => {
      causticsParameters[key] = Number((event.currentTarget as HTMLInputElement).value);
      applyCaustics();
    });
  for (const [id, key] of [
    ['caustics-sun-azimuth', 'azimuth'],
    ['caustics-sun-elevation', 'elevation'],
    ['caustics-sun-intensity', 'intensity'],
  ] as const)
    element<HTMLInputElement>(`#${id}`).addEventListener('input', (event) => {
      sunParameters[key] = Number((event.currentTarget as HTMLInputElement).value);
      applyCaustics();
    });
  applyCaustics();
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-body]'))
    button.addEventListener('click', () => {
      selectedBody = button.dataset.body as BodyType;
      mountScenario();
    });
  element<HTMLSelectElement>('#scenario').addEventListener('change', (event) => {
    scenario = (event.currentTarget as HTMLSelectElement).value as Scenario;
    selectedView = 'overview';
    pose =
      scenario === 'shared'
        ? { eye: [35, 22, 52], target: [14, 0, 0] }
        : { eye: [...poses[startView].eye], target: [...poses[startView].target] };
    cameraControls.reset();
    refreshViewButtons();
    mountScenario();
  });
  element('#body-instance').addEventListener('change', () => {
    materialPanel.refresh();
    sceneControls.selectedChanged();
  });
  element<HTMLInputElement>('#height').addEventListener('input', (event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    const delta = value - pose.eye[1];
    pose.eye[1] = value;
    pose.target[1] += delta;
    applyCamera();
  });
  element<HTMLInputElement>('#ssr').addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    if (enabled)
      world
        .addComponent(camera, {
          component: ScreenSpaceReflection,
          data: SSR_SETTINGS,
        })
        .unwrap();
    else world.removeComponent(camera, ScreenSpaceReflection).unwrap();
  });
  element<HTMLInputElement>('#taa').addEventListener('change', (event) =>
    world
      .set(camera, Camera, {
        antialias: (event.currentTarget as HTMLInputElement).checked
          ? ANTIALIAS_TAA
          : ANTIALIAS_NONE,
      })
      .unwrap(),
  );
  element<HTMLInputElement>('#post-processing').addEventListener('change', (event) =>
    world
      .set(camera, Camera, { postProcessing: (event.currentTarget as HTMLInputElement).checked })
      .unwrap(),
  );
  element<HTMLButtonElement>('#recover-renderer').addEventListener('click', async () => {
    const recovered = await app.renderer.recover();
    element('#selection-action').textContent = recovered.ok ? '渲染器已恢复' : recovered.error.code;
  });
  element<HTMLInputElement>('#scale').addEventListener('change', (event) => {
    if ((event.currentTarget as HTMLInputElement).checked)
      world
        .addComponent(camera, {
          component: DynamicResolution,
          data: { minScale: 0.67, maxScale: 0.67, targetGpuMs: 16.67 },
        })
        .unwrap();
    else world.removeComponent(camera, DynamicResolution).unwrap();
  });
  element<HTMLInputElement>('#motion').addEventListener('change', (event) => {
    animate = (event.currentTarget as HTMLInputElement).checked;
  });
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'waterR3SceneAnimation',
        queries: [],
        fn: () => {
          if (!animate) return;
          const delta = world.getResource(Time).delta;
          if (delta === 0) return;
          time += delta;
          world
            .set(moving, Transform, {
              pos: [1 + Math.sin(time * 0.45) * 3, 1.6, -2],
              quat: [0, Math.sin(time * 0.2), 0, Math.cos(time * 0.2)],
            })
            .unwrap();
        },
      }),
    )
    .unwrap();
  const readState = () => {
    const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
    const view = water.viewState(viewIdentity);
    const mesh = waterSceneMeshView(world, zoneGuid, viewIdentity);
    const scene = [...bodies, peer, opticalLake].flatMap((body) => {
      const snapshot = waterSceneSnapshot(world, Number(body.entity));
      return snapshot === undefined
        ? []
        : [
            {
              guid: snapshot.guid,
              sourceAssetGuid: snapshot.sourceAssetGuid,
              instanceEntity: snapshot.instanceEntity,
              sourceVersion: snapshot.sourceVersion,
              sceneGeneration: snapshot.sceneGeneration,
              type: snapshot.asset.type,
              waveSetGuid: snapshot.asset.waveSetGuid,
              maxWaveHeightM: snapshot.asset.maxWaveHeightM,
              surfaceMaterialGuid: snapshot.asset.surfaceMaterialGuid,
              lodMaterialGuid: snapshot.asset.lodMaterialGuid,
              underwaterPostProcessMaterialGuid: snapshot.asset.underwaterPostProcessMaterialGuid,
              overlapPriority: snapshot.asset.overlapPriority,
              outputs: snapshot.outputs,
              outputGenerations: snapshot.outputGenerations,
              outputReceipts: snapshot.outputReceipts,
            },
          ];
    });
    const sceneStatus = world.hasResource(WATER_SCENE_STATUS_RESOURCE)
      ? world.getResource<WaterSceneStatus>(WATER_SCENE_STATUS_RESOURCE)
      : undefined;
    return {
      completedFrames,
      completedFps,
      completedReceipt,
      selectedBody,
      selectedView,
      cameraPose: { eye: [...pose.eye], target: [...pose.target] },
      manualCameraEnabled: cameraControls.enabled,
      scenario,
      caustics: {
        mode: causticsMode,
        textureClock: textureClock.readState(),
        strength: causticsStrength,
        sunDirection: [...world.get(sunlight, DirectionalLight).unwrap().direction],
        receivers: {
          terrainSections: assets.read(terrain).unwrap().sections.length,
          path: 'before-medium-scene-data',
          spheres: sphereReceivers.map((receiver) => Number(receiver.entity)),
        },
        parameters: { ...causticsParameters },
        sunIntensity: world.get(sunlight, DirectionalLight).unwrap().intensity,
        shadowEnabled: world.get(sunlight, DirectionalLight).unwrap().castShadow,
        requestedWaveSetGuid: assets.read(causticsHandle).unwrap().waveSetGuid,
        receiverHeightM: CAUSTICS_PLANE_Y,
        ...caustics.readState(),
      },
      selectedEntity: Number(currentBody().entity),
      materialOperations: materialPanel.operations,
      material: materialPanel.readState(),
      selectionDiagnostics: sceneControls.diagnostics,
      view,
      scene,
      sceneStatus,
      errors,
      errorCount,
      lastError: errors.at(-1),
      mesh:
        mesh === undefined
          ? undefined
          : {
              zoneGuid: mesh.zoneGuid,
              zoneGeneration: mesh.zoneGeneration,
              viewId: mesh.viewId,
              publicationGeneration: mesh.publicationGeneration,
              digest: mesh.digest,
              current: mesh.current,
              receipt: {
                selectedTileCount: mesh.receipt.selectedTileCount,
                farInstanceCount: mesh.receipt.farInstanceCount,
                visibleLeafCount: mesh.receipt.visibleLeafCount,
                bucketCount: mesh.receipt.buckets.length,
                instanceBytes: mesh.receipt.instanceBytes.byteLength,
                coverageBytes: mesh.receipt.coverageBytes.byteLength,
                buckets: mesh.receipt.buckets.map((bucket) => ({
                  materialKey: bucket.materialKey,
                  densityKey: bucket.densityKey,
                  vertexCount: bucket.vertexCount,
                  indexCount: bucket.indexCount,
                  instanceCount: bucket.instances.length,
                })),
              },
            },
    };
  };
  const refresh = () => {
    const state = readState();
    element('#frame-count').textContent = `${completedFrames} 帧`;
    element('#completed-receipt').textContent =
      completedReceipt === undefined
        ? '待完成'
        : `帧 ${completedReceipt.frameId} · 设备代 ${completedReceipt.deviceGeneration}`;
    element('#tile-count').textContent = String(state.mesh?.receipt.selectedTileCount ?? 0);
    materialPanel.refresh();
    sceneControls.refresh();
    if (state.view?.ok) {
      element('#immersion').textContent = `${state.view.value.immersionDepthM.toFixed(2)} m`;
      element('#view-medium').textContent =
        state.view.value.immersionDepthM > 0 ? '水下' : '水面以上';
      element('#post-process').textContent = state.view.value.visualPpActive ? '生效' : '未生效';
      element('#audio-state').textContent = state.view.value.audioUnderwater ? '水下' : '水面以上';
    } else {
      element('#immersion').textContent = '—';
      element('#view-medium').textContent = '待选体';
      element('#post-process').textContent =
        state.view?.ok === false ? state.view.error.code : '待处理';
      element('#audio-state').textContent = '待处理';
    }
    const lastError = errors.at(-1);
    const lastCode =
      typeof lastError === 'object' && lastError !== null && 'code' in lastError
        ? String(lastError.code)
        : undefined;
    element('#status').textContent =
      `已完成 ${completedFrames} 帧 · ${state.scene.length} 个场景水体` +
      (errorCount ? ` · 累计运行错误 ${errorCount}${lastCode ? ` · 最近 ${lastCode}` : ''}` : '');
  };
  const recordError = (error: unknown, label: string) => {
    errorCount++;
    errors.push(error);
    if (errors.length > 64) errors.shift();
    clearFps();
    element('#render-state').textContent = label;
    refresh();
  };
  app.renderer.subscribe((event) => {
    if (event.kind === 'state-changed') {
      element<HTMLButtonElement>('#recover-renderer').disabled = event.current !== 'device-lost';
      if (event.current !== 'alive') clearFps();
    }
    if (event.kind === 'error') recordError(event.error, '渲染错误');
    if (event.kind === 'frame-submitted')
      void event.receipt.completed
        .then((result) => {
          if (!result.ok) {
            recordError(result.error, 'GPU 错误');
            return;
          }
          if (event.receipt.presentation !== 'ready') return;
          completedReceipt = {
            frameId: event.receipt.frameId,
            deviceGeneration: event.receipt.deviceGeneration,
            ...(event.receipt.graphGeneration === undefined
              ? {}
              : { graphGeneration: event.receipt.graphGeneration }),
          };
          completedFrames++;
          sampleCompletedFrame();
          element('#render-state').textContent = '实时渲染';
          if (completedFrames % 10 === 0) refresh();
        })
        .catch((error: unknown) => recordError(error, '完成帧错误'));
  });
  app.onError((error) => recordError(error, '运行错误'));
  Object.assign(window, {
    __waterR3: {
      app,
      world,
      camera,
      zoneGuid,
      bodies: [...bodies, peer, opticalLake],
      errors,
      readState,
      setCameraPose,
      setManualCameraEnabled: cameraControls.setEnabled,
      setCausticsVisibilityDiagnostic: (enabled: boolean) => {
        causticsDiagnostic = enabled;
      },
    },
  });
  window.addEventListener('beforeunload', () => {
    window.clearInterval(fpsExpiry);
    materialPanel.dispose();
    void app.dispose();
  });
  await dressWaterStage(app, [0, 0, 0], 1);
  stageRuntimePanel(
    app,
    requireDemoValue(document.getElementById('controls-panel'), 'accepted authored scene member'),
    'R3',
  );
  const materialControls = element<HTMLFieldSetElement>('#material-controls');
  const binding = document.createElement('details');
  const bindingTitle = document.createElement('summary');
  bindingTitle.textContent = '高级 · 资产、颜色通道与材质分支';
  binding.append(bindingTitle);
  const appearance = element<HTMLSelectElement>('#water-appearance');
  const appearanceLabel = materialControls.querySelector<HTMLElement>('[for=water-appearance]');
  const primary = new Set<Element>([appearance, appearanceLabel ?? appearance]);
  for (const id of ['roughness', 'normal', 'refraction-strength', 'bottom-refraction']) {
    primary.add(element(`#${id}`));
    const label = materialControls.querySelector(`[for=${id}]`);
    if (label) primary.add(label);
  }
  for (const child of [...materialControls.children])
    if (!primary.has(child)) binding.append(child);
  materialControls.append(binding);
  const quality = waterQualityControl((level) => {
    for (const [id, on] of [
      ['ssr', level > 0],
      ['taa', level > 0],
      ['scale', level === 0],
    ] as const) {
      const control = element<HTMLInputElement>(`#${id}`);
      if (control.checked !== on) {
        control.checked = on;
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const source = assets.read(zoneHandle).unwrap();
    const resolution = [256, 512, 1024, 2048][level] ?? 512;
    assets
      .replace(zoneHandle, {
        ...source,
        tessellationFactor: [3, 4, 5, 6][level] ?? 4,
        waterInfo: {
          ...source.waterInfo,
          resolution: { widthPx: resolution, heightPx: resolution },
        },
      })
      .unwrap();
  }, 1);
  const sections = [...panel.querySelectorAll<HTMLElement>(':scope > section')].filter(
    (section) => section.id !== 'caustics-controls',
  );
  arrangeWaterSettings({
    panel,
    hero: panel.querySelector<HTMLElement>('.panel-heading') ?? undefined,
    title: '反射与水下',
    description: '从湖畔走到水线，再潜入水下。观察倒影、折射与水色随视角和水深的变化。',
    dimensions: [
      {
        title: '展示场景',
        elements: [...sections.slice(0, 1), element<HTMLElement>('#caustics-controls')],
        open: true,
      },
      { title: '相机与水线', elements: sections.slice(1, 2), open: true },
      { title: '水色与折射', elements: sections.slice(2, 3) },
      { title: '画质与动画', elements: [quality, ...sections.slice(4, 5)] },
      {
        title: '高级 · 水体选择与观测',
        elements: [...sections.slice(3, 4), ...sections.slice(5, 6)],
      },
    ],
  });
  waterStageNavigation('R3');
  app.start().unwrap();
  mountScenario();
  applyCamera();
}

void main().catch((error: unknown) => {
  element('#render-state').textContent = '启动失败';
  element('#status').textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
});
