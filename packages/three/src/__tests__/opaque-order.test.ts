import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { MeshRenderer, samplerContribution } from '@forgeax/engine-render';
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
  const buffers = {
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
  };
}

it('shares default materials and keeps ordered handles, programs and idle asset versions stable', () => {
  const f = fixture();
  f.sync();
  expect(f.handle(f.first)).toBe(f.handle(f.second));
  const defaultProgram = f.data(f.first).passes?.[0]?.program;
  f.first.renderOrder = 2;
  f.sync();
  const first = f.handle(f.first),
    second = f.handle(f.second);
  expect(first).not.toBe(second);
  expect(f.queue(f.first)).toBe(2001);
  expect(f.queue(f.second)).toBe(2000);
  expect(f.data(f.first).passes?.[0]?.program).toEqual(defaultProgram);
  const changes = f.assets.observe().unwrap();
  for (let i = 0; i < 20; i++) f.sync();
  expect(changes.read().unwrap().changes).toEqual([]);
  f.second.renderOrder = 3;
  f.sync();
  expect(f.handle(f.first)).toBe(first);
  expect(f.handle(f.second)).toBe(second);
  expect([f.queue(f.first), f.queue(f.second)]).toEqual([2000, 2001]);
  expect(
    changes
      .read()
      .unwrap()
      .changes.map((change) => change.handle)
      .sort(),
  ).toEqual([first, second].sort());
  f.first.renderOrder = f.second.renderOrder = 0;
  f.sync();
  expect(f.handle(f.first)).toBe(f.handle(f.second));
  expect(f.assets.validate(first).ok).toBe(false);
  expect(f.assets.validate(second).ok).toBe(false);
  changes.dispose();
});

it('uses group order before object order, preserves traversal when sorting is disabled and rejects unsupported combinations atomically', () => {
  const f = fixture(),
    group = new Group();
  group.renderOrder = 2;
  f.first.renderOrder = -20;
  group.add(f.first);
  f.scene.add(group);
  f.sync();
  expect([f.queue(f.first), f.queue(f.second)]).toEqual([2001, 2000]);
  f.buffers.sortObjects = false;
  f.sync();
  expect([f.queue(f.first), f.queue(f.second)]).toEqual([2001, 2000]);
  const instances = new InstancedMesh(f.geometry, f.material, 1);
  instances.frustumCulled = false;
  f.scene.add(instances);
  const previous = f.handle(f.first);
  expect(f.sync).toThrow('single-material, unclipped ordinary meshes');
  expect(f.projection.entityFor(instances)).toBeUndefined();
  expect(f.handle(f.first)).toBe(previous);
  f.scene.remove(instances);
  instances.dispose();
  f.buffers.opaqueOrder = false;
  expect(f.sync).toThrow('renderer-owned ordering');
});

it('bounds explicit opaque ordering below the transparent queue without limiting default scenes', () => {
  const f = fixture();
  for (let i = 2; i < 1001; i++) {
    const mesh = new Mesh(f.geometry, f.material);
    mesh.frustumCulled = false;
    f.scene.add(mesh);
  }
  f.sync();
  f.first.renderOrder = 1;
  expect(f.sync).toThrow('at most 1000 objects');
});
