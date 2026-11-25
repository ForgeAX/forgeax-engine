import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { copyMeshAttribute } from '@forgeax/engine-geometry';
import {
  ClippingPlanes,
  Instances,
  Layer,
  MeshFilter,
  MeshRenderer,
  DirectionalLight as NativeDirectional,
  PointLight as NativePoint,
  PointLightShadow as NativePointShadow,
  Points as NativePoints,
  SpotLight as NativeSpot,
  ShadowParticipation,
} from '@forgeax/engine-render';
import { ChildOf, GlobalTransform, MorphWeights, Name } from '@forgeax/engine-scene';
import { SynchronousTransform } from '@forgeax/engine-scene/internal';
import { Skin } from '@forgeax/engine-skinning';
import { ClippingGroup } from 'three/src/objects/ClippingGroup.js';
import {
  AmbientLight,
  Bone,
  BoxGeometry,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  LOD,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  RectAreaLight,
  Scene,
  Skeleton,
  SkinnedMesh,
  SpotLight,
  Sprite,
  SpriteMaterial,
  Uint16BufferAttribute,
} from 'three/src/Three.Core.js';
import { expect, it, vi } from 'vitest';
import { installDefaultAssetDecoders } from '../../../runtime/src/asset-contributions';
import { cameraData } from '../camera';
import * as geometryProjection from '../geometry';
import { MeshBasicNodeMaterial } from '../node-materials';
import {
  bindThreeSurface,
  clearSurfaceProgramSelection,
  normalizeThreeSurface,
} from '../node-surface';
import { SceneProjection } from '../scene';
import { SharedAssets } from '../shared-assets';
import { type JointSnapshots, projectJoints } from '../skinning';
import { SceneChanges, setThreeSceneTracking } from '../source-changes';
import {
  enableThreeSourceTracking,
  ownedCollection,
  publishWorldMatrix,
  watchTargetMatrix,
} from '../source-collections';
import { observeField, observeScale, releaseField } from '../source-fields';
import {
  bindSourceWorldPose,
  reflectSourceWorldPose,
  resolveSourceWorldPose,
} from '../source-world-pose';
import { reference, texture, uniform, uv, vec4 } from '../tsl';

it('rebinds a mesh without enrolling its source or its children again', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const geometry = new BoxGeometry();
  const first = new MeshBasicMaterial({ color: 0xff0000 });
  const second = new MeshBasicMaterial({ color: 0x00ff00 });
  const parent = new Mesh(geometry, first);
  const child = new Mesh(geometry, first);
  child.position.x = 1;
  parent.add(child);
  scene.add(parent);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      ecsPoses: true,
      updateMatrices: true,
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
      nativeTransparentOrder: true,
    });
  const enroll = vi.spyOn(SceneChanges.prototype, 'registerNode');
  try {
    sync();
    sync();
    const parentEntity = projection.entityFor(parent);
    const childEntity = projection.entityFor(child);
    if (parentEntity === undefined || childEntity === undefined)
      throw new Error('Missing projected mesh');
    const material = () => projection.world.get(parentEntity, MeshRenderer).unwrap().materials[0];
    const prior = material();

    enroll.mockClear();
    parent.material = second;
    parent.position.x = 2;
    sync();
    expect(enroll).not.toHaveBeenCalled();
    expect(projection.entityFor(child)).toBe(childEntity);
    expect(projection.world.get(childEntity, GlobalTransform).unwrap().world[12]).toBe(3);
    expect(material()).not.toBe(prior);
    expect(projection.world.get(childEntity, MeshRenderer).unwrap().materials[0]).toBe(prior);

    second.dispose();
    sync();
    expect(enroll).not.toHaveBeenCalled();
    expect(projection.world.get(childEntity, MeshRenderer).unwrap().materials[0]).toBe(prior);
  } finally {
    enroll.mockRestore();
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    first.dispose();
    second.dispose();
  }
});

it('keeps unaffected source-order view paths across binding admission', () => {
  const root = new Scene();
  const left = new Group();
  const right = new Group();
  const resident = new Mesh();
  const residual = new Mesh();
  left.add(resident);
  right.add(residual);
  root.add(left, right);
  const changes = new SceneChanges(root, [], 1, undefined, true, true);
  const canSkip = (node: object) => node !== residual;
  try {
    changes.index(root, canSkip);
    const paths = changes.residualChildren();
    const rightPath = paths.get(right);
    expect(paths.get(root)).toEqual([right]);
    expect(rightPath).toEqual([residual]);

    changes.invalidateBinding(resident);
    changes.reconcile();
    const rebinding = changes.residualChildren();
    expect(rebinding.get(root)).toEqual([left, right]);
    expect(rebinding.get(left)).toEqual([resident]);
    expect(rebinding.get(right)).toBe(rightPath);

    changes.promote(canSkip);
    const promoted = changes.residualChildren();
    expect(promoted.get(root)).toEqual([right]);
    expect(promoted.has(left)).toBe(false);
    expect(promoted.get(right)).toBe(rightPath);

    left.add(residual);
    changes.reconcile();
    changes.promote(canSkip);
    const moved = changes.residualChildren();
    expect(moved.get(root)).toEqual([left]);
    expect(moved.get(left)).toEqual([residual]);
    expect(moved.has(right)).toBe(false);
  } finally {
    changes.dispose();
  }
});

it('keeps ordered residual siblings when a middle binding repeatedly changes', () => {
  const root = new Scene();
  const children = Array.from({ length: 256 }, () => new Mesh());
  const middle = children[120];
  const tail = children[255];
  if (!middle || !tail) throw new Error('Missing roster fixture');
  root.add(...children);
  const stop = enableThreeSourceTracking();
  root.children = ownedCollection(root.children);
  stop();
  const changes = new SceneChanges(root, [], 1, undefined, true, true);
  const canSkip = (node: object) => node !== tail;
  try {
    changes.index(root, canSkip);
    expect(changes.residualChildren().get(root)).toEqual([tail]);
    for (let i = 0; i < 3; i++) {
      changes.rosterEntries = 0;
      changes.invalidateBinding(middle);
      changes.reconcile();
      expect(changes.residualChildren().get(root)).toEqual([middle, tail]);
      changes.promote(canSkip);
      expect(changes.residualChildren().get(root)).toEqual([tail]);
      if (i > 0) expect(changes.rosterEntries).toBeLessThan(16);
    }
    root.children.reverse();
    changes.invalidateBinding(middle);
    changes.reconcile();
    expect(changes.residualChildren().get(root)).toEqual([tail, middle]);
  } finally {
    changes.dispose();
  }
});

it('creates separate stock material instances from an admitted definition', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const geometry = new BoxGeometry();
  const source = new MeshStandardMaterial({ emissive: 0xff0000, emissiveIntensity: 2 });
  const instance = new MeshStandardMaterial({ emissive: 0x00ff00, emissiveIntensity: 7 });
  const firstMesh = new Mesh(geometry, source);
  const secondMesh = new Mesh(geometry, instance);
  const copy = vi.spyOn(assets, 'copy');
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  const handle = (mesh: Mesh) => {
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('Missing projected mesh');
    const material = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    if (material === undefined) throw new Error('Missing projected material');
    return material;
  };
  try {
    scene.add(firstMesh);
    sync();
    const first = handle(firstMesh);
    scene.add(secondMesh);
    sync();
    const second = handle(secondMesh);
    expect(copy).toHaveBeenCalledWith(first);
    expect(second).not.toBe(first);
    expect(assets.read(second).unwrap()).toMatchObject({
      values: { emissive: [0, 1, 0], emissiveIntensity: 7 },
    });
    instance.emissiveIntensity = 12;
    sync();
    expect(assets.read(first).unwrap()).toMatchObject({ values: { emissiveIntensity: 2 } });
    expect(assets.read(second).unwrap()).toMatchObject({ values: { emissiveIntensity: 12 } });
  } finally {
    copy.mockRestore();
    projection.dispose();
    assets.dispose();
    source.dispose();
    instance.dispose();
    geometry.dispose();
  }
});

