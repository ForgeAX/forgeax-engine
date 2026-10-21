import { World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import { expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

const CHILD = '11111111-1111-4111-8111-111111111111';

it('collect preserves the wrapper key, source GUID and explicit parent declaration', async () => {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  try {
    publishTestAssets(assets, [
      {
        guid: CHILD,
        kind: 'scene',
        payload: {
          kind: 'scene',
          entities: { leaf: { components: { Transform: {} } } },
        },
      },
    ]);
    const child = (await assets.load(CHILD, 'scene')).unwrap();
    const parent = assets
      .create({
        kind: 'scene',
        entities: {
          root: { components: { Transform: {} } },
          wrapper: { components: { ChildOf: { parent: 'root' } }, instance: { source: child } },
        },
      })
      .unwrap();
    const root = assets.instantiate(parent, world).unwrap();
    expect(
      [...world.iterDescendants(root)].filter((entity) => world.get(entity, SceneInstance).ok),
    ).toHaveLength(1);
    const collected = rootsToSceneAsset(assets, world, [root]).unwrap();
    expect(collected.entities.wrapper?.instance?.source).toBe(CHILD);
    expect(collected.entities.wrapper?.components.ChildOf).toEqual({ parent: 'root' });
  } finally {
    assets.dispose();
  }
});
