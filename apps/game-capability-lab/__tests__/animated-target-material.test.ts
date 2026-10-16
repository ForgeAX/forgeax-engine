import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { MeshRenderer } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createAnimatedMaterialTarget, resetAnimatedMaterial, stepAnimatedMaterial } from '../assets/plugins/animated-target-material';

vi.mock('../assets/shaders/animated-target.wgsl', () => ({ default: { wgsl: '' } }));

it('publishes animation without modifying shared source content and restores bindings on reset', () => {
  const world = new World();
  const base: MaterialAsset = Object.freeze({
    kind: 'material',
    values: Object.freeze({ baseColor: [1, 0, 0, 1], time: 0 }),
  });
  const mat = world.allocSharedRef('MaterialAsset', base);
  const e = world.spawn({ component: MeshRenderer, data: { materials: [mat] } }).unwrap();
  const other = world.spawn({ component: MeshRenderer, data: { materials: [mat] } }).unwrap();
  const target = createAnimatedMaterialTarget(world, { e, mat });
  const projectedTime = () => resolveAssetHandle<MaterialAsset>(world, target.material).unwrap().values?.time;
  stepAnimatedMaterial(world, target, 2);
  expect(projectedTime()).toBe(2);
  expect(base.values?.time).toBe(0);
  expect(world.get(other, MeshRenderer).unwrap().materials[0]).toBe(mat);
  resetAnimatedMaterial(world, target);
  expect(world.get(e, MeshRenderer).unwrap().materials[0]).toBe(mat);
  expect(projectedTime()).toBe(0);
  stepAnimatedMaterial(world, target, 3);
  expect(world.get(e, MeshRenderer).unwrap().materials[0]).toBe(target.material);
  expect(projectedTime()).toBe(3);
});