it('publishes observed node fields without reading unchanged ECS components', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const group = new Group();
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  scene.add(group);
  group.add(mesh);
  setThreeSceneTracking(scene, true);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    const groupEntity = projection.entityFor(group);
    const meshEntity = projection.entityFor(mesh);
    const sceneEntity = projection.entityFor(scene);
    if (groupEntity === undefined || meshEntity === undefined || sceneEntity === undefined)
      throw new Error('Missing projected node');
    const reads = vi.spyOn(projection.world, 'get');
    const writes = vi.spyOn(projection.world, 'set');
    sync();
    expect(reads.mock.calls.some(([e, c]) => e === sceneEntity && c === Name)).toBe(false);
    expect(reads.mock.calls.some(([e, c]) => e === meshEntity && c === ShadowParticipation)).toBe(
      false,
    );
    group.name = 'changed in place';
    mesh.receiveShadow = true;
    sync();
    expect(writes.mock.calls.filter(([e, c]) => e === groupEntity && c === Name)).toHaveLength(1);
    expect(projection.world.get(groupEntity, Name).unwrap().value).toBe(group.name);
    expect(projection.world.get(meshEntity, ShadowParticipation).unwrap().receive).toBe(true);
    writes.mockClear();
    sync();
    expect(writes.mock.calls.some(([e, c]) => e === meshEntity && c === ShadowParticipation)).toBe(
      false,
    );
    expect(writes.mock.calls.some(([e, c]) => e === groupEntity && c === Name)).toBe(false);
  } finally {
    vi.restoreAllMocks();
    projection.dispose();
    assets.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});

it('retains a cooked draw and patches only the changed surface inputs', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const material = new MeshBasicNodeMaterial({ transparent: true });
  const tint = { color: new Color(0.25, 0.5, 0.75) };
  const gain = uniform(0.5);
  const image = new DataTexture(Uint8Array.of(100, 100, 100, 255), 1, 1);
  image.needsUpdate = true;
  const sampled = texture(image, uv());
  material.colorNode = sampled.mul(vec4(reference('color', 'color', tint), gain));
  const graph = normalizeThreeSurface(material).unwrap();
  const projection = new SceneProjection(assets, undefined, (material) => {
    clearSurfaceProgramSelection(material);
    if (material.parent !== undefined) return material;
    return { ...material, parameters: [...(material.parameters ?? []), ...graph.parameters] };
  });
  const recipe = {
    version: 'three-r187-surface/1',
    graphKey: graph.graphKey,
    programGuid: `forgeax-three-surface-${'a'.repeat(64)}`,
  } as const;
  bindThreeSurface(material, recipe).unwrap();
  const mesh = new Mesh(new PlaneGeometry(), material);
  mesh.renderOrder = 5;
  scene.add(mesh);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      depth: true,
      stencil: true,
      sortObjects: true,
      nativeTransparentOrder: true,
      opaque: true,
      transparent: true,
      updateMatrices: true,
    });
  const handle = () => {
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('Missing projected mesh');
    const material = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    if (!material) throw new Error('Missing projected material');
    return material;
  };
  const materialValues = () => assets.read(handle()).unwrap().values;
  try {
    sync();
    sync();
    const first = handle();
    expect(projection.sourceWork()).toMatchObject({
      mode: 'tracked',
      meshPlans: 0,
      materialUses: 0,
    });
    const updates = vi.spyOn(assets, 'update');
    gain.value = 0.75;
    sync();
    expect(updates).toHaveBeenCalledExactlyOnceWith(first, { values: { threeInput1: 0.75 } });
    expect(materialValues()?.threeInput1).toBe(0.75);
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0, materialUses: 0 });

    updates.mockClear();
    tint.color.g = 0.625;
    sync();
    expect(updates).toHaveBeenCalledExactlyOnceWith(first, {
      values: { threeInput0: [0.25, 0.625, 0.75] },
    });
    const oldBinding = materialValues()?.threeTexture0;
    const replacement = new DataTexture(Uint8Array.of(25, 50, 75, 255), 1, 1);
    replacement.needsUpdate = true;
    sampled.value = replacement;
    sync();
    expect(handle()).toBe(first);
    expect(materialValues()?.threeTexture0).not.toEqual(oldBinding);
    expect(materialValues()?.threeInput1).toBe(0.75);
    bindThreeSurface(material, recipe).unwrap();
    sync();
    sync();
    expect(projection.sourceWork()).toMatchObject({
      mode: 'tracked',
      meshPlans: 0,
      materialUses: 0,
    });
    gain.value = Number.NaN;
    expect(sync).toThrow('live input type/value changed');
    gain.value = 0.5;
    sync();
    expect(materialValues()?.threeInput1).toBe(0.5);
  } finally {
    vi.restoreAllMocks();
    projection.dispose();
    assets.dispose();
  }
});

it('publishes point content edits without rebinding material observers', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const geometry = new BufferGeometry();
  const position = new Float32BufferAttribute([0, 0, 0, 0.5, 0, 0], 3);
  const color = new Float32BufferAttribute([1, 0, 0, 0, 1, 0], 3);
  geometry.setAttribute('position', position);
  geometry.setAttribute('color', color);
  const material = new PointsMaterial({ transparent: true, vertexColors: true });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      depth: true,
      stencil: false,
      sortObjects: true,
      nativeTransparentOrder: true,
      opaque: true,
      transparent: true,
      updateMatrices: true,
    });
  const watchUse = vi.spyOn(SceneChanges.prototype, 'watchUse');
  const repack = vi.spyOn(geometryProjection, 'repackPointContent');
  const observer = assets.observe().unwrap();
  try {
    sync();
    const entity = projection.entityFor(points);
    if (entity === undefined) throw new Error('Missing projected points');
    const meshHandle = () => projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    const readMesh = () => assets.read(meshHandle()).unwrap();
    const handle = meshHandle();
    const readPosition = () => copyMeshAttribute(readMesh(), 'position');
    const initial = readMesh();
    expect(watchUse).toHaveBeenCalled();
    expect(readPosition()?.[0]).toBe(0);
    observer.read().unwrap().accept();

    watchUse.mockClear();
    position.setX(0, 0.25);
    position.needsUpdate = true;
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0, materialUses: 0 });
    expect(readPosition()?.[0]).toBe(0.25);
    const moved = readMesh();
    expect(meshHandle()).toBe(handle);
    const movedEdits = observer.read().unwrap();
    expect(movedEdits.changes).toContainEqual(
      expect.objectContaining({
        handle,
        fields: ['aabb'],
        ranges: [expect.objectContaining({ path: ['vertices'], rowBytes: 12 })],
      }),
    );
    movedEdits.accept();
    expect(moved.indices).toEqual(initial.indices);
    expect(moved.aabb?.[0]).toBe(0.25);
    expect(initial.aabb?.[0]).toBe(0);
    expect(copyMeshAttribute(moved, 'normal')).toEqual(copyMeshAttribute(initial, 'normal'));
    expect(copyMeshAttribute(moved, 'color')).toEqual(copyMeshAttribute(initial, 'color'));
    expect(repack).not.toHaveBeenCalled();
    expect(watchUse).not.toHaveBeenCalled();

    color.setXYZ(0, 0, 0, 1);
    color.needsUpdate = true;
    // A color notification does not authorize an unannounced position edit.
    position.setX(0, 0.375);
    sync();
    expect(readPosition()?.[0]).toBe(0.25);
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0, materialUses: 0 });
    expect(copyMeshAttribute(readMesh(), 'color')).toEqual(
      new Float32Array([0, 0, 1, 1, 0, 1, 0, 1]),
    );
    expect(copyMeshAttribute(initial, 'color')).toEqual(new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]));
    expect(meshHandle()).toBe(handle);
    const colorEdits = observer.read().unwrap();
    expect(colorEdits.changes).toContainEqual(
      expect.objectContaining({
        handle,
        fields: [],
        ranges: [expect.objectContaining({ path: ['vertices'], rowBytes: 16 })],
      }),
    );
    colorEdits.accept();
    expect(repack).not.toHaveBeenCalled();

    geometry.setDrawRange(1, 1);
    sync();
    expect(readMesh().indices).toEqual(new Uint16Array([1]));
    expect(repack).not.toHaveBeenCalled();
    geometry.setDrawRange(0, Infinity);
    sync();
    expect(readMesh().indices).toEqual(initial.indices);
    watchUse.mockClear();

    camera.fov = 60;
    camera.updateProjectionMatrix();
    position.needsUpdate = true;
    sync();
    camera.position.x = 0.1;
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0 });
    expect(watchUse).not.toHaveBeenCalled();

    points.frustumCulled = true;
    position.setX(0, 0.375);
    position.needsUpdate = true;
    sync();
    expect(readPosition()?.[0]).toBe(0.375);
    expect(watchUse).toHaveBeenCalled();

    repack.mockClear();
    const getX = position.getX.bind(position);
    position.getX = (index) => getX(index) + 0.125;
    position.needsUpdate = true;
    sync();
    expect(readPosition()?.[0]).toBe(0.5);
    expect(repack).not.toHaveBeenCalled();
  } finally {
    repack.mockRestore();
    watchUse.mockRestore();
    observer.dispose();
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    material.dispose();
  }
});

