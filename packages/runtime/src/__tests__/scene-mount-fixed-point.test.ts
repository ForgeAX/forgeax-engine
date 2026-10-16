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

const CHILD = '11111111-1111-4111-8111-111111111111';
const SAVED = '22222222-2222-4222-8222-222222222222';

function guid(value: string): AssetGuid {
  const result = AssetGuid.parse(value);
  if (!result.ok) throw new Error(`bad GUID: ${value}`);
  return result.value;
}

function register(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  registerSceneComponents(world);
  return world.allocSharedRef('SceneAsset', asset);
}

function catalog(registry: AssetRegistry, id: string, asset: SceneAsset): void {
  const result = registry.catalog(guid(id), asset as Asset);
  if (!result.ok) throw new Error(result.error.code);
}

function parse(
  registry: AssetRegistry,
  payload: Record<string, unknown>,
  refs: readonly string[],
): SceneAsset {
  const result = (
    registry as unknown as {
      parseAssetPayload(
        kind: string,
        payload: Record<string, unknown>,
        refs?: readonly string[],
      ): unknown;
    }
  ).parseAssetPayload('scene', payload, refs);
  if (result === undefined) throw new Error('scene payload parse failed');
  return result as SceneAsset;
}

describe('keyed SceneAsset collect fixed point', () => {
  it('collect -> serialize -> reload -> collect preserves nested declaration and keys', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: { door: { components: { Transform: { pos: [2, 0, 0] } } } },
    };
    catalog(registry, CHILD, child);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: { Transform: {} } },
        house: { components: {}, instance: { source: CHILD } },
      },
    };
    const first = registry.instantiate(register(world, parent), world);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const collected1 = rootsToSceneAsset(registry, world, [first.value]);
    expect(collected1.ok).toBe(true);
    if (!collected1.ok) return;
    expect(collected1.value.entities.house?.instance?.source).toBe(CHILD);
    const packed = serializeSceneAssetToPack(collected1.value, world.components.entries(), SAVED);
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    const row = (packed.value.assets as Array<Record<string, unknown>>)[0];
    if (!row) throw new Error('missing serialized scene');
    const decoded = parse(
      registry,
      row.payload as Record<string, unknown>,
      row.refs as readonly string[],
    );
    expect(decoded.entities.house?.instance?.source).toBe(CHILD);

    const secondWorld = new World();
    catalog(registry, SAVED, decoded);
    const second = registry.instantiate(register(secondWorld, decoded), secondWorld);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const collected2 = rootsToSceneAsset(registry, secondWorld, [second.value]);
    expect(collected2.ok).toBe(true);
    if (!collected2.ok) return;
    expect(Object.keys(collected2.value.entities)).toEqual(Object.keys(collected1.value.entities));
    expect(collected2.value.entities.house?.instance).toEqual(
      collected1.value.entities.house?.instance,
    );
  });

  it('a scene without nested instances remains a keyed two entity asset', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        root: { components: { Transform: {} } },
        child: { components: { Transform: {}, ChildOf: { parent: 'root' } } },
      },
    };
    const root = registry.instantiate(register(world, asset), world);
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    const collected = rootsToSceneAsset(registry, world, [root.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(Object.keys(collected.value.entities)).toEqual(['root', 'child']);
    expect(collected.value.entities.child?.components.ChildOf).toEqual({ parent: 'root' });
  });

  it('the transient SceneInstance state is not emitted as an authored component', () => {
    const registry = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { root: { components: { Transform: {} } } },
    };
    const root = registry.instantiate(register(world, asset), world);
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(world.get(root.value, SceneInstance).ok).toBe(true);
    const collected = rootsToSceneAsset(registry, world, [root.value]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(collected.value.entities.root?.components.SceneInstance).toBeUndefined();
  });
});
