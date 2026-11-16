import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createApp } from '@forgeax/engine/app/browser';
import { defineSystem, Update } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine/render';
import {
  waterSceneSnapshot,
  waterSceneWaterInfoGeometry,
  waterSceneZoneGround,
} from '@forgeax/engine/runtime';
import { Terrain } from '@forgeax/engine/terrain';
import {
  Transform,
  WaterBodyInstance,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine/scene';
import type { AssetHandle, WaterBodyAsset } from '@forgeax/engine/types';
import { WATER_TERRAIN_PROVIDER_PACKAGE_NAMESPACE } from './identity';
import './style.css';

type Revision = 'a' | 'b';
const element = <T extends HTMLElement>(selector: string) => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return node;
};
const canvas = element<HTMLCanvasElement>('#scene');
const renderState = element<HTMLElement>('#render-state');
const status = element<HTMLElement>('#status');
const cameraFovForAspect = (aspect: number) =>
  2 * Math.atan(Math.tan(Math.PI / 3.15 / 2) * Math.max(1, 2 / aspect));
const resizeCanvas = () => {
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
};
resizeCanvas();

const main = async () => {
  const app = (
    await createApp(
      canvas,
      {
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
      },
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
    AssetGuid.format(AssetGuid.derive(WATER_TERRAIN_PROVIDER_PACKAGE_NAMESPACE, key));
  const zoneGuid = assetGuid('zone/main');
  const terrainHandles: Record<Revision, AssetHandle<'terrain'>> = {
    a: (await assets.load(assetGuid('terrain/planned-a/terrain'), 'terrain')).unwrap(),
    b: (await assets.load(assetGuid('terrain/planned-b/terrain'), 'terrain')).unwrap(),
  };
  const zoneHandle = (await assets.load(zoneGuid, 'water-zone')).unwrap();
  const bodyGuid = assetGuid('body/river');
  const bodyHandle = (await assets.load(bodyGuid, 'water-body')).unwrap();
  const body = assets.read(bodyHandle).unwrap() as WaterBodyAsset;
  if (!body.waterInfoMeshGuid || !body.dilatedWaterInfoMeshGuid)
    throw new Error('River Pack closure is missing its WaterInfo geometry products');
  const waterInfoMeshes = await Promise.all([
    assets.load(body.waterInfoMeshGuid, 'mesh'),
    assets.load(body.dilatedWaterInfoMeshGuid, 'mesh'),
  ]).then((results) => results.map((result) => result.unwrap()));
  const surfaceMaterial = (await assets.load(body.surfaceMaterialGuid, 'material')).unwrap();
  const riverSegments: Array<{ mesh: AssetHandle<'mesh'> }> = [];
  for (const guid of body.riverSegmentMeshGuids ?? []) {
    const mesh = (await assets.load(guid, 'mesh')).unwrap();
    riverSegments.push({ mesh });
  }

  const zoneEntity = world
    .spawn(
      { component: Transform, data: { pos: [32, 0, 32] } },
      { component: WaterZoneInstance, data: { zone: zoneHandle } },
    )
    .unwrap();
  const terrainEntity = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: Terrain, data: { asset: terrainHandles.a, lod0Diameter: 0.4 } },
      { component: WaterTerrainProvider, data: { terrain: terrainHandles.a } },
    )
    .unwrap();
  const bodyEntity = world
    .spawn(
      { component: Transform, data: { pos: [32, 0, 32] } },
      { component: WaterBodyInstance, data: { body: bodyHandle } },
    )
    .unwrap();
  for (const segment of riverSegments) {
    world
      .spawn(
        { component: Transform, data: { pos: [32, 0, 32] } },
        { component: MeshFilter, data: { assetHandle: segment.mesh } },
        { component: MeshRenderer, data: { materials: [surfaceMaterial] } },
      )
      .unwrap();
  }
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.5, -0.9, -0.4],
        color: [1, 0.98, 0.92],
        intensity: 2.5,
        castShadow: true,
        mapSize: 1536,
      },
    })
    .unwrap();
  const eye: [number, number, number] = [83, 74, 94];
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [32, 0.8, 32], [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: cameraFovForAspect(canvas.width / canvas.height),
            aspect: canvas.width / canvas.height,
            near: 0.1,
            far: 240,
          }),
          clearColor: [0.84, 0.89, 0.83, 1],
        },
      },
    )
    .unwrap();

  let selectedRevision: Revision = 'a';
  const providerToggle = element<HTMLInputElement>('#provider-enabled');
  const setProviderEnabled = (enabled: boolean) => {
    providerToggle.checked = enabled;
    if (enabled) {
      const data = { terrain: terrainHandles[selectedRevision] };
      if (world.hasComponent(terrainEntity, WaterTerrainProvider)) {
        world.set(terrainEntity, WaterTerrainProvider, data).unwrap();
      } else {
        world.addComponent(terrainEntity, { component: WaterTerrainProvider, data }).unwrap();
      }
    } else if (world.hasComponent(terrainEntity, WaterTerrainProvider)) {
      world.removeComponent(terrainEntity, WaterTerrainProvider).unwrap();
    }
    status.textContent = enabled
      ? `已将预制 Terrain 方案 ${selectedRevision.toUpperCase()} 绑定为 Zone provider`
      : 'Terrain 仍在场景中显示；Zone 当前没有 Terrain provider';
  };
  const selectRevision = (revision: Revision) => {
    selectedRevision = revision;
    world.set(terrainEntity, Terrain, { asset: terrainHandles[revision] }).unwrap();
    if (providerToggle.checked)
      world
        .set(terrainEntity, WaterTerrainProvider, { terrain: terrainHandles[revision] })
        .unwrap();
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-revision]'))
      button.setAttribute('aria-pressed', String(button.dataset.revision === revision));
    status.textContent = `Scene 正在显示预制方案 ${revision.toUpperCase()}`;
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-revision]'))
    button.addEventListener('click', () =>
      selectRevision(button.dataset.revision === 'b' ? 'b' : 'a'),
    );
  providerToggle.addEventListener('change', () => setProviderEnabled(providerToggle.checked));

  const renderGroundReadout = () => {
    const snapshot = waterSceneZoneGround(world, zoneGuid).unwrap();
    const availability = element<HTMLElement>('#availability');
    const providers = snapshot?.providers ?? [];
    const provider = providers[0];
    element('#generation').textContent = snapshot ? String(snapshot.generation) : '—';
    element('#dirty-state').textContent = snapshot
      ? snapshot.dirty
        ? '待下游读取'
        : '输入稳定'
      : '尚未观测';
    element('#zone-guid').textContent = zoneGuid;
    element('#provider-guid').textContent = provider?.terrainGuid ?? '—';
    element('#provider-version').textContent = provider ? String(provider.terrainVersion) : '—';
    element('#provider-bounds').textContent = provider
      ? `${provider.boundsXZ.minM.map((value) => value.toFixed(1)).join(', ')} → ${provider.boundsXZ.maxM.map((value) => value.toFixed(1)).join(', ')} m`
      : '—';
    availability.textContent = provider ? `${providers.length} 可用` : '无 Provider';
    availability.dataset.available = String(providers.length > 0);
    const acceptedGeometry = waterSceneWaterInfoGeometry(world, bodyEntity);
    const geometryReadout = element<HTMLElement>('#water-info-geometry');
    if (acceptedGeometry) {
      geometryReadout.textContent = `已接纳 · G${acceptedGeometry.geometryGeneration} · receipt ${acceptedGeometry.geometryReceipt.digest.slice(0, 16)} · U${acceptedGeometry.undilated.version}${acceptedGeometry.dilated ? ` / D${acceptedGeometry.dilated.version}` : ''}`;
    } else {
      const snapshot = waterSceneSnapshot(world, bodyEntity);
      geometryReadout.textContent = !snapshot
        ? '等待挂载'
        : !snapshot.asset.flags.affectsWaterInfo
          ? '未请求 WaterInfo 几何'
          : snapshot.dirty.has('geometry')
            ? '几何待接纳'
            : snapshot.outputs.geometry !== 'ready'
              ? `几何 ${snapshot.outputs.geometry}`
              : '几何依赖不可用';
    }
    geometryReadout.dataset.ready = String(acceptedGeometry !== undefined);
    geometryReadout.dataset.receipt = acceptedGeometry?.geometryReceipt.digest ?? '';
  };
  world
    .addSystem(
      Update,
      defineSystem({ name: 'terrain-provider-demo-readout', queries: [], fn: renderGroundReadout }),
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  renderGroundReadout();

  element<HTMLButtonElement>('#panel-toggle').addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const visible = document.body.classList.toggle('panel-hidden') === false;
    button.setAttribute('aria-expanded', String(visible));
    button.title = visible ? '隐藏面板' : '显示面板';
    button.textContent = visible ? '面板' : '显示面板';
  });

  app.renderer.subscribe((event) => {
    if (event.kind === 'error') {
      renderState.textContent = '渲染错误';
      status.textContent = `渲染器错误：${event.error.code}`;
    } else if (event.kind === 'frame-submitted') {
      void event.receipt.completed.then((result) => {
        if (result.ok) {
          renderState.textContent = '场景就绪';
          status.textContent = providerToggle.checked
            ? `场景就绪 · 预制方案 ${selectedRevision.toUpperCase()} 已接入 Zone provider`
            : '场景就绪 · Zone 无 Terrain provider（Terrain 仍显示）';
        } else {
          renderState.textContent = '设备错误';
          status.textContent = `设备错误：${result.error.code}`;
        }
      });
    }
  });
  window.addEventListener('resize', () => {
    resizeCanvas();
    const aspect = canvas.width / canvas.height;
    world.set(cameraEntity, Camera, { aspect, fov: cameraFovForAspect(aspect) }).unwrap();
  });
  window.addEventListener('beforeunload', () => {
    void app.dispose();
  });
  renderState.textContent = '正在提交场景';
  app.start().unwrap();
  world.update(1 / 60).unwrap();
  renderGroundReadout();
  document.body.dataset.zoneEntity = String(zoneEntity);
  document.body.dataset.bodyEntity = String(bodyEntity);
  document.body.dataset.terrainEntity = String(terrainEntity);
  document.body.dataset.terrainRevision = String(assets.revision(terrainHandles.a).unwrap());
  document.body.dataset.terrainRevisionB = String(assets.revision(terrainHandles.b).unwrap());
  if (new URLSearchParams(window.location.search).has('smoke')) {
    (
      window as Window & { __waterTerrainProviderDemo?: Readonly<Record<string, unknown>> }
    ).__waterTerrainProviderDemo = Object.freeze({
      app,
      world,
      zoneGuid,
      terrainEntity,
      bodyEntity,
      terrainHandles: Object.freeze({ ...terrainHandles }),
      waterInfoMeshes: Object.freeze([...waterInfoMeshes]),
    });
  }
};

main().catch((error) => {
  renderState.textContent = '启动失败';
  status.textContent = error instanceof Error ? error.message : String(error);
  console.error('water terrain provider bootstrap', error);
});