it('skips resident meshes and matrices and updates shared colors and the moved branch', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const shared = new Color(1, 0, 0);
  const mat = new MeshBasicMaterial(),
    other = new MeshStandardMaterial();
  mat.color = other.color = shared;
  const geometry = new BoxGeometry(),
    group = new Group();
  scene.add(group);
  const meshes = Array.from({ length: 64 }, (_, i) => new Mesh(geometry, i % 2 ? mat : other));
  group.add(...meshes);
  const [first, second] = meshes;
  if (!first || !second) throw new Error('Missing test meshes');
  const entityFor = (mesh: Mesh) => {
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('Missing projected mesh');
    return entity;
  };
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  const meshColor = (mesh: Mesh) => {
    const handle = projection.world.get(entityFor(mesh), MeshRenderer).unwrap().materials[0];
    if (!handle) throw new Error('Missing projected material');
    return assets.read(handle).unwrap().values?.baseColor;
  };
  setThreeSceneTracking(scene, true);
  try {
    sync();
    const materialRead = vi.spyOn(
      projection as unknown as { planMesh(...args: unknown[]): void },
      'planMesh',
    );
    sync();
    expect(projection.sourceWork()).toMatchObject({
      mode: 'tracked',
      sourceNodes: 0,
      poseChanges: 0,
    });
    expect(materialRead).not.toHaveBeenCalled();
    first.position.x = 0.1;
    shared.g = 0.5;
    sync();
    expect(materialRead).not.toHaveBeenCalled();
    expect(meshColor(first)).toEqual([1, 0.5, 0, 1]);
    expect(meshColor(second)).toEqual([1, 0.5, 0, 1]);
    const entity = entityFor(first);
    expect(projection.world.get(entity, GlobalTransform).unwrap().world[12]).toBeCloseTo(0.1);
    group.position.x = 0.3;
    sync();
    expect(projection.world.get(entity, GlobalTransform).unwrap().world[12]).toBeCloseTo(0.4);
    other.color = new Color(0, 0, 1);
    sync();
    shared.r = 0.25;
    sync();
    expect(meshColor(first)).toEqual([0, 0, 1, 1]);
    expect(meshColor(second)).toEqual([0.25, 0.5, 0, 1]);
    group.remove(first);
    sync();
    expect(projection.entityFor(first)).toBeUndefined();
    expect(projection.world.get(entityFor(second), MeshFilter).unwrap().assetHandle).not.toBe(0);
  } finally {
    vi.restoreAllMocks();
    projection.dispose();
    assets.dispose();
  }
  expect(Object.getOwnPropertyDescriptor(shared, 'r')?.value).toBe(0.25);
});

it('delivers shared edits independently and restores observation after the final consumer', () => {
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 3;
  const material = new MeshBasicMaterial(),
    mesh = new Mesh(new BoxGeometry(), material);
  scene.add(mesh);
  setThreeSceneTracking(scene, true);
  const consumers = Array.from({ length: 2 }, () => {
    const assets = new AssetRegistry();
    installDefaultAssetDecoders(assets);
    const projection = new SceneProjection(assets);
    return {
      sync: () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1)),
      work: () => projection.sourceWork(),
      dispose: () => {
        projection.dispose();
        assets.dispose();
      },
    };
  });
  const [first, second] = consumers;
  if (!first || !second) throw new Error('Missing test consumers');
  let firstDisposed = false;
  try {
    first.sync();
    second.sync();
    const alias = material.color;
    alias.g = 0.25;
    second.sync();
    first.sync();
    for (const consumer of consumers)
      expect(consumer.work()).toMatchObject({ mode: 'tracked', meshPlans: 0, materialUses: 0 });
    first.dispose();
    firstDisposed = true;
    alias.r = 0.5;
    second.sync();
    expect(second.work()?.materialUses).toBe(0);
    const original = mesh.onBeforeRender;
    mesh.onBeforeRender = () => {};
    expect(() => second.sync()).toThrow();
    mesh.onBeforeRender = original;
    second.sync();
    second.sync();
    expect(second.work()).toMatchObject({ mode: 'tracked', meshPlans: 0 });
  } finally {
    if (!firstDisposed) first.dispose();
    second.dispose();
  }
  expect(Object.getOwnPropertyDescriptor(material.color, 'r')?.value).toBe(0.5);
});

it('keeps a culled Sprite binding through pose edits, disappearance and local admissions', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const map = new DataTexture(Uint8Array.of(255, 255, 255, 255), 1, 1);
  map.needsUpdate = true;
  const material = new SpriteMaterial({ map, transparent: true });
  const sprite = new Sprite(material);
  scene.add(sprite);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      depth: true,
      stencil: false,
      sortObjects: true,
      nativeTransparentOrder: true,
      opaque: true,
      transparent: true,
      updateMatrices: true,
    });
  const markUsed = vi.spyOn(SharedAssets.prototype, 'markUsed');
  const geometry = new BoxGeometry();
  const meshMaterial = new MeshBasicMaterial();
  try {
    sync();
    sync();
    const entity = projection.entityFor(sprite);
    if (entity === undefined) throw new Error('Missing projected sprite');
    const handle = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    if (!handle) throw new Error('Missing sprite material');
    const mesh = projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    expect(projection.world.get(entity, MeshRenderer).unwrap().frustumCulled).toBe(true);
    material.opacity = 0.25;
    material.rotation = 0.15;
    sprite.center.x = 0.4;
    camera.rotation.y = 0.2;
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0, materialUses: 0 });
    expect(projection.world.get(entity, MeshRenderer).unwrap().materials[0]).toBe(handle);
    expect(assets.read(handle).unwrap().values?.baseColor).toEqual([1, 1, 1, 0.25]);
    expect(projection.world.get(entity, GlobalTransform).unwrap().world[2]).toBeCloseTo(
      -Math.sin(0.2) * Math.cos(0.15),
    );

    scene.add(new Mesh(geometry, meshMaterial));
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 1 });

    sprite.position.x = 20;
    material.opacity = 0.5;
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0, materialUses: 0 });
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).toBe(0);
    expect(assets.read(handle).unwrap().values?.baseColor).toEqual([1, 1, 1, 0.25]);
    camera.rotation.y = 0;
    camera.position.x = 20;
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0, materialUses: 1 });
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).toBe(mesh);
    expect(assets.read(handle).unwrap().values?.baseColor).toEqual([1, 1, 1, 0.5]);

    markUsed.mockClear();
    sprite.visible = false;
    sync();
    sync();
    expect(markUsed).not.toHaveBeenCalled();
    sprite.visible = true;
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0 });
    expect(projection.world.get(entity, MeshRenderer).unwrap().materials[0]).toBe(handle);
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).toBe(mesh);
    material.dispose();
    sync();
    const replacement = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    if (!replacement) throw new Error('Missing republished Sprite material');
    expect(replacement).not.toBe(handle);
    expect(assets.read(handle).ok).toBe(false);
    scene.remove(sprite);
    sync();
    expect(projection.entityFor(sprite)).toBeUndefined();
    expect(assets.read(replacement).ok).toBe(false);

    sprite.position.x = -20;
    scene.add(sprite);
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 1 });
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0 });
    camera.position.x = -20;
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 1 });
    sync();
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0 });
  } finally {
    markUsed.mockRestore();
    projection.dispose();
    geometry.dispose();
    meshMaterial.dispose();
    map.dispose();
    material.dispose();
    assets.dispose();
  }
});

