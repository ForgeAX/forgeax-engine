import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { quat } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine/render';
import { waterSceneMeshView, waterSceneZoneSnapshot } from '@forgeax/engine/runtime';
import { Transform, WaterBodyInstance, WaterTerrainProvider, WaterZoneInstance } from '@forgeax/engine/scene';
import type { WaterSystem } from '@forgeax/engine/water';
import { WATER_MESH_DEMO_PACKAGE } from './identity';
import './style.css';

const $ = <T extends HTMLElement>(selector: string) => { const node = document.querySelector<T>(selector); if (!node) throw new Error(`Missing ${selector}`); return node; };
const canvas = $('#scene') as HTMLCanvasElement;
type Mode = 'ocean' | 'river' | 'lake' | 'island';
const modeLabels: Record<Mode, string> = { ocean: '海洋', river: '河流', lake: '湖泊', island: '岛屿' };
const cameraPresets: Record<Mode, { target: [number, number, number]; distance: number; height: number; direction: readonly [number, number] }> = {
  ocean: { target: [0, 0, -80], distance: 104, height: 8, direction: [0, 1] },
  river: { target: [0, 0, 0], distance: 82, height: 48, direction: [0.67, 0.74] },
  lake: { target: [0, 0, 0], distance: 72, height: 50, direction: [0.67, 0.74] },
  island: { target: [26, 1.2, 20], distance: 66, height: 50, direction: [0.67, 0.74] },
};
const main = async () => {
  const app = (await createApp(canvas, { ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}) }, { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) })).unwrap();
  const assets = app.assets;
  if (!assets) throw new Error('App asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_MESH_DEMO_PACKAGE, key));
  const zoneGuid = guid('zone/main');
  const zone = (await assets.load(zoneGuid, 'water-zone')).unwrap();
  world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }, { component: WaterZoneInstance, data: { zone } }).unwrap();
  const bodyModes: readonly { key: string; modes: readonly Mode[] }[] = [
    { key: 'ocean', modes: ['ocean'] },
    { key: 'river', modes: ['river'] },
    { key: 'lake', modes: ['lake'] },
    { key: 'island-ocean', modes: ['island'] },
    { key: 'lagoon', modes: ['island'] },
  ];
  const bodies = await Promise.all(bodyModes.map(async ({ key, modes }) => {
    const handle = (await assets.load(guid(`body/${key}`), 'water-body')).unwrap();
    const entity = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap();
    if (key === 'ocean') world.addComponent(entity, { component: WaterBodyInstance, data: { body: handle } }).unwrap();
    return { key, modes, handle, entity };
  }));
  const islandLandMesh = (await assets.load(guid('mesh/island-ring'), 'mesh')).unwrap();
  const islandLandMaterial = (await assets.load(guid('material/island-land'), 'material')).unwrap();
  const islandTerrain = (await assets.load(guid('terrain/island/terrain'), 'terrain')).unwrap();
  const islandLand = world.spawn(
    { component: Transform, data: { pos: [0, 0, 0] } },
    { component: MeshFilter, data: { assetHandle: islandLandMesh } },
  ).unwrap();
  const islandGround = world.spawn({ component: Transform, data: { pos: [-10, 0, -16] } }).unwrap();
  const landOffExperiment = new URLSearchParams(location.search).has('land-off-experiment');
  world.spawn({ component: DirectionalLight, data: { direction: [-0.4, -0.9, -0.3], color: [1, 1, 1], intensity: 1.8, castShadow: false, mapSize: 512 } }).unwrap();
  let target: [number, number, number] = [...cameraPresets.ocean.target];
  let distance = cameraPresets.ocean.distance;
  let cameraHeight = cameraPresets.ocean.height;
  let direction = cameraPresets.ocean.direction;
  let eye: [number, number, number] = [0, cameraHeight, 24];
  const camera = world.spawn({ component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) } }, { component: Camera, data: { ...perspective({ fov: 0.88, aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight), near: 0.1, far: 6000 }), clearColor: [0.77, 0.86, 0.84, 1] } }).unwrap();
  let selected: Mode = 'ocean';
  let edgesVisible = false;
  let publicationPending = true;
  let inputRevision = 0;
  const markViewChanged = () => { inputRevision += 1; publicationPending = true; $('#render-state').textContent = '准备当前视图'; };
  const applyCamera = () => {
    eye = [target[0] + distance * direction[0], cameraHeight, target[2] + distance * direction[1]];
    world.set(camera, Transform, { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) }).unwrap();
  };
  const updateVisibility = () => {
    markViewChanged();
    if (selected === 'island' && !landOffExperiment && !world.hasComponent(islandLand, MeshRenderer)) {
      world.addComponent(islandLand, { component: MeshRenderer, data: { materials: [islandLandMaterial] } }).unwrap();
    } else if ((selected !== 'island' || landOffExperiment) && world.hasComponent(islandLand, MeshRenderer)) {
      world.removeComponent(islandLand, MeshRenderer).unwrap();
    }
    if (selected === 'island' && !landOffExperiment && !world.hasComponent(islandGround, WaterTerrainProvider)) {
      world.addComponent(islandGround, { component: WaterTerrainProvider, data: { terrain: islandTerrain } }).unwrap();
    } else if ((selected !== 'island' || landOffExperiment) && world.hasComponent(islandGround, WaterTerrainProvider)) {
      world.removeComponent(islandGround, WaterTerrainProvider).unwrap();
    }
    for (const body of bodies) {
      const visible = body.modes.includes(selected);
      if (visible && !world.hasComponent(body.entity, WaterBodyInstance)) world.addComponent(body.entity, { component: WaterBodyInstance, data: { body: body.handle } }).unwrap();
      else if (!visible && world.hasComponent(body.entity, WaterBodyInstance)) world.removeComponent(body.entity, WaterBodyInstance).unwrap();
    }
    refresh();
  };
  const refresh = () => {
    $('#mode-readout').textContent = modeLabels[selected];
    const snapshot = waterSceneZoneSnapshot(world, zoneGuid);
    if (!snapshot) { $('#status').textContent = '等待区域快照'; return; }
    const viewId = `camera:${camera}`;
    const publication = waterSceneMeshView(world, zoneGuid, viewId);
    if (publicationPending || !publication) {
      $('#tiles').textContent = '—'; $('#far').textContent = '—'; $('#lod-range').textContent = '—'; $('#depth').textContent = '—'; $('#digest').textContent = '—'; $('#roster').replaceChildren();
      $('#status').textContent = '等待当前相机视图提交'; return;
    }
    const receipt = publication.receipt;
    $('#tiles').textContent = `${receipt.selectedTileCount} / ${receipt.visibleLeafCount}`;
    $('#far').textContent = String(receipt.farInstanceCount);
    const lods = receipt.instances.filter((tile) => !tile.far).flatMap((tile) => [tile.lod0, tile.lod1]);
    $('#lod-range').textContent = lods.length ? `L${Math.min(...lods)}–L${Math.max(...lods)}` : '—';
    $('#depth').textContent = String(receipt.treeDepth);
    $('#digest').textContent = receipt.layout.dataHash.slice(0, 10);
    $('#roster').replaceChildren(...receipt.instances.slice(0, 8).map((tile, index) => {
      const item = document.createElement('div'); item.className = 'tile';
      const title = document.createElement('b');
      title.textContent = `${tile.far ? '远场' : '近场'} #${index + 1}`;
      item.append(title, `${tile.sizeM.toFixed(1)} m · L${tile.lod0}→${tile.lod1} · ${tile.coverageRings?.length ?? 0} 环`);
      item.title = `高度渐变 ${tile.heightMorph01.toFixed(2)} · 距离渐变 ${tile.shouldMorph ? '开启' : '关闭'} · 二次渐变 ${tile.canMorphTwice ? '开启' : '关闭'}`;
      return item;
    }));
    const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
    $('#status').textContent = `视图已提交 · 发布 G${publication.publicationGeneration} · ${water.snapshots().filter((row) => row.binding.kind === 'bound').length} 个水体 · 瓦片 ${receipt.layout.byteLength} B / 覆盖 ${receipt.layout.coverageByteLength} B`;
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-mode]')) button.addEventListener('click', () => {
    selected = button.dataset.mode as Mode;
    const preset = cameraPresets[selected];
    target = [...preset.target];
    distance = preset.distance;
    cameraHeight = preset.height;
    direction = preset.direction;
    ($('#camera-distance') as HTMLInputElement).value = String(distance);
    ($('#camera-height') as HTMLInputElement).value = String(cameraHeight);
    $('#camera-distance-value').textContent = `${distance} m`;
    $('#camera-height-value').textContent = `${cameraHeight} m`;
    applyCamera();
    for (const item of document.querySelectorAll<HTMLButtonElement>('button[data-mode]')) item.setAttribute('aria-pressed', String(item === button));
    updateVisibility();
  });
  $('#edge-toggle').addEventListener('change', (event) => {
    edgesVisible = (event.currentTarget as HTMLInputElement).checked;
    world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE).setMeshEdgeOverlayEnabled(edgesVisible);
    refresh();
  });
  for (const [selector, setter] of [
    ['#camera-distance', (value: number) => { distance = value; }],
    ['#camera-height', (value: number) => { cameraHeight = value; }],
  ] as const) $(selector).addEventListener('input', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    setter(Number(input.value));
    $(`${selector}-value`).textContent = `${input.value} m`;
    applyCamera(); markViewChanged(); refresh();
  });
  $('#panel-toggle').addEventListener('click', (event) => { const button = event.currentTarget as HTMLButtonElement; const shown = !document.body.classList.toggle('panel-hidden'); button.setAttribute('aria-expanded', String(shown)); button.title = shown ? '隐藏面板' : '显示面板'; });
  app.renderer.subscribe((event) => { if (event.kind === 'frame-submitted') { const submittedRevision = inputRevision; void event.receipt.completed.then((result) => { if (submittedRevision !== inputRevision) return; if (!result.ok) { $('#render-state').textContent = '设备错误'; $('#status').textContent = result.error.code; return; } if (event.receipt.presentation !== 'ready') return; publicationPending = false; $('#render-state').textContent = 'GPU 帧已提交'; refresh(); }); } else if (event.kind === 'error') { $('#render-state').textContent = '渲染错误'; $('#status').textContent = event.error.code; } });
  if (new URLSearchParams(location.search).has('visual-smoke')) {
    const errors: unknown[] = [];
    app.renderer.subscribe((event) => { if (event.kind === 'error') errors.push(event.error); });
    const readWaterState = () => {
      const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
      return {
        ground: water.zoneGroundSnapshot(zoneGuid),
        bodies: water.snapshots().map((snapshot) => ({
          guid: snapshot.guid, sourceAssetGuid: snapshot.sourceAssetGuid, sceneGeneration: snapshot.sceneGeneration,
          sourceVersion: snapshot.sourceVersion, binding: snapshot.binding, dirty: [...snapshot.dirty],
          outputs: snapshot.outputs, outputGenerations: snapshot.outputGenerations, outputReceipts: snapshot.outputReceipts,
          dependencies: snapshot.dependencies.map(({ guid: dependencyGuid, kind, field, status, actualKind }) => ({
            guid: dependencyGuid, kind, field, status, actualKind,
          })),
          body: { type: snapshot.asset.type, waterInfoMeshGuid: snapshot.asset.waterInfoMeshGuid, visibleMeshGuid: snapshot.asset.visibleMeshGuid,
            riverSegmentMeshGuids: snapshot.asset.riverSegmentMeshGuids, flags: snapshot.asset.flags },
        })),
        meshView: waterSceneMeshView(world, zoneGuid, `camera:${camera}`),
        mode: selected,
        edgesVisible,
      };
    };
    Object.assign(window, { __waterMeshVisualDebug: { app, world, zoneGuid, bodies, camera, errors, readWaterState } });
  }
  window.addEventListener('resize', () => { const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight); world.set(camera, Camera, { aspect, fov: 0.88 }).unwrap(); refresh(); });
  window.addEventListener('beforeunload', () => { void app.dispose(); });
  app.start().unwrap(); world.update(1 / 60).unwrap(); refresh();
};
main().catch((error) => { $('#render-state').textContent = '启动失败'; $('#status').textContent = error instanceof Error ? error.message : String(error); console.error(error); });
