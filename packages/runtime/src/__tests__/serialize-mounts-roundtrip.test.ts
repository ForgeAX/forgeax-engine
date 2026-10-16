// Keyed SceneAsset production and round-trip coverage.
// The filename remains for the historical test target, while the public
// contract is now `entities[key].instance`, with no authored mount windows.

import type { Asset } from '@forgeax/engine-assets-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { SceneInstance } from '@forgeax/engine-render';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

const CHILD_GUID = '11111111-1111-4111-8111-111111111111';
const PARENT_GUID = '22222222-2222-4222-8222-222222222222';
const OUT_GUID = '33333333-3333-4333-8333-333333333333';

function parseGuid(value: string): AssetGuid {
  const result = AssetGuid.parse(value);
  if (!result.ok) throw new Error(`bad GUID: ${value}`);
  return result.value;
}

function register(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  registerSceneComponents(world);
  return world.allocSharedRef('SceneAsset', asset);
}

function catalog(registry: AssetRegistry, guid: string, asset: SceneAsset): void {
  const result = registry.catalog(parseGuid(guid), asset as Asset);
  if (!result.ok) throw new Error(result.error.code);
}

function childScene(): SceneAsset {
  return {
    kind: 'scene',
    entities: {
      door: { components: { Transform: { pos: [1, 0, 0] } } },
      frame: { components: { Transform: { pos: [0, 0, 0] } } },
    },
  };
}

describe('keyed SceneAsset serialize and decode', () => {
  it('serializes nested instance sources to refs and decodes them back to GUIDs', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
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
    const serialized = serializeSceneAssetToPack(scene, new Map(), OUT_GUID);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const packedAsset = (serialized.value.assets as Array<Record<string, unknown>>)[0];
    expect(packedAsset).toBeDefined();
    if (!packedAsset) return;
    const payload = packedAsset.payload as Record<string, unknown>;
    const entities = payload.entities as Record<string, Record<string, unknown>>;
    expect((entities.house?.instance as Record<string, unknown>).source).toBe(0);
    const parsed = (
      registry as unknown as {
        parseAssetPayload(
          kind: string,
          payload: Record<string, unknown>,
          refs?: readonly string[],
        ): unknown;
      }
    ).parseAssetPayload('scene', payload, packedAsset.refs as readonly string[]);
    expect(parsed).toMatchObject({
      kind: 'scene',
      entities: { house: { instance: { source: CHILD_GUID } } },
    });
  });

  it('collects a live nested instance back to a keyed declaration', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const child = childScene();
    catalog(registry, CHILD_GUID, child);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: { Transform: { pos: [0, 0, 0] } } },
        house: { components: {}, instance: { source: CHILD_GUID } },
      },
    };
    catalog(registry, PARENT_GUID, parent);
    const result = registry.instantiate(register(world, parent), world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(world.get(result.value, SceneInstance).ok).toBe(true);
    const collected = rootsToSceneAsset(registry, world, [result.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(Object.keys(collected.value.entities)).toContain('house');
    expect(collected.value.entities.house?.instance?.source).toBe(CHILD_GUID);
    expect(collected.value.entities.house?.instance?.overrides).toBeUndefined();
  });

  it('keeps nested declarations isolated across two instances', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    catalog(registry, CHILD_GUID, childScene());
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        left: { components: {}, instance: { source: CHILD_GUID } },
        right: { components: {}, instance: { source: CHILD_GUID } },
      },
    };
    const result = registry.instantiate(register(world, parent), world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nestedRoots = [...world.iterDescendants(result.value)].filter(
      (entity) => world.get(entity, SceneInstance).ok,
    );
    expect(nestedRoots).toHaveLength(2);
  });

  it('rejects keyed recursive instances before a root is published', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const a: SceneAsset = {
      kind: 'scene',
      entities: { b: { components: {}, instance: { source: CHILD_GUID } } },
    };
    const b: SceneAsset = {
      kind: 'scene',
      entities: { a: { components: {}, instance: { source: PARENT_GUID } } },
    };
    catalog(registry, CHILD_GUID, b);
    catalog(registry, PARENT_GUID, a);
    const before = world.inspect().entityCount;
    const result = registry.instantiate(register(world, a), world);
    expect(result.ok).toBe(false);
    expect(world.inspect().entityCount).toBe(before);
  });
});
