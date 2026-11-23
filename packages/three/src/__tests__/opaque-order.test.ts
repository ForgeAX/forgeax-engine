import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Camera, Layer, MeshRenderer, samplerContribution } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
} from 'three/src/Three.Core.js';
import { afterEach, expect, it } from 'vitest';
import { cameraData } from '../camera';
import { SceneProjection } from '../scene';

const owned: (() => void)[] = [];
afterEach(() => {
  for (const dispose of owned.splice(0)) dispose();
});
function fixture() {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const geometry = new BoxGeometry(),
    material = new MeshBasicMaterial();
  const first = new Mesh(geometry, material),
    second = new Mesh(geometry, material);
  scene.add(first, second);
  const buffers: NonNullable<Parameters<typeof projection.sync>[3]> = {
    depth: true,
    stencil: false,
    sortObjects: true,
    opaque: true,
    transparent: true,
    updateMatrices: true,
    opaqueOrder: true,
  };
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1), buffers);
  const handle = (mesh: Mesh) => {
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('missing mesh');
    const handle = projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    if (handle === undefined) throw new Error('missing material');
    return handle;
  };
  const data = (mesh: Mesh) => assets.read(handle(mesh)).unwrap() as MaterialAsset;
  const queue = (mesh: Mesh) =>
    data(mesh).passes?.find((pass) => pass.name !== 'shadow-caster')?.renderState?.queue;
  const rank = (mesh: Mesh) => {
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('missing mesh');
    return projection.world.get(entity, Layer).unwrap().value;
  };
  const orderedView = () => {
    const entity = projection.entityFor(camera);
    if (entity === undefined) throw new Error('missing camera');
    return projection.world.get(entity, Camera).unwrap().orderOpaqueByLayer;
  };
  owned.push(() => {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    material.dispose();
  });
  return {
    assets,
    projection,
    scene,
    camera,
    geometry,
    material,
    first,
    second,
    buffers,
    sync,
    handle,
    data,
    queue,
    rank,
    orderedView,
  };
}

it('keeps per-object transparent order for meshes sharing one plan', () => {
  const f = fixture();
  f.material.transparent = true;
  f.second.position.z = -1;
  f.sync();
  expect(f.handle(f.first)).toBe(f.handle(f.second));
  expect(f.rank(f.second)).toBeLessThan(f.rank(f.first));

  f.second.position.z = 1;
  f.sync();
  expect(f.rank(f.first)).toBeLessThan(f.rank(f.second));

  f.buffers.transparentSort = (a, b) => (b.id ?? 0) - (a.id ?? 0);
  f.sync();
  expect(f.rank(f.second)).toBeLessThan(f.rank(f.first));

  f.buffers.sortObjects = false;
  f.sync();
  expect(f.rank(f.first)).toBeLessThan(f.rank(f.second));
});

it('orders opaque draws in the view without changing shared materials or programs', () => {
  const f = fixture();
  f.sync();
  const handle = f.handle(f.first);
  expect(f.handle(f.second)).toBe(handle);
  expect(f.orderedView()).toBe(false);
  const defaultProgram = f.data(f.first).passes?.[0]?.program;

  const changes = f.assets.observe().unwrap();
  f.first.renderOrder = 2;
  f.sync();
  expect(f.orderedView()).toBe(true);
  expect(f.handle(f.first)).toBe(f.handle(f.second));
  expect(f.queue(f.first)).toBe(2000);
  expect(f.rank(f.second)).toBeLessThan(f.rank(f.first));
  expect(f.data(f.first).passes?.[0]?.program).toEqual(defaultProgram);
  for (let i = 0; i < 20; i++) f.sync();
  expect(changes.read().unwrap().changes).toEqual([]);

  f.second.renderOrder = 3;
  f.sync();
  expect(f.rank(f.first)).toBeLessThan(f.rank(f.second));
  expect(f.handle(f.first)).toBe(handle);
  expect(f.handle(f.second)).toBe(handle);
  expect(changes.read().unwrap().changes).toEqual([]);

  f.first.renderOrder = f.second.renderOrder = 0;
  f.sync();
  expect(f.orderedView()).toBe(false);
  expect(f.handle(f.first)).toBe(handle);
  expect(f.assets.validate(handle).ok).toBe(true);
  changes.dispose();
});

it('uses group order before object order, preserves traversal when sorting is disabled and rejects unsupported draw combinations without rebinding existing materials', () => {
  const f = fixture(),
    group = new Group();
  group.renderOrder = 2;
  f.first.renderOrder = -20;
  group.add(f.first);
  f.scene.add(group);
  f.sync();
  expect(f.rank(f.second)).toBeLessThan(f.rank(f.first));
  f.buffers.sortObjects = false;
  f.sync();
  expect(f.rank(f.second)).toBeLessThan(f.rank(f.first));
  const instances = new InstancedMesh(f.geometry, f.material, 1);
  instances.frustumCulled = false;
  f.scene.add(instances);
  const previous = f.handle(f.first);
  expect(f.sync).toThrow('single-material, unclipped ordinary meshes');
  const pending = f.projection.entityFor(instances);
  if (pending === undefined) throw new Error('expected a projected pose');
  expect(f.projection.world.hasComponent(pending, MeshRenderer)).toBe(false);
  expect(f.handle(f.first)).toBe(previous);
  f.scene.remove(instances);
  instances.dispose();
  f.buffers.opaqueOrder = false;
  expect(f.sync).toThrow('renderer-owned ordering');
});

it('orders more than one thousand opaque draws without allocating material queues', () => {
  const f = fixture();
  for (let i = 2; i < 1001; i++) {
    const mesh = new Mesh(f.geometry, f.material);
    mesh.frustumCulled = false;
    f.scene.add(mesh);
  }
  f.sync();
  const handle = f.handle(f.first);
  f.first.renderOrder = 1;
  f.sync();
  expect(f.orderedView()).toBe(true);
  expect(f.rank(f.second)).toBeLessThan(f.rank(f.first));
  expect(f.handle(f.first)).toBe(handle);
  expect(f.queue(f.first)).toBe(2000);
});
