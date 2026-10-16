import * as SceneOwner from '@forgeax/engine-scene';
// Keyed runtime cycle gate: A -> B -> C -> A through nested `instance` declarations.

import { World } from '@forgeax/engine-ecs';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { registerSceneComponents } from './helpers/register-scene-components';

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  registerSceneComponents(world);
  return world.allocSharedRef('SceneAsset', asset);
}

describe('runtime cycle fail-fast (keyed SceneAsset)', () => {
  it('A -> B -> C -> A surfaces pack-cyclic-reference', () => {
    const world = new World();
    const assetA: SceneAsset = {
      kind: 'scene',
      entities: { a: { components: {}, instance: { source: 'B' } } },
    };
    const assetB: SceneAsset = {
      kind: 'scene',
      entities: { b: { components: {}, instance: { source: 'C' } } },
    };
    const assetC: SceneAsset = {
      kind: 'scene',
      entities: { c: { components: {}, instance: { source: 'A' } } },
    };
    const handleA = registerSceneAsset(world, assetA);
    const handleB = registerSceneAsset(world, assetB);
    const handleC = registerSceneAsset(world, assetC);
    SceneOwner.worldSetSceneAssetResolver(world, (source, parentHandle) => {
      if (typeof source === 'number') return ok(source as Handle<'SceneAsset', 'shared'>);
      const parent = Number(parentHandle);
      if (parent === Number(handleA) && source === 'B') return ok(handleB);
      if (parent === Number(handleB) && source === 'C') return ok(handleC);
      if (parent === Number(handleC) && source === 'A') return ok(handleA);
      return err({ code: 'asset-not-found' });
    });
    const r = SceneOwner.worldInstantiateScene(world, handleA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.error as { code: string; detail?: { kind?: string; cycle?: readonly string[] } };
    expect(e.code).toBe('pack-cyclic-reference');
    expect(e.detail?.kind).toBe('mount-asset');
    expect(Array.isArray(e.detail?.cycle)).toBe(true);
    expect((e.detail?.cycle ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
