import { WATER_SYSTEM_RESOURCE, WATER_SCENE_STATUS_RESOURCE } from '@forgeax/engine/runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { defineSystem, Disabled, Update, type EntityHandle } from '@forgeax/engine/ecs';
import { quat, vec3 } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { createRuntimePackPublication } from '@forgeax/engine/pack/runtime';
import { Collider, ColliderShapeValue, PhysicsWorldResource, RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine/render';
import { Transform, WaterBodyInstance, WaterExclusionMode, WaterExclusionVolume } from '@forgeax/engine/scene';
import { err, ok, type AssetHandle, type CatalogEntry, type MeshAsset, type WaterBodyAsset } from '@forgeax/engine/types';
import { buildWaterPackOutputs, buildWaterPhysicsCandidateInput, deleteWaterSplinePoint, duplicateWaterSplinePointInSpline, insertWaterSplinePointInSpline, validateWaterAsset } from '@forgeax/engine/water';
import type { WaterSystem } from '@forgeax/engine/water';
import { WATER_BODY_GEOMETRY_PACKAGE_ID, WATER_BODY_GEOMETRY_PACKAGE_NAMESPACE } from './identity';
import './style.css';

type BodyEntry = {
  sourceKey: string;
  label: string;
  color: string;
  position: [number, number, number];
  body: WaterBodyAsset;
  bodyHandle: AssetHandle<'water-body'>;
  materialHandle: AssetHandle<'material'>;
  meshes: AssetHandle<'mesh'>[];
  debugMeshes: Array<{ kind: 'water-info' | 'dilated'; guid: string; handle: AssetHandle<'mesh'>; entity?: EntityHandle }>;
  entities: EntityHandle[];
  visible: boolean;
  draftSpline: WaterBodyAsset['spline'];
  scale: [number, number, number];
  draftScale: [number, number, number];
};

const element = <T extends HTMLElement>(selector: string) => {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing element ${selector}`);
  return value;
};

const canvas = element<HTMLCanvasElement>('#scene');
const status = element<HTMLElement>('#status');
const renderState = element<HTMLElement>('#render-state');
const frames = element<HTMLElement>('#frame-count');
const cameraFovForAspect = (aspect: number) => 2 * Math.atan(Math.tan((Math.PI / 3.5) / 2) * Math.max(1, 2 / aspect));

const main = async () => {
  const app = (await createApp(canvas, {
    plugins: [physics3d],
    ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
  }, {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  })).unwrap();
  const assets = app.assets;
  if (!assets) throw new Error('App asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const packageGuid = (sourceKey: string) => AssetGuid.format(AssetGuid.derive(WATER_BODY_GEOMETRY_PACKAGE_NAMESPACE, sourceKey));
  const definitions = [
    { sourceKey: 'body/river', label: '河流', color: '#10a8bb', position: [0, 0, 0] as [number, number, number] },
    { sourceKey: 'body/lake', label: '湖泊', color: '#36a87a', position: [11, 0, 8] as [number, number, number] },
    { sourceKey: 'body/ocean', label: '海洋', color: '#2476a8', position: [20, 0, 8] as [number, number, number] },
    { sourceKey: 'body/custom', label: '自定义', color: '#d18a42', position: [-12, 0, 10] as [number, number, number] },
  ];
  const bodies: BodyEntry[] = [];
  for (const definition of definitions) {
    const bodyHandle = (await assets.load(packageGuid(definition.sourceKey), 'water-body')).unwrap();
    const body = assets.read(bodyHandle).unwrap() as WaterBodyAsset;
    if (!body.surfaceMaterialGuid) throw new Error(`${definition.label}缺少水面材质 GUID`);
    const materialHandle = (await assets.load(body.surfaceMaterialGuid, 'material')).unwrap();
    const meshGuids = body.riverSegmentMeshGuids ?? (body.visibleMeshGuid ? [body.visibleMeshGuid] : []);
    const meshes: AssetHandle<'mesh'>[] = [];
    for (const guid of meshGuids) meshes.push((await assets.load(guid, 'mesh')).unwrap());
    const debugMeshes: BodyEntry['debugMeshes'] = [];
    if (body.waterInfoMeshGuid) debugMeshes.push({ kind: 'water-info', guid: body.waterInfoMeshGuid, handle: (await assets.load(body.waterInfoMeshGuid, 'mesh')).unwrap() });
    if (body.dilatedWaterInfoMeshGuid) debugMeshes.push({ kind: 'dilated', guid: body.dilatedWaterInfoMeshGuid, handle: (await assets.load(body.dilatedWaterInfoMeshGuid, 'mesh')).unwrap() });
    bodies.push({ ...definition, body, bodyHandle, materialHandle, meshes, debugMeshes, entities: [], visible: true, draftSpline: body.spline, scale: [1, 1, 1], draftScale: [1, 1, 1] });
  }

  const { world } = app;
  const waterInfoDebugMaterial = assets.create(Materials.unlit('#126170')).unwrap();
  const dilatedDebugMaterial = assets.create(Materials.unlit('#a75d1b')).unwrap();
  let productMode: 'visible' | 'water-info' | 'dilated' = 'visible';
  for (const entry of bodies) {
    const bodyEntity = world.spawn(
      { component: Transform, data: { pos: entry.position } },
      { component: WaterBodyInstance, data: { body: entry.bodyHandle } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    ).unwrap();
    entry.entities.push(bodyEntity);
    for (const handle of entry.meshes) {
      const entity = world.spawn(
        { component: Transform, data: { pos: entry.position } },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: { materials: [entry.materialHandle] } },
      ).unwrap();
      entry.entities.push(entity);
    }
    for (const debugMesh of entry.debugMeshes) {
      const entity = world.spawn(
        { component: Transform, data: { pos: entry.position } },
        { component: MeshFilter, data: { assetHandle: debugMesh.handle } },
        { component: MeshRenderer, data: { materials: [debugMesh.kind === 'water-info' ? waterInfoDebugMaterial : dilatedDebugMaterial] } },
        { component: Disabled, data: {} },
      ).unwrap();
      debugMesh.entity = entity;
      entry.entities.push(entity);
    }
  }

  const ground = assets.create(createBoxGeometry(50, 0.18, 36).unwrap()).unwrap();
  const groundMaterial = assets.create(Materials.unlit('#89948d')).unwrap();
  const groundEntity = world.spawn(
    { component: Transform, data: { pos: [0, -0.58, 0] } },
    { component: MeshFilter, data: { assetHandle: ground } },
    { component: MeshRenderer, data: { materials: [groundMaterial] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [25, 0.09, 18] } },
  ).unwrap();
  const islandGeometry = assets.create(createBoxGeometry(3.2, 0.52, 3.2).unwrap()).unwrap();
  const islandMaterial = assets.create(Materials.unlit('#9a8262')).unwrap();
  for (const entry of bodies.filter((body) => body.body.type === 'lake' || body.body.type === 'ocean')) {
    const height = entry.body.type === 'lake' ? 0.55 : 0.2;
    const island = world.spawn(
      { component: Transform, data: { pos: [entry.position[0], height, entry.position[2]] } },
      { component: MeshFilter, data: { assetHandle: islandGeometry } },
      { component: MeshRenderer, data: { materials: [islandMaterial] } },
    ).unwrap();
    entry.entities.push(island);
  }
  world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -0.8, -0.4], color: [1, 0.98, 0.93], intensity: 2.4, castShadow: true } }).unwrap();

  const probeMesh = assets.create(createBoxGeometry(0.7, 0.7, 0.7).unwrap()).unwrap();
  const probeMaterial = assets.create(Materials.unlit('#e6bc52')).unwrap();
  const probeTargetFor = (entry: BodyEntry): [number, number, number] => {
    const riverPoint = entry.body.type === 'river' ? entry.body.spline.points[Math.floor(entry.body.spline.points.length / 2)] : undefined;
    const local = riverPoint?.positionM ?? (entry.body.type === 'lake' ? [2.2, 0, 0] : entry.body.type === 'ocean' ? [4, 0, 0] : [0, 0, 0]);
    const surfaceY = entry.body.type === 'river'
      ? local[1]
      : entry.body.baseHeightM + (entry.body.type === 'ocean' ? entry.body.heightOffsetM ?? 0 : 0);
    return [entry.position[0] + local[0] * entry.scale[0], entry.position[1] + surfaceY * entry.scale[1] + 0.3, entry.position[2] + local[2] * entry.scale[2]];
  };
  const probe = world.spawn(
    { component: Transform, data: { pos: probeTargetFor(bodies[0]!) } },
    { component: MeshFilter, data: { assetHandle: probeMesh } },
    { component: MeshRenderer, data: { materials: [probeMaterial] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1, gravityScale: 1 } },
    { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: 0.35, restitution: 0.1 } },
  ).unwrap();

  const cameraPosition: [number, number, number] = [18, 24, 20];
  const camera = world.spawn(
    { component: Transform, data: { pos: cameraPosition, quat: quat.fromLookAt(quat.create(), cameraPosition, [0, 0, 0], [0, 1, 0]) } },
    { component: Camera, data: { ...perspective({ fov: cameraFovForAspect(canvas.clientWidth / Math.max(1, canvas.clientHeight)), aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight), near: 0.1, far: 160 }), tonemap: 2, clearColor: [0.89, 0.94, 0.91, 1] } },
  ).unwrap();

  let selected = 0;
  let recookRevision = 0;
  let failNextRecookBeforeCommit = false;
  let exclusionEntity: EntityHandle | undefined;
  let exclusionMeshEntity: EntityHandle | undefined;
  let exclusionEnabled = false;
  const exclusionMesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const exclusionMaterial = assets.create(Materials.unlit('#e4785f')).unwrap();
  const bodyWorldMatrix = (entry: BodyEntry, scale = entry.scale): readonly number[] => [
    scale[0], 0, 0, 0,
    0, scale[1], 0, 0,
    0, 0, scale[2], 0,
    entry.position[0], entry.position[1], entry.position[2], 1,
  ];
  let yaw = 0.68;
  let pitch = 0.62;
  let distance = 34;
  let target: [number, number, number] = [8.5, 0, 5.5];
  let dragging = false;
  let previous = { x: 0, y: 0 };
  const applyView = () => {
    const eye: [number, number, number] = [target[0] + Math.sin(yaw) * Math.cos(pitch) * distance, target[1] + Math.sin(pitch) * distance, target[2] + Math.cos(yaw) * Math.cos(pitch) * distance];
    world.set(camera, Transform, { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) }).unwrap();
  };
  const meshBounds = (entries: readonly BodyEntry[], includeDebug = false) => {
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const entry of entries) {
      const handles = includeDebug ? [...entry.meshes, ...entry.debugMeshes.map((mesh) => mesh.handle)] : entry.meshes;
      for (const handle of handles) {
        const mesh = assets.read(handle as AssetHandle<'mesh', MeshAsset>);
        if (!mesh.ok || !(mesh.value.attributes.position instanceof Float32Array)) continue;
        const positions = mesh.value.attributes.position;
        for (let index = 0; index < positions.length; index += 3) for (let axis = 0; axis < 3; axis++) {
          const value = entry.position[axis]! + positions[index + axis]! * entry.scale[axis]!;
          bounds.min[axis] = Math.min(bounds.min[axis]!, value);
          bounds.max[axis] = Math.max(bounds.max[axis]!, value);
        }
      }
    }
    return bounds;
  };
  const fitViewToBounds = (bounds: { min: number[]; max: number[] }, aspect: number, nextYaw: number, nextPitch: number) => {
    if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) return false;
    const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    target = [0, 1, 2].map((axis) => (bounds.min[axis]! + bounds.max[axis]!) / 2) as [number, number, number];
    const radius = Math.hypot(...[0, 1, 2].map((axis) => (bounds.max[axis]! - bounds.min[axis]!) / 2));
    const verticalHalfFov = cameraFovForAspect(safeAspect) / 2;
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * safeAspect);
    const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
    if (!(radius > 0) || !(limitingHalfFov > 0 && limitingHalfFov < Math.PI / 2)) return false;
    yaw = nextYaw;
    pitch = nextPitch;
    distance = Math.max(4, radius / Math.sin(limitingHalfFov) * 1.15);
    world.set(camera, Camera, {
      aspect: safeAspect,
      fov: cameraFovForAspect(safeAspect),
      near: Math.max(0.05, distance - radius * 1.25),
      far: Math.max(160, distance + radius * 1.25),
    }).unwrap();
    applyView();
    return true;
  };
  const fitViewToBodies = (aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight)) => {
    fitViewToBounds(meshBounds(bodies), aspect, aspect < 0.7 ? 0.95 : 0.68, aspect < 0.7 ? 0.92 : 0.62);
  };
  const visibleMeshCount = () => bodies.filter((entry) => entry.visible).reduce((sum, entry) => sum + entry.meshes.length, 0);
  const updateReadout = () => {
    element('#body-count').textContent = String(bodies.length);
    element('#mesh-count').textContent = String(visibleMeshCount());
    element('#focus-state').textContent = bodies[selected]?.label ?? '—';
    const selectedBody = bodies[selected];
    const refreshSelectedBodyFields = () => {
      const heightInput = element<HTMLInputElement>('#height-offset');
      const dilationInput = element<HTMLInputElement>('#shape-dilation');
      const heightLabel = heightInput.closest('label')?.querySelector('span');
      if (heightLabel)
        heightLabel.textContent =
          selectedBody?.body.type === 'ocean' ? '海平面高度偏移' : '水体基准高度';
      heightInput.disabled = selectedBody?.body.type === 'custom';
      dilationInput.disabled = selectedBody?.body.type === 'custom';
      element<HTMLButtonElement>('#recook').disabled = selectedBody?.body.type === 'custom';
      const bodyNote = element<HTMLElement>('#body-note');
      bodyNote.hidden = !selectedBody;
      bodyNote.textContent =
        selectedBody?.body.type === 'custom'
          ? '自定义水体使用独立网格覆盖；可调整场景缩放，几何与碰撞来源仍由网格资产控制。'
          : selectedBody?.body.type === 'ocean'
            ? 'Ocean 外边界由范围控制；闭合样条定义岛屿/排除边界。缩放会连同范围、查询边界和碰撞一起重建。'
            : selectedBody?.body.type === 'lake'
              ? 'Lake 使用闭合样条定义水面边界；缩放与样条将在重建时一起接纳。'
              : 'River 使用开放样条；缩放按场景世界距离重新采样，再接纳几何、查询与 Physics。';
      element<HTMLOutputElement>('#height-value').textContent =
        `${(selectedBody?.body.type === 'ocean' ? (selectedBody.body.heightOffsetM ?? 0) : (selectedBody?.body.baseHeightM ?? 0)).toFixed(2)} m`;
      element<HTMLInputElement>('#height-offset').value = String(
        selectedBody?.body.type === 'ocean'
          ? (selectedBody.body.heightOffsetM ?? 0)
          : (selectedBody?.body.baseHeightM ?? 0),
      );
      element<HTMLOutputElement>('#dilation-value').textContent =
        `${(selectedBody?.body.shapeDilationM ?? 40.96).toFixed(2)} m`;
      element<HTMLInputElement>('#shape-dilation').value = String(
        selectedBody?.body.shapeDilationM ?? 40.96,
      );
    };
    refreshSelectedBodyFields();

    const spline = selectedBody?.draftSpline;
    const pointSelect = element<HTMLSelectElement>('#spline-point');
    const priorPoint = Number(pointSelect.value);
    const points = spline?.points ?? [];
    pointSelect.replaceChildren(...points.map((point, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `点 ${index + 1} · ${point.positionM.map((value) => value.toFixed(1)).join(', ')}`;
      return option;
    }));
    const pointIndex = Math.max(0, Math.min(points.length - 1, Number.isInteger(priorPoint) ? priorPoint : 0));
    if (points.length) pointSelect.value = String(pointIndex);
    const point = points[pointIndex];
    const refreshSelectedPointFields = () => {
      for (const [selector, axis] of [
        ['#point-x', 0],
        ['#point-y', 1],
        ['#point-z', 2],
      ] as const) {
        const input = element<HTMLInputElement>(selector);
        input.value = point ? String(point.positionM[axis]) : '';
        input.disabled = !point || selectedBody?.body.type === 'custom';
      }
      for (const [selector, key] of [
        ['#point-width', 'widthM'],
        ['#point-depth', 'depthM'],
        ['#point-velocity', 'velocityMPerSec'],
        ['#point-audio', 'audioIntensity'],
      ] as const) {
        const input = element<HTMLInputElement>(selector);
        input.value = point ? String(point[key]) : '';
        input.disabled = !point || selectedBody?.body.type === 'custom';
      }
      for (const axis of ['x', 'y', 'z'] as const) {
        const input = element<HTMLInputElement>(`#scale-${axis}`);
        input.value = String(selectedBody?.draftScale['xyz'.indexOf(axis)] ?? 1);
        input.disabled = selectedBody?.body.type === 'custom';
      }
      for (const selector of ['#point-insert', '#point-copy', '#point-delete']) {
        element<HTMLButtonElement>(selector).disabled =
          !point ||
          selectedBody?.body.type === 'custom' ||
          (selector === '#point-delete' && points.length <= (spline?.closed ? 3 : 2));
      }
    };
    refreshSelectedPointFields();

    for (const button of element<HTMLElement>('#product-switch').querySelectorAll<HTMLButtonElement>('button[data-product]')) {
      const mode = button.dataset.product;
      button.disabled = mode !== 'visible' && !selectedBody?.debugMeshes.some((mesh) => mesh.kind === mode);
      button.setAttribute('aria-pressed', String(mode === productMode));
    }
  };
  const applyProductMode = () => {
    if (productMode !== 'visible' && !bodies[selected]?.debugMeshes.some((mesh) => mesh.kind === productMode)) productMode = 'visible';
    bodies.forEach((entry, index) => {
      const setVisible = (entity: EntityHandle, visible: boolean) => {
        if (visible && world.hasComponent(entity, Disabled)) world.removeComponent(entity, Disabled).unwrap();
        else if (!visible && !world.hasComponent(entity, Disabled)) world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
      };
      for (const entity of entry.entities) setVisible(entity, entry.visible);
      entry.entities.slice(1, 1 + entry.meshes.length).forEach((entity) =>
        setVisible(entity, entry.visible && (index !== selected || productMode === 'visible')),
      );
      for (const debugMesh of entry.debugMeshes) if (debugMesh.entity !== undefined)
        setVisible(debugMesh.entity, entry.visible && index === selected && productMode === debugMesh.kind);
    });
    for (const button of element<HTMLElement>('#product-switch').querySelectorAll<HTMLButtonElement>('button[data-product]')) {
      const mode = button.dataset.product;
      button.disabled = mode !== 'visible' && !bodies[selected]?.debugMeshes.some((mesh) => mesh.kind === mode);
      button.setAttribute('aria-pressed', String(button.dataset.product === productMode));
    }
  };
  const recookSelectedBody = async () => {
    const entry = bodies[selected];
    if (!entry) return;
    if (entry.body.type === 'custom') {
      status.textContent = '自定义水体由独立网格覆盖控制，请在网格资产中编辑';
      return;
    }
    const heightOffset = Number(element<HTMLInputElement>('#height-offset').value);
    const shapeDilationM = Number(element<HTMLInputElement>('#shape-dilation').value);
    if (!Number.isFinite(heightOffset) || !Number.isFinite(shapeDilationM) || shapeDilationM < 0) {
      status.textContent = '高度与膨胀值必须是有限数值，膨胀值不能小于 0';
      return;
    }
    const bodyRevision = assets.revision(entry.bodyHandle).unwrap();
    const requestRevision = ++recookRevision;
const prepareSelectedBodySource = () => {
    const previousOffset = entry.body.type === 'ocean' ? entry.body.heightOffsetM ?? 0 : entry.body.baseHeightM;
    const offsetDelta = heightOffset - previousOffset;
    const {
      riverSegmentMeshGuids: _riverSegments,
      visibleMeshGuid: _visible,
      waterInfoMeshGuid: _waterInfo,
      dilatedWaterInfoMeshGuid: _dilated,
      brushShapeMeshGuid: _brush,
      collisionMeshGuid: _collision,
      waterGeometryVersion: _geometryVersion,
      oceanCenterM: _oceanCenter,
      geometryAuthoringWorldMatrixM: _authoringTransform,
      geometrySnapshot: _snapshot,
      ...sourceBody
    } = entry.body;
    const nextBody: WaterBodyAsset = {
      ...sourceBody,
      ...(entry.body.type === 'ocean' ? { heightOffsetM: heightOffset } : { baseHeightM: entry.body.baseHeightM + offsetDelta }),
      shapeDilationM,
      spline: entry.body.type === 'ocean'
        ? entry.draftSpline
        : {
            ...entry.draftSpline,
            points: entry.draftSpline.points.map((point) => ({ ...point, positionM: [point.positionM[0], point.positionM[1] + offsetDelta, point.positionM[2]] as const })),
          },
    };
return nextBody;
};
const nextBody = prepareSelectedBodySource();
    let packPublished = false;
    let stagedMeshHandles = new Map<string, AssetHandle<'mesh', MeshAsset>>();
    const stagedConsumerEntities: EntityHandle[] = [];
    try {
      const output = await buildWaterPackOutputs({ [entry.sourceKey]: nextBody }, {
        packageId: WATER_BODY_GEOMETRY_PACKAGE_NAMESPACE,
        bodyWorldTransformsM: { [entry.sourceKey]: bodyWorldMatrix(entry, entry.draftScale) },
        readByGuid: async (guid) => {
          const handle = await assets.load(AssetGuid.format(guid), 'mesh');
          if (!handle.ok) return err(handle.error);
          try {
            return ok(assets.read(handle.value).unwrap());
          } finally {
            assets.release(handle.value).unwrap();
          }
        },
      });
      if (!output.ok) throw new Error(`${output.error.code}: ${JSON.stringify(output.error)}`);
      const nextCooked = output.value[entry.sourceKey] as WaterBodyAsset | undefined;
      if (!nextCooked || nextCooked.kind !== 'water-body') throw new Error('Pack 闭包没有发布 WaterBody');
      const nextValidation = validateWaterAsset(nextCooked);
      if (!nextValidation.ok) throw new Error(`Pack WaterBody 无效：${JSON.stringify(nextValidation.error)}`);
      const generatedPrefix = `${entry.sourceKey}/`;
      if (requestRevision !== recookRevision) throw new Error('已有更新的重建请求，请重试');
const collectSelectedBodyPackCandidates = () => {
      const referenceGuids = [
        nextCooked.surfaceMaterialGuid,
        nextCooked.zoneGuid,
        nextCooked.waveSetGuid,
        nextCooked.customMeshOverrideGuid,
        nextCooked.collision.meshGuid,
        nextCooked.riverToLakeTransitionMaterialGuid,
        nextCooked.riverToOceanTransitionMaterialGuid,
        nextCooked.waterInfoMaterialGuid,
        nextCooked.lodMaterialGuid,
        nextCooked.underwaterPostProcessMaterialGuid,
      ].filter((guid): guid is string => typeof guid === 'string');
      const generatedGuids = [
        ...(nextCooked.riverSegmentMeshGuids ?? []),
        nextCooked.visibleMeshGuid,
        nextCooked.waterInfoMeshGuid,
        nextCooked.dilatedWaterInfoMeshGuid,
        nextCooked.brushShapeMeshGuid,
        nextCooked.collisionMeshGuid,
      ].filter((guid): guid is string => typeof guid === 'string');
      const newVisibleGuids = nextCooked.type === 'river'
        ? nextCooked.riverSegmentMeshGuids ?? []
        : nextCooked.visibleMeshGuid ? [nextCooked.visibleMeshGuid] : [];
      const nextDebugGuids = [
        ...(nextCooked.waterInfoMeshGuid ? [{ kind: 'water-info' as const, guid: nextCooked.waterInfoMeshGuid }] : []),
        ...(nextCooked.dilatedWaterInfoMeshGuid ? [{ kind: 'dilated' as const, guid: nextCooked.dilatedWaterInfoMeshGuid }] : []),
      ];
      const bodyRefs = [...new Set([...referenceGuids, ...generatedGuids].map((guid) => guid.toLowerCase()))];
      const candidates = Object.entries(output.value)
        .filter(([sourceKey]) => sourceKey === entry.sourceKey || sourceKey.startsWith(generatedPrefix))
        .map(([sourceKey, value]) => ({
          guid: packageGuid(sourceKey),
          kind: value.kind,
          payload: value,
          refs: sourceKey === entry.sourceKey ? bodyRefs : [],
          artifacts: {},
        }));
      candidates.push({
        guid: nextCooked.surfaceMaterialGuid,
        kind: 'material',
        payload: assets.read(entry.materialHandle).unwrap(),
        refs: [],
        artifacts: {},
      });
return { candidates, newVisibleGuids, nextDebugGuids };
};
const { candidates, newVisibleGuids, nextDebugGuids } = collectSelectedBodyPackCandidates();
      const generatedMeshCount = candidates.filter((candidate) => candidate.kind === 'mesh').length;
      const scopeId = runtimeBinding?.scopeId
        ?? assets.catalogEntry(packageGuid(entry.sourceKey))?.packageId
        ?? WATER_BODY_GEOMETRY_PACKAGE_ID;
      const packageUrl = `https://water-body-geometry.invalid/recook/${requestRevision}.pack.json`;
      const prepared = createRuntimePackPublication({
        scopeId,
        sourcePath: 'assets/body-geometry.pack.ts',
        sourceRevision: `recook-${requestRevision}-${bodyRevision}`,
        packageUrl,
        pack: { assets: candidates },
      });
      const rows: CatalogEntry[] = prepared.pack.assets.map((asset) => ({
        guid: asset.guid,
        kind: asset.kind,
        refs: asset.refs,
        sourcePath: 'assets/body-geometry.pack.ts',
        packageUrl,
        publication: prepared.publication,
      }));
      (await assets.preparePublication(rows, async () => new Response('', { status: 404 }), undefined, { pack: prepared.pack })).unwrap();
const stageSelectedBodySceneConsumers = () => {
      const bodyEntity = entry.entities[0]!;
      const oldVisibleGuids = entry.body.type === 'river'
        ? entry.body.riverSegmentMeshGuids ?? []
        : entry.body.visibleMeshGuid ? [entry.body.visibleMeshGuid] : [];
      const oldMeshEntities = entry.entities.slice(1, 1 + entry.meshes.length);
      const priorDebugEntities = new Set(entry.debugMeshes.flatMap((mesh) => mesh.entity === undefined ? [] : [mesh.entity]));
      const auxiliaryEntities = entry.entities.slice(1 + entry.meshes.length).filter((entity) => !priorDebugEntities.has(entity));
      const stagedDebugEntities = new Map<BodyEntry['debugMeshes'][number]['kind'], EntityHandle>();
      for (let index = oldMeshEntities.length; index < newVisibleGuids.length; index++) {
        stagedConsumerEntities.push(world.spawn(
          { component: Transform, data: { pos: entry.position, scale: [...entry.scale] } },
          { component: MeshFilter, data: { assetHandle: entry.meshes[0]! } },
          { component: MeshRenderer, data: { materials: [entry.materialHandle] } },
          { component: Disabled, data: {} },
        ).unwrap());
      }
      for (const debug of nextDebugGuids) {
        if (entry.debugMeshes.some((mesh) => mesh.kind === debug.kind && mesh.entity !== undefined)) continue;
        const placeholder = entry.debugMeshes[0]?.handle ?? entry.meshes[0]!;
        const material = debug.kind === 'water-info' ? waterInfoDebugMaterial : dilatedDebugMaterial;
        const entity = world.spawn(
          { component: Transform, data: { pos: entry.position, scale: [...entry.scale] } },
          { component: MeshFilter, data: { assetHandle: placeholder } },
          { component: MeshRenderer, data: { materials: [material] } },
          { component: Disabled, data: {} },
        ).unwrap();
        stagedConsumerEntities.push(entity);
        stagedDebugEntities.set(debug.kind, entity);
      }
      for (const entity of [...stagedConsumerEntities]) {
        world.get(entity, Transform).unwrap();
        world.get(entity, MeshFilter).unwrap();
      }
return { bodyEntity, oldVisibleGuids, oldMeshEntities, priorDebugEntities, auxiliaryEntities, stagedDebugEntities };
};
const { bodyEntity, oldVisibleGuids, oldMeshEntities, priorDebugEntities, auxiliaryEntities, stagedDebugEntities } = stageSelectedBodySceneConsumers();
      assets.adoptPreparedContent(prepared.pack, [], (staged) => {
        if (requestRevision !== recookRevision || assets.revision(entry.bodyHandle).unwrap() !== bodyRevision)
          throw new Error('候选 Pack 已过期或源 Body 已更新');
        if (!world.hasComponent(bodyEntity, WaterBodyInstance)) throw new Error('Water Body Scene consumer was removed');
        world.get(bodyEntity, Transform).unwrap();
        for (const entity of [...oldMeshEntities, ...priorDebugEntities]) {
          world.get(entity, Transform).unwrap();
          world.get(entity, MeshFilter).unwrap();
        }
        for (const handle of [...entry.meshes, ...entry.debugMeshes.map((mesh) => mesh.handle)]) assets.validate(handle).unwrap();
        for (const guid of new Set([...newVisibleGuids, ...nextDebugGuids.map((mesh) => mesh.guid)])) {
          const key = guid.toLowerCase();
          const handle = staged.get(key);
          if (handle === undefined) throw new Error(`候选 Pack 缺少场景 Mesh handle ${guid}`);
          const asset = assets.read(handle as AssetHandle<'mesh', MeshAsset>).unwrap();
          if (asset.kind !== 'mesh') throw new Error(`候选 Pack 场景资产不是 Mesh：${guid}`);
          stagedMeshHandles.set(key, handle as AssetHandle<'mesh', MeshAsset>);
        }
        if (failNextRecookBeforeCommit) {
          failNextRecookBeforeCommit = false;
          throw new Error('injected failure before Pack and Scene consumer commit');
        }
      }).unwrap();
const commitSelectedBodySceneConsumers = () => {
      packPublished = true;
      const nextMeshHandles: AssetHandle<'mesh'>[] = newVisibleGuids.map((guid) => stagedMeshHandles.get(guid.toLowerCase())!);
      const stagedVisibleCount = Math.max(0, newVisibleGuids.length - oldMeshEntities.length);
      const nextMeshEntities: EntityHandle[] = [...oldMeshEntities, ...stagedConsumerEntities.slice(0, stagedVisibleCount)];
      for (let index = 0; index < nextMeshHandles.length; index++) {
        const entity = nextMeshEntities[index]!;
        world.set(entity, MeshFilter, { assetHandle: nextMeshHandles[index]! }).unwrap();
        if (!oldMeshEntities.includes(entity)) world.set(entity, Transform, { pos: entry.position, scale: [...entry.scale] }).unwrap();
      }
      for (const entity of oldMeshEntities.slice(nextMeshHandles.length)) world.despawn(entity).unwrap();
      const nextVisibleGuidSet = new Set(newVisibleGuids.map((guid) => guid.toLowerCase()));
      entry.meshes.forEach((handle, index) => {
        if (!oldVisibleGuids[index] || !nextVisibleGuidSet.has(oldVisibleGuids[index]!.toLowerCase())) assets.release(handle).unwrap();
      });
      const nextDebugMeshes: BodyEntry['debugMeshes'] = [];
      for (const nextDebug of nextDebugGuids) {
        const previous = entry.debugMeshes.find((mesh) => mesh.kind === nextDebug.kind);
        const handle = previous?.guid.toLowerCase() === nextDebug.guid.toLowerCase()
          ? previous.handle
          : stagedMeshHandles.get(nextDebug.guid.toLowerCase())!;
        const entity = previous?.entity ?? stagedDebugEntities.get(nextDebug.kind);
        if (entity === undefined) throw new Error(`预检后的 ${nextDebug.kind} Scene consumer 丢失`);
        if (previous?.entity === undefined || previous.guid.toLowerCase() !== nextDebug.guid.toLowerCase())
          world.set(entity, MeshFilter, { assetHandle: handle }).unwrap();
        if (previous?.entity === undefined) world.set(entity, Transform, { pos: entry.position, scale: [...entry.scale] }).unwrap();
        nextDebugMeshes.push({ ...nextDebug, handle, entity });
      }
      for (const previous of entry.debugMeshes) {
        const replacement = nextDebugMeshes.find((mesh) => mesh.kind === previous.kind);
        if (!replacement && previous.entity !== undefined) world.despawn(previous.entity).unwrap();
        if (!replacement || replacement.guid.toLowerCase() !== previous.guid.toLowerCase()) assets.release(previous.handle).unwrap();
      }
      entry.body = nextCooked;
      entry.draftSpline = nextCooked.spline;
      entry.scale = [...entry.draftScale];
      entry.meshes = nextMeshHandles;
      entry.debugMeshes = nextDebugMeshes;
      entry.entities = [bodyEntity, ...nextMeshEntities, ...nextDebugMeshes.flatMap((mesh) => mesh.entity === undefined ? [] : [mesh.entity]), ...auxiliaryEntities];
      for (const entity of entry.entities) {
        const transform = world.get(entity, Transform).unwrap();
        world.set(entity, Transform, { ...transform, scale: [...entry.scale] }).unwrap();
      }
      physics.teleport(probe, vec3.create(...probeTargetFor(entry)));
      const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
      fitViewToBounds(meshBounds([entry]), aspect, aspect < 0.7 ? 0.95 : 0.68, aspect < 0.7 ? 0.92 : 0.62);
      status.textContent = `${entry.label} Pack publication 已完成（${generatedMeshCount} 个场景网格）；等待同代 Scene 几何、查询与 Physics 接纳`;
      updateReadout();
      applyProductMode();
      renderBodyList();};
commitSelectedBodySceneConsumers();

    } catch (cause) {
const reportSelectedBodyRecookFailure = () => {
      const detail = cause instanceof Error ? cause.message : typeof cause === 'object' && cause !== null ? JSON.stringify(cause) : String(cause);
      if (packPublished) {
        status.textContent = `Pack 已发布，但 Scene consumer transition failed; reload the Body scene before recooking: ${detail}`;
      } else {
        for (const entity of stagedConsumerEntities) if (world.get(entity, Transform).ok) world.despawn(entity).unwrap();
        status.textContent = `Pack 重建未接纳：${detail}`;
      }};
reportSelectedBodyRecookFailure();

    }
  };
  const selectedPointIndex = () => Math.max(0, Number(element<HTMLSelectElement>('#spline-point').value) || 0);
  const updateDraftPoint = (field: 'widthM' | 'depthM' | 'velocityMPerSec' | 'audioIntensity', value: number) => {
    const entry = bodies[selected];
    if (!entry || entry.body.type === 'custom' || !Number.isFinite(value) || (field === 'widthM' || field === 'depthM') && value < 0) return;
    const index = selectedPointIndex();
    const points = [...entry.draftSpline.points];
    const point = points[index];
    if (!point) return;
    points[index] = { ...point, [field]: value };
    entry.draftSpline = { ...entry.draftSpline, points };
    status.textContent = `${entry.label}控制点草稿已更新；重建后才会同步到几何、查询与 Physics`;
    updateReadout();
  };
  const editSplinePoints = (operation: 'insert' | 'copy' | 'delete') => {
    const entry = bodies[selected];
    if (!entry || entry.body.type === 'custom') return;
    const index = selectedPointIndex();
    const insertIndex = entry.draftSpline.closed && index === entry.draftSpline.points.length - 1
      ? 0
      : index === entry.draftSpline.points.length - 1 ? index : index + 1;
    const result = operation === 'insert'
      ? insertWaterSplinePointInSpline(entry.draftSpline, insertIndex, 0.5, entry.draftSpline.metadataDefaults)
      : operation === 'copy'
        ? duplicateWaterSplinePointInSpline(entry.draftSpline, index)
        : deleteWaterSplinePoint(entry.draftSpline.points, index, entry.draftSpline.closed);
    if (!result.ok) {
      status.textContent = `样条编辑失败：${result.error.hint ?? result.error.expected}`;
      return;
    }
    entry.draftSpline = { ...entry.draftSpline, points: result.value };
    element<HTMLSelectElement>('#spline-point').value = String(operation === 'delete' ? Math.max(0, index - 1) : operation === 'insert' ? insertIndex : Math.min(index, result.value.length - 1));
    status.textContent = operation === 'copy'
      ? `${entry.label}控制点已复制；可编辑 XYZ 坐标，重建后同步派生数据`
      : `${entry.label}样条草稿已更新；重建后才会同步到几何、查询与 Physics`;
    updateReadout();
  };
  const setExclusion = (enabled: boolean) => {
    const entry = bodies[selected];
    if (!entry) return;
    if (!enabled) {
      if (exclusionEntity !== undefined) world.despawn(exclusionEntity).unwrap();
      if (exclusionMeshEntity !== undefined) world.despawn(exclusionMeshEntity).unwrap();
      exclusionEntity = undefined;
      exclusionMeshEntity = undefined;
      exclusionEnabled = false;
      status.textContent = '水体排除盒已移除';
      return;
    }
    if (exclusionEntity !== undefined) world.despawn(exclusionEntity).unwrap();
    if (exclusionMeshEntity !== undefined) world.despawn(exclusionMeshEntity).unwrap();
    const bodyEntity = entry.entities[0]!;
    const exclusionCenter = probeTargetFor(entry);
    exclusionEntity = world.spawn(
      { component: Transform, data: { pos: exclusionCenter, scale: [8, 4, 8] } },
      { component: WaterExclusionVolume, data: { mode: WaterExclusionMode.addListedBodiesToExclusion, waterBodies: [bodyEntity], centerM: [0, 0, 0], halfExtentsM: [0.5, 0.5, 0.5] } },
    ).unwrap();
    exclusionMeshEntity = world.spawn(
      { component: Transform, data: { pos: [exclusionCenter[0], exclusionCenter[1] + 1.3, exclusionCenter[2]], scale: [8, 4, 8] } },
      { component: MeshFilter, data: { assetHandle: exclusionMesh } },
      { component: MeshRenderer, data: { materials: [exclusionMaterial] } },
    ).unwrap();
    exclusionEnabled = true;
    status.textContent = `${entry.label}的 WaterExclusionVolume 已接入 Scene 查询与 Physics 更新`;
  };
  const physics = world.getResource(PhysicsWorldResource);
  const renderBodyList = () => {
    const list = element<HTMLUListElement>('#body-list');
    list.replaceChildren(...bodies.map((entry, index) => {
      const row = document.createElement('li');
      row.className = 'body-row';
      row.dataset.type = entry.body.type;
      const focus = document.createElement('button');
      focus.className = 'body-focus';
      focus.type = 'button';
      focus.setAttribute('aria-pressed', String(selected === index));
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.backgroundColor = entry.color;
      const title = document.createElement('span');
      title.className = 'body-name';
      title.textContent = entry.label;
      const detail = document.createElement('span');
      detail.className = 'body-detail';
      detail.textContent = `${entry.body.spline.points.length} 个控制点 · ${entry.meshes.length} 个网格`;
      focus.append(swatch, title, detail);
      focus.addEventListener('click', () => {
        selected = index;
        const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
        fitViewToBounds(meshBounds([entry]), aspect, aspect < 0.7 ? 0.95 : 0.68, aspect < 0.7 ? 0.92 : 0.62);
        if (physics.hasBody(probe)) physics.teleport(probe, vec3.create(...probeTargetFor(entry)));
        if (exclusionEnabled) setExclusion(true);
        updateReadout();
        renderBodyList();
        applyProductMode();
        applyView();
      });
      const visibility = document.createElement('button');
      visibility.className = 'visibility';
      visibility.type = 'button';
      visibility.setAttribute('aria-label', `${entry.visible ? '隐藏' : '显示'}${entry.label}`);
      visibility.setAttribute('aria-pressed', String(entry.visible));
      visibility.title = `${entry.visible ? '隐藏' : '显示'}${entry.label}`;
      visibility.textContent = entry.visible ? '●' : '○';
      visibility.addEventListener('click', () => {
        entry.visible = !entry.visible;
        updateReadout();
        renderBodyList();
        applyProductMode();
      });
      row.append(focus, visibility);
      return row;
    }));
  };
  updateReadout();
  renderBodyList();
  applyProductMode();
  fitViewToBodies();
  const updatePhysicsReadout = () => {
    const entry = bodies[selected];
    const selectedBodyEntity = entry?.entities[0];
    const refreshSelectedCollision = () => {
      if (entry && selectedBodyEntity !== undefined) {
        const bodyGuid = `scene-entity:${selectedBodyEntity}`;
        const receipt = physics.getDerivedCollisionReceipt?.(selectedBodyEntity);
        const expectedSourceKey = `water:${bodyGuid}`;
        const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
        const snapshot = water.snapshot(bodyGuid);
        const collisionGeneration = snapshot?.outputGenerations.collision;
        const hasReceipt = receipt?.sourceKey === expectedSourceKey && receipt.shapes.length > 0;
        const receiptCurrent = hasReceipt && receipt.publication.revision === collisionGeneration;
        element('#collision-state').textContent = hasReceipt
          ? `Physics rev ${receipt.publication.revision} · Water G${collisionGeneration ?? '—'} · ${receiptCurrent ? '已同步' : '旧碰撞'}`
          : entry.body.collision.enabled
            ? `Water G${collisionGeneration ?? '—'} · 等待 Physics 接纳`
            : '此水体未启用碰撞';
        const geometry = snapshot?.asset.geometrySnapshot;
        const geometryState = snapshot?.outputs.geometry;
        element('#geometry-state').textContent = snapshot
          ? `G${snapshot.outputGenerations.geometry} ${snapshot.asset.geometrySnapshot ? '已 Cook' : '未 Cook'} · ${geometryState === 'ready' ? '消费已接纳' : snapshot.dirty.has('geometry') ? '消费待接纳' : '未请求'}`
          : '等待挂载';
        const excluded = water.isPointExcluded(bodyGuid, entry.position);
        element('#query-state').textContent = snapshot
          ? `Q${snapshot.outputGenerations.query} ${geometry ? '已 Cook' : '未 Cook'} · ${snapshot.outputs.query === 'ready' ? '查询已接纳' : snapshot.dirty.has('query') ? '查询待消费' : '未请求'} · ${geometry?.queryFootprint.outer.length ?? 0} 点 · ${excluded ? '已排除' : '未排除'}`
          : '等待挂载';
      }
    };
    refreshSelectedCollision();

    const refreshContactReadout = () => {
      const contacts = physics.getCurrentContacts?.(probe);
      const selectedReceipt =
        selectedBodyEntity === undefined
          ? undefined
          : physics.getDerivedCollisionReceipt?.(selectedBodyEntity);
      const hasSelectedCollider =
        selectedReceipt?.sourceKey === `water:scene-entity:${selectedBodyEntity}` &&
        selectedReceipt.shapes.length > 0;
      const selectedWaterSnapshot =
        selectedBodyEntity === undefined
          ? undefined
          : world
              .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
              .snapshot(`scene-entity:${selectedBodyEntity}`);
      const selectedReceiptCurrent =
        hasSelectedCollider &&
        selectedReceipt.publication.revision === selectedWaterSnapshot?.outputGenerations.collision;
      const waterContacts =
        contacts?.ok && selectedBodyEntity !== undefined
          ? contacts.value.manifolds.filter((manifold) => manifold.other === selectedBodyEntity).length
          : 0;
      element('#contact-state').textContent = !hasSelectedCollider
        ? '此水体无物理碰撞'
        : contacts?.ok
          ? `${waterContacts} 个所选水体接触 · ${selectedReceiptCurrent ? '当前' : `旧 rev ${selectedReceipt!.publication.revision}`}`
          : physics.hasBody(probe)
            ? '等待接触'
            : '启动中';
      const sceneStatus = world.getResource(WATER_SCENE_STATUS_RESOURCE);
      const collisionFailure = sceneStatus.waterCollisionFailures.find(
        (failure) => failure.entity === selectedBodyEntity,
      );
      const geometryRecook = sceneStatus.waterGeometryRecookRequired.find(
        (failure) => failure.entity === selectedBodyEntity,
      );
      element('#physics-detail').textContent = collisionFailure
        ? `${collisionFailure.stage} ${collisionFailure.code ?? collisionFailure.reason}: ${collisionFailure.hint ?? collisionFailure.expected ?? ''}`
        : geometryRecook
          ? `几何需重建：${geometryRecook.hint}`
          : hasSelectedCollider
            ? `Physics rev ${selectedReceipt!.publication.revision} · Water G${selectedWaterSnapshot?.outputGenerations.collision ?? '—'} · ${selectedReceiptCurrent ? '当前接纳' : '旧 receipt'} · ${selectedReceipt!.sourceKey} · ${selectedReceipt!.shapes.length} 个碰撞形状`
            : '等待所选水体的 Physics 候选接纳';
    };
    refreshContactReadout();

  };
  world.addSystem(Update, defineSystem({ name: 'water-body-physics-readout', queries: [], fn: updatePhysicsReadout })).unwrap();
  element<HTMLButtonElement>('#recook').addEventListener('click', recookSelectedBody);
  element<HTMLElement>('#product-switch').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-product]');
    const mode = button?.dataset.product;
    if (mode !== 'visible' && mode !== 'water-info' && mode !== 'dilated') return;
    productMode = mode;
    applyProductMode();
  });
  element<HTMLInputElement>('#height-offset').addEventListener('input', (event) => {
    element<HTMLOutputElement>('#height-value').textContent = `${Number((event.currentTarget as HTMLInputElement).value).toFixed(2)} m`;
  });
  element<HTMLInputElement>('#shape-dilation').addEventListener('input', (event) => {
    element<HTMLOutputElement>('#dilation-value').textContent = `${Number((event.currentTarget as HTMLInputElement).value).toFixed(2)} m`;
  });
  element<HTMLSelectElement>('#spline-point').addEventListener('change', updateReadout);
  element<HTMLButtonElement>('#point-insert').addEventListener('click', () => editSplinePoints('insert'));
  element<HTMLButtonElement>('#point-copy').addEventListener('click', () => editSplinePoints('copy'));
  element<HTMLButtonElement>('#point-delete').addEventListener('click', () => editSplinePoints('delete'));
  for (const [selector, field] of [
    ['#point-width', 'widthM'],
    ['#point-depth', 'depthM'],
    ['#point-velocity', 'velocityMPerSec'],
    ['#point-audio', 'audioIntensity'],
  ] as const) {
    element<HTMLInputElement>(selector).addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      if (input.value.trim() === '') {
        updateReadout();
        return;
      }
      updateDraftPoint(field, Number(input.value));
    });
  }
  for (const [selector, axis] of [['#scale-x', 0], ['#scale-y', 1], ['#scale-z', 2]] as const) {
    element<HTMLInputElement>(selector).addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const value = Number(input.value);
      const entry = bodies[selected];
      if (!entry || entry.body.type === 'custom' || !Number.isFinite(value) || value < 0.1 || value > 4) {
        updateReadout();
        return;
      }
      entry.draftScale[axis] = value;
      status.textContent = `${entry.label}场景缩放草稿已更新；重建会以同一 authoring transform 重新 Cook 几何、查询与 Physics`;
    });
  }
  for (const [selector, axis] of [['#point-x', 0], ['#point-y', 1], ['#point-z', 2]] as const) {
    element<HTMLInputElement>(selector).addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const value = Number(input.value);
      const entry = bodies[selected];
      if (!entry || entry.body.type === 'custom' || input.value.trim() === '' || !Number.isFinite(value)) {
        updateReadout();
        return;
      }
      const points = [...entry.draftSpline.points];
      const index = selectedPointIndex();
      const point = points[index];
      if (!point) return;
      const positionM = [...point.positionM] as [number, number, number];
      positionM[axis] = value;
      points[index] = { ...point, positionM };
      entry.draftSpline = { ...entry.draftSpline, points };
      status.textContent = `${entry.label}控制点位置草稿已更新；重建后同步几何、查询与 Physics`;
      updateReadout();
    });
  }
  element<HTMLButtonElement>('#exclusion').addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    setExclusion(!exclusionEnabled);
    button.setAttribute('aria-pressed', String(exclusionEnabled));
    button.textContent = exclusionEnabled ? '移除排除盒' : '添加排除盒';
  });
  element<HTMLButtonElement>('#raycast').addEventListener('click', () => {
    const entry = bodies[selected];
    if (!entry) return;
    const bodyEntity = entry.entities[0]!;
    const expectedSourceKey = `water:scene-entity:${bodyEntity}`;
    const receipt = physics.getDerivedCollisionReceipt?.(bodyEntity);
    if (!receipt || receipt.sourceKey !== expectedSourceKey || receipt.shapes.length === 0) {
      element('#raycast-state').textContent = '该水体无已接纳碰撞';
      status.textContent = `${entry.label}没有当前接纳的派生 Physics 碰撞体`;
      return;
    }
    const probePoint = probeTargetFor(entry);
    const snapshot = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE).snapshot(`scene-entity:${bodyEntity}`);
    const receiptCurrent = receipt.publication.revision === snapshot?.outputGenerations.collision;
    const hit = physics.raycast(vec3.create(probePoint[0] + 1.2, 24, probePoint[2]), vec3.create(0, -1, 0), 60);
    if (hit?.entity !== bodyEntity) {
      element('#raycast-state').textContent = hit ? `其他实体 ${hit.entity}` : '未命中';
      status.textContent = hit ? `最近命中实体 ${hit.entity}，不是 ${entry.label} 的碰撞体` : 'Physics 场景射线没有命中';
      return;
    }
    element('#raycast-state').textContent = `${hit.point[1]!.toFixed(2)} m · Physics rev ${receipt.publication.revision} · ${receiptCurrent ? '当前' : '旧碰撞'}`;
    status.textContent = `射线命中 ${entry.label} 的 Physics receipt rev ${receipt.publication.revision}${receiptCurrent ? '' : `（Water 当前 G${snapshot?.outputGenerations.collision ?? '—'}）`}，shape rev ${receipt.shapes.map((shape) => shape.revision).join(', ')}，交点高度 ${hit.point[1]!.toFixed(2)} m`;
  });
  canvas.addEventListener('pointerdown', (event) => { dragging = true; previous = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    yaw += (event.clientX - previous.x) * 0.006;
    pitch = Math.max(0.18, Math.min(1.2, pitch + (event.clientY - previous.y) * 0.004));
    previous = { x: event.clientX, y: event.clientY };
    applyView();
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    distance = Math.max(22, Math.min(62, distance + event.deltaY * 0.025));
    applyView();
  }, { passive: false });
  element('#reset-view').addEventListener('click', () => fitViewToBodies());
  element('#show-all').addEventListener('click', () => {
    for (const entry of bodies) {
      entry.visible = true;
    }
    updateReadout();
    renderBodyList();
    applyProductMode();
    fitViewToBodies();
  });
  element<HTMLButtonElement>('#panels').addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const hidden = document.body.classList.toggle('panel-hidden');
    button.setAttribute('aria-expanded', String(!hidden));
    button.title = hidden ? '显示面板' : '隐藏面板';
    button.textContent = hidden ? '显示面板' : '面板';
    document.body.dataset.panelsVisible = String(!hidden);
  });

  app.renderer.subscribe((event) => {
    if (event.kind === 'error') {
      renderState.textContent = '渲染错误';
      status.textContent = `渲染器错误：${event.error.code}`;
      document.body.dataset.error = event.error.code;
    } else if (event.kind === 'frame-submitted') {
      void event.receipt.completed.then((result) => {
        if (!result.ok) {
          renderState.textContent = '设备错误';
          status.textContent = `设备错误：${result.error.code}`;
          return;
        }
        const count = Number(frames.textContent) + 1;
        frames.textContent = String(count);
        document.body.dataset.frames = String(count);
      });
    }
  });
  window.addEventListener('resize', () => {
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));
    const aspect = canvas.width / canvas.height;
    world.set(camera, Camera, { aspect, fov: cameraFovForAspect(aspect) }).unwrap();
    fitViewToBodies(aspect);
  });
  renderState.textContent = '运行中';
  element('#pack-state').textContent = '已加载';
  status.textContent = '四类水体与 Pack 水面材质已加载';
  document.body.dataset.bodyCount = String(bodies.length);
  document.body.dataset.panelsVisible = 'true';
  document.body.dataset.ready = 'true';
  if (new URLSearchParams(location.search).has('smoke')) Object.assign(window, { __waterBodyDemo: {
    app, world, bodies, camera, probe, Disabled, MeshFilter, validateWaterAsset, buildWaterPhysicsCandidateInput,
    injectNextRecookFailureBeforeCommit: () => { failNextRecookBeforeCommit = true; },
    setProductEvidenceView: (bodyIndex: number | null) => {
      let evidenceBounds: { min: number[]; max: number[] } | undefined;
      bodies.forEach((entry, index) => { entry.visible = bodyIndex === null || index === bodyIndex; });
      if (bodyIndex === null) {
        if (world.hasComponent(groundEntity, Disabled)) world.removeComponent(groundEntity, Disabled).unwrap();
      } else {
        if (!world.hasComponent(groundEntity, Disabled)) world.addComponent(groundEntity, { component: Disabled, data: {} }).unwrap();
        const entry = bodies[bodyIndex];
        if (entry) {
          const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
          for (const debugMesh of entry.debugMeshes) {
          const positions = assets.read(debugMesh.handle as AssetHandle<'mesh', MeshAsset>).unwrap().attributes.position;
          if (!(positions instanceof Float32Array)) continue;
            for (let index = 0; index < positions.length; index += 3) for (let axis = 0; axis < 3; axis++) {
              const value = (positions[index + axis] ?? 0) * entry.scale[axis]!;
              bounds.min[axis] = Math.min(bounds.min[axis]!, value);
              bounds.max[axis] = Math.max(bounds.max[axis]!, value);
            }
          }
          if (bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite)) {
            const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
            const worldBounds = { min: bounds.min.map((value, axis) => value + entry.position[axis]!), max: bounds.max.map((value, axis) => value + entry.position[axis]!) };
            evidenceBounds = worldBounds;
            fitViewToBounds(worldBounds, aspect, aspect < 0.7 ? 0.95 : 0.68, aspect < 0.7 ? 0.92 : 0.62);
          }
        }
      }
      const setEvidenceEntityVisible = (entity: EntityHandle | undefined, visible: boolean) => {
        if (entity === undefined) return;
        if (visible && world.hasComponent(entity, Disabled)) world.removeComponent(entity, Disabled).unwrap();
        else if (!visible && !world.hasComponent(entity, Disabled)) world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
      };
      setEvidenceEntityVisible(probe, bodyIndex === null);
      setEvidenceEntityVisible(exclusionMeshEntity, bodyIndex === null && exclusionEnabled);
      applyProductMode();
      updateReadout();
      renderBodyList();
      return bodyIndex === null ? undefined : { bounds: evidenceBounds, target: [...target], distance };
    },
  } });
  app.start().unwrap();
  window.addEventListener('pagehide', () => void app.dispose(), { once: true });
};

void main().catch((error: unknown) => {
  renderState.textContent = '启动失败';
  status.textContent = `启动错误：${error instanceof Error ? error.message : String(error)}`;
  document.body.dataset.error = 'water-body-geometry-startup';
  console.error(error);
});
