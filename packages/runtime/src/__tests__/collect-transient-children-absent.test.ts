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

import { World } from '@forgeax/engine-ecs';
import type { SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

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
    const reg = testAssets(world);
    // biome-ignore lint/suspicious/noExplicitAny: branded type mismatch
    const handle = reg.create(asset).unwrap() as any;
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

  it('3-level hierarchy: all entities free of Children in collect output', async () => {
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
    const reg = testAssets(world);

    const guid = (n: number) => `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
    publishTestAssets(
      reg,
      [leafAsset, midAsset, outerAsset].map((payload, index) => ({
        guid: guid(index),
        kind: 'scene',
        payload,
        refs: [],
        artifacts: {},
      })),
    );
    const leafH = (await reg.load(guid(0), 'scene')).unwrap();
    const midH = (await reg.load(guid(1), 'scene')).unwrap();
    const outerH = (await reg.load(guid(2), 'scene')).unwrap();

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
    const reg = testAssets(world);
    // biome-ignore lint/suspicious/noExplicitAny: branded type mismatch
    const handle = reg.create(asset).unwrap() as any;
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
