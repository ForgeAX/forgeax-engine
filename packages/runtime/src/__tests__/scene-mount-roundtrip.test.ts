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

const GUID_B = '11111111-1111-4111-8111-111111111111';
const GUID_C = '22222222-2222-4222-8222-222222222222';
const GUID_OUT = '33333333-3333-4333-8333-333333333333';

function guid(value: string): AssetGuid {
  const result = AssetGuid.parse(value);
  if (!result.ok) throw new Error(`bad GUID: ${value}`);
  return result.value;
}
function handle(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  registerSceneComponents(world);
  return world.allocSharedRef('SceneAsset', asset);
}
function catalog(registry: AssetRegistry, id: string, asset: SceneAsset): void {
  const result = registry.catalog(guid(id), asset as Asset);
  if (!result.ok) throw new Error(result.error.code);
}
function decode(registry: AssetRegistry, row: Record<string, unknown>): SceneAsset {
  const parsed = (
    registry as unknown as {
      parseAssetPayload(
        kind: string,
        payload: Record<string, unknown>,
        refs?: readonly string[],
      ): unknown;
    }
  ).parseAssetPayload(
    'scene',
    row.payload as Record<string, unknown>,
    row.refs as readonly string[],
  );
  if (parsed === undefined) throw new Error('decode failed');
  return parsed as SceneAsset;
}

describe('keyed nested SceneAsset round-trip', () => {
  it('A -> B -> C retains source keys, hierarchy and nested SceneInstance roots', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const c: SceneAsset = { kind: 'scene', entities: { leaf: { components: { Transform: {} } } } };
    const b: SceneAsset = {
      kind: 'scene',
      entities: { child: { components: {}, instance: { source: GUID_C } } },
    };
    const a: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: { Transform: {} } },
        nested: { components: { ChildOf: { parent: 'root' } }, instance: { source: GUID_B } },
      },
    };
    catalog(registry, GUID_C, c);
    catalog(registry, GUID_B, b);
    const result = registry.instantiate(handle(world, a), world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const instances = [...world.iterDescendants(result.value)].filter(
      (entity) => world.get(entity, SceneInstance).ok,
    );
    expect(instances).toHaveLength(2);
    const collected = rootsToSceneAsset(registry, world, [result.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(collected.value.entities.nested?.instance?.source).toBe(GUID_B);
    expect(collected.value.entities.nested?.components.ChildOf).toEqual({ parent: 'root' });
  });

  it('serialized keyed source uses one refs entry and decodes to the same GUID', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const scene: SceneAsset = {
      kind: 'scene',
      entities: { house: { components: {}, instance: { source: GUID_B } } },
    };
    const packed = serializeSceneAssetToPack(scene, new Map(), GUID_OUT);
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const row = (packed.value.assets as Array<Record<string, unknown>>)[0];
    if (!row) throw new Error('missing row');
    const payload = row.payload as Record<string, unknown>;
    expect(
      (payload.entities as Record<string, Record<string, unknown>>).house?.instance,
    ).toMatchObject({ source: 0 });
    expect(decode(registry, row).entities.house?.instance?.source).toBe(GUID_B);
  });

  it('child declarations with same source remain separate instance paths', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: { leaf: { components: { Transform: {} } } },
    };
    catalog(registry, GUID_B, child);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        left: { components: {}, instance: { source: GUID_B } },
        right: { components: {}, instance: { source: GUID_B } },
      },
    };
    const result = registry.instantiate(handle(world, parent), world);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nested = [...world.iterDescendants(result.value)].filter(
      (entity) => world.get(entity, SceneInstance).ok,
    );
    expect(nested).toHaveLength(2);
    expect(nested[0]).not.toBe(nested[1]);
  });
});
