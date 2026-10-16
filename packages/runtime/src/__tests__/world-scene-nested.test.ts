import { World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import * as SceneOwner from '@forgeax/engine-scene';
import { ChildOf } from '@forgeax/engine-scene';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { registerSceneComponents } from './helpers/register-scene-components';

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  registerSceneComponents(world);
  return world.allocSharedRef('SceneAsset', asset);
}

describe('keyed nested SceneAsset instances', () => {
  it('double-nested A -> B -> C materialises three SceneInstance roots', () => {
    const world = new World();
    const assetC: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: {} } } },
    };
    const handleC = registerSceneAsset(world, assetC);
    const assetB: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        child: { components: {}, instance: { source: 'C' } },
      },
    };
    const handleB = registerSceneAsset(world, assetB);
    const assetA: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        child: { components: {}, instance: { source: 'B' } },
      },
    };
    const handleA = registerSceneAsset(world, assetA);
    SceneOwner.worldSetSceneAssetResolver(world, (source, parentHandle) => {
      if (typeof source === 'number') return ok(source as Handle<'SceneAsset', 'shared'>);
      const parent = Number(parentHandle);
      if (parent === Number(handleA) && source === 'B') return ok(handleB);
      if (parent === Number(handleB) && source === 'C') return ok(handleC);
      return err({ code: 'asset-not-found' });
    });

    const result = SceneOwner.worldInstantiateScene(world, handleA);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    if (!result.ok) return;
    let count = 0;
    const query = world.query({ with: [SceneInstance] }).unwrap();
    for (const _row of query) count += 1;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('five keyed instance layers recurse without stack overflow', () => {
    const world = new World();
    const handles: Handle<'SceneAsset', 'shared'>[] = [];
    for (let layer = 5; layer >= 0; layer -= 1) {
      const asset: SceneAsset = {
        kind: 'scene',
        entities: {
          'entity-0': { components: { Transform: {} } },
          ...(layer < 5
            ? { child: { components: {}, instance: { source: `layer-${layer + 1}` } } }
            : {}),
        },
      };
      handles.unshift(registerSceneAsset(world, asset));
    }
    SceneOwner.worldSetSceneAssetResolver(world, (_source, parentHandle) => {
      const parentIndex = handles.findIndex((handle) => Number(handle) === Number(parentHandle));
      const next = handles[parentIndex + 1];
      return next === undefined ? err({ code: 'asset-not-found' }) : ok(next);
    });
    const result = SceneOwner.worldInstantiateScene(
      world,
      handles[0] as Handle<'SceneAsset', 'shared'>,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
  });

  it('same child instance twice gets disjoint child mappings', () => {
    const world = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [99, 0, 0] } } } },
    };
    const childHandle = registerSceneAsset(world, child);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        first: { components: {}, instance: { source: 'child' } },
        second: { components: {}, instance: { source: 'child' } },
      },
    };
    const parentHandle = registerSceneAsset(world, parent);
    SceneOwner.worldSetSceneAssetResolver(world, (source) => {
      return typeof source === 'number'
        ? ok(source as Handle<'SceneAsset', 'shared'>)
        : source === 'child'
          ? ok(childHandle)
          : err({ code: 'asset-not-found' });
    });
    const result = SceneOwner.worldInstantiateScene(world, parentHandle);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    if (!result.ok) return;
    const instance = world.get(result.value.root, SceneInstance);
    expect(instance.ok).toBe(true);
    if (!instance.ok) return;
    expect(instance.value.mapping[2]).toBeDefined();
    expect(instance.value.mapping[3]).toBeDefined();
    expect(instance.value.mapping[2]).not.toBe(instance.value.mapping[3]);
  });

  it('parent components can address a nested child by a key path', () => {
    const world = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        'entity-1': { components: { Transform: {} } },
      },
    };
    const childHandle = registerSceneAsset(world, child);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        'entity-1': {
          components: { Transform: {}, ChildOf: { parent: ['child', 'entity-0'] } },
        },
        child: { components: {}, instance: { source: 'child' } },
      },
    };
    const parentHandle = registerSceneAsset(world, parent);
    SceneOwner.worldSetSceneAssetResolver(world, (source) =>
      typeof source === 'number'
        ? ok(source as Handle<'SceneAsset', 'shared'>)
        : source === 'child'
          ? ok(childHandle)
          : err({ code: 'asset-not-found' }),
    );
    const result = SceneOwner.worldInstantiateScene(world, parentHandle);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const instance = world.get(result.value.root, SceneInstance);
    expect(instance.ok).toBe(true);
    if (!instance.ok) return;
    const outer = instance.value.mapping[1] as number;
    const nested = instance.value.mapping[3] as number;
    const childOf = world.get(outer as never, ChildOf);
    expect(childOf.ok).toBe(true);
    if (!childOf.ok) return;
    expect(childOf.value.parent as unknown as number).toBe(nested);
  });
});
