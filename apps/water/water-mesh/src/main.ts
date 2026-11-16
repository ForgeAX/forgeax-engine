import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { defineSystem, Time, Update } from '@forgeax/engine/ecs';
import { createCylinderGeometry } from '@forgeax/engine/geometry';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  InputFrameStartScan,
  type InputSnapshot,
} from '@forgeax/engine/input';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import {
  Collider,
  ColliderShapeValue,
  type PhysicsWorld,
  PhysicsWorldResource,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine/render';
import { WATER_SYSTEM_RESOURCE, waterSceneMeshView } from '@forgeax/engine/runtime';
import {
  Transform,
  WaterBodyInstance,
  WaterExclusionMode,
  WaterExclusionVolume,
  WaterPontoonSet,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import type { WaterBodyAsset } from '@forgeax/engine/types';
import {
  cookGerstnerWaveSet,
  cookWaterAsset,
  evaluateGerstnerWavesCpuFull,
  evaluateGerstnerWavesCpuSimple,
  WATER_WAVE_LWC_TILE_LENGTH_M,
  WaterQueryFlags,
  type WaterSystem,
} from '@forgeax/engine/water';
import { waterBodyEditor } from '../../body-editor';
import { demoWaveSetSource } from '../../demo-wave-set';
import { stageRuntimePanel } from '../../presentation';
import { presentationGuid } from '../../presentation-identity';
import {
  type RuntimeFormField,
  type RuntimeFormFields,
  refreshRuntimeForms,
  runtimeForm,
} from '../../runtime-form';
import { waterQualityControl } from '../../settings-panel';
import { WATER_MESH_DEMO_PACKAGE } from './identity';
import { mountWatershedScenery } from './scenery';
import { createSeaControls } from './sea-controls';
import { WORLD_ORIGIN } from './watershed';
import './style.css';
import '../../settings-panel.css';
const node = <T extends HTMLElement = HTMLElement>(id: string) => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing ${id}`);
  return e as T;
};
const views = {
  overview: { eye: [410, 285, 440], target: [-20, 10, -20] },
  lake: { eye: [-98, 52, 2], target: [-190, 30, -75] },
  river: { eye: [20, 35, -105], target: [-40, 15, -175] },
  mouth: { eye: [214, 22, -35], target: [129, 1, -126] },
  ocean: { eye: [260, 12, 70], target: [50, 0, -30] },
} as const;
async function main() {
  const started = performance.now();
  const checkpoint = (stage: string) => {
    node('status').textContent = `${stage} · ${Math.round(performance.now() - started)} ms`;
  };
  checkpoint('app-create');
  const canvas = node<HTMLCanvasElement>('scene');
  const app = (
    await createApp(
      canvas,
      {
        plugins: [physics3d],
        pointerLockAllowed: () => false,
        uiRoot: node('controls-panel'),
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
      },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    )
  ).unwrap();
  checkpoint('app-created');
  const assets = app.assets;
  if (!assets) throw new Error('Asset owner unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world,
    g = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_MESH_DEMO_PACKAGE, key));
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const zone = (await assets.load(g('zone/main'), 'water-zone')).unwrap();
  const farMaterialGuid = assets.read(zone).unwrap().farMaterialGuid;
  if (farMaterialGuid !== undefined) (await assets.load(farMaterialGuid, 'material')).unwrap();
  checkpoint('zone-far-material-admitted');
  const zoneEntity = world
    .spawn({ component: Transform, data: {} }, { component: WaterZoneInstance, data: { zone } })
    .unwrap();
  const bodies = await Promise.all(
    ['ocean', 'lake', 'river', 'custom'].map(async (key) => {
      const handle = (await assets.load(g(`body/${key}`), 'water-body')).unwrap();
      const entity = world
        .spawn(
          { component: Transform, data: { pos: key === 'custom' ? [193, 0.15, 118] : [0, 0, 0] } },
          { component: WaterBodyInstance, data: { body: handle } },
        )
        .unwrap();
      return { key, entity, handle };
    }),
  );
  const surfaceMaterials = await Promise.all(
    bodies.map(async (b) =>
      (await assets.load(assets.read(b.handle).unwrap().surfaceMaterialGuid, 'material')).unwrap(),
    ),
  );
  const customBody = bodies.find((b) => b.key === 'custom');
  if (customBody) {
    const mesh = (await assets.load(g('mesh/custom'), 'mesh')).unwrap();
    const material = (await assets.load(g('material/custom'), 'material')).unwrap();
    world
      .addComponent(customBody.entity, { component: MeshFilter, data: { assetHandle: mesh } })
      .unwrap();
    world
      .addComponent(customBody.entity, { component: MeshRenderer, data: { materials: [material] } })
      .unwrap();
  }
  checkpoint('water-bodies-and-materials-loaded');
  const terrains = await Promise.all(
    ['a', 'b'].map(async (key) =>
      (await assets.load(g(`terrain/${key}/terrain`), 'terrain')).unwrap(),
    ),
  );
  const firstTerrain = terrains[0];
  if (firstTerrain === undefined) throw new Error('Terrain A missing');
  const ground = world
    .spawn(
      { component: Transform, data: { pos: [...WORLD_ORIGIN] } },
      { component: Terrain, data: { asset: firstTerrain } },
      { component: WaterTerrainProvider, data: { terrain: firstTerrain } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    )
    .unwrap();
  checkpoint('terrain-mounted');
  const sky = (await assets.load(g('sky/world'), 'equirect')).unwrap();
  world.spawn({ component: SkyboxBackground, data: { equirect: sky } }).unwrap();
  world
    .spawn({
      component: Skylight,
      data: { equirect: sky, intensity: 0.85, ambientIrradiance: [0.16, 0.2, 0.23] },
    })
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.4, -0.8, -0.3],
        color: [1, 0.93, 0.82],
        intensity: 2.1,
        castShadow: false,
      },
    })
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: 0.82,
            aspect: canvas.clientWidth / canvas.clientHeight,
            near: 0.3,
            far: 14000,
          }),
          tonemap: TONEMAP_ACES_FILMIC,
          exposure: 1,
          clearColor: [0.62, 0.78, 0.85, 1],
        },
      },
    )
    .unwrap();
  let activeView = 'overview';
  let yaw = 0,
    pitch = 0,
    navigationSpeed = 30;
  let previousMouse: { x: number; y: number } | undefined;
  const navigationCodes = [
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'ArrowUp',
    'ArrowLeft',
    'ArrowDown',
    'ArrowRight',
    'KeyE',
    'KeyQ',
    'Space',
    'PageUp',
    'PageDown',
    'ShiftLeft',
    'ShiftRight',
  ];
  const releasedNavigationCodes = new Set<string>();
  const releaseNavigation = () => {
    previousMouse = undefined;
    for (const code of navigationCodes) releasedNavigationCodes.add(code);
    canvas.classList.remove('looking');
  };
  const setView = (name: keyof typeof views) => {
    activeView = name;
    const p = views[name];
    const direction = p.target.map((value, axis) => value - (p.eye[axis] ?? 0));
    yaw = Math.atan2(direction[0] ?? 0, direction[2] ?? 0);
    pitch = Math.asin((direction[1] ?? 0) / Math.hypot(...direction));
    releaseNavigation();
    world
      .set(camera, Transform, {
        pos: [...p.eye],
        quat: quat.fromLookAt(quat.create(), p.eye, p.target, [0, 1, 0]),
      })
      .unwrap();
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
      button.setAttribute('aria-pressed', String(button.dataset.view === name));
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
    button.onclick = () => setView(button.dataset.view as keyof typeof views);
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button === 0 || event.button === 2) canvas.focus({ preventScroll: true });
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'Escape') canvas.blur();
    if (navigationCodes.includes(event.code)) event.preventDefault();
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.activeElement === canvas) event.preventDefault();
    },
    { passive: false },
  );
  canvas.addEventListener('blur', releaseNavigation);
  window.addEventListener('blur', releaseNavigation);
  world
    .addSystem(
      Update,
      defineSystem({
        name: 'watershed-free-navigation',
        after: [InputFrameStartScan],
        queries: [],
        fn: () => {
          const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
          const focused = document.hasFocus() && document.activeElement === canvas;
          const keyboard = input.keyboard;
          for (const code of releasedNavigationCodes)
            if (!keyboard.downCode(code)) releasedNavigationCodes.delete(code);
          const pressed = (...codes: string[]) =>
            codes.some((code) => !releasedNavigationCodes.has(code) && keyboard.downCode(code));
          const enabled =
            focused && !keyboard.down('Control') && !keyboard.down('Meta') && !keyboard.down('Alt');
          const looking = enabled && (input.mouse.button(0) || input.mouse.button(2));
          canvas.classList.toggle('looking', looking);
          let changed = false;
          const mouse = input.mouse.position;
          const applyMouseLook = () => {
            if (
              looking &&
              mouse &&
              previousMouse &&
              !input.mouse.justPressed(0) &&
              !input.mouse.justPressed(2)
            ) {
              const dx =
                ((mouse.x - previousMouse.x) * canvas.clientWidth) / Math.max(canvas.width, 1);
              const dy =
                ((mouse.y - previousMouse.y) * canvas.clientHeight) / Math.max(canvas.height, 1);
              yaw -= dx * 0.004;
              pitch = Math.max(-1.5, Math.min(1.5, pitch - dy * 0.004));
              changed = dx !== 0 || dy !== 0;
            }
            return changed;
          };
          changed = applyMouseLook();
          previousMouse = enabled ? mouse : undefined;
          if (enabled && input.mouse.wheelDelta !== 0)
            navigationSpeed = Math.max(
              0.5,
              Math.min(500, navigationSpeed * 1.2 ** -input.mouse.wheelDelta),
            );
          const applyNavigationTranslation = () => {
            const boosted = enabled && pressed('ShiftLeft', 'ShiftRight');
            const speed = navigationSpeed * (boosted ? 3 : 1);
            const forward = [
              Math.sin(yaw) * Math.cos(pitch),
              Math.sin(pitch),
              Math.cos(yaw) * Math.cos(pitch),
            ];
            const advance = enabled
              ? Number(pressed('KeyW', 'ArrowUp')) - Number(pressed('KeyS', 'ArrowDown'))
              : 0;
            const strafe = enabled
              ? Number(pressed('KeyD', 'ArrowRight')) - Number(pressed('KeyA', 'ArrowLeft'))
              : 0;
            const vertical = enabled
              ? Number(pressed('KeyE', 'Space', 'PageUp')) - Number(pressed('KeyQ', 'PageDown'))
              : 0;
            const movement = [
              (forward[0] ?? 0) * advance - Math.cos(yaw) * strafe,
              (forward[1] ?? 0) * advance + vertical,
              (forward[2] ?? 0) * advance + Math.sin(yaw) * strafe,
            ];
            const length = Math.hypot(...movement);
            if (changed || length > 0) {
              const pose = world.get(camera, Transform).unwrap();
              const distance =
                (speed * Math.min(world.getResource(Time).delta, 0.05)) / Math.max(length, 1);
              const eye = pose.pos.map((value, axis) => value + (movement[axis] ?? 0) * distance);
              const target = eye.map((value, axis) => value + (forward[axis] ?? 0));
              world
                .set(camera, Transform, {
                  pos: eye,
                  quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]),
                })
                .unwrap();
              if (activeView !== 'free') {
                activeView = 'free';
                for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
                  button.setAttribute('aria-pressed', 'false');
              }
            }
            return { boosted, speed };
          };
          const { boosted, speed } = applyNavigationTranslation();
          const label = `${enabled ? '漫游中' : '点击画面开始漫游'} · ${speed.toFixed(1)} m/s${boosted ? ' · 加速 ×3' : ''}`;
          if (node('navigation-speed').textContent !== label)
            node('navigation-speed').textContent = label;
        },
      }),
    )
    .unwrap();
  checkpoint('scenery-load');
  await mountWatershedScenery(app);
  checkpoint('scenery-mounted');
  const probes: import('@forgeax/engine/ecs').EntityHandle[] = [];
  const probeMesh = assets.create(createCylinderGeometry(0.18, 0.24, 4, 12).unwrap()).unwrap();
  const probeMaterial = (
    await assets.load(presentationGuid('material/brass'), 'material')
  ).unwrap();
  for (const pos of [
    [250, 0.8, 80],
    [-190, 30.8, -80],
    [-59, 17.8, -176],
  ] as const) {
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [...pos] } },
        { component: MeshFilter, data: { assetHandle: probeMesh } },
        { component: MeshRenderer, data: { materials: [probeMaterial] } },
        {
          component: RigidBody,
          data: {
            type: RigidBodyTypeValue.dynamic,
            mass: 60,
            linearDamping: 0.4,
            angularDamping: 2,
          },
        },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cylinder, radius: 0.24, halfHeight: 2 },
        },
        {
          component: WaterPontoonSet,
          data: {
            enabled: true,
            anchorsM: [0, 0, 0],
            radiiM: [0.55],
            buoyancyCoefficientNPerM3: 1800,
            dampingNPerMps: 900,
            maxBuoyantForceN: 4000,
          },
        },
      )
      .unwrap();
    probes.push(entity);
  }
  const exclusion = world.spawn({ component: Transform, data: { pos: [250, 0, 80] } }).unwrap();
  let selected = bodies[0];
  if (!selected) throw new Error('No Body');
  const selectedBody = () => {
    if (!selected) throw new Error('No selected Body');
    return selected;
  };
  const forms: ReturnType<typeof runtimeForm>[] = [];
  const dimension = (id: string, title: string, fields: RuntimeFormFields) => {
    const form = runtimeForm(node(id), title, fields);
    form.section.classList.add('water-dimension');
    forms.push(form);
    return form;
  };
  const field = (
    name: string,
    label: string,
    value: unknown,
    set: (value: unknown) => void,
    read: () => unknown,
    extra: Partial<RuntimeFormField> = {},
  ): RuntimeFormField => ({ name, label, value, set, read, ...extra });
  const number = (v: unknown, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error('Value outside admitted range');
    return n;
  };
  let queryBody = 0;
  const querySettings = {
    x: 250,
    y: -1,
    z: 80,
    depth: true,
    normal: true,
    velocity: true,
    waves: true,
    simple: false,
    ignoreExclusion: false,
  };
  const selection = node<HTMLSelectElement>('body-select');
  for (const [i, b] of bodies.entries()) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent =
      { ocean: '海洋', lake: '高地湖', river: '河流', custom: '入海口 Custom 浮台' }[b.key] ??
      b.key;
    selection.append(o);
  }
  selection.onchange = () => {
    selected = bodies[Number(selection.value)];
    queryBody = Number(selection.value);
    const points = [
      [250, -1, 80],
      [-190, 29, -75],
      [-59, 16, -176],
      [193, 0, 118],
    ];
    const p = points[queryBody];
    if (p) {
      querySettings.x = p[0] ?? 0;
      querySettings.y = p[1] ?? 0;
      querySettings.z = p[2] ?? 0;
    }
    for (const f of forms) f.refresh();
  };
  let bodyForm: ReturnType<typeof runtimeForm> | undefined;
  const bodyEditors = new Map(
    bodies.map((b) => [
      b.handle,
      waterBodyEditor(
        assets,
        b.handle,
        () => bodyForm?.refresh(),
        (e) => bodyForm?.rejectPending(e),
      ),
    ]),
  );
  const editBody = (patch: Partial<WaterBodyAsset>) => {
    const b = selectedBody();
    const editor = bodyEditors.get(b.handle);
    if (!editor) throw new Error('Body editor unavailable');
    editor({ ...assets.read(b.handle).unwrap(), ...patch });
  };
  const bodyFields: RuntimeFormFields = Object.assign([], {
    readFields: () => {
      const b = assets.read(selectedBody().handle).unwrap();
      return [
        field(
          'baseHeightM',
          '选中水体水位',
          b.baseHeightM,
          (v) => editBody({ baseHeightM: number(v, -5, 80) }),
          () => assets.read(selectedBody().handle).unwrap().baseHeightM,
          { unit: 'm', min: -5, max: 80, slider: true },
        ),
        field(
          'maxWaveHeightM',
          '保守波高边界',
          b.maxWaveHeightM,
          (v) => editBody({ maxWaveHeightM: number(v, 0, 10) }),
          () => assets.read(selectedBody().handle).unwrap().maxWaveHeightM,
          { unit: 'm', min: 0, max: 10 },
        ),
        field(
          'overlapPriority',
          '重叠优先级',
          b.overlapPriority,
          (v) => editBody({ overlapPriority: Math.round(number(v, -50, 50)) }),
          () => assets.read(selectedBody().handle).unwrap().overlapPriority,
          { step: 1, min: -50, max: 50 },
        ),
      ];
    },
  });
  bodyForm = dimension('dimension-water', '水位与真实几何发布', bodyFields);
  const source = demoWaveSetSource();
  if (source.waveSource.kind !== 'generated') throw new Error('Wave generator missing');
  let generator = { ...source.waveSource.generatorConfig };
  const spectrum = (await assets.load(g('waves/seed-731-v1'), 'water-wave-set')).unwrap();
  const changeWave = (key: string, v: unknown) => {
    const next = { ...generator, [key]: Number(v) };
    const cooked = cookWaterAsset({
      ...source,
      waveSource: { ...source.waveSource, generatorConfig: next },
    }).unwrap();
    if (cooked.kind !== 'water-wave-set') throw new Error('Invalid WaveSet');
    assets.replace(spectrum, cooked).unwrap();
    generator = next;
  };
  dimension(
    'dimension-waves',
    '海洋 / 河流共享风浪（高地湖保留独立静浪）',
    ['count', 'windAngleDegrees', 'amplitudeMaxM', 'wavelengthMaxM'].map((key) =>
      field(
        key,
        {
          count: '波数量',
          windAngleDegrees: '风向',
          amplitudeMaxM: '最大振幅',
          wavelengthMaxM: '最长波长',
        }[key] ?? key,
        generator[key],
        (v) => changeWave(key, v),
        () => generator[key],
        {
          min: key === 'count' ? 1 : 0,
          max:
            key === 'count'
              ? 32
              : key === 'windAngleDegrees'
                ? 360
                : key === 'amplitudeMaxM'
                  ? 1
                  : 160,
          ...(key === 'count' ? { step: 1 } : {}),
          slider: true,
        },
      ),
    ),
  );
  const quality = waterQualityControl((level) => {
    const source = assets.read(zone).unwrap();
    const resolution = [256, 512, 1024, 2048][level] ?? 512;
    assets
      .replace(zone, {
        ...source,
        tessellationFactor: [3, 4, 5, 6][level] ?? 4,
        waterInfo: {
          ...source.waterInfo,
          resolution: { widthPx: resolution, heightPx: resolution },
        },
      })
      .unwrap();
  }, 2);
  node('dimension-mesh').prepend(quality);
  document.body.classList.add('water-experience');
  node('controls-panel').classList.add('water-settings');
  for (const element of document.querySelectorAll('#controls-panel details'))
    element.classList.add('water-dimension');
  dimension('dimension-mesh', '网格与 WaterInfo', [
    field(
      'wire',
      '真实瓦片 / LOD 网格',
      false,
      (v) => {
        node<HTMLInputElement>('wire-toggle').checked = Boolean(v);
        water().setMeshEdgeOverlayEnabled(Boolean(v));
      },
      () => node<HTMLInputElement>('wire-toggle').checked,
    ),
    field(
      'resolution',
      'WaterInfo 分辨率',
      String(assets.read(zone).unwrap().waterInfo.resolution.widthPx),
      (v) => {
        const n = Number(v);
        const s = assets.read(zone).unwrap();
        assets
          .replace(zone, {
            ...s,
            waterInfo: { ...s.waterInfo, resolution: { widthPx: n, heightPx: n } },
          })
          .unwrap();
      },
      () => String(assets.read(zone).unwrap().waterInfo.resolution.widthPx),
      { choices: ['256', '512', '1024'] },
    ),
    field(
      'tessellationFactor',
      '细分等级',
      assets.read(zone).unwrap().tessellationFactor,
      (v) => {
        const s = assets.read(zone).unwrap();
        assets.replace(zone, { ...s, tessellationFactor: number(v, 1, 8) }).unwrap();
      },
      () => assets.read(zone).unwrap().tessellationFactor,
      { min: 1, max: 8, step: 1, slider: true },
    ),
  ]);
  const seaFields = createSeaControls(assets, () => {
    const handle = surfaceMaterials[bodies.indexOf(selectedBody())];
    if (handle === undefined) throw new Error('Missing current surface material');
    return handle;
  });
  dimension('dimension-sea', '海色与清澈度', seaFields);
  node<HTMLInputElement>('wire-toggle').onchange = (e) =>
    water().setMeshEdgeOverlayEnabled((e.target as HTMLInputElement).checked);
  dimension(
    'dimension-query',
    '查询点与输出字段',
    Object.entries(querySettings).map(([key, v]) =>
      field(
        key,
        {
          x: '查询 X',
          y: '查询 Y',
          z: '查询 Z',
          depth: '水深',
          normal: '法线',
          velocity: '流速',
          waves: '包含波浪',
          simple: '简波',
          ignoreExclusion: '忽略排除体积',
        }[key] ?? key,
        v,
        (value) => {
          (querySettings as Record<string, unknown>)[key] = value;
        },
        () => querySettings[key as keyof typeof querySettings],
      ),
    ),
  );
  let fixtureEnabled = false;
  node<HTMLInputElement>('fixture-toggle').onchange = (e) => {
    fixtureEnabled = (e.target as HTMLInputElement).checked;
    const b = selectedBody(),
      snapshot = water().snapshot(`scene-entity:${b.entity}`);
    if (!snapshot) return;
    if (!fixtureEnabled) {
      water().clearBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration).unwrap();
      return;
    }
    const samples = new Float32Array(9 * 9 * 4);
    for (let i = 0; i < 81; i++) samples.set([snapshot.asset.baseHeightM, 8, 0.6, 0.15], i * 4);
    water()
      .publishBakedQueryGrid(snapshot.guid, snapshot.sceneGeneration, {
        kind: 'live-capture',
        enabled: true,
        componentValid: true,
        dataValid: true,
        grid: {
          originXZ: [querySettings.x - 16, querySettings.z - 16],
          originY: 0,
          spacingXZ: [4, 4],
          width: 9,
          height: 9,
          samples,
        },
      })
      .unwrap();
  };
  node<HTMLInputElement>('exclusion-toggle').onchange = (e) => {
    if ((e.target as HTMLInputElement).checked)
      world
        .addComponent(exclusion, {
          component: WaterExclusionVolume,
          data: {
            mode: WaterExclusionMode.addListedBodiesToExclusion,
            waterBodies: [bodies[0]?.entity ?? selectedBody().entity],
            centerM: [0, 0, 0],
            halfExtentsM: [5, 5, 5],
          },
        })
        .unwrap();
    else if (world.hasComponent(exclusion, WaterExclusionVolume))
      world.removeComponent(exclusion, WaterExclusionVolume).unwrap();
  };
  node<HTMLSelectElement>('terrain-select').onchange = (e) => {
    const h = terrains[(e.target as HTMLSelectElement).value === 'b' ? 1 : 0];
    if (h === undefined) return;
    world.set(ground, Terrain, { asset: h }).unwrap();
    if (world.hasComponent(ground, WaterTerrainProvider))
      world.set(ground, WaterTerrainProvider, { terrain: h }).unwrap();
  };
  node<HTMLInputElement>('provider-toggle').onchange = (e) => {
    if ((e.target as HTMLInputElement).checked) {
      const h = world.get(ground, Terrain).unwrap().asset;
      world
        .addComponent(ground, { component: WaterTerrainProvider, data: { terrain: h } })
        .unwrap();
    } else if (world.hasComponent(ground, WaterTerrainProvider))
      world.removeComponent(ground, WaterTerrainProvider).unwrap();
  };
  node('zone-toggle').onclick = () => {
    if (world.hasComponent(zoneEntity, WaterZoneInstance))
      world.removeComponent(zoneEntity, WaterZoneInstance).unwrap();
    else world.addComponent(zoneEntity, { component: WaterZoneInstance, data: { zone } }).unwrap();
  };
  node('body-toggle').onclick = () => {
    const b = selectedBody();
    const mounted = world.hasComponent(b.entity, WaterBodyInstance);
    if (mounted) world.removeComponent(b.entity, WaterBodyInstance).unwrap();
    else
      world
        .addComponent(b.entity, { component: WaterBodyInstance, data: { body: b.handle } })
        .unwrap();
    // Custom uses an ordinary authored mesh, whose material still requires its Body.
    if (world.hasComponent(b.entity, MeshRenderer)) {
      const data = {
        state: mounted ? VisibilityStateValue.hidden : VisibilityStateValue.visible,
      };
      if (world.hasComponent(b.entity, Visibility)) world.set(b.entity, Visibility, data).unwrap();
      else world.addComponent(b.entity, { component: Visibility, data }).unwrap();
    }
  };
  node('body-retire').onclick = () => {
    const b = selectedBody();
    const mesh = world.hasComponent(b.entity, MeshFilter)
      ? world.get(b.entity, MeshFilter).unwrap()
      : undefined;
    const renderer = world.hasComponent(b.entity, MeshRenderer)
      ? world.get(b.entity, MeshRenderer).unwrap()
      : undefined;
    world.despawn(b.entity).unwrap();
    b.entity = world
      .spawn(
        { component: Transform, data: { pos: b.key === 'custom' ? [193, 0.15, 118] : [0, 0, 0] } },
        { component: WaterBodyInstance, data: { body: b.handle } },
        ...(mesh ? [{ component: MeshFilter, data: mesh }] : []),
        ...(renderer ? [{ component: MeshRenderer, data: renderer }] : []),
      )
      .unwrap();
  };
  node<HTMLInputElement>('river-width').onchange = (e) => {
    const b = bodies.find((b) => b.key === 'river');
    if (!b) return;
    const s = assets.read(b.handle).unwrap();
    const multiplier = number((e.target as HTMLInputElement).value, 0.5, 2);
    const initial = [13, 12, 11, 14, 20, 30, 42];
    const spline = {
      ...s.spline,
      points: s.spline.points.map((p, i) => ({ ...p, widthM: (initial[i] ?? 12) * multiplier })),
    };
    const editor = bodyEditors.get(b.handle);
    if (!editor) throw new Error('River editor unavailable');
    editor({ ...s, spline });
  };
  const panel = node('controls-panel');
  const advanced = node('advanced');
  const group = (title: string, nodes: HTMLElement[], open = false) => {
    const details = document.createElement('details');
    details.className = 'water-dimension';
    details.open = open;
    const summary = document.createElement('summary');
    summary.textContent = title;
    const body = document.createElement('div');
    body.className = 'dimension-body';
    body.append(...nodes);
    details.append(summary, body);
    panel.insertBefore(details, advanced);
    return details;
  };
  group('水色与风浪', [node('dimension-sea'), node('dimension-waves')], true);
  group('画质', [node('dimension-mesh')]);
  group('高级 · 场景、地形与查询', [
    node('dimension-water'),
    node('dimension-lifecycle'),
    node('dimension-query'),
    node('query-facts'),
  ]);
  dimension('dimension-view', '镜头与日光', [
    field(
      'fov',
      '视场角',
      47,
      (v) => world.set(camera, Camera, { fov: (number(v, 30, 90) * Math.PI) / 180 }).unwrap(),
      () => (world.get(camera, Camera).unwrap().fov * 180) / Math.PI,
      { min: 30, max: 90, slider: true, unit: '°' },
    ),
    field(
      'exposure',
      '曝光',
      1,
      (v) => world.set(camera, Camera, { exposure: number(v, 0.3, 2) }).unwrap(),
      () => world.get(camera, Camera).unwrap().exposure,
      { min: 0.3, max: 2, slider: true },
    ),
    field(
      'sun',
      '日光强度',
      2.1,
      (v) => world.set(sun, DirectionalLight, { intensity: number(v, 0.1, 5) }).unwrap(),
      () => world.get(sun, DirectionalLight).unwrap().intensity,
      { min: 0.1, max: 5, slider: true },
    ),
  ]);
  group('相机与日光', [node('dimension-view')]);
  stageRuntimePanel(app, node('advanced'), 'R0–R2');
  node('panel-toggle').onclick = () => document.body.classList.toggle('panel-hidden');
  let completedFrames = 0,
    last = 0;
  const errors: unknown[] = [];
  let query: unknown;
  const readState = () => ({
    completedFrames,
    activeView,
    query,
    largeWorldWave: (() => {
      const cooked = cookGerstnerWaveSet(assets.read(spectrum).unwrap()).unwrap();
      const input = {
        waves: cooked.waves,
        positionXZ: [
          WATER_WAVE_LWC_TILE_LENGTH_M * 3 + 0.2,
          WATER_WAVE_LWC_TILE_LENGTH_M - 0.2,
        ] as const,
        timeSeconds: world.getResource(Time).elapsed,
        depthM: 5,
        depthMaskM: cooked.depthMaskM,
      };
      return {
        positionXZ: input.positionXZ,
        full: evaluateGerstnerWavesCpuFull(input),
        simple: evaluateGerstnerWavesCpuSimple(input),
      };
    })(),
    bodies: water().snapshots(),
    zones: water().zoneSnapshots(),
    ground: water().zoneGroundSnapshot(g('zone/main')),
    mesh: waterSceneMeshView(world, g('zone/main'), `camera:${camera}`),
    probes: probes.map((entity) => ({
      entity,
      dynamics: world
        .getResource<PhysicsWorld>(PhysicsWorldResource)
        .getCommittedBodyDynamics?.(entity),
    })),
    geometry: bodies.map((b) => ({ key: b.key, asset: assets.read(b.handle).unwrap() })),
    scene: Array.from(world.query({ read: [WaterBodyInstance] }).unwrap()).length,
  });
  app.renderer.subscribe((event) => {
    if (event.kind === 'error') {
      errors.push(event.error);
      node('status').textContent = event.error.code;
    }
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed.then((r) => {
      if (!r.ok || event.receipt.presentation !== 'ready') return;
      completedFrames++;
      if (performance.now() - last < 250) return;
      last = performance.now();
      refreshRuntimeForms(forms);
      const b = bodies[queryBody];
      const snapshot = b && water().snapshot(`scene-entity:${b.entity}`);
      if (!snapshot) query = undefined;
      if (snapshot) {
        const flags =
          WaterQueryFlags.ComputeLocation |
          (querySettings.depth ? WaterQueryFlags.ComputeDepth : 0) |
          (querySettings.normal ? WaterQueryFlags.ComputeNormal : 0) |
          (querySettings.velocity ? WaterQueryFlags.ComputeVelocity : 0) |
          (querySettings.waves ? WaterQueryFlags.IncludeWaves : 0) |
          (querySettings.simple ? WaterQueryFlags.SimpleWaves : 0) |
          (querySettings.ignoreExclusion ? WaterQueryFlags.IgnoreExclusionVolumes : 0);
        query = water().queryBody(snapshot.guid, {
          positionM: [querySettings.x, querySettings.y, querySettings.z],
          timeSeconds: world.getResource(Time).elapsed,
          expectedBodyGeneration: snapshot.sceneGeneration,
          flags,
        });
      }
      node('render-state').textContent = `${completedFrames} 完成帧`;
      node('status').textContent =
        '同一 World · ' +
        water()
          .snapshots()
          .filter((b) => b.binding.kind === 'bound').length +
        ' 个已绑定水体';
      if ((node('query-facts') as HTMLDetailsElement).open)
        node('query-output').textContent = JSON.stringify(
          {
            query,
            fixture: { enabled: fixtureEnabled, kind: 'authored-query-grid-fixture-not-gpu-bake' },
            waterInfo: {
              ground: water().zoneGroundSnapshot(g('zone/main')),
              accepted: app.renderer.inspect().waterGraph?.waterInfo,
            },
            largeWorldWave: readState().largeWorldWave,
          },
          (_, v) => (v instanceof Set ? [...v] : v),
          2,
        );
    });
  });
  setView('overview');
  Object.assign(window, {
    __waterR012: {
      app,
      world,
      assets,
      zone,
      zoneEntity,
      ground,
      bodies,
      probes,
      camera,
      setView,
      readState,
      errors,
    },
    __waterR2: { app, world, assets, bodies, camera, readState },
  });
  app.start().unwrap();
  checkpoint('app-started');
  window.addEventListener('resize', () =>
    world.set(camera, Camera, { aspect: canvas.clientWidth / canvas.clientHeight }).unwrap(),
  );
  window.addEventListener('beforeunload', () => void app.dispose());
}
void main().catch((e) => {
  node('status').textContent = JSON.stringify(e, Object.getOwnPropertyNames(e ?? {}), 2);
  console.error(
    '[watershed-startup-failed]',
    JSON.stringify(e, (_key, value) =>
      value instanceof Error ? { ...value, name: value.name, message: value.message } : value,
    ),
  );
  console.error(e);
});
