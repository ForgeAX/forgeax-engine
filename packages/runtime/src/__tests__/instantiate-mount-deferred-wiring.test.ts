import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

it('attaches a nested SceneInstance root under the keyed instance entity', () => {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  try {
    const child = assets
      .create({
        kind: 'scene',
        entities: { childRoot: { components: { Transform: { pos: [7, 0, 0] } } } },
      })
      .unwrap();
    const parent = assets
      .create({
        kind: 'scene',
        entities: {
          wrapper: { components: { Transform: { pos: [1, 0, 0] } }, instance: { source: child } },
        },
      })
      .unwrap();
    const root = assets.instantiate(parent, world).unwrap();
    const wrapper = world.get(root, SceneInstance).unwrap().mapping[0];
    if (wrapper === undefined) throw new Error('missing keyed instance wrapper');
    const nested = [...world.iterDescendants(root)].filter(
      (entity) => world.get(entity, SceneInstance).ok,
    );
    expect(nested).toHaveLength(1);
    const nestedRoot = nested[0];
    if (nestedRoot === undefined) throw new Error('missing nested SceneInstance root');
    expect(world.get(nestedRoot, ChildOf).unwrap().parent).toBe(wrapper);
    expect(world.get(wrapper as EntityHandle, Transform).unwrap().pos).toEqual(
      new Float32Array([1, 0, 0]),
    );
  } finally {
    assets.dispose();
  }
});
