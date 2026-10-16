import * as SceneOwner from '@forgeax/engine-scene';

// feat-20260707-engine-world-clone-transient-for-editor-ssot M1 / m1t4:
// AC-05 roundtrip regression test (red-first — falsification anchor).
//
// TDD red phase: on un-fixed code, collect writes Children from archetype
// columns (the double-write bug). After m1t6 (Children = transient, skipped
// by collect), mirror hook becomes the sole reconstruction path => no duplicates.
//
// Assertions:
//   (a) Children.entities has zero duplicate handles after round-trip.
//   (b) Each child's ChildOf.parent points back (bijective check).
//   (c) Degenerate: zero parent-child scene round-trips correctly.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { componentDefinition, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  ChildOf,
  Children,
  GlobalTransform,
  propagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import type { LocalEntityId, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

// Read the resolved world mat4 (column-major 16 floats) from the Transform
// world column array view.
function worldOf(world: World, entity: EntityHandle): Float32Array {
  return world.get(entity, GlobalTransform).unwrap().world;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function _localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

// biome-ignore lint/suspicious/noExplicitAny: branded Handle type mismatch
function registerSceneAsset(world: World, asset: SceneAsset): any {
  return world.allocSharedRef('SceneAsset', asset);
}

describe('m1t4 — AC-05 roundtrip regression (red-first)', () => {
  it('(a,b) roundtrip: Children.entities no duplicate + ChildOf bijectivity', () => {
    // Build hierarchy via instantiateScene's own entity structure.
    // A scene with 3 entities: e0 is root, e1 and e2 are children under e0.
    // After instantiateScene, the synthetic root has Children populated by mirror hook.
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: {} },
        'entity-1': { components: {} },
        'entity-2': { components: {} },
      },
    };

    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Collect from the instantiated scene.
    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Round-trip to a fresh world.
    const world2 = new World();
    registerSceneComponents(world2);
    const reg2 = makeRegistry();
    const sg2 = AssetGuid.parse('11111111-1111-1111-1111-111111111111');
    if (sg2.ok) reg2.catalog(sg2.value, collected.value);
    // biome-ignore lint/suspicious/noExplicitAny: branded Handle type mismatch
    const h2 = world2.allocSharedRef('SceneAsset', collected.value) as any;
    const inst2 = SceneOwner.worldInstantiateScene(world2, h2);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;

    // Traverse the round-tripped world and check dedup + bijectivity.
    const checked = new Set<number>();

    function check(entity: EntityHandle): void {
      const raw = entity as unknown as number;
      if (checked.has(raw)) return;
      checked.add(raw);

      const kidsRes = world2.get(entity, Children);
      if (kidsRes.ok && kidsRes.value.entities.length > 0) {
        const kids = [...kidsRes.value.entities];

        // Assertion (a): no duplicate handles.
        const seen = new Set<number>();
        for (const k of kids) {
          const kidRaw = k as unknown as number;
          if (seen.has(kidRaw)) {
            // TDD red phase: this is the double-write failure.
            expect.fail(`duplicate child handle ${kidRaw}`);
          }
          seen.add(kidRaw);

          // Assertion (b): bijectivity.
          const coRes = world2.get(k as unknown as EntityHandle, ChildOf);
          if (coRes.ok) {
            expect(coRes.value.parent).toBe(entity);
          }

          check(k as unknown as EntityHandle);
        }
      }
    }

    check(inst2.value.root);
  });

  it('(c) degenerate: zero parent-child scene round-trips', () => {
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} } },
    };

    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Round-trip through a second world.
    const world2 = new World();
    registerSceneComponents(world2);
    const reg2 = makeRegistry();
    const sg2 = AssetGuid.parse('11111111-1111-1111-1111-111111111111');
    if (sg2.ok) reg2.catalog(sg2.value, collected.value);
    // biome-ignore lint/suspicious/noExplicitAny: branded Handle type mismatch
    const h2 = world2.allocSharedRef('SceneAsset', collected.value) as any;
    const inst2 = SceneOwner.worldInstantiateScene(world2, h2);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;

    // Second collect also works.
    const collected2 = rootsToSceneAsset(reg2, world2, [inst2.value.root]);
    expect(collected2.ok).toBe(true);
  });
});

