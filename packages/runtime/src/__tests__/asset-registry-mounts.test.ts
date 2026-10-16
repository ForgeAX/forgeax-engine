// Keyed SceneAsset registry and decode closure.
// The public payload uses entity keys and nested `instance` declarations;
// numeric slots are derived only by the Scene owner at instantiate time.

import {
  type Asset,
  AssetRegistry,
  resolveAssetHandle,
  sceneLoader,
} from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { MeshFilter, SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Transform, worldResolveSceneEntity } from '@forgeax/engine-scene';
import type { Handle, LoadContext, MeshAsset, SceneAsset } from '@forgeax/engine-types';
import { BUILTIN_BASE } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const GUID_A = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const GUID_B = 'f6af7007-158f-4d92-9e47-93bf2f213e1f';
const GUID_MESH = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function guid(value: string): AssetGuid {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw new Error(`bad GUID: ${value}`);
  return parsed.value;
}

function context(): LoadContext {
  return {
    fetchBinary: async () => ({ ok: false, error: new Error('not wired') }),
    resolveRef: async () => ({ ok: false, error: new Error('not wired') }),
    transcodeCaps: { bc: false, etc2: false, astc: false },
    device: undefined,
  };
}

function childScene(): SceneAsset {
  return {
    kind: 'scene',
    entities: {
      'entity-0': { components: { Transform: {}, MeshFilter: { assetHandle: 0 } } },
    },
  };
}

function meshAsset(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array([
      -0.5, 0, 0.5, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0.5, 0, 0.5, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5, 0, -0.5,
      0, 1, 0, 1, 1, 1, 0, 0, 1,
    ]),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
}

function worldWithSceneComponents(): World {
  const world = new World();
  for (const component of [Transform, ChildOf, MeshFilter, SceneInstance]) {
    world.components.register(component).unwrap();
  }
  return world;
}

describe('keyed SceneAsset decode', () => {
  it('resolves only wire refs declared by instance.source and preserves ordinary fields', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const parse = (
      registry as unknown as {
        parseAssetPayload(
          kind: string,
          payload: Record<string, unknown>,
          refs?: readonly string[],
        ): unknown;
      }
    ).parseAssetPayload.bind(registry);
    const payload = {
      entities: {
        root: { components: { Transform: { source: 1 } } },
        child: { components: {}, instance: { source: 0 } },
      },
    };
    const asset = parse('scene', payload, [GUID_A]);
    expect(asset).toMatchObject({
      kind: 'scene',
      entities: {
        root: { components: { Transform: { source: 1 } } },
        child: { instance: { source: GUID_A } },
      },
    });
  });

  it('rejects an instance source refs index outside the envelope', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const parse = (
      registry as unknown as {
        parseAssetPayload(
          kind: string,
          payload: Record<string, unknown>,
          refs?: readonly string[],
        ): unknown;
      }
    ).parseAssetPayload.bind(registry);
    expect(
      parse('scene', { entities: { child: { components: {}, instance: { source: 7 } } } }, [
        GUID_A,
      ]),
    ).toBeUndefined();
  });

  it('loads keyed payloads concurrently without cross contaminating entity keys', () => {
    const payloadA = {
      entities: { 'entity-a': { components: { Transform: { pos: [0, 0, 0] } } } },
    };
    const payloadB = {
      entities: { 'entity-b': { components: { Transform: { pos: [1, 0, 0] } } } },
    };
    const a = sceneLoader.load(payloadA, [GUID_A], context());
    const b = sceneLoader.load(payloadB, [GUID_B], context());
    expect(a).toMatchObject({ kind: 'scene', entities: { 'entity-a': {} } });
    expect(b).toMatchObject({ kind: 'scene', entities: { 'entity-b': {} } });
  });
});

describe('keyed nested registry instantiate', () => {
  it('projects the authored source key from the Catalog into scene bindings', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = worldWithSceneComponents();
    const scene: SceneAsset = {
      kind: 'scene',
      entities: { player: { components: { Transform: {} } } },
    };
    expect(registry.catalog(guid(GUID_A), scene as Asset).ok).toBe(true);
    registry.packIndexCache = new Map([
      [
        GUID_A,
        {
          packageUrl: '/assets/scene.pack.json',
          kind: 'scene',
          sourceKey: 'scene/showcase',
        },
      ],
    ]);

    const result = registry.instantiate(world.allocSharedRef('SceneAsset', scene), world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const resolved = worldResolveSceneEntity(world, result.value, {
      sceneSourceKey: 'scene/showcase',
      address: 'player',
    });
    expect(resolved.ok).toBe(true);
  });

  it('resolves direct and nested authored addresses from one instance', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = worldWithSceneComponents();
    expect(registry.catalog(guid(GUID_B), childScene() as Asset).ok).toBe(true);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        house: { components: {}, instance: { source: GUID_B } },
      },
    };
    const result = registry.instantiate(world.allocSharedRef('SceneAsset', parent), world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const direct = worldResolveSceneEntity(world, result.value, {
      sceneSourceKey: '',
      address: 'house',
    });
    const nested = worldResolveSceneEntity(world, result.value, {
      sceneSourceKey: '',
      address: ['house', 'entity-0'],
    });
    expect(direct.ok).toBe(true);
    expect(nested.ok).toBe(true);
    if (direct.ok && nested.ok) expect(direct.value).not.toBe(nested.value);
  });

  it('resolves nested instance source and override asset GUID before spawning', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = worldWithSceneComponents();
    expect(registry.catalog(guid(GUID_MESH), meshAsset()).ok).toBe(true);
    expect(registry.catalog(guid(GUID_B), childScene() as Asset).ok).toBe(true);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        mount: {
          components: {},
          instance: {
            source: GUID_B,
            overrides: [
              { target: ['entity-0'], components: { MeshFilter: { assetHandle: GUID_MESH } } },
            ],
          },
        },
      },
    };
    const handle = world.allocSharedRef('SceneAsset', parent);
    const result = registry.instantiate(handle, world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const instance = world.get(result.value, SceneInstance);
    expect(instance.ok).toBe(true);
    if (!instance.ok) return;
    const member = instance.value.mapping[1] as unknown as EntityHandle;
    const mesh = world.get(member, MeshFilter);
    expect(mesh.ok).toBe(true);
    if (!mesh.ok) return;
    expect(mesh.value.assetHandle as unknown as number).toBeGreaterThanOrEqual(BUILTIN_BASE);
    const payload = resolveAssetHandle<MeshAsset>(
      world,
      mesh.value.assetHandle as unknown as Handle<string, 'shared'>,
    );
    expect(payload.ok).toBe(true);
    if (payload.ok) expect(payload.value.kind).toBe('mesh');
  });

  it('rejects recursive keyed instances before creating a usable root', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = worldWithSceneComponents();
    const a: SceneAsset = {
      kind: 'scene',
      entities: { b: { components: {}, instance: { source: GUID_B } } },
    };
    const b: SceneAsset = {
      kind: 'scene',
      entities: { a: { components: {}, instance: { source: GUID_A } } },
    };
    expect(registry.catalog(guid(GUID_A), a as Asset).ok).toBe(true);
    expect(registry.catalog(guid(GUID_B), b as Asset).ok).toBe(true);
    const handle = world.allocSharedRef('SceneAsset', a);
    const before = world.inspect().entityCount;
    const result = registry.instantiate(handle, world);
    expect(result.ok).toBe(false);
    expect(world.inspect().entityCount).toBe(before);
  });
});
