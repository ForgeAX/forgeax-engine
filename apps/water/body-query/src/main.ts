import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { Time } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine/render';
import {
  Transform,
  WaterBodyInstance,
  WaterExclusionMode,
  WaterExclusionVolume,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import type { AssetHandle } from '@forgeax/engine/types';
import {
  type WaterQueryField,
  WaterQueryFlags,
  type WaterQueryResult,
  type WaterQuerySource,
  type WaterSystem,
} from '@forgeax/engine/water';
import { dressWaterStage, stageRuntimePanel } from '../../presentation';
import { requireDemoValue } from '../../runtime-input';
import { waterStageNavigation } from '../../stage-catalog';
import { BODY_QUERY_PACKAGE_NAMESPACE } from './identity';
import './style.css';

function startupFailureDetails(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const source = value as {
    name?: string;
    message?: string;
    code?: string;
    expected?: string;
    hint?: string;
    detail?: unknown;
    cause?: unknown;
  };
  return {
    name: source.name,
    message: source.message,
    code: source.code,
    expected: source.expected,
    hint: source.hint,
    detail: source.detail,
    ...(depth < 5 && source.cause !== undefined
      ? { cause: startupFailureDetails(source.cause, seen, depth + 1) }
      : {}),
  };
}

const element = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const canvas = element<HTMLCanvasElement>('#scene');
const resize = () => {
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
};
resize();

const main = async () => {
  const app = (
    await createApp(
      canvas,
      { ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}) },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    )
  ).unwrap();
  const assets = app.assets;
  if (!assets) throw new Error('App asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;
  const assetGuid = (key: string) =>
    AssetGuid.format(AssetGuid.derive(BODY_QUERY_PACKAGE_NAMESPACE, key));
  const zoneHandles = {
    lower: (await assets.load(assetGuid('zone/lower'), 'water-zone')).unwrap(),
    upper: (await assets.load(assetGuid('zone/upper'), 'water-zone')).unwrap(),
  };
  const terrainHandle = (await assets.load(assetGuid('terrain/terrain'), 'terrain')).unwrap();
  const entries = await Promise.all(
    (['lower', 'upper'] as const).map(async (key) => {
      const sourceKey = key === 'lower' ? 'body/lower-lake' : 'body/upper-ocean';
      const handle: AssetHandle<'water-body'> = (
        await assets.load(assetGuid(sourceKey), 'water-body')
      ).unwrap();
      const centerX = key === 'lower' ? 0 : 40;
      const baseY = key === 'lower' ? 0 : 4;
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [centerX, baseY, 0] } },
          { component: WaterBodyInstance, data: { body: handle } },
        )
        .unwrap();
      return { key, entity, centerX, baseY };
    }),
  );
  const zoneEntities = {
    lower: world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0] } },
        { component: WaterZoneInstance, data: { zone: zoneHandles.lower } },
      )
      .unwrap(),
    upper: world
      .spawn(
        { component: Transform, data: { pos: [40, 4, 0] } },
        { component: WaterZoneInstance, data: { zone: zoneHandles.upper } },
      )
      .unwrap(),
  };
  const terrainEntity = world
    .spawn(
      { component: Transform, data: { pos: [-24, 0, -24] } },
      { component: Terrain, data: { asset: terrainHandle, lod0Diameter: 0.4 } },
      { component: WaterTerrainProvider, data: { terrain: terrainHandle } },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -0.85, -0.35],
        color: [1, 0.98, 0.92],
        intensity: 2.4,
        castShadow: true,
      },
    })
    .unwrap();
  const markerColumnMesh = assets.create(createBoxGeometry(0.18, 1, 0.18).unwrap()).unwrap();
  const probeMarkerMesh = assets.create(createBoxGeometry(0.72, 0.72, 0.72).unwrap()).unwrap();
  const lowerMarkerMaterial = assets.create(Materials.unlit('#f0bc49')).unwrap();
  const upperMarkerMaterial = assets.create(Materials.unlit('#e25c54')).unwrap();
  const sourceMarkerMaterials: Record<WaterQuerySource, AssetHandle<'material'>> = {
    plane: assets.create(Materials.unlit('#748b82')).unwrap(),
    terrain: assets.create(Materials.unlit('#247c73')).unwrap(),
    spline: assets.create(Materials.unlit('#a17627')).unwrap(),
    baked: assets.create(Materials.unlit('#3979a8')).unwrap(),
    exclusion: assets.create(Materials.unlit('#bb4d50')).unwrap(),
  };
  const depthMarker = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0], scale: [1, 0.04, 1] } },
      { component: MeshFilter, data: { assetHandle: markerColumnMesh } },
      { component: MeshRenderer, data: { materials: [sourceMarkerMaterials.plane] } },
    )
    .unwrap();
  const probeMarker = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: probeMarkerMesh } },
      { component: MeshRenderer, data: { materials: [lowerMarkerMaterial] } },
    )
    .unwrap();
  const beaconColumn = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0], scale: [1, 0.04, 1] } },
      { component: MeshFilter, data: { assetHandle: markerColumnMesh } },
      { component: MeshRenderer, data: { materials: [lowerMarkerMaterial] } },
    )
    .unwrap();
  const beaconMarker = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: probeMarkerMesh } },
      { component: MeshRenderer, data: { materials: [lowerMarkerMaterial] } },
    )
    .unwrap();
  const eye: [number, number, number] = [18, 45, 74];
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [18, 1.5, 0], [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: 0.86, aspect: canvas.width / canvas.height, near: 0.1, far: 220 }),
          clearColor: [0.84, 0.91, 0.88, 1],
        },
      },
    )
    .unwrap();

  const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const keys = {
    lower: `scene-entity:${requireDemoValue(entries[0], 'accepted authored scene member').entity}`,
    upper: `scene-entity:${requireDemoValue(entries[1], 'accepted authored scene member').entity}`,
  };
  const terrainToggle = element<HTMLInputElement>('#terrain-toggle');
  const exclusionToggle = element<HTMLInputElement>('#exclusion-toggle');
  const bakedToggle = element<HTMLInputElement>('#baked-toggle');
  let bakedEnabledApplied = false;
  const exclusionEntity = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap();
  const bakedSamples = new Float32Array(5 * 5 * 4);
  for (let index = 0; index < 25; index++) {
    bakedSamples[index * 4] = 0.35;
    bakedSamples[index * 4 + 1] = 3.4;
    bakedSamples[index * 4 + 2] = 0.6;
    bakedSamples[index * 4 + 3] = -0.2;
  }
  const publishBaked = (entry: (typeof entries)[number]) => {
    const snapshot = water.snapshot(keys[entry.key]);
    if (!snapshot) return '等待当前水体快照';
    if (water.bakedQueryGrid(keys[entry.key], snapshot.sceneGeneration)) return undefined;
    const grid = {
      originXZ: [entry.centerX - 2, -2] as const,
      originY: entry.baseY,
      spacingXZ: [1, 1] as const,
      width: 5,
      height: 5,
      samples: bakedSamples,
    };
    const result = water.publishBakedQueryGrid(keys[entry.key], snapshot.sceneGeneration, {
      kind: 'live-capture',
      enabled: true,
      componentValid: true,
      dataValid: true,
      grid,
    });
    return result.ok ? undefined : `${result.error.code} · ${result.error.expected}`;
  };
  const clearBaked = (entry: (typeof entries)[number]) => {
    const snapshot = water.snapshot(keys[entry.key]);
    if (!snapshot) return '等待当前水体快照';
    const result = water.clearBakedQueryGrid(keys[entry.key], snapshot.sceneGeneration);
    return result.ok ? undefined : `${result.error.code} · ${result.error.expected}`;
  };
  const syncBakedSources = () => {
    const enabled = bakedToggle.checked;
    for (const entry of entries) {
      const failure = enabled
        ? publishBaked(entry)
        : bakedEnabledApplied
          ? clearBaked(entry)
          : undefined;
      if (failure !== undefined) return `预烘焙查询数据：${failure}`;
    }
    bakedEnabledApplied = enabled;
    return undefined;
  };
  let exclusionActive = false;
  const applyExclusion = () => {
    if (exclusionToggle.checked && !exclusionActive) {
      world
        .addComponent(exclusionEntity, {
          component: WaterExclusionVolume,
          data: {
            mode: WaterExclusionMode.addListedBodiesToExclusion,
            waterBodies: [requireDemoValue(entries[0], 'accepted authored scene member').entity],
            centerM: [0, 0, 0],
            halfExtentsM: [2, 2, 2],
          },
        })
        .unwrap();
      exclusionActive = true;
    }
    if (!exclusionToggle.checked && exclusionActive) {
      world.removeComponent(exclusionEntity, WaterExclusionVolume).unwrap();
      exclusionActive = false;
    }
  };
  const point = element<HTMLSelectElement>('#point');
  const selectedBody = element<HTMLSelectElement>('#body');
  const depth = element<HTMLInputElement>('#probe-depth');
  const applyCamera = () => {
    const mobile = canvas.clientWidth <= 600;
    const focusX = mobile ? (selectedBody.value === 'upper' ? 40 : 0) : 18;
    const eye: [number, number, number] = mobile ? [focusX, 50, 95] : [18, 45, 74];
    const target: [number, number, number] = [focusX, mobile ? 22 : 1.5, 0];
    world
      .set(cameraEntity, Transform, {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]),
      })
      .unwrap();
  };
  const flagInputs = [...document.querySelectorAll<HTMLInputElement>('[data-flag]')];
  const fieldFlags = {
    location: WaterQueryFlags.ComputeLocation,
    normal: WaterQueryFlags.ComputeNormal,
    depth: WaterQueryFlags.ComputeDepth,
    immersion: WaterQueryFlags.ComputeImmersionDepth,
    velocity: WaterQueryFlags.ComputeVelocity,
    waves: WaterQueryFlags.IncludeWaves,
    simple: WaterQueryFlags.SimpleWaves,
    ignore: WaterQueryFlags.IgnoreExclusionVolumes,
  } as const;
  const sourceLabels: Record<WaterQuerySource, string> = {
    plane: '平面',
    terrain: '地形',
    spline: '样条',
    baked: '预烘焙',
    exclusion: '排除区',
  };
  const fieldLabels: Record<WaterQueryField, string> = {
    location: '位置',
    normal: '法线',
    depth: '水深',
    immersion: '浸没',
    velocity: '流速',
    waves: '波浪',
  };
  const formatVec = (value: readonly number[] | undefined) =>
    value?.map((v) => v.toFixed(2)).join(', ') ?? '未请求';
  const updateMarkers = (
    entry: (typeof entries)[number],
    positionM: readonly [number, number, number],
    sample?: WaterQueryResult,
  ) => {
    const bodyMaterial = entry.key === 'upper' ? upperMarkerMaterial : lowerMarkerMaterial;
    const surfaceY = sample?.surfaceM?.[1] ?? sample?.locationM?.[1] ?? positionM[1];
    const depthM = sample?.depthM ?? 0;
    const markerHeight = sample?.depthM === undefined ? 0.04 : Math.max(depthM, 0.04);
    const markerY = sample?.surfaceM === undefined ? positionM[1] : surfaceY - depthM * 0.5;
    const beaconY = Math.max(surfaceY, positionM[1]) + 1.6;
    world.set(probeMarker, Transform, { pos: [...positionM], scale: [1, 1, 1] }).unwrap();
    world.set(probeMarker, MeshRenderer, { materials: [bodyMaterial] }).unwrap();
    world
      .set(beaconColumn, Transform, {
        pos: [positionM[0], (beaconY + positionM[1]) * 0.5, positionM[2]],
        scale: [1, beaconY - positionM[1], 1],
      })
      .unwrap();
    world.set(beaconColumn, MeshRenderer, { materials: [bodyMaterial] }).unwrap();
    world
      .set(beaconMarker, Transform, {
        pos: [positionM[0], beaconY, positionM[2]],
        scale: [1, 1, 1],
      })
      .unwrap();
    world.set(beaconMarker, MeshRenderer, { materials: [bodyMaterial] }).unwrap();
    world
      .set(depthMarker, Transform, {
        pos: [positionM[0], markerY, positionM[2]],
        scale: [1, markerHeight, 1],
      })
      .unwrap();
    world
      .set(depthMarker, MeshRenderer, {
        materials: [sourceMarkerMaterials[sample?.source ?? 'plane']],
      })
      .unwrap();
  };
  const update = () => {
    const entry = requireDemoValue(
      entries[selectedBody.value === 'upper' ? 1 : 0],
      'accepted authored scene member',
    );
    const x = entry.centerX + (point.value === 'edge' ? 2 : 0);
    const positionM: [number, number, number] = [x, entry.baseY - Number(depth.value), 0];
    const requested = flagInputs.reduce(
      (flags, input) =>
        input.checked ? flags | fieldFlags[input.dataset.flag as keyof typeof fieldFlags] : flags,
      0,
    );
    element('#probe-value').textContent = `${Number(depth.value).toFixed(2)} m`;
    element('#requested').textContent = `0x${requested.toString(16)}`;
    element('#query-position').textContent = `${formatVec(positionM)} m`;
    const currentSnapshot = water.snapshot(keys[entry.key]);
    if (!currentSnapshot) {
      element('#trace').textContent = '等待当前水体快照';
      updateMarkers(entry, positionM);
      return;
    }
    const timeSeconds = world.getResource(Time).elapsed;
    const result = water.queryBody(keys[entry.key], {
      positionM,
      flags: requested,
      timeSeconds,
      expectedBodyGeneration: currentSnapshot.sceneGeneration,
    });
    if (!result.ok) {
      element('#trace').textContent =
        `查询失败：${result.error.code} · ${result.error.expected} · ${result.error.hint}`;
      element('#source').textContent = '错误';
      element('#valid').textContent = '无';
      element('#provider').textContent = terrainToggle.checked ? '未采样' : '关闭';
      element('#surface-height').textContent = '—';
      element('#water-depth').textContent = '—';
      element('#immersion').textContent = '—';
      element('#status').textContent = `查询不可用 · ${result.error.code}`;
      updateMarkers(entry, positionM);
      return;
    }
    const sample = result.value;
    updateMarkers(entry, positionM, sample);
    element('#body-guid').textContent = currentSnapshot.sourceAssetGuid ?? sample.bodyGuid;
    element('#generation').textContent = String(sample.bodyGeneration);
    element('#source').textContent = sourceLabels[sample.source];
    element('#surface-height').textContent = sample.surfaceM
      ? `${sample.surfaceM[1].toFixed(2)} m`
      : '未请求';
    element('#water-depth').textContent =
      sample.depthM === undefined ? '未请求' : `${sample.depthM.toFixed(2)} m`;
    element('#immersion').textContent =
      sample.immersionM === undefined ? '未请求' : `${sample.immersionM.toFixed(2)} m`;
    element('#provider').textContent = sample.terrainSample
      ? `${sample.terrainSample.heightM.toFixed(2)} m`
      : terrainToggle.checked
        ? '未采样'
        : '关闭';
    element('#adjusted').textContent = `0x${sample.adjustedFlags.toString(16)}`;
    element('#location').textContent =
      `${formatVec(sample.locationM)} / ${formatVec(sample.surfaceM)}`;
    element('#normal').textContent =
      `${formatVec(sample.normalYUp)} / ${sample.depthM?.toFixed(2) ?? '未请求'} m`;
    element('#motion').textContent =
      `${sample.immersionM?.toFixed(2) ?? '未请求'} / ${formatVec(sample.velocityMPerSec)}`;
    element('#valid').textContent =
      [...sample.valid].map((field) => fieldLabels[field]).join('、') || '无';
    element('#trace').textContent =
      `水体 ${sample.bodyGuid} · 代次 ${sample.bodyGeneration} · 引擎时间 ${timeSeconds.toFixed(3)} s · ${sample.excluded ? '已排除' : '有效'} · 来源 ${sourceLabels[sample.source]}${sample.terrainSample ? ` · 地形 ${sample.terrainSample.heightM.toFixed(2)} m` : ''}${sample.waveInfo ? ` · 波高 ${sample.waveInfo.heightM.toFixed(3)} m` : ''}`;
    element('#status').textContent =
      `${entry.key === 'lower' ? '左侧湖泊' : '右侧海面'} · ${sourceLabels[sample.source]}结果 · ${sample.valid.size} 个可读字段 · ${sample.excluded ? '已排除' : '有效'}`;
  };
  selectedBody.addEventListener('change', () => {
    applyCamera();
    update();
  });
  point.addEventListener('change', update);
  depth.addEventListener('input', update);
  for (const input of flagInputs) input.addEventListener('change', update);
  terrainToggle.addEventListener('change', () => {
    if (terrainToggle.checked && world.hasComponent(terrainEntity, WaterTerrainProvider))
      world.set(terrainEntity, WaterTerrainProvider, { terrain: terrainHandle }).unwrap();
    else if (terrainToggle.checked)
      world
        .addComponent(terrainEntity, {
          component: WaterTerrainProvider,
          data: { terrain: terrainHandle },
        })
        .unwrap();
    else if (world.hasComponent(terrainEntity, WaterTerrainProvider))
      world.removeComponent(terrainEntity, WaterTerrainProvider).unwrap();
    update();
  });
  exclusionToggle.addEventListener('change', () => {
    applyExclusion();
    update();
  });
  bakedToggle.addEventListener('change', () => {
    element('#status').textContent = bakedToggle.checked
      ? '正在接入预烘焙查询数据'
      : '正在清除预烘焙查询数据';
  });
  element('#render-state').textContent = '引擎运行中';
  element('#status').textContent = '等待首个水体查询';
  document.documentElement.dataset.ready = 'true';
  let submittedFrames = 0;
  const rendererErrors: unknown[] = [];
  app.renderer.subscribe((event) => {
    if (event.kind === 'error') {
      const error = event.error as unknown as {
        code?: string;
        message?: string;
        expected?: string;
        hint?: string;
        detail?: unknown;
      };
      rendererErrors.push({
        code: error.code,
        message: error.message,
        expected: error.expected,
        hint: error.hint,
        detail: error.detail,
      });
      document.body.dataset.rendererErrorCount = String(rendererErrors.length);
      element('#render-state').textContent = `渲染错误：${event.error.code}`;
      return;
    }
    if (event.kind !== 'frame-submitted') return;
    void event.receipt.completed.then((result) => {
      if (!result.ok || event.receipt.presentation !== 'ready') return;
      submittedFrames++;
      element('#render-state').textContent = `第 ${submittedFrames} 帧已提交`;
      const bakedFailure =
        bakedToggle.checked || bakedEnabledApplied ? syncBakedSources() : undefined;
      update();
      if (bakedFailure) element('#status').textContent = bakedFailure;
    });
  });
  window.addEventListener('resize', () => {
    resize();
    world.set(cameraEntity, Camera, { aspect: canvas.width / canvas.height }).unwrap();
    applyCamera();
  });
  if (new URLSearchParams(location.search).has('smoke'))
    Object.assign(window, {
      __waterBodyQueryDemo: {
        app,
        world,
        water,
        keys,
        entries,
        zoneEntities,
        terrainEntity,
        exclusionEntity,
        rendererErrors,
        query: update,
        probeMarker,
        depthMarker,
        beaconMarker,
      },
    });
  applyCamera();
  await dressWaterStage(app, [18, 0, 0], 1.2);
  stageRuntimePanel(
    app,
    requireDemoValue(
      document.querySelector('main, aside, #controls-panel'),
      'accepted authored scene member',
    ),
    'R2',
  );
  waterStageNavigation('R2');
  app.start().unwrap();
};
void main().catch((error: unknown) => {
  if (new URLSearchParams(location.search).has('smoke'))
    Object.assign(window, { __waterBodyQueryStartupError: startupFailureDetails(error) });
  document.body.dataset.startupError = 'true';
  element('#status').textContent = error instanceof Error ? error.message : String(error);
  element('#render-state').textContent = '启动失败';
});
