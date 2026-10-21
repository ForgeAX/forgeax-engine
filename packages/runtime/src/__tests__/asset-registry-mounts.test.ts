import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { MeshFilter, SceneInstance } from '@forgeax/engine-render';
import { worldResolveSceneEntity } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

const A = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const B = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';
const MESH = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const child: SceneAsset = {
  kind: 'scene',
  entities: { 'entity-0': { components: { Transform: {}, MeshFilter: {} } } },
};

function fixture() {
  const world = new World();
  registerSceneComponents(world, [MeshFilter]);
  return { world, assets: testAssets(world) };
}

describe('keyed SceneAsset decode', () => {
  it('resolves instance source wire refs and preserves ordinary fields', async () => {
    const { assets } = fixture();
    try {
      publishTestAssets(assets, [
        { guid: B, kind: 'scene', payload: child },
        {
          guid: A,
          kind: 'scene',
          refs: [B],
          payload: {
            entities: {
              root: { components: { Transform: { source: 1 } } },
              child: { components: {}, instance: { source: 0 } },
            },
          },
        },
      ]);
      const loaded = assets.read((await assets.load(A, 'scene')).unwrap()).unwrap();
      expect(loaded.entities.root?.components.Transform).toEqual({ source: 1 });
      const source = loaded.entities.child?.instance?.source;
      if (typeof source !== 'number') throw new Error('unlinked nested source');
      expect(assets.guidOf(source)).toBe(B);
    } finally {
      assets.dispose();
    }
  });

  it('rejects an instance source refs index outside the envelope', async () => {
    const { assets } = fixture();
    try {
      publishTestAssets(assets, [
        { guid: B, kind: 'scene', payload: child },
        {
          guid: A,
          kind: 'scene',
          refs: [B],
          payload: {
            entities: { child: { components: {}, instance: { source: 7 } } },
          },
        },
      ]);
      expect(await assets.load(A, 'scene')).toMatchObject({
        ok: false,
        error: { code: 'asset-package-invalid' },
      });
    } finally {
      assets.dispose();
    }
  });

  it('loads keyed payloads concurrently without contaminating entity keys', async () => {
    const { assets } = fixture();
    try {
      publishTestAssets(assets, [
        {
          guid: A,
          kind: 'scene',
          payload: {
            entities: { 'entity-a': { components: { Transform: { pos: [0, 0, 0] } } } },
          },
        },
        {
          guid: B,
          kind: 'scene',
          payload: {
            entities: { 'entity-b': { components: { Transform: { pos: [1, 0, 0] } } } },
          },
        },
      ]);
      const [a, b] = await Promise.all([assets.load(A, 'scene'), assets.load(B, 'scene')]);
      expect(Object.keys(assets.read(a.unwrap()).unwrap().entities)).toEqual(['entity-a']);
      expect(Object.keys(assets.read(b.unwrap()).unwrap().entities)).toEqual(['entity-b']);
    } finally {
      assets.dispose();
    }
  });
});

describe('keyed nested registry instantiate', () => {
  it('projects the authored Catalog source key into scene bindings', async () => {
    const { world, assets } = fixture();
    try {
      publishRuntimeAssets(assets, [
        {
          guid: A,
          sourceKey: 'scene/showcase',
          asset: {
            kind: 'scene',
            entities: { player: { components: { Transform: {} } } },
          },
        },
      ]);
      const root = assets.instantiate((await assets.load(A, 'scene')).unwrap(), world).unwrap();
      expect(
        worldResolveSceneEntity(world, root, {
          sceneSourceKey: 'scene/showcase',
          address: 'player',
        }).ok,
      ).toBe(true);
    } finally {
      assets.dispose();
    }
  });

  it('resolves direct and nested authored addresses from one instance', () => {
    const { world, assets } = fixture();
    try {
      const source = assets.create(child).unwrap();
      const parent = assets
        .create({
          kind: 'scene',
          entities: {
            house: { components: {}, instance: { source } },
          },
        })
        .unwrap();
      const root = assets.instantiate(parent, world).unwrap();
      const direct = worldResolveSceneEntity(world, root, {
        sceneSourceKey: '',
        address: 'house',
      }).unwrap();
      const nested = worldResolveSceneEntity(world, root, {
        sceneSourceKey: '',
        address: ['house', 'entity-0'],
      }).unwrap();
      expect(direct).not.toBe(nested);
    } finally {
      assets.dispose();
    }
  });

  it('resolves nested source and override asset GUIDs before spawning', async () => {
    const { world, assets } = fixture();
    try {
      publishTestAssets(assets, [
        { guid: MESH, kind: 'mesh', payload: createBoxGeometry(1, 1, 1).unwrap() },
        { guid: B, kind: 'scene', payload: child },
        {
          guid: A,
          kind: 'scene',
          refs: [B, MESH],
          payload: {
            entities: {
              mount: {
                components: {},
                instance: {
                  source: B,
                  overrides: [
                    { target: ['entity-0'], components: { MeshFilter: { assetHandle: MESH } } },
                  ],
                },
              },
            },
          },
        },
      ]);
      const root = assets.instantiate((await assets.load(A, 'scene')).unwrap(), world).unwrap();
      const member = world.get(root, SceneInstance).unwrap().mapping[1] as EntityHandle;
      const reference = world.get(member, MeshFilter).unwrap().assetHandle;
      expect(assets.guidOf(reference)).toBe(MESH);
      expect(assets.read(reference).unwrap().kind).toBe('mesh');
    } finally {
      assets.dispose();
    }
  });

  it('rejects recursive keyed instances before creating a usable root', async () => {
    const { world, assets } = fixture();
    try {
      publishTestAssets(assets, [
        {
          guid: A,
          kind: 'scene',
          refs: [B],
          payload: {
            entities: { b: { components: {}, instance: { source: B } } },
          },
        },
        {
          guid: B,
          kind: 'scene',
          refs: [A],
          payload: {
            entities: { a: { components: {}, instance: { source: A } } },
          },
        },
      ]);
      const before = world.inspect().entityCount;
      expect(await assets.load(A, 'scene')).toMatchObject({
        ok: false,
        error: { code: 'asset-reference-invalid' },
      });
      expect(world.inspect().entityCount).toBe(before);
    } finally {
      assets.dispose();
    }
  });
});
