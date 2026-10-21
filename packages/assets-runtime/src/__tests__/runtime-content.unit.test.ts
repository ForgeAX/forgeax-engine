import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  buildMeshCardLayout,
  buildVisibilityDistanceField,
  createBoxGeometry,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { expect, test } from 'vitest';
import { AssetRegistry } from '../asset-registry';

const Binding = defineComponent('RuntimeContentBinding', { material: 'asset<material>' });
const material = (roughness = 1): MaterialAsset => ({
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
  values: { roughness, baseColor: [1, 1, 1, 1] },
});

test('managed material writes isolate inputs and preserve independent observer positions', () => {
  const assets = new AssetRegistry();
  const handle = assets.create(material()).unwrap();
  const first = assets.observe().unwrap();
  const second = assets.observe().unwrap();
  const fixed = assets.snapshot(handle).unwrap();
  const input = [1, 0, 0, 1];
  assets.update(handle, { values: { baseColor: input } }).unwrap();
  input.fill(0);
  expect(assets.read(handle).unwrap().values?.baseColor).toEqual([1, 0, 0, 1]);
  expect(first.read().unwrap().changes).toHaveLength(1);
  first.read().unwrap().accept();
  expect(first.read().unwrap().changes).toHaveLength(0);
  expect(second.read().unwrap().changes).toHaveLength(1);
  assets.update(handle, { values: { baseColor: [0, 1, 0, 1] } }).unwrap();
  expect(assets.read(handle).unwrap().values?.baseColor).toEqual([0, 1, 0, 1]);
  expect(fixed.read<MaterialAsset>(handle).unwrap().values?.baseColor).toEqual([1, 1, 1, 1]);
  fixed.dispose();
  first.dispose();
  second.dispose();
  assets.dispose();
});

test('runtime values need no additional component registration', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const reference = assets.create(material()).unwrap();
  const entity = world.spawn({ component: Binding, data: { material: reference } }).unwrap();
  assets.release(reference).unwrap();
  assets.update(reference, { values: { roughness: 0.25 } }).unwrap();
  expect(world.get(entity, Binding).unwrap().material).toBe(reference);
  expect(assets.read(reference).unwrap().values?.roughness).toBe(0.25);
  expect(world.inspect().entityCount).toBe(1);
  expect(world.sharedRefs._liveCount()).toBe(0);
  world.despawn(entity).unwrap();
  expect(assets.read(reference).ok).toBe(false);
  assets.dispose();
});

test('rebinding changes only that binding and retired references never target replacements', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const a = assets.create(material()).unwrap();
  const b = assets.create(material(0.5)).unwrap();
  const entity = world.spawn({ component: Binding, data: { material: a } }).unwrap();
  assets.update(a, { values: { roughness: 0.25 } }).unwrap();
  world.set(entity, Binding, { material: b }).unwrap();
  expect(assets.read(a).unwrap().values?.roughness).toBe(0.25);
  expect(assets.read(b).unwrap().values?.roughness).toBe(0.5);
  assets.release(a).unwrap();
  const replacement = assets.create(material(0.75)).unwrap();
  expect(replacement).not.toBe(a);
  expect(assets.update(a, { values: { roughness: 0 } }).ok).toBe(false);
  expect(assets.read(replacement).unwrap().values?.roughness).toBe(0.75);
  world.despawn(entity).unwrap();
  assets.dispose();
});

test('mesh writes isolate input and retire geometry-derived attachments while fixed content survives', async () => {
  const assets = new AssetRegistry();
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const positions = geometry.attributes.position;
  if (!(positions instanceof Float32Array) || !geometry.indices)
    throw new Error('expected indexed box');
  const base: MeshAsset = {
    ...geometry,
    cardLayout: (
      await buildMeshCardLayout(positions, geometry.indices, { resolution: 8 })
    ).unwrap(),
    distanceField: {
      ...(
        await buildVisibilityDistanceField(positions, geometry.indices, {
          voxelSize: 0.5,
          triangleSidedness: new Uint8Array(geometry.indices.length / 3),
        })
      ).unwrap(),
      sectionSidedness: geometry.submeshes.map(() => 0 as const),
    },
  };
  const handle = assets.create(base).unwrap();
  const fixed = assets.snapshot(handle).unwrap();
  const input = base.vertices.slice();
  const stride = deriveVertexLayoutProjection(base.attributes).arrayStride / 4;
  for (let row = 0; row < input.length; row += stride) input[row] = (input[row] ?? 0) * 2;
  const expected = input.slice();
  assets.update(handle, { vertices: input }).unwrap();
  input.fill(99);
  const current = assets.read(handle).unwrap();
  expect(current.vertices).toEqual(expected);
  expect(current.aabb?.[0]).toBe((base.aabb?.[0] ?? 0) * 2);
  expect(current.aabb?.[3]).toBe((base.aabb?.[3] ?? 0) * 2);
  expect(current.distanceField).toBeUndefined();
  expect(current.cardLayout).toBeUndefined();
  expect(fixed.read<MeshAsset>(handle).unwrap().distanceField).toEqual(base.distanceField);
  expect(base.cardLayout).toBeDefined();
  fixed.dispose();
  assets.dispose();
});

test('malformed candidates leave current geometry usable and do not publish a revision', () => {
  const assets = new AssetRegistry();
  const base = createBoxGeometry(1, 1, 1).unwrap();
  const handle = assets.create(base).unwrap();
  const observer = assets.observe().unwrap();
  expect(assets.update(handle, { vertices: Float32Array.of(1) })).toMatchObject({
    ok: false,
    error: { code: 'asset-invalid-value' },
  });
  expect(assets.read(handle).unwrap().vertices).toEqual(base.vertices);
  expect(observer.read().unwrap().changes).toHaveLength(0);
  assets.update(handle, { vertices: base.vertices }).unwrap();
  expect(assets.read(handle).unwrap().vertices).toEqual(base.vertices);
  observer.dispose();
  assets.dispose();
});

test('ordered writes to one parameter coalesce without duplicate content entities', () => {
  const assets = new AssetRegistry();
  const handle = assets.create(material()).unwrap();
  const observer = assets.observe().unwrap();
  assets.update(handle, { values: { roughness: 0.25 } }).unwrap();
  assets.update(handle, { values: { roughness: 0.75 } }).unwrap();
  expect(assets.read(handle).unwrap().values?.roughness).toBe(0.75);
  expect(observer.read().unwrap().changes).toHaveLength(1);
  observer.dispose();
  assets.dispose();
});