it('publishes stock shadow light inputs on change and retains pending refresh requests', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const directional = new DirectionalLight();
  const spot = new SpotLight(0xffffff, 1, 20);
  const point = new PointLight(0xffffff, 1, 20);
  const caster = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ transparent: true }));
  const stopTracking = enableThreeSourceTracking();
  for (const light of [directional, spot, point]) {
    for (const matrix of [light.shadow.matrix, light.shadow.camera.projectionMatrix])
      matrix.elements = ownedCollection(matrix.elements);
  }
  stopTracking();
  caster.castShadow = true;
  caster.layers.set(2);
  directional.shadow.camera.layers.set(2);
  for (const light of [directional, spot, point]) {
    light.castShadow = true;
    light.position.y = 5;
    scene.add(light);
  }
  scene.add(directional.target, spot.target, caster);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      ecsPoses: true,
      updateMatrices: true,
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
      shadowMap: { enabled: true, type: PCFShadowMap, cameraLayers: camera.layers.mask },
    });
  const project = vi.spyOn(projection.shadowUpdates, 'project');
  const entity = (object: typeof spot | typeof point | typeof caster) => {
    const value = projection.entityFor(object);
    if (value === undefined) throw new Error('Missing projected shadow source');
    return value;
  };
  const spotState = () => projection.world.get(entity(spot), NativeSpot).unwrap();
  try {
    sync();
    sync();
    project.mockClear();
    sync();
    expect(project).not.toHaveBeenCalled();
    expect(projection.world.get(entity(caster), MeshFilter).unwrap().assetHandle).not.toBe(0);

    const before = spotState().shadowViewProjection.slice();
    spot.target.position.x = 2;
    point.shadow.bias = -0.125;
    sync();
    expect(project.mock.calls.map(([light]) => light)).toEqual(
      expect.arrayContaining([point, spot]),
    );
    expect(project).toHaveBeenCalledTimes(2);
    expect(spotState().shadowViewProjection).not.toEqual(before);
    expect(projection.world.get(entity(point), NativePointShadow).unwrap().depthBias).toBeCloseTo(
      0.125,
    );

    project.mockClear();
    point.position.x = 4;
    sync();
    expect(project.mock.calls.map(([light]) => light)).toEqual([point]);
    expect(projection.world.get(entity(point), NativePointShadow).unwrap().shadowPosition[0]).toBe(
      4,
    );

    const aimed = spotState().shadowViewProjection.slice();
    spot.shadow.camera.zoom = 1.5;
    spot.shadow.camera.updateProjectionMatrix();
    sync();
    expect(spotState().shadowViewProjection).not.toEqual(aimed);

    const automatic = spotState().shadowViewProjection.slice();
    spot.shadow.autoUpdate = false;
    spot.shadow.mapSize.set(1024, 512);
    spot.position.x = 3;
    sync();
    expect(spotState()).toMatchObject({ mapSize: 512, shadowAutoUpdate: false, shadowRevision: 0 });
    expect(spotState().shadowViewProjection).toEqual(automatic);

    spot.shadow.needsUpdate = true;
    sync();
    expect(spotState()).toMatchObject({ mapSize: 1024, shadowMapAspect: 2, shadowRevision: 1 });
    expect(spot.shadow.needsUpdate).toBe(true);
    sync();
    expect(spotState().shadowRevision).toBe(1);
    projection.submitted();
    expect(spot.shadow.needsUpdate).toBe(false);
    project.mockClear();
    sync();
    expect(project).not.toHaveBeenCalled();

    const matrix = spotState().shadowViewProjection.slice();
    spot.shadow.matrix.elements[0] += 0.25;
    sync();
    expect(spotState().shadowViewProjection).not.toEqual(matrix);
    directional.shadow.camera.layers.set(3);
    sync();
    expect(projection.world.get(entity(caster), MeshFilter).unwrap().assetHandle).toBe(0);

    // Reusing mutable stock shadow state brings both lights back to traversal.
    const follower = new SpotLight(0xffffff, 1, 20);
    follower.castShadow = true;
    follower.shadow = spot.shadow;
    scene.add(follower);
    sync();
    sync();
    project.mockClear();
    sync();
    expect(project.mock.calls.map(([light]) => light)).toEqual([spot, follower]);
  } finally {
    project.mockRestore();
    projection.dispose();
    caster.geometry.dispose();
    caster.material.dispose();
    assets.dispose();
  }
});

it('reuses a mixed view and wakes light, view and instance dependencies independently', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const geo = new BoxGeometry();
  const point = new PointLight(0xffffff, 1),
    lamp = new DirectionalLight(),
    ambient = new AmbientLight();
  const particles = new Points(geo, new PointsMaterial({ size: 2 }));
  const instances = new InstancedMesh(geo, new MeshBasicMaterial(), 2);
  const glass = new Mesh(geo, new MeshBasicMaterial({ transparent: true }));
  const sprite = new Sprite(new SpriteMaterial());
  scene.add(
    ambient,
    point,
    lamp,
    lamp.target,
    new SpotLight(),
    new RectAreaLight(),
    new Bone(),
    particles,
    instances,
    glass,
    sprite,
    new LineSegments(geo, new LineBasicMaterial()),
  );
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  const entity = (o: (typeof scene.children)[number]) => {
    const e = projection.entityFor(o);
    if (e === undefined) throw new Error('Missing accepted entity');
    return e;
  };
  setThreeSceneTracking(scene, true);
  try {
    for (let i = 0; i < 4; i++) sync();
    expect(projection.sourceWork()).toMatchObject({
      mode: 'tracked',
      viewBindings: 5,
      sourceNodes: 0,
      meshPlans: 0,
    });
    glass.position.x = 0.1;
    sync();
    expect(projection.sourceWork()).toMatchObject({
      sourceNodes: 0,
      meshPlans: 0,
      poseChanges: 1,
      viewPoseChecks: 1,
    });
    expect(projection.world.get(entity(glass), GlobalTransform).unwrap().world[12]).toBeCloseTo(
      0.1,
    );
    point.intensity = 2;
    lamp.target.position.x = 1;
    sync();
    expect(projection.world.get(entity(point), NativePoint).unwrap().intensity).toBe(2);
    expect(
      projection.world.get(entity(lamp), NativeDirectional).unwrap().direction[0],
    ).toBeGreaterThan(0);
    camera.layers.set(1);
    sync();
    expect(projection.world.get(entity(point), NativePoint).unwrap().intensity).toBe(0);
    camera.layers.set(0);
    sync();
    expect(projection.world.get(entity(point), NativePoint).unwrap().intensity).toBe(2);
    const before = projection.world.get(entity(particles), NativePoints).unwrap().size;
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    sync();
    expect(projection.world.get(entity(particles), NativePoints).unwrap().size).toBeCloseTo(
      before / 2,
    );
    instances.setMatrixAt(1, new Matrix4().makeTranslation(1, 0, 0));
    instances.instanceMatrix.needsUpdate = true;
    sync();
    expect(projection.world.get(entity(instances), Instances).unwrap().transforms[28]).toBe(1);
    glass.material.color.setRGB(1, 0, 0);
    sync();
    const h = projection.world.get(entity(glass), MeshRenderer).unwrap().materials[0];
    if (!h) throw new Error('Missing material');
    expect(assets.read(h).unwrap().values?.baseColor).toEqual([1, 0, 0, 1]);
    scene.remove(sprite, point);
    sync();
    expect(projection.entityFor(point)).toBeUndefined();
    expect(projection.entityFor(sprite)).toBeUndefined();
  } finally {
    projection.dispose();
    assets.dispose();
  }
});

