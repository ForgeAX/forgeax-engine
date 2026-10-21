import { World } from '@forgeax/engine-ecs';
import type { RuntimePackAssetInput } from '@forgeax/engine-pack/runtime';
import { SceneInstance } from '@forgeax/engine-render';
import type { SceneAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

const B = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const SAVED = '33333333-3333-4333-8333-333333333333';
const child: SceneAsset = { kind: 'scene', entities: { leaf: { components: { Transform: {} } } } };

it('A -> B -> C retains source keys, hierarchy and nested SceneInstance roots', async () => {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  try {
    publishTestAssets(assets, [
      { guid: C, kind: 'scene', payload: child },
      {
        guid: B,
        kind: 'scene',
        refs: [C],
        payload: {
          kind: 'scene',
          entities: { child: { components: {}, instance: { source: C } } },
        },
      },
    ]);
    const nested = (await assets.load(B, 'scene')).unwrap();
    const parent = assets
      .create({
        kind: 'scene',
        entities: {
          root: { components: { Transform: {} } },
          nested: { components: { ChildOf: { parent: 'root' } }, instance: { source: nested } },
        },
      })
      .unwrap();
    const root = assets.instantiate(parent, world).unwrap();
    expect(
      [...world.iterDescendants(root)].filter((entity) => world.get(entity, SceneInstance).ok),
    ).toHaveLength(2);
    const collected = rootsToSceneAsset(assets, world, [root]).unwrap();
    expect(collected.entities.nested?.instance?.source).toBe(B);
    expect(collected.entities.nested?.components.ChildOf).toEqual({ parent: 'root' });
  } finally {
    assets.dispose();
  }
});

it('serialized keyed source deduplicates its GUID and loads the matching managed Scene', async () => {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  try {
    const scene: SceneAsset = {
      kind: 'scene',
      entities: { house: { components: {}, instance: { source: B } } },
    };
    const packed = serializeSceneAssetToPack(scene, world.components.entries(), SAVED).unwrap();
    const rows = packed.assets as RuntimePackAssetInput[];
    expect(rows[0]?.refs).toEqual([B]);
    expect(rows[0]?.payload).toMatchObject({ entities: { house: { instance: { source: 0 } } } });
    publishTestAssets(assets, [{ guid: B, kind: 'scene', payload: child }, ...rows]);
    const loaded = (await assets.load(SAVED, 'scene')).unwrap();
    const nested = assets.read(loaded).unwrap().entities.house?.instance?.source;
    if (typeof nested !== 'number') throw new Error('nested Scene source was not linked');
    expect(assets.guidOf(nested)).toBe(B);
  } finally {
    assets.dispose();
  }
});

it('child declarations with the same managed source remain separate instance paths', () => {
  const world = new World();
  registerSceneComponents(world);
  const assets = testAssets(world);
  try {
    const source = assets.create(child).unwrap();
    const parent = assets
      .create({
        kind: 'scene',
        entities: {
          left: { components: {}, instance: { source } },
          right: { components: {}, instance: { source } },
        },
      })
      .unwrap();
    const root = assets.instantiate(parent, world).unwrap();
    const nested = [...world.iterDescendants(root)].filter(
      (entity) => world.get(entity, SceneInstance).ok,
    );
    expect(nested).toHaveLength(2);
    expect(nested[0]).not.toBe(nested[1]);
  } finally {
    assets.dispose();
  }
});
