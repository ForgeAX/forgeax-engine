import * as SceneOwner from '@forgeax/engine-scene';

// feat-20260707-engine-world-clone-transient-for-editor-ssot M1 / m1t3:
// Children-absent collect test (AC-04).
//
// After Children is declared transient:true (and SceneInstance likewise),
// rootsToSceneAsset on a scene with parent-child hierarchy produces SceneAsset
// where NO entity's components record contains a 'Children' key.
//
// TDD red-phase: this test asserts POST-FIX behavior. Before m1t6 lands,
// Children IS serialized (double-write bug) — the test will FAIL, confirming
// the bug exists. After m1t6 fixes collect to skip transient components,
// the test must PASS.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function _localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

function hasComp(entity: SceneEntity, name: string): boolean {
  return (entity.components as Record<string, Record<string, unknown>>)[name] !== undefined;
}

describe('m1t3 — Children absent from collect (AC-04)', () => {
  it('2-level hierarchy: no entity has Children in collect output', () => {
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} }, 'entity-1': { components: {} } },
    };

    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    // biome-ignore lint/suspicious/noExplicitAny: branded type mismatch
    const handle = world.allocSharedRef('SceneAsset', asset) as any;
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Verify: no entity in the collected scene has 'Children' component.
    for (const ent of Object.values(collected.value.entities)) {
      expect(hasComp(ent, 'Children')).toBe(false);
    }

    // Also verify no entity has 'SceneInstance'.
    for (const ent of Object.values(collected.value.entities)) {
      expect(hasComp(ent, 'SceneInstance')).toBe(false);
    }
  });

  it('3-level hierarchy: all entities free of Children in collect output', () => {
    // Nest 3 levels: use nested instantiateScene calls with child scene assets.
    // Level 1: outer parent scene.
    // Level 2: mid scene instantiated under outer parent entity.
    // Level 3: leaf scene instantiated under mid scene entity.
    const leafAsset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} } },
    };
    const midAsset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} } },
    };
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} }, 'entity-1': { components: {} } },
    };

    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const sg0 = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    const sg1 = AssetGuid.parse('11111111-1111-1111-1111-111111111111');
    const sg2 = AssetGuid.parse('22222222-2222-2222-2222-222222222222');
    if (sg0.ok) reg.catalog(sg0.value, leafAsset);
    if (sg1.ok) reg.catalog(sg1.value, midAsset);
    if (sg2.ok) reg.catalog(sg2.value, outerAsset);

    // biome-ignore lint/suspicious/noExplicitAny: branded type mismatch
    const leafH = world.allocSharedRef('SceneAsset', leafAsset) as any;
    // biome-ignore lint/suspicious/noExplicitAny: branded type mismatch
    const midH = world.allocSharedRef('SceneAsset', midAsset) as any;
    // biome-ignore lint/suspicious/noExplicitAny: branded type mismatch
    const outerH = world.allocSharedRef('SceneAsset', outerAsset) as any;

    // Instantiate outer scene first.
    const outerInst = SceneOwner.worldInstantiateScene(world, outerH);
    expect(outerInst.ok).toBe(true);
    if (!outerInst.ok) return;

    // Find entity at localId 0 under outer root — this is the anchor for mid.
    // We use iterDescendants to find it or directly spawn ChildOf under root.
    // Simpler: instantiate mid under outer root directly.
    const midInst = SceneOwner.worldInstantiateScene(world, midH, outerInst.value.root);
    expect(midInst.ok).toBe(true);
    if (!midInst.ok) return;

    // Instantiate leaf under mid root.
    const leafInst = SceneOwner.worldInstantiateScene(world, leafH, midInst.value.root);
    expect(leafInst.ok).toBe(true);
    if (!leafInst.ok) return;

    // Collect from outer root.
    const collected = rootsToSceneAsset(reg, world, [outerInst.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Hierarchy: outer root + (2 outer children) + mid root + (1 mid child) + leaf root + (1 leaf child) >= 7 entities.
    // But the exact count depends on mount-collapse logic — focus on the Children assertion.
    expect(Object.keys(collected.value.entities).length).toBeGreaterThan(0);

    // No entity has Children or SceneInstance.
    for (const ent of Object.values(collected.value.entities)) {
      expect(hasComp(ent, 'Children')).toBe(false);
      expect(hasComp(ent, 'SceneInstance')).toBe(false);
    }
  });

  it('degenerate: zero-hierarchy scene has no Children', () => {
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} } },
    };

    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    // biome-ignore lint/suspicious/noExplicitAny: branded type mismatch
    const handle = world.allocSharedRef('SceneAsset', asset) as any;
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    for (const ent of Object.values(collected.value.entities)) {
      expect(hasComp(ent, 'Children')).toBe(false);
    }
  });
});