it('keeps ECS skin draws resident until a binding input changes', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const geometry = new PlaneGeometry();
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32BufferAttribute(new Float32Array(count * 4), 4);
  for (let i = 0; i < count; i++) weights.setX(i, 1);
  geometry.setAttribute('skinWeight', weights);
  const first = new MeshStandardMaterial({ color: 0xff0000 });
  const second = new MeshStandardMaterial({ color: 0x0000ff });
  const actor = new Group();
  const rig = new Group();
  const joint = new Bone();
  const mesh = new SkinnedMesh(geometry, first);
  // The inverse array remains writable through an external alias.
  const inverses = [new Matrix4()];
  mesh.bind(new Skeleton([joint], inverses), new Matrix4());
  mesh.castShadow = true;
  actor.add(mesh, rig);
  rig.add(joint);
  scene.add(actor);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      ecsPoses: true,
      updateMatrices: true,
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
      nativeTransparentOrder: true,
      shadowMap: { enabled: true, type: PCFShadowMap, cameraLayers: 1 },
    });
  try {
    sync();
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('Missing projected skin');
    const skin = () => projection.world.get(entity, Skin).unwrap();
    const material = () => projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    const original = skin().skeleton;
    expect(Array.from(skin().joints)).toEqual([projection.entityFor(joint)]);

    for (const x of [1, 2, 3]) {
      joint.position.x = x;
      sync();
      expect(projection.sourceWork()).toMatchObject({ poseAuthority: 'ecs', meshPlans: 0 });
      expect(skin().skeleton).toBe(original);
    }
    const before = material();
    mesh.material = second;
    sync();
    expect(projection.sourceWork()?.meshPlans).toBe(1);
    expect(material()).not.toBe(before);

    inverses[0]?.makeTranslation(-1, 0, 0);
    sync();
    expect(projection.sourceWork()?.meshPlans).toBe(1);
    expect(assets.read(skin().skeleton).unwrap().inverseBindMatrices[12]).toBe(-1);

    const other = new SkinnedMesh(geometry, second);
    const sharedInverse = inverses[0] as Matrix4;
    const otherInverses = [sharedInverse];
    other.bind(new Skeleton([joint], otherInverses), new Matrix4());
    actor.add(other);
    sync();
    sync();
    const sharedChecks = projection.sourceWork()?.foreignInputChecks;
    expect(sharedChecks).toBeTypeOf('number');
    const otherEntity = projection.entityFor(other);
    if (otherEntity === undefined) throw new Error('Missing second skin');
    const otherInverseX = () =>
      assets.read(projection.world.get(otherEntity, Skin).unwrap().skeleton).unwrap()
        .inverseBindMatrices[12];
    sharedInverse.elements[12] = -2;
    sync();
    expect(otherInverseX()).toBe(-2);
    expect(assets.read(skin().skeleton).unwrap().inverseBindMatrices[12]).toBe(-2);
    otherInverses[0] = new Matrix4().makeTranslation(-3, 0, 0);
    sync();
    expect(otherInverseX()).toBe(-3);
    sync();
    expect(projection.sourceWork()?.foreignInputChecks).toBe(Number(sharedChecks) + 1);
    otherInverses[0] = sharedInverse;
    sync();
    sync();
    expect(projection.sourceWork()?.foreignInputChecks).toBe(sharedChecks);
    actor.remove(other);
    sync();
    sharedInverse.elements[12] = -4;
    sync();
    expect(assets.read(skin().skeleton).unwrap().inverseBindMatrices[12]).toBe(-4);

    actor.scale.x = 2;
    sync();
    expect(projection.world.hasComponent(entity, Skin)).toBe(false);
    actor.scale.x = 1;
    sync();
    expect(Array.from(skin().joints)).toEqual([projection.entityFor(joint)]);
    sync();
    expect(projection.sourceWork()?.meshPlans).toBe(0);

    actor.remove(rig);
    sync();
    expect(projection.entityFor(joint)).toBeUndefined();
    expect(skin().joints).toHaveLength(1);
    const [projectedJoint] = skin().joints;
    if (projectedJoint === undefined) throw new Error('Missing projected joint');
    expect(projection.world.get(projectedJoint as EntityHandle, GlobalTransform).ok).toBe(true);
    actor.add(rig);
    sync();
    expect(Array.from(skin().joints)).toEqual([projection.entityFor(joint)]);
    sync();
    expect(projection.sourceWork()?.meshPlans).toBe(0);

    scene.remove(actor);
    sync();
    expect(projection.entityFor(mesh)).toBeUndefined();
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    first.dispose();
    second.dispose();
  }
});

it('keeps tuple observation until the last attachment of the same reader retires', () => {
  const scale = new Group().scale;
  const dirty = vi.fn();
  const first = observeScale(scale, dirty);
  const second = observeScale(scale, dirty);
  expect(first).toBeTypeOf('function');
  expect(second).toBeTypeOf('function');
  scale.x = 2;
  first?.();
  first?.();
  scale.y = 3;
  expect(dirty).toHaveBeenCalledTimes(2);
  second?.();
  scale.z = 4;
  expect(dirty).toHaveBeenCalledTimes(2);
  expect(Object.getOwnPropertyDescriptor(scale, 'y')?.value).toBe(3);
});

it('retires readers after a game seals or freezes a tracked vector', () => {
  const scale = new Group().scale;
  const first = vi.fn();
  const second = vi.fn();
  const releaseFirst = observeScale(scale, first);
  const releaseSecond = observeScale(scale, second);
  Object.seal(scale);
  releaseFirst?.();
  scale.x = 3;
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  releaseSecond?.();
  scale.y = 4;
  expect(second).toHaveBeenCalledOnce();

  const frozen = new Group().scale;
  const a = observeScale(frozen, first);
  const b = observeScale(frozen, second);
  Object.freeze(frozen);
  expect(() => a?.()).not.toThrow();
  expect(() => b?.()).not.toThrow();
});

it('retains direct edits and published world matrices until the last reader detaches', () => {
  const close = enableThreeSourceTracking();
  const elements = ownedCollection([0]);
  close();
  const read = vi.fn();
  const other = vi.fn();
  const a = watchTargetMatrix(elements, read);
  const b = watchTargetMatrix(elements, read);
  const c = watchTargetMatrix(elements, other);
  try {
    elements[0] = 1;
    publishWorldMatrix(elements);
    expect(read).toHaveBeenCalledTimes(2);
    a?.();
    a?.();
    elements[0] = 2;
    publishWorldMatrix(elements);
    expect(read).toHaveBeenCalledTimes(4);
    expect(other).toHaveBeenCalledTimes(4);
    c?.();
    elements[0] = 3;
    publishWorldMatrix(elements);
    expect(read).toHaveBeenCalledTimes(6);
    expect(other).toHaveBeenCalledTimes(4);
    b?.();
    elements[0] = 4;
    publishWorldMatrix(elements);
    expect(read).toHaveBeenCalledTimes(6);
  } finally {
    a?.();
    b?.();
    c?.();
  }
});

it('keeps the prepared local matrix valid across world-pose publication', () => {
  const object = new Group();
  object.position.x = 2;
  const compose = vi.spyOn(object.matrix, 'compose');
  const binding = bindSourceWorldPose(object, SynchronousTransform, () => {});
  try {
    expect(resolveSourceWorldPose(object)).toBe(true);
    expect(compose).toHaveBeenCalledTimes(1);
    object.matrixWorld.makeTranslation(3, 0, 0);
    reflectSourceWorldPose(object);
    expect(resolveSourceWorldPose(object)).toBe(true);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(object.matrixWorld.elements[12]).toBe(2);

    object.position.x = 4;
    binding.transform.invalidateLocal();
    expect(resolveSourceWorldPose(object)).toBe(true);
    expect(compose).toHaveBeenCalledTimes(2);
    expect(object.matrixWorld.elements[12]).toBe(4);
  } finally {
    binding.release();
    compose.mockRestore();
  }
});

