import { World } from '@forgeax/engine-ecs';
import type { RuntimePackAssetInput } from '@forgeax/engine-pack/runtime';
import { SceneInstance } from '@forgeax/engine-render';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

const CHILD_GUID = '11111111-1111-4111-8111-111111111111';
const PARENT_GUID = '22222222-2222-4222-8222-222222222222';
const OUT_GUID = '33333333-3333-4333-8333-333333333333';
const child: SceneAsset = {
  kind: 'scene',
  entities: {
    door: { components: { Transform: { pos: [1, 0, 0] } } },
    frame: { components: { Transform: { pos: [0, 0, 0] } } },
  },
};

function fixture() {
  const world = new World();
  registerSceneComponents(world);
  return { world, assets: testAssets(world) };
}

describe('keyed SceneAsset serialize and decode', () => {
  it('serializes nested source GUIDs to refs and loads the same source and overrides', async () => {
    const { world, assets } = fixture();
    try {
      const scene: SceneAsset = {
        kind: 'scene',
        entities: {
          root: { components: { Transform: { pos: [0, 0, 0] } } },
          house: {
            components: {},
            instance: {
              source: CHILD_GUID,
              overrides: [{ target: ['door'], components: { Transform: { pos: [4, 0, 0] } } }],
            },
          },
        },
      };
      const serialized = serializeSceneAssetToPack(
        scene,
        world.components.entries(),
        OUT_GUID,
      ).unwrap();
      const rows = serialized.assets as RuntimePackAssetInput[];
      expect(rows[0]?.refs).toEqual([CHILD_GUID]);
      expect(rows[0]?.payload).toMatchObject({ entities: { house: { instance: { source: 0 } } } });
      publishTestAssets(assets, [{ guid: CHILD_GUID, kind: 'scene', payload: child }, ...rows]);
      const reference = (await assets.load(OUT_GUID, 'scene')).unwrap();
      const loaded = assets.read(reference).unwrap().entities.house?.instance;
      if (typeof loaded?.source !== 'number') throw new Error('unlinked nested Scene');
      expect(assets.guidOf(loaded.source)).toBe(CHILD_GUID);
      expect(loaded.overrides).toEqual(scene.entities.house?.instance?.overrides);
    } finally {
      assets.dispose();
    }
  });

  it('collects a live nested instance back to a keyed declaration', async () => {
    const { world, assets } = fixture();
    try {
      publishTestAssets(assets, [{ guid: CHILD_GUID, kind: 'scene', payload: child }]);
      const source = (await assets.load(CHILD_GUID, 'scene')).unwrap();
      const parent = assets
        .create({
          kind: 'scene',
          entities: {
            root: { components: { Transform: { pos: [0, 0, 0] } } },
            house: { components: {}, instance: { source } },
          },
        })
        .unwrap();
      const root = assets.instantiate(parent, world).unwrap();
      expect(world.get(root, SceneInstance).ok).toBe(true);
      const collected = rootsToSceneAsset(assets, world, [root]).unwrap();
      expect(Object.keys(collected.entities)).toContain('house');
      expect(collected.entities.house?.instance?.source).toBe(CHILD_GUID);
      expect(collected.entities.house?.instance?.overrides).toBeUndefined();
    } finally {
      assets.dispose();
    }
  });

  it('keeps nested declarations isolated across two instances', () => {
    const { world, assets } = fixture();
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
      const nestedRoots = [...world.iterDescendants(root)].filter(
        (entity) => world.get(entity, SceneInstance).ok,
      );
      expect(nestedRoots).toHaveLength(2);
      expect(nestedRoots[0]).not.toBe(nestedRoots[1]);
    } finally {
      assets.dispose();
    }
  });

  it('rejects keyed recursive instances before a root is published', async () => {
    const { world, assets } = fixture();
    try {
      publishTestAssets(assets, [
        {
          guid: PARENT_GUID,
          kind: 'scene',
          refs: [CHILD_GUID],
          payload: {
            kind: 'scene',
            entities: { b: { components: {}, instance: { source: CHILD_GUID } } },
          },
        },
        {
          guid: CHILD_GUID,
          kind: 'scene',
          refs: [PARENT_GUID],
          payload: {
            kind: 'scene',
            entities: { a: { components: {}, instance: { source: PARENT_GUID } } },
          },
        },
      ]);
      const before = world.inspect().entityCount;
      const result = await assets.load(PARENT_GUID, 'scene');
      expect(result).toMatchObject({ ok: false, error: { code: 'asset-reference-invalid' } });
      expect(world.inspect().entityCount).toBe(before);
    } finally {
      assets.dispose();
    }
  });
});
