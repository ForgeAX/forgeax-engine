import { World } from '@forgeax/engine-ecs';
import { worldInstantiateScene } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

it('rejects A -> B -> C -> A before publishing a cyclic runtime Scene', () => {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  const a = assets.create({ kind: 'scene', entities: {} }).unwrap();
  const c = assets
    .create({
      kind: 'scene',
      entities: { c: { components: {}, instance: { source: a } } },
    })
    .unwrap();
  const b = assets
    .create({
      kind: 'scene',
      entities: { b: { components: {}, instance: { source: c } } },
    })
    .unwrap();
  const cyclic = assets.update(a, {
    entities: { a: { components: {}, instance: { source: b } } },
  });
  expect(cyclic).toMatchObject({ ok: false, error: { code: 'asset-reference-invalid' } });
  expect(assets.read(a).unwrap().entities).toEqual({});
  expect(worldInstantiateScene(world, b).ok).toBe(true);
  world.despawnAll().unwrap();
  assets.dispose();
});