it('composes from the admitted parent output and switches to live storage on retirement', () => {
  const parent = new Group();
  const child = new Group();
  parent.add(child);
  const matrix = parent.matrixWorld;
  const read = vi.fn(() => matrix);
  Object.defineProperty(parent, 'matrixWorld', { configurable: true, get: read });
  const root = bindSourceWorldPose(parent, SynchronousTransform);
  const branch = bindSourceWorldPose(child, SynchronousTransform);
  try {
    read.mockClear();
    for (let frame = 1; frame <= 60; frame++) {
      parent.position.x = frame;
      root.transform.invalidateLocal();
      resolveSourceWorldPose(parent);
      resolveSourceWorldPose(child);
      expect(child.matrixWorld.elements[12]).toBe(frame);
    }
    expect(read).not.toHaveBeenCalled();
    root.release();
    matrix.makeTranslation(73, 0, 0);
    resolveSourceWorldPose(child);
    expect(read).toHaveBeenCalledOnce();
    expect(child.matrixWorld.elements[12]).toBe(73);
  } finally {
    root.release();
    branch.release();
  }
});

it('isolates matrix destinations across a reentrant read of an unobserved parent', () => {
  const parent = new Group();
  const child = new Group();
  const nested = new Group();
  child.position.x = 2;
  nested.position.x = 11;
  parent.add(child);
  const matrix = parent.matrixWorld.makeTranslation(3, 0, 0);
  const a = bindSourceWorldPose(child, SynchronousTransform);
  const b = bindSourceWorldPose(nested, SynchronousTransform);
  try {
    Object.defineProperty(parent, 'matrixWorld', {
      get() {
        resolveSourceWorldPose(nested);
        return matrix;
      },
    });
    resolveSourceWorldPose(child);
    expect(child.matrixWorld.elements[12]).toBe(5);
    expect(nested.matrixWorld.elements[12]).toBe(11);
  } finally {
    b.release();
    a.release();
  }
});

it('keeps the ECS matrix attachment live when another observer releases twice', () => {
  const node = new Group();
  const ecs = bindSourceWorldPose(node, SynchronousTransform);
  const changed = vi.fn();
  const view = bindSourceWorldPose(node, SynchronousTransform, changed);
  const other = bindSourceWorldPose(node, SynchronousTransform, changed);
  try {
    expect(view.transform).toBe(ecs.transform);
    view.release();
    view.release();
    node.position.x = 3;
    ecs.transform.invalidateLocal();
    expect(resolveSourceWorldPose(node)).toBe(true);
    expect(node.matrixWorld.elements[12]).toBe(3);
    expect(changed).toHaveBeenCalledTimes(1);
    other.release();
    node.position.x = 7;
    ecs.transform.invalidateLocal();
    expect(resolveSourceWorldPose(node)).toBe(true);
    expect(node.matrixWorld.elements[12]).toBe(7);
    expect(changed).toHaveBeenCalledTimes(1);
  } finally {
    view.release();
    other.release();
    ecs.release();
  }
  expect(resolveSourceWorldPose(node)).toBe(false);
});

it('reuses native joints and replaces only a changed bone result', () => {
  const mesh = new SkinnedMesh(),
    a = new Bone(),
    b = new Bone();
  mesh.bind(new Skeleton([a, b]));
  const cache: JointSnapshots = new WeakMap();
  const first = projectJoints(mesh, cache);
  expect(projectJoints(mesh, cache)).toBe(first);
  b.position.x = 2;
  b.updateMatrixWorld();
  const second = projectJoints(mesh, cache);
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[1]);
  expect(second[1]?.pos[0]).toBe(2);
  expect(first[1]?.pos[0]).toBe(0);
});

it('updates only the compatibility pose consumers of a changed ECS branch', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const branch = new Group();
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const sprite = new Sprite(new SpriteMaterial());
  const area = new RectAreaLight();
  const lamp = new DirectionalLight();
  lamp.position.y = 1;
  branch.add(mesh, sprite, area, lamp.target);
  scene.add(branch, lamp);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      ecsPoses: true,
      updateMatrices: true,
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
      nativeTransparentOrder: true,
    });
  const entity = (object: typeof mesh | typeof sprite | typeof lamp | typeof area) => {
    const value = projection.entityFor(object);
    if (value === undefined) throw new Error('Missing projected node');
    return value;
  };
  try {
    sync();
    sync();
    branch.position.x = 1;
    sync();
    expect(projection.sourceWork()).toMatchObject({
      mode: 'tracked',
      poseAuthority: 'ecs',
      poseChanges: 3,
      meshPlans: 0,
    });
    expect(mesh.matrixWorld.elements[12]).toBe(1);
    expect(projection.world.get(entity(mesh), GlobalTransform).unwrap().world[12]).toBe(1);
    expect(projection.world.get(entity(sprite), GlobalTransform).unwrap().world[12]).toBe(1);
    expect(projection.world.get(entity(area), GlobalTransform).unwrap().world[12]).toBe(1);
    expect(projection.world.get(entity(lamp), NativeDirectional).unwrap().direction[0]).toBeCloseTo(
      Math.SQRT1_2,
    );
    lamp.position.x = 1;
    sync();
    expect(projection.world.get(entity(lamp), NativeDirectional).unwrap().direction[0]).toBe(0);
    sync();
    expect(projection.sourceWork()).toMatchObject({ poseChanges: 0, meshPlans: 0 });
  } finally {
    projection.dispose();
    assets.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
    sprite.material.dispose();
  }
});

it('publishes finite source poses with rounded quaternions and manual or scaled ancestors', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const manual = new Group();
  manual.matrixAutoUpdate = false;
  manual.matrix.makeTranslation(2, 3, 4);
  const scaled = new Group();
  scaled.scale.set(1, 2, 3);
  const bone = new Bone();
  bone.quaternion.set(
    -0.003967104014009237,
    0.005715548992156982,
    -0.6668944954872131,
    0.7451196908950806,
  );
  bone.position.x = 1;
  scaled.add(bone);
  manual.add(scaled);
  scene.add(manual);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      ecsPoses: true,
      updateMatrices: true,
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
    });
  const expected = manual.matrix
    .clone()
    .multiply(scaled.matrix.compose(scaled.position, scaled.quaternion, scaled.scale))
    .multiply(bone.matrix.compose(bone.position, bone.quaternion, bone.scale));
  try {
    sync();
    expect(projection.sourceWork()?.poseAuthority).toBe('ecs');
    const joint = projection.entityFor(bone);
    if (joint === undefined) throw new Error('Missing joint');
    expect(projection.world.get(joint, ChildOf).unwrap().parent).toBe(projection.entityFor(scaled));
    const actual = projection.world.get(joint, GlobalTransform).unwrap().world;
    expected.elements.forEach((value, i) => {
      expect(actual[i]).toBeCloseTo(value, 6);
      expect(bone.matrixWorld.elements[i]).toBeCloseTo(value, 6);
    });
    manual.matrix.setPosition(6, 7, 8);
    sync();
    expect(bone.matrixWorld.elements.slice(12, 15)).toEqual([7, 7, 8]);
  } finally {
    projection.dispose();
    assets.dispose();
  }
});

it('wakes a retained morph binding through its original influence array', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 3;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geo.morphAttributes.position = [new Float32BufferAttribute([0, 0, 1, 1, 0, 0, 0, 1, 0], 3)];
  const mesh = new Mesh(geo, new MeshBasicMaterial());
  scene.add(mesh);
  setThreeSceneTracking(scene, true);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    sync();
    sync();
    expect(projection.sourceWork()).toMatchObject({ viewBindings: 1, meshPlans: 0 });
    const weights = mesh.morphTargetInfluences;
    if (!weights) throw new Error('Missing morph influences');
    weights[0] = 0.25;
    sync();
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('Missing mesh');
    expect(projection.world.get(entity, MorphWeights).unwrap().weights[0]).toBe(0.25);
  } finally {
    projection.dispose();
    assets.dispose();
  }
});

