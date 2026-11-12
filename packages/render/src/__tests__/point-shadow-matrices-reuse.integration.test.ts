import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { PointLight, PointLightShadow } from '../components';
import { extractFrames } from '../render-system-extract-tail';

it('reuses packed point shadow matrices until position, near or far change', () => {
  const world = new World();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: PointLight, data: {} },
      { component: PointLightShadow, data: {} },
    )
    .unwrap();
  propagateTransforms(world).unwrap();
  const assets = new AssetRegistry({} as never);
  const pull = () => extractFrames([world], 0, assets).lights.pointShadow?.[0]?.shadowMatrices;
  const a = pull();
  const b = pull();
  expect(a).toBeDefined();
  expect(b).toBe(a);
  world.set(entity, Transform, { pos: [3, 1, 2] }).unwrap();
  propagateTransforms(world).unwrap();
  const c = pull();
  expect(c).not.toBe(a);
  expect(Array.from(c ?? [])).not.toEqual(Array.from(a ?? []));
  expect(pull()).toBe(c);
});
