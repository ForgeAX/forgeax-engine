import { defineSystem } from '@forgeax/engine/ecs';
import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { Update } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { mat4, quat, ray } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine/render';
import { waterSceneZoneGround, waterSceneZoneSnapshot } from '@forgeax/engine/runtime';
import {
  Transform,
  WaterBodyInstance,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import type { AssetHandle, WaterBodyAsset, WaterZoneAsset } from '@forgeax/engine/types';
import type { WaterSystem } from '@forgeax/engine/water';
import { waterInfoWorldToUv } from '@forgeax/engine/water';
import { dressWaterStage, stageRuntimePanel } from '../../presentation';
import { requireDemoValue } from '../../runtime-input';
import { waterStageNavigation } from '../../stage-catalog';
import { WATER_INFO_DEMO_PACKAGE } from './identity';
import './style.css';

const $ = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const canvas = $('#scene') as HTMLCanvasElement;
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
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_INFO_DEMO_PACKAGE, key));
  const zoneGuid = guid('zone/main');
  const zoneHandle = (await assets.load(zoneGuid, 'water-zone')).unwrap();
  const zoneAsset = assets.read(zoneHandle).unwrap() as WaterZoneAsset;
  const zoneEntity = world
    .spawn(
      { component: Transform, data: { pos: [32, 0, 32] } },
      { component: WaterZoneInstance, data: { zone: zoneHandle } },
    )
    .unwrap();
  const bodyHandle = (await assets.load(guid('body/river'), 'water-body')).unwrap();
  const bodyAsset = assets.read(bodyHandle).unwrap() as WaterBodyAsset;
  const waterOffExperiment = new URLSearchParams(location.search).has('water-off-experiment');
  const bodyEntity = waterOffExperiment
    ? undefined
    : world
        .spawn(
          { component: Transform, data: { pos: [32, 0, 32] } },
          { component: WaterBodyInstance, data: { body: bodyHandle } },
        )
        .unwrap();
  const terrainSourceKeys = ['terrain/planned-a/terrain', 'terrain/planned-b/terrain'] as const;
  const terrainHandles = (await Promise.all(
    terrainSourceKeys.map(async (sourceKey) =>
      (await assets.load(guid(sourceKey), 'terrain')).unwrap(),
    ),
  )) as [AssetHandle<'terrain'>, AssetHandle<'terrain'>];
  const terrainOffExperiment = new URLSearchParams(location.search).has('terrain-off-experiment');
  const terrainEntity = terrainOffExperiment
    ? undefined
    : world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0] } },
          { component: Terrain, data: { asset: terrainHandles[0], lod0Diameter: 0.45 } },
          { component: WaterTerrainProvider, data: { terrain: terrainHandles[0] } },
        )
        .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -0.9, -0.4],
        color: [1, 1, 1],
        intensity: 2,
        castShadow: true,
        mapSize: 1024,
      },
    })
    .unwrap();
  const eye: [number, number, number] = [66, 58, 76];
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [32, 0.3, 32], [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: 0.92,
            aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
            near: 0.1,
            far: 260,
          }),
          clearColor: [0.78, 0.86, 0.83, 1],
        },
      },
    )
    .unwrap();
  const probeColumnMesh = assets.create(createBoxGeometry(0.09, 1, 0.09).unwrap()).unwrap();
  const probeMarkerMesh = assets.create(createBoxGeometry(0.56, 0.56, 0.56).unwrap()).unwrap();
  const probeMaterial = assets.create(Materials.unlit('#f0bc49')).unwrap();
  const probeColumn = world
    .spawn(
      { component: Transform, data: { pos: [32, 2.75, 32], scale: [1, 5.5, 1] } },
      { component: MeshFilter, data: { assetHandle: probeColumnMesh } },
      { component: MeshRenderer, data: { materials: [probeMaterial] } },
    )
    .unwrap();
  const probeMarker = world
    .spawn(
      { component: Transform, data: { pos: [32, 5.65, 32] } },
      { component: MeshFilter, data: { assetHandle: probeMarkerMesh } },
      { component: MeshRenderer, data: { materials: [probeMaterial] } },
    )
    .unwrap();
  let format: 'rgba16f' | 'rgba32f' = 'rgba16f';
  let terrainIndex = 0;
  let probeXZ: readonly [number, number] = [32, 32];
  let receiptState = '等待首帧';
  const moveProbeMarker = () => {
    world
      .set(probeColumn, Transform, { pos: [probeXZ[0], 2.75, probeXZ[1]], scale: [1, 5.5, 1] })
      .unwrap();
    world
      .set(probeMarker, Transform, { pos: [probeXZ[0], 5.65, probeXZ[1]], scale: [1, 1, 1] })
      .unwrap();
  };
  const applyZone = () => {
    const resolutionPx = Number(($('#resolution') as HTMLSelectElement).value);
    const blurRadius = Number(($('#blur') as HTMLInputElement).value);
    const localTessellation = ($('#local') as HTMLInputElement).checked;
    const next: WaterZoneAsset = {
      ...zoneAsset,
      waterInfo: {
        resolution: { widthPx: resolutionPx, heightPx: resolutionPx },
        format,
        blurRadius,
        localTessellation,
      },
    };
    const result = assets.replace(zoneHandle, next);
    if (!result.ok) {
      $('#status').textContent = `${result.error.code}: ${result.error.expected}`;
      return;
    }
    $('#blur-value').textContent = `${blurRadius} px`;
    receiptState = '等待更新帧';
    world.update(1 / 60).unwrap();
    refresh();
  };
  const refresh = () => {
    const zone = waterSceneZoneSnapshot(world, zoneGuid);
    if (!zone) return;
    const groundResult = waterSceneZoneGround(world, zoneGuid);
    const ground = groundResult.ok ? groundResult.value : undefined;
    $('#ground').textContent = ground?.providers.length
      ? `${ground.providers.length} 个地形 · G${ground.generation}${ground.dirty ? ' · 待采集' : ''}`
      : '无提供者';
    $('#generation').textContent =
      `区域 G${zone.generation} · ${format} · ${zone.asset.waterInfo.resolution.widthPx}px`;
    const bodySnapshot = world
      .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
      .snapshots()
      .find((snapshot) => snapshot.sourceAssetGuid === guid('body/river'));
    const capture = bodySnapshot?.outputReceipts.waterInfo;
    $('#capture').textContent = capture
      ? `已接纳 G${capture.consumerGeneration} · 水体 G${capture.outputGeneration}`
      : '等待采集';
    $('#passes').textContent = receiptState;
    $('#digest').textContent = bodyAsset.waterInfoMeshGuid
      ? bodyAsset.waterInfoMeshGuid.slice(0, 18)
      : '无源网格';
    $('#slice').textContent = zone.asset.waterInfo.localTessellation
      ? `局部视图 · 对齐 ${zone.asset.tileSizeM}m`
      : '区域共享视图';
    const uv = waterInfoWorldToUv({ centerXZ: [32, 32], extentXZ: [64, 64] }, probeXZ);
    const x = Math.min(
      zone.asset.waterInfo.resolution.widthPx - 1,
      Math.floor(uv[0] * zone.asset.waterInfo.resolution.widthPx),
    );
    const y = Math.min(
      zone.asset.waterInfo.resolution.heightPx - 1,
      Math.floor(uv[1] * zone.asset.waterInfo.resolution.heightPx),
    );
    $('#probe-uv').textContent = `U ${uv[0].toFixed(3)} · V ${uv[1].toFixed(3)}`;
    $('#probe-texel').textContent = `${x}, ${y}`;
    $('#probe-state').textContent =
      `世界坐标 ${probeXZ[0].toFixed(1)}, ${probeXZ[1].toFixed(1)} m · 纹素 ${x}, ${y}`;
    $('#status').textContent =
      `${capture ? '采集已提交' : '等待采集'} · 地形 ${ground?.generation ?? '待接入'} · ${format} · 模糊 ${zone.asset.waterInfo.blurRadius}px`;
    $('#render-state').textContent = receiptState;
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-format]'))
    button.addEventListener('click', () => {
      format = button.dataset.format === 'rgba32f' ? 'rgba32f' : 'rgba16f';
      for (const option of document.querySelectorAll<HTMLButtonElement>('button[data-format]'))
        option.setAttribute('aria-pressed', String(option === button));
      applyZone();
    });
  $('#resolution').addEventListener('change', applyZone);
  $('#blur').addEventListener('input', applyZone);
  $('#local').addEventListener('change', applyZone);
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-terrain]'))
    button.addEventListener('click', () => {
      if (terrainEntity === undefined) return;
      terrainIndex = button.dataset.terrain === 'b' ? 1 : 0;
      const handle = requireDemoValue(
        terrainHandles[terrainIndex],
        'accepted authored scene member',
      );
      world.set(terrainEntity, Terrain, { asset: handle }).unwrap();
      world.set(terrainEntity, WaterTerrainProvider, { terrain: handle }).unwrap();
      for (const option of document.querySelectorAll<HTMLButtonElement>('button[data-terrain]'))
        option.setAttribute('aria-pressed', String(option === button));
      receiptState = '等待更新帧';
      world.update(1 / 60).unwrap();
      refresh();
    });
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    const screenRay = ray.screenToRay(
      ray.create(new Float32Array(6)),
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
      mat4.lookAt(mat4.create(), eye, [32, 0.3, 32], [0, 1, 0]),
      mat4.perspective(mat4.create(), 0.92, rect.width / Math.max(1, rect.height), 0.1, 260),
    );
    const dy = requireDemoValue(screenRay[4], 'accepted authored scene member');
    const hitDistance =
      Math.abs(dy) < 1e-6
        ? -1
        : (0 - requireDemoValue(screenRay[1], 'accepted authored scene member')) / dy;
    if (hitDistance < 0) {
      $('#probe-state').textContent = '探针未落在地面';
      return;
    }
    probeXZ = [
      requireDemoValue(screenRay[0], 'accepted authored scene member') +
        requireDemoValue(screenRay[3], 'accepted authored scene member') * hitDistance,
      requireDemoValue(screenRay[2], 'accepted authored scene member') +
        requireDemoValue(screenRay[5], 'accepted authored scene member') * hitDistance,
    ];
    receiptState = '等待探针更新帧';
    moveProbeMarker();
    refresh();
  });
  $('#panel-toggle').addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const shown = !document.body.classList.toggle('panel-hidden');
    button.setAttribute('aria-expanded', String(shown));
    button.title = shown ? '隐藏面板' : '显示面板';
  });
  world
    .addSystem(Update, defineSystem({ name: 'water-info-demo-readout', queries: [], fn: refresh }))
    .unwrap();
  app.renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted')
      void event.receipt.completed.then((result) => {
        if (result.ok) {
          if (event.receipt.presentation !== 'ready') return;
          receiptState = `第 ${event.frameId} 帧已提交`;
          refresh();
        } else {
          receiptState = '提交失败';
          $('#render-state').textContent = receiptState;
          $('#status').textContent = result.error.code;
        }
      });
    else if (event.kind === 'error') {
      receiptState = '渲染错误';
      $('#render-state').textContent = receiptState;
      $('#status').textContent = event.error.code;
    }
  });
  if (new URLSearchParams(location.search).has('visual-smoke')) {
    const errors: unknown[] = [];
    app.renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const readWaterState = () => {
      const groundResult = waterSceneZoneGround(world, zoneGuid);
      return {
        zone: waterSceneZoneSnapshot(world, zoneGuid),
        ground: groundResult.ok ? groundResult.value : undefined,
        probe: { worldXZ: [...probeXZ], markerY: 5.65 },
        view: { eye: [...eye], target: [32, 0.3, 32], fov: 0.92 },
        bodies: world
          .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
          .snapshots()
          .map((snapshot) => ({
            guid: snapshot.guid,
            sourceAssetGuid: snapshot.sourceAssetGuid,
            sceneGeneration: snapshot.sceneGeneration,
            sourceVersion: snapshot.sourceVersion,
            binding: snapshot.binding,
            dirty: [...snapshot.dirty],
            outputs: snapshot.outputs,
            outputGenerations: snapshot.outputGenerations,
            outputReceipts: snapshot.outputReceipts,
            dependencies: snapshot.dependencies.map(
              ({ guid: dependencyGuid, kind, field, status, actualKind }) => ({
                guid: dependencyGuid,
                kind,
                field,
                status,
                actualKind,
              }),
            ),
            body: {
              type: snapshot.asset.type,
              waterInfoMeshGuid: snapshot.asset.waterInfoMeshGuid,
              visibleMeshGuid: snapshot.asset.visibleMeshGuid,
              riverSegmentMeshGuids: snapshot.asset.riverSegmentMeshGuids,
              flags: snapshot.asset.flags,
            },
          })),
      };
    };
    Object.assign(window, {
      __waterInfoVisualDebug: {
        app,
        world,
        zoneGuid,
        zoneEntity,
        bodyEntity,
        bodyAsset,
        terrainHandles,
        terrainEntity,
        camera,
        errors,
        readWaterState,
      },
    });
  }
  window.addEventListener('resize', () => {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    world.set(camera, Camera, { aspect, fov: 0.92 }).unwrap();
  });
  window.addEventListener('beforeunload', () => {
    void app.dispose();
  });
  moveProbeMarker();
  await dressWaterStage(app, [32, 0, 32], 1.2);
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
  world.update(1 / 60).unwrap();
  refresh();
};
main().catch((error) => {
  $('#render-state').textContent = '启动失败';
  $('#status').textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
});