it('observes a light target whose world matrix is produced by a different tracked projection', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const sourceAssets = new AssetRegistry();
  installDefaultAssetDecoders(sourceAssets);
  const source = new SceneProjection(sourceAssets),
    lights = new SceneProjection(assets);
  const a = new Scene(),
    b = new Scene(),
    camera = new PerspectiveCamera(),
    light = new DirectionalLight();
  const target = light.target;
  const end = enableThreeSourceTracking();
  target.matrixWorld.elements = ownedCollection(target.matrixWorld.elements);
  end();
  a.add(target);
  b.add(light);
  setThreeSceneTracking(a, true);
  setThreeSceneTracking(b, true);
  const sync = () => {
    const data = cameraData(camera, NoToneMapping, 1);
    source.sync(a, camera, data);
    lights.sync(b, camera, data);
  };
  try {
    sync();
    sync();
    target.position.x = 3;
    sync();
    const e = lights.entityFor(light);
    if (e === undefined) throw new Error('Missing projected light');
    expect(lights.world.get(e, NativeDirectional).unwrap().direction[0]).toBeGreaterThan(0.9);
  } finally {
    source.dispose();
    lights.dispose();
    sourceAssets.dispose();
    assets.dispose();
  }
});

it('visits only the dynamic LOD subtree and keeps retained transparent ranks on both sides of a crossing', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 8;
  const geo = new BoxGeometry(),
    mat = new MeshBasicMaterial({ transparent: true });
  const count = 96,
    fixed = Array.from({ length: count }, () => new Mesh(geo, mat));
  const dynamic = new Mesh(geo, mat),
    lod = new LOD();
  dynamic.position.z = 1;
  lod.addLevel(dynamic, 0);
  scene.add(...fixed, lod);
  setThreeSceneTracking(scene, true);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  const first = fixed[0];
  if (!first) throw new Error('Missing retained draw');
  first.position.z = 0.5;
  const layer = (object: Mesh) => {
    const entity = projection.entityFor(object);
    if (entity === undefined) throw new Error('Missing projected draw');
    return projection.world.get(entity, Layer).unwrap().value;
  };
  try {
    sync();
    sync();
    sync();
    expect(projection.sourceWork()?.sourceNodes).toBe(2);
    expect(layer(dynamic)).toBe(count);
    dynamic.position.z = 0.8;
    sync();
    expect(projection.sourceWork()?.retainedRankUpdates).toBe(0);
    dynamic.position.z = 0.2;
    sync();
    expect(layer(dynamic)).toBe(count - 1);
    expect(projection.sourceWork()?.retainedRankUpdates).toBe(1);
    dynamic.position.z = -1;
    sync();
    expect(layer(dynamic)).toBe(0);
    expect(projection.sourceWork()?.retainedRankUpdates).toBe(count - 1);
    expect(layer(first)).toBe(count);
    expect(projection.sourceWork()?.sourceNodes).toBe(2);
    dynamic.visible = false;
    lod.autoUpdate = false;
    sync();
    sync();
    expect(layer(first)).toBe(count - 1);
  } finally {
    projection.dispose();
    assets.dispose();
  }
});

it('dispatches inherited methods with the live receiver through replacement and release', () => {
  const proto = { dispatch: () => 1 };
  const node = Object.create(proto);
  const other = Object.create(node);
  const changed = vi.fn();
  expect(observeField(node, 'dispatch', changed, true)).toBe(true);
  expect(other.dispatch()).toBe(1);
  proto.dispatch = () => 2;
  expect(node.dispatch()).toBe(2);
  Object.defineProperty(proto, 'dispatch', {
    get(this: object) {
      return () => this;
    },
  });
  expect(node.dispatch()).toBe(node);
  expect(other.dispatch()).toBe(other);
  Object.setPrototypeOf(node, null);
  expect(node.dispatch).toBeUndefined();
  Object.setPrototypeOf(node, { dispatch: () => 3 });
  expect(node.dispatch()).toBe(3);
  other.dispatch = () => 4;
  expect(changed).not.toHaveBeenCalled();
  node.dispatch = () => 5;
  expect(changed).toHaveBeenCalledTimes(1);
  releaseField(node, 'dispatch', changed);
  expect(node.dispatch()).toBe(5);
  expect(other.dispatch()).toBe(4);
});

it('reuses released field slots while preserving inherited writes and duplicate subscriptions', () => {
  const source = Object.assign(Object.create({ flag: 3 }), { x: 1, y: 2 });
  const first = vi.fn(),
    second = vi.fn();
  for (const key of ['x', 'y']) expect(observeField(source, key, first)).toBe(true);
  releaseField(source, 'x', first);
  expect(observeField(source, 'flag', first, true)).toBe(true);
  expect(source.flag).toBe(3);
  expect(Object.keys(source)).toEqual(['x', 'y']);
  expect(observeField(source, 'flag', second)).toBe(true);
  expect(observeField(source, 'flag', second)).toBe(true);
  source.flag = undefined;
  releaseField(source, 'flag', second);
  source.flag = 4;
  releaseField(source, 'flag', first);
  source.flag = 5;
  releaseField(source, 'flag', second);
  source.flag = 6;
  source.y = 7;
  releaseField(source, 'y', first);
  expect(first).toHaveBeenCalledTimes(3);
  expect(second).toHaveBeenCalledTimes(3);
  expect(Object.getOwnPropertyDescriptor(source, 'flag')).toEqual({
    value: 6,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  expect(Object.getOwnPropertyDescriptor(source, 'y')?.value).toBe(7);
});

it('sleeps attached hidden draws and publishes the latest geometry and material on wake', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const first = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const parent = new Group();
  scene.add(parent, first);
  setThreeSceneTracking(scene, true);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    first.visible = false;
    sync();
    const entity = projection.entityFor(first);
    if (entity === undefined) throw new Error('Missing hidden draw');
    const handle = () => projection.world.get(entity, MeshFilter).unwrap().assetHandle;
    expect(handle()).toBe(0);
    sync();
    expect(projection.sourceWork()?.sourceNodes).toBe(0);
    first.material = new MeshBasicMaterial({ color: 0xff0000 });
    first.geometry = new BoxGeometry(0.25, 0.25, 0.25);
    first.position.x = 0.2;
    parent.add(first);
    sync();
    expect(handle()).toBe(0);
    first.visible = true;
    sync();
    expect(projection.entityFor(first)).toBe(entity);
    expect(handle()).not.toBe(0);
    const color = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    if (!color) throw new Error('Missing woken material');
    expect(assets.read(color).unwrap().values?.baseColor).toEqual([1, 0, 0, 1]);
    expect(projection.world.get(entity, GlobalTransform).unwrap().world[12]).toBeCloseTo(0.2);
    first.visible = false;
    sync();
    parent.remove(first);
    sync();
    expect(projection.entityFor(first)).toBeUndefined();
  } finally {
    projection.dispose();
    assets.dispose();
  }
});

it.each([
  Mesh,
  InstancedMesh,
])('keeps explicit transparent order local for %s and re-evaluates an opaque transition', (Draw) => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const geometry = new BoxGeometry(),
    plain = new MeshBasicMaterial();
  const material = new MeshBasicMaterial({ transparent: true });
  const ordered =
    Draw === InstancedMesh
      ? new InstancedMesh(geometry, material, 1)
      : new Mesh(geometry, material);
  ordered.visible = false;
  ordered.renderOrder = 3;
  const other = new Mesh(geometry, new MeshBasicMaterial({ transparent: true }));
  scene.add(...Array.from({ length: 24 }, () => new Mesh(geometry, plain)), other, ordered);
  setThreeSceneTracking(scene, true);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  const rank = (mesh: Mesh) => {
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('Missing ordered mesh');
    return projection.world.get(entity, Layer).unwrap().value;
  };
  try {
    sync();
    sync();
    sync();
    expect(projection.sourceWork()?.mode).toBe('tracked');
    expect(projection.sourceWork()?.meshPlans).toBeLessThan(3);
    ordered.visible = true;
    sync();
    expect(projection.sourceWork()?.mode).toBe('tracked');
    expect(rank(ordered)).toBeGreaterThan(rank(other));
    ordered.renderOrder = -1;
    sync();
    sync();
    expect(rank(ordered)).toBeLessThan(rank(other));
    ordered.material.transparent = false;
    expect(sync).toThrow('Opaque renderOrder');
  } finally {
    projection.dispose();
    assets.dispose();
  }
});