// feat-20260709-transform-serialization-vec-fields-and-field-trans M1 / w1:
// AC-04 field-transient roundtrip numeric equivalence (TDD red-first).
//
// A Transform-carrying scene serialized (world skipped, transient) then
// re-instantiated must, after the first propagate pass, produce a world mat4
// numerically equivalent (within float tolerance) to the world mat4 the source
// world produced. The transient world column is reconstructed by propagate from
// the persisted local TRS -- proving skipping it loses nothing.
describe('w1 — AC-04 transient world roundtrip numeric equivalence', () => {
  function _localId2(n: number): LocalEntityId {
    return n as LocalEntityId;
  }

  it('world mat4 after roundtrip+propagate equals source within tolerance', () => {
    // Non-identity local TRS so the world mat4 is a real, distinguishable value.
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': {
          components: {
            Transform: {
              pos: [3, 4, 5],
              quat: [0, 0, 0, 1],
              scale: [2, 2, 2],
            },
          },
        },
      },
    };

    const world = new World();
    registerSceneComponents(world);
    const reg = makeRegistry();
    const sg = AssetGuid.parse('00000000-0000-0000-0000-000000000000');
    if (sg.ok) reg.catalog(sg.value, asset);
    const handle = registerSceneAsset(world, asset);
    const res = SceneOwner.worldInstantiateScene(world, handle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Source world mat4 (drive propagate first).
    expect(propagateTransforms(world).ok).toBe(true);
    // The Transform entity is the child of the synthetic root; locate it via
    // the collect closure being 2 entities (root + our entity).
    const collected = rootsToSceneAsset(reg, world, [res.value.root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Serialized output must not carry world (transient).
    for (const ent of Object.values(collected.value.entities)) {
      const t = (ent.components as Record<string, Record<string, unknown>>).Transform;
      if (t !== undefined) expect('world' in t).toBe(false);
      expect((ent.components as Record<string, unknown>).GlobalTransform).toBeUndefined();
    }

    // Round-trip into a fresh world.
    const world2 = new World();
    registerSceneComponents(world2);
    const reg2 = makeRegistry();
    const sg2 = AssetGuid.parse('11111111-1111-1111-1111-111111111111');
    if (sg2.ok) reg2.catalog(sg2.value, collected.value);
    // biome-ignore lint/suspicious/noExplicitAny: branded Handle type mismatch
    const h2 = world2.allocSharedRef('SceneAsset', collected.value) as any;
    const inst2 = SceneOwner.worldInstantiateScene(world2, h2);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;
    expect(propagateTransforms(world2).ok).toBe(true);

    // Recursively find the entity whose resolved world translation matches the
    // authored TRS (3,4,5). Roundtrip re-nests under fresh synthetic roots that
    // also carry identity Transforms, so select by value, not by depth.
    function findAuthoredWorld(w: World, root: EntityHandle): Float32Array {
      const stack: EntityHandle[] = [root];
      const seen = new Set<number>();
      while (stack.length > 0) {
        const e = stack.pop() as EntityHandle;
        const raw = e as unknown as number;
        if (seen.has(raw)) continue;
        seen.add(raw);
        if (w.get(e, Transform).ok) {
          const mat = worldOf(w, e);
          if (
            Math.abs((mat[12] as number) - 3) < 1e-3 &&
            Math.abs((mat[13] as number) - 4) < 1e-3 &&
            Math.abs((mat[14] as number) - 5) < 1e-3
          ) {
            return mat.slice();
          }
        }
        const kidsRes = w.get(e, Children);
        if (kidsRes.ok) {
          for (const k of kidsRes.value.entities) stack.push(k as unknown as EntityHandle);
        }
      }
      throw new Error('authored Transform entity not found');
    }

    const wSrc = findAuthoredWorld(world, res.value.root);
    const wDst = findAuthoredWorld(world2, inst2.value.root);
    expect(wSrc.length).toBe(16);
    expect(wDst.length).toBe(16);
    for (let i = 0; i < 16; i++) {
      expect(wDst[i] as number).toBeCloseTo(wSrc[i] as number, 5);
    }
    // Sanity: the world mat4 carries the expected translation (col 3).
    expect(wDst[12] as number).toBeCloseTo(3, 5);
    expect(wDst[13] as number).toBeCloseTo(4, 5);
    expect(wDst[14] as number).toBeCloseTo(5, 5);
  });

  it('declares GlobalTransform transient and reconstructs it from the authored pair', () => {
    expect(componentDefinition(GlobalTransform).policy.transient).toBe(true);
  });
});
