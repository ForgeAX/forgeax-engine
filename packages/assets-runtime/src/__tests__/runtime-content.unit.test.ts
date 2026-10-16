import { defineComponent, World } from '@forgeax/engine-ecs';
import { createStateProjection } from '@forgeax/engine-ecs/projection';
import {
  buildMeshCardLayout,
  buildVisibilityDistanceField,
  createBoxGeometry,
} from '@forgeax/engine-geometry';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { expect, test } from 'vitest';
import { resolveAssetHandle } from '../resolve-asset-handle';
import { RuntimeMaterialValue, RuntimeMeshVertices } from '../runtime-content';

test('managed material values isolate input aliases and independent consumers', () => {
  const world = new World();
  const base: MaterialAsset = { kind: 'material', values: { baseColor: [1, 1, 1, 1] } };
  const handle = world.allocSharedRef('MaterialAsset', base);
  const first = createStateProjection(world, [RuntimeMaterialValue]);
  const second = createStateProjection(world, [RuntimeMaterialValue]);
  first.read().accept();
  second.read().accept();
  const input = [1, 0, 0, 1];
  const content = world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: handle, parameter: 'baseColor', kind: 2, value: input },
    })
    .unwrap();
  input[0] = 0;
  expect(resolveAssetHandle<MaterialAsset>(world, handle).unwrap().values?.baseColor).toEqual([
    1, 0, 0, 1,
  ]);
  expect(first.read().indices).toHaveLength(1);
  first.read().accept();
  expect(second.read().indices).toHaveLength(1);
  world.set(content, RuntimeMaterialValue, { value: [0, 1, 0, 1] }).unwrap();
  expect(resolveAssetHandle<MaterialAsset>(world, handle).unwrap().values?.baseColor).toEqual([
    0, 1, 0, 1,
  ]);
  world.despawn(content).unwrap();
  expect(resolveAssetHandle<MaterialAsset>(world, handle).unwrap()).toBe(base);
});

test('projects values from the World-owned material token used by a separately bundled plugin', () => {
  const workerMaterialValue = defineComponent('RuntimeMaterialValue', {
    asset: 'shared<MaterialAsset>',
    parameter: 'string',
    kind: { type: 'enum', labels: { number: 0, boolean: 1, vector: 2 }, default: 0 },
    value: 'array<f32>',
  }) as typeof RuntimeMaterialValue;
  const world = new World();
  const base: MaterialAsset = {
    kind: 'material',
    values: { subsurfaceRadius: [9, 6, 3] },
  };
  const handle = world.allocSharedRef('MaterialAsset', base);
  expect(
    resolveAssetHandle<MaterialAsset>(world, handle).unwrap().values?.subsurfaceRadius,
  ).toEqual([9, 6, 3]);
  world.components.register(workerMaterialValue).unwrap();
  world
    .spawn({
      component: workerMaterialValue,
      data: {
        asset: handle,
        parameter: 'subsurfaceRadius',
        kind: 2,
        value: [0, 0, 0],
      },
    })
    .unwrap();

  expect(world.components.resolve('RuntimeMaterialValue')).toBe(workerMaterialValue);
  expect(
    resolveAssetHandle<MaterialAsset>(world, handle).unwrap().values?.subsurfaceRadius,
  ).toEqual([0, 0, 0]);
});

test('content rebind and generation replacement do not leave values on the old asset', () => {
  const world = new World();
  const a = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    values: { roughness: 1 },
  } as MaterialAsset);
  const b = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    values: { roughness: 0.5 },
  } as MaterialAsset);
  const content = world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: a, parameter: 'roughness', value: [0.25] },
    })
    .unwrap();
  resolveAssetHandle(world, a).unwrap();
  world.set(content, RuntimeMaterialValue, { asset: b }).unwrap();
  expect(resolveAssetHandle<MaterialAsset>(world, a).unwrap().values?.roughness).toBe(1);
  expect(resolveAssetHandle<MaterialAsset>(world, b).unwrap().values?.roughness).toBe(0.25);
  world.despawn(content).unwrap();
  const replacement = world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: a, parameter: 'roughness', value: [0.75] },
    })
    .unwrap();
  expect(replacement).not.toBe(content);
  expect(resolveAssetHandle<MaterialAsset>(world, b).unwrap().values?.roughness).toBe(0.5);
});

test('shared numeric mesh writes isolate aliases and retire static attachments until removal', async () => {
  const world = new World();
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
  const handle = world.allocSharedRef('MeshAsset', base);
  const input = base.vertices.slice();
  for (let row = 0; row < input.length; row += 12) input[row] = (input[row] ?? 0) * 2;
  const content = world
    .spawn({ component: RuntimeMeshVertices, data: { asset: handle, vertices: input } })
    .unwrap();
  const expected = input.slice();
  input.fill(99);
  const first = resolveAssetHandle<MeshAsset>(world, handle).unwrap();
  const second = resolveAssetHandle<MeshAsset>(world, handle).unwrap();
  expect(first).toBe(second);
  expect(first.vertices).toEqual(expected);
  expect(first.aabb?.[0]).toBe((base.aabb?.[0] ?? 0) * 2);
  expect(first.aabb?.[3]).toBe((base.aabb?.[3] ?? 0) * 2);
  expect(first).not.toHaveProperty('distanceField');
  expect(first).not.toHaveProperty('cardLayout');
  expect(base.distanceField).toBeDefined();
  expect(base.cardLayout).toBeDefined();
  world.despawn(content).unwrap();
  expect(resolveAssetHandle<MeshAsset>(world, handle).unwrap()).toBe(base);
});

test('malformed mesh candidates return structured failure and repair through the same content entity', () => {
  const world = new World();
  const base = createBoxGeometry(1, 1, 1).unwrap();
  const handle = world.allocSharedRef('MeshAsset', base);
  const content = world
    .spawn({ component: RuntimeMeshVertices, data: { asset: handle, vertices: [1] } })
    .unwrap();
  expect(resolveAssetHandle(world, handle)).toMatchObject({
    ok: false,
    error: { code: 'mesh-vertex-stride-mismatch' },
  });
  world.set(content, RuntimeMeshVertices, { vertices: base.vertices }).unwrap();
  expect(resolveAssetHandle<MeshAsset>(world, handle).unwrap().vertices).toEqual(base.vertices);
});

test('duplicate material parameters fail deterministically until the duplicate is removed', () => {
  const world = new World();
  const handle = world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    values: { roughness: 1 },
  } as MaterialAsset);
  world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: handle, parameter: 'roughness', value: [0.25] },
    })
    .unwrap();
  const duplicate = world
    .spawn({
      component: RuntimeMaterialValue,
      data: { asset: handle, parameter: 'roughness', value: [0.75] },
    })
    .unwrap();
  expect(resolveAssetHandle(world, handle)).toMatchObject({
    ok: false,
    error: { code: 'asset-invalid-value' },
  });
  world.despawn(duplicate).unwrap();
  expect(resolveAssetHandle<MaterialAsset>(world, handle).unwrap().values?.roughness).toBe(0.25);
});