it('publishes scalar edits of a shared textured transparent material without replanning its meshes', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const texture = new DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  texture.needsUpdate = true;
  texture.offset.x = 0.25;
  const material = new MeshBasicMaterial({ map: texture, transparent: true });
  const geometry = new BoxGeometry(),
    first = new Mesh(geometry, material);
  scene.add(first, ...Array.from({ length: 19 }, () => new Mesh(geometry, material)));
  setThreeSceneTracking(scene, true);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  const read = () => {
    const entity = projection.entityFor(first);
    if (entity === undefined) throw new Error('Missing textured draw');
    const handle = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    if (!handle) throw new Error('Missing textured material');
    return assets.read(handle).unwrap().values;
  };
  try {
    sync();
    sync();
    const old = read()?.baseColorTexture;
    material.opacity = 0.35;
    sync();
    expect(projection.sourceWork()?.meshPlans).toBe(0);
    expect(read()?.baseColor).toEqual([1, 1, 1, 0.35]);
    expect(read()?.baseColorTexture).toEqual(old);
    texture.offset.x = 0.5;
    sync();
    const edited = read();
    setThreeSceneTracking(scene, false);
    sync();
    expect(read()).toEqual(edited);
  } finally {
    projection.dispose();
    assets.dispose();
  }
});

it('refactors a shared clipping plane onto the camera when the last unclipped witness hides', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const group = new ClippingGroup();
  group.clippingPlanes = [new Plane()];
  const geometry = new BoxGeometry(),
    material = new MeshBasicMaterial();
  const witness = new Mesh(geometry, material);
  group.add(new Mesh(geometry, material));
  scene.add(group, witness);
  setThreeSceneTracking(scene, true);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    const entity = sync();
    sync();
    expect(projection.sourceWork()?.mode).toBe('tracked');
    expect(projection.world.hasComponent(entity, ClippingPlanes)).toBe(false);
    witness.visible = false;
    sync();
    expect(projection.world.hasComponent(entity, ClippingPlanes)).toBe(true);
    witness.visible = true;
    sync();
    expect(projection.world.hasComponent(entity, ClippingPlanes)).toBe(false);
  } finally {
    projection.dispose();
    assets.dispose();
  }
});

it('keeps edits made by native source validation with their original pose owners', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const world = new World({ assets });
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const first = new Group();
  const other = new Group();
  first.name = 'first';
  other.name = 'other';
  scene.add(first, other);
  setThreeSceneTracking(scene, true);
  let nextEdit: (() => void) | undefined;
  const projection = new SceneProjection(assets, undefined, undefined, {
    world,
    validateSource: (object) => {
      if (object !== first || nextEdit === undefined) return;
      const edit = nextEdit;
      nextEdit = undefined;
      edit();
    },
  });
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      ecsPoses: true,
      updateMatrices: true,
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
    });
  try {
    sync();
    sync();
    const a = projection.entityFor(first),
      b = projection.entityFor(other);
    if (a === undefined || b === undefined) throw new Error('Expected both native source rows');
    for (let step = 1; step <= 8; step++) {
      first.position.x = step;
      world.set(a, Name, { value: `native-${step}` }).unwrap();
      nextEdit = () => {
        first.position.x = step + 0.25;
        other.position.x = -step;
      };
      sync();
      expect(nextEdit).toBeUndefined();
      sync();
      expect(world.get(a, GlobalTransform).unwrap().world[12]).toBe(step + 0.25);
      expect(world.get(b, GlobalTransform).unwrap().world[12]).toBe(-step);
    }
  } finally {
    projection.dispose();
    assets.dispose();
  }
});

it('retains ordinary NodeMaterial bindings and re-admits changed node inputs', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.z = 5;
  const material = new MeshBasicNodeMaterial({ color: 0xff0000 });
  const geometry = new PlaneGeometry();
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
      updateMatrices: true,
      nativeTransparentOrder: true,
    });
  const handle = () => {
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('Missing projected mesh');
    const first = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    if (first === undefined) throw new Error('Missing projected material');
    return first;
  };
  try {
    sync();
    const initial = handle();
    sync();
    expect(projection.sourceWork()).toMatchObject({
      mode: 'tracked',
      meshPlans: 0,
      materialUses: 0,
    });
    material.color.setRGB(0, 1, 0);
    sync();
    expect(handle()).toBe(initial);
    expect(assets.read(handle()).unwrap().values?.baseColor).toEqual([0, 1, 0, 1]);
    expect(projection.sourceWork()).toMatchObject({ meshPlans: 0, materialUses: 0 });
    Reflect.set(material, 'roughnessNode', uniform(0.4));
    expect(sync).toThrow('roughnessNode');
    Reflect.set(material, 'roughnessNode', null);
    sync();
    material.colorNode = uniform(new Color(0, 0, 1));
    sync();
    expect(assets.read(handle()).unwrap().values?.baseColor).toEqual([0, 0, 1, 1]);
  } finally {
    projection.dispose();
    geometry.dispose();
    material.dispose();
    assets.dispose();
  }
});

it('publishes moving hidden descendants to ECS and admits their current draws on reveal', () => {
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  const projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  const hidden = new Group(),
    socket = new Group();
  const geometry = new BoxGeometry(),
    material = new MeshStandardMaterial({ transparent: true, opacity: 0.75 });
  const children = Array.from({ length: 32 }, () => new Mesh(geometry, material));
  for (const child of children) child.castShadow = true;
  hidden.visible = false;
  scene.add(hidden);
  hidden.add(socket);
  socket.add(...children);
  setThreeSceneTracking(scene, true);
  const sync = () =>
    projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), {
      ecsPoses: true,
      updateMatrices: true,
      depth: true,
      stencil: false,
      sortObjects: true,
      opaque: true,
      transparent: true,
      nativeTransparentOrder: true,
      shadowMap: { enabled: true, type: PCFShadowMap, cameraLayers: camera.layers.mask },
    });
  const enroll = vi.spyOn(SceneChanges.prototype, 'registerNode');
  try {
    sync();
    enroll.mockClear();
    const child = children[0];
    if (!child) throw new Error('Expected the first hidden mesh');
    const entity = projection.entityFor(child);
    if (entity === undefined) throw new Error('Missing projected entity');
    for (let frame = 1; frame <= 6; frame++) {
      socket.position.y = frame;
      child.name = `moving-${frame}`;
      child.position.x = frame;
      sync();
      expect(projection.sourceWork()?.sourceNodes).toBeLessThan(4);
      expect(projection.world.get(entity, Name).unwrap().value).toBe(child.name);
      expect(projection.world.get(entity, GlobalTransform).unwrap().world[13]).toBe(frame);
      expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).toBe(0);
    }
    hidden.visible = true;
    sync();
    expect(projection.entityFor(child)).toBe(entity);
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).not.toBe(0);
    for (let frame = 1; frame <= 6; frame++) {
      child.position.z = frame;
      material.opacity = 0.1 * frame;
      sync();
      expect(projection.sourceWork()?.meshPlans).toBe(0);
      expect(projection.world.get(entity, GlobalTransform).unwrap().world[14]).toBe(frame);
      const handle = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
      if (!handle) throw new Error('Missing transparent material');
      expect(assets.read(handle).unwrap().values?.baseColor).toEqual([
        1,
        1,
        1,
        expect.closeTo(material.opacity),
      ]);
    }
    hidden.visible = false;
    sync();
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).toBe(0);
    sync();
    expect(projection.sourceWork()?.sourceNodes).toBeLessThan(4);
    expect(enroll).not.toHaveBeenCalled();
    scene.add(child);
    sync();
    expect(projection.world.get(entity, MeshFilter).unwrap().assetHandle).not.toBe(0);
    expect(projection.world.get(entity, GlobalTransform).unwrap().world[13]).toBe(0);
  } finally {
    enroll.mockRestore();
    projection.dispose();
    geometry.dispose();
    material.dispose();
    assets.dispose();
  }
});
