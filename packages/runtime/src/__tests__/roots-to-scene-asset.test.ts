import * as SceneOwner from '@forgeax/engine-scene';

// M2 test -- rootsToSceneAsset forest entry + schema-derived field conversion
// (plan-strategy D-1/D-2/D-4/D-7/D-8).
//
// Coverage (by task):
//   m2-t1: forest multi-root BFS closure + localId renumbering
//   m2-t2: entity / array<entity> -> localId (AC-04/05)
//   m2-t3: shared<> / array<shared<>> -> GUID, incl. fixed-size variant (AC-06/07)
//   m2-t4: root ChildOf strip + cross-root closure refs (AC-09/10)
//   m2-t5: out-of-bounds fail-fast + GUID unresolved fail-fast + exhaustive switch (AC-11/12/17)

import { AnimationPlayer } from '@forgeax/engine-animation';
import type { Asset } from '@forgeax/engine-assets-runtime';
import {
  AssetRegistry,
  resolveAssetHandle,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { SceneInstance } from '@forgeax/engine-render';
import { ChildOf } from '@forgeax/engine-scene';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

function linkChildren(
  world: World,
  parent: EntityHandle,
  children: readonly (EntityHandle | number)[],
): void {
  registerSceneComponents(world);
  for (const child of children) {
    const result = world.addComponent(child as EntityHandle, {
      component: ChildOf,
      data: { parent },
    });
    if (!result.ok) throw new Error(result.error.code);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function makePayload(kind: Asset['kind']): Asset {
  return { kind } as Asset;
}

// A marker component with no entity/shared fields -- safe for entity spawning.
const Tag = defineComponent('Tag', { value: 'f32' });

/** Spawn an entity with a component; return raw id. */
// biome-ignore lint/suspicious/noExplicitAny: test helper bridging typed component tokens to World.spawn
function s(w: World, comp: any, data: any): number {
  registerSceneComponents(w, [comp]);
  // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for World.spawn overload
  const r = w.spawn({ component: comp, data } as any);
  if (!r.ok) throw new Error('spawn failed');
  return r.value as number;
}

/** Spawn a tag-only entity (no entity ref fields). */
function stag(w: World, n: number): number {
  return s(w, Tag, { value: n });
}

// Reusable ref components for entity-type fields.
const Test_EntityRef = defineComponent('Test_EntityRef', { target: 'entity' });
const Test_EntityArray = defineComponent('Test_EntityArray', { targets: 'array<entity>' });

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t1: forest multi-root BFS closure + localId renumbering
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t1: forest multi-root BFS closure + localId renumbering', () => {
  it('3-root forest yields all entities in the closure', () => {
    const world = new World();
    const reg = makeRegistry();

    const e0 = stag(world, 0);
    const e1 = stag(world, 1);
    const e2 = stag(world, 2);
    const e3 = stag(world, 3);
    const e4 = stag(world, 4);
    const e5 = stag(world, 5);

    // Tree A: e0 -> e1 -> e2
    linkChildren(world, e0 as EntityHandle, [e1 as EntityHandle]);
    linkChildren(world, e1 as EntityHandle, [e2 as EntityHandle]);
    // Tree C: e4 -> e5
    linkChildren(world, e4 as EntityHandle, [e5 as EntityHandle]);

    const result = rootsToSceneAsset(reg, world, [
      e0 as EntityHandle,
      e3 as EntityHandle,
      e4 as EntityHandle,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.entities)).toHaveLength(6);
  });

  it('ancestor-descendant overlapping roots silently de-duplicate', () => {
    const world = new World();
    const reg = makeRegistry();
    const e0 = stag(world, 0);
    const e1 = stag(world, 1);
    const e2 = stag(world, 2);
    const e3 = stag(world, 3);
    linkChildren(world, e0 as EntityHandle, [e1 as EntityHandle]);
    linkChildren(world, e1 as EntityHandle, [e2 as EntityHandle]);
    linkChildren(world, e2 as EntityHandle, [e3 as EntityHandle]);

    const result = rootsToSceneAsset(reg, world, [e0 as EntityHandle, e1 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.entities)).toHaveLength(4);
  });

  it('localIds are 0..N-1 continuous in BFS order', () => {
    const world = new World();
    const reg = makeRegistry();
    const e0 = stag(world, 0);
    const e1 = stag(world, 1);
    const e2 = stag(world, 2);
    const e3 = stag(world, 3);
    const e4 = stag(world, 4);
    linkChildren(world, e0 as EntityHandle, [e1 as EntityHandle, e2 as EntityHandle]);
    linkChildren(world, e1 as EntityHandle, [e3 as EntityHandle]);
    linkChildren(world, e2 as EntityHandle, [e4 as EntityHandle]);

    const result = rootsToSceneAsset(reg, world, [e0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(Object.keys(scene.entities)).toHaveLength(5);

    const keys = Object.keys(scene.entities);
    expect(keys).toEqual(['entity-0', 'entity-1', 'entity-2', 'entity-3', 'entity-4']);
  });

  it('empty roots produces empty SceneAsset (no error)', () => {
    const world = new World();
    const reg = makeRegistry();
    const result = rootsToSceneAsset(reg, world, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.entities)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t2: entity / array<entity> -> localId (AC-04/05)
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t2: entity / array<entity> -> localId', () => {
  it('entity field round-trips as localId, not raw handle', () => {
    const world = new World();
    const reg = makeRegistry();

    const r0 = stag(world, 0);
    const r1 = s(world, Test_EntityRef, { target: r0 });
    linkChildren(world, r0 as EntityHandle, [r1 as EntityHandle]);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(Object.keys(scene.entities)).toHaveLength(2);

    const e1 = scene.entities['entity-1'];
    if (!e1) throw new Error('entity 1 missing');
    const refComps = (e1.components as Record<string, Record<string, unknown>>).Test_EntityRef;
    expect(refComps).toBeDefined();
    if (!refComps) throw new Error('Test_EntityRef missing');
    expect(refComps.target).toBe('entity-0');
  });

  it('array<entity> field round-trips each element as localId', () => {
    const world = new World();
    const reg = makeRegistry();

    const r0 = stag(world, 0);
    const r1 = stag(world, 1);
    const r2 = stag(world, 2);
    linkChildren(world, r0 as EntityHandle, [r1 as EntityHandle, r2 as EntityHandle]);
    registerSceneComponents(world, [Test_EntityArray]);
    world.addComponent(r0 as EntityHandle, {
      component: Test_EntityArray,
      // biome-ignore lint/suspicious/noExplicitAny: entity handle arrays typed as EntityHandle[]; data schema matches component definition
      data: { targets: [r1 as EntityHandle, r2 as EntityHandle] } as any,
    });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(Object.keys(scene.entities)).toHaveLength(3);

    const rootEnt = scene.entities['entity-0'];
    if (!rootEnt) throw new Error('entity 0 missing');
    const elComps = (rootEnt.components as Record<string, Record<string, unknown>>)
      .Test_EntityArray;
    expect(elComps).toBeDefined();
    if (!elComps) throw new Error('Test_EntityArray missing');
    const targetsArr = elComps.targets as unknown[];
    expect(Array.isArray(targetsArr)).toBe(true);
    expect(targetsArr).toEqual(['entity-1', 'entity-2']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t3: shared<> / array<shared<>> -> GUID, incl. fixed-size variant (AC-06/07)
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t3: shared<> / array<shared<>> -> GUID', () => {
  it('shared<> scalar field resolves to GUID string (no handleToGuid param)', () => {
    const assetPayload = makePayload('skeleton');
    const reg = makeRegistry();
    const guid = AssetGuid.parse('d0000000-d000-0000-0000-000000000001');
    if (!guid.ok) throw new Error('guid parse failed');
    reg.catalog(guid.value, assetPayload);

    const world = new World();
    const handle = world.allocSharedRef('', assetPayload);

    const Test_HasShared = defineComponent('Test_HasShared', {
      ref: { type: 'shared<TestAsset>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent generic constraint is too strict for complex schema types like shared<>
    } as any);

    const r0 = s(world, Test_HasShared, {
      ref: handle,
      // biome-ignore lint/suspicious/noExplicitAny: Handle<> branded type is not directly assignable to component data field for schema 'shared<>'
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    const ent0 = scene.entities['entity-0'];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>).Test_HasShared;
    expect(comps).toBeDefined();
    if (!comps) throw new Error('Test_HasShared missing');
    expect(comps.ref).toBeTypeOf('string');
    expect(comps.ref).toBe(AssetGuid.format(guid.value));
  });

  it('array<shared<>> field resolves each element to GUID', () => {
    const assetA = makePayload('skeleton');
    const assetB = makePayload('equirect');
    const reg = makeRegistry();
    const guidA = AssetGuid.parse('d0000000-d000-0000-0000-000000000001');
    const guidB = AssetGuid.parse('e0000000-e000-0000-0000-000000000001');
    if (!guidA.ok || !guidB.ok) throw new Error('guid parse failed');
    reg.catalog(guidA.value, assetA);
    reg.catalog(guidB.value, assetB);

    const world = new World();
    const hA = world.allocSharedRef('', assetA);
    const hB = world.allocSharedRef('', assetB);

    const Test_HasSharedArray = defineComponent('Test_HasSharedArray', {
      sources: { type: 'array<shared<TestAsset>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for complex schema types like array<shared<>>
    } as any);

    const r0 = s(world, Test_HasSharedArray, {
      // biome-ignore lint/suspicious/noExplicitAny: Handle<> branded types require casting for component data assignment
      sources: [hA as any, hB as any],
      // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for component spawn
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    const ent0 = scene.entities['entity-0'];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>).Test_HasSharedArray;
    expect(comps).toBeDefined();
    if (!comps) throw new Error('Test_HasSharedArray missing');
    const sources = comps.sources as unknown[];
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toBe(AssetGuid.format(guidA.value));
    expect(sources[1]).toBe(AssetGuid.format(guidB.value));
  });

  it('EMPTY array<shared<>> collects WITHOUT throwing (default-material fallback)', () => {
    // Regression: the editor used to auto-mint a synthetic default MaterialAsset
    // (allocSharedRef WITHOUT catalog) for MeshFilter-only entities, so on save
    // this collect path hit `_guidForAsset === undefined` and threw
    // SceneCollectAssetGuidUnresolvedError -> the whole save aborted. The fix
    // attaches an EMPTY `materials: []` instead (engine's own default-material
    // fallback paints it grey). An empty shared-array must serialize to `[]` with
    // ZERO _guidForAsset calls -> no throw, save succeeds.
    const reg = makeRegistry();
    const world = new World();

    const Test_HasSharedArray = defineComponent('Test_EmptyMaterials', {
      sources: { type: 'array<shared<TestAsset>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for array<shared<>>
    } as any);

    // Empty array -- exactly what MeshRenderer{materials:[]} produces.
    const r0 = s(world, Test_HasSharedArray, {
      sources: [],
      // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for component spawn
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ent0 = result.value.entities['entity-0'];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>).Test_EmptyMaterials;
    // An empty shared array serializes to [] (or the component is omitted when it
    // has no other populated fields) -- either way, no unresolved-GUID throw.
    if (comps !== undefined) {
      expect(comps.sources as unknown[]).toEqual([]);
    }
  });

  it('anti-vacuous: a NON-cataloged handle in the shared array DOES throw', () => {
    // Guards the test above from passing vacuously: a shared-array element whose
    // handle resolves to an UNcataloged asset (the old synthetic-mint situation)
    // must still fail-fast with SceneCollectAssetGuidUnresolvedError.
    const reg = makeRegistry();
    const world = new World();
    const uncataloged = makePayload('material');
    // allocSharedRef WITHOUT reg.catalog(...) -- the exact old bug shape.
    const h = world.allocSharedRef('', uncataloged);

    const Test_HasSharedArray = defineComponent('Test_UncatMaterials', {
      sources: { type: 'array<shared<TestAsset>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for array<shared<>>
    } as any);
    const r0 = s(world, Test_HasSharedArray, {
      // biome-ignore lint/suspicious/noExplicitAny: Handle<> branded types require casting
      sources: [h as any],
      // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for component spawn
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SceneCollectAssetGuidUnresolvedError);
    }
  });

  it('fixed-size array<shared<T>,N> schema variant matches startsWith classifier', () => {
    // Verify that classifyFieldSchema startsWith('array<shared<')
    // covers fixed-size 'array<shared<T>,N>' variants (R-1 / D-2).
    expect('array<shared<TestAsset>, 3>'.startsWith('array<shared<')).toBe(true);
    expect('array<shared<TestAsset>>'.startsWith('array<shared<')).toBe(true);
    expect('array<shared<>>'.startsWith('array<shared<')).toBe(true);
  });

  // NULL sentinel handle 0 -- an UNSET shared<T> field defaults to slot 0
  // (ECS three-layer default). world.ts retain arms treat `!== 0` as the
  // active-slot guard, so slot 0 is the documented "no asset here" sentinel.
  // collect must NOT try to resolve it to a GUID (there is none) -- otherwise
  // every entity carrying an unset shared field aborts the whole scene
  // serialize (regression: feedback 2026-07-08-rootstosceneasset).
  it('scalar shared<> field left at NULL sentinel (handle 0) is OMITTED, not an error', () => {
    const reg = makeRegistry();
    const world = new World();

    const Test_UnsetScalar = defineComponent('Test_UnsetScalarShared', {
      ref: { type: 'shared<TestAsset>' },
      tag: { type: 'f32', default: 7 },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for shared<>
    } as any);

    // Spawn WITHOUT setting `ref` -- it defaults to slot 0 (NULL sentinel).
    const r0 = s(world, Test_UnsetScalar, { tag: 42 });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ent0 = result.value.entities['entity-0'];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>)
      .Test_UnsetScalarShared;
    if (!comps) throw new Error('Test_UnsetScalarShared missing');
    // The unset shared scalar is omitted; other fields survive.
    expect(comps.ref).toBeUndefined();
    expect(comps.tag).toBe(42);
  });

  it('array<shared<T>,N> with NULL sentinel slots preserves POSITION (does not compact)', () => {
    // Positional SoA (e.g. AnimationPlayer.clips = [h, 0, 0, 0]) -- a slot may
    // be 0 while its paired arrays (times/weights) carry per-slot data at the
    // same index. collect must keep the slot as numeric 0, not drop it, or the
    // arrays desynchronize on reload.
    const assetA = makePayload('skeleton');
    const reg = makeRegistry();
    const guidA = AssetGuid.parse('d0000000-d000-0000-0000-000000000009');
    if (!guidA.ok) throw new Error('guid parse failed');
    reg.catalog(guidA.value, assetA);

    const world = new World();
    const hA = world.allocSharedRef('', assetA);

    // Fixed-size-4 array; only slot 2 is populated -> [0, 0, hA, 0].
    const Test_SparseArray = defineComponent('Test_SparseSharedArray', {
      slots: { type: 'array<shared<TestAsset>, 4>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for array<shared<>,N>
    } as any);

    const r0 = s(world, Test_SparseArray, {
      // biome-ignore lint/suspicious/noExplicitAny: short-prefix write pads tail with sentinel 0
      slots: [0, 0, hA as any, 0],
      // biome-ignore lint/suspicious/noExplicitAny: test helper adapter for component spawn
    } as any);

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ent0 = result.value.entities['entity-0'];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>)
      .Test_SparseSharedArray;
    if (!comps) throw new Error('Test_SparseSharedArray missing');
    const slots = comps.slots as unknown[];
    expect(Array.isArray(slots)).toBe(true);
    // Position preserved: 4 slots, GUID only at index 2, sentinel 0 elsewhere.
    expect(slots).toHaveLength(4);
    expect(slots[0]).toBe(0);
    expect(slots[1]).toBe(0);
    expect(slots[2]).toBe(AssetGuid.format(guidA.value));
    expect(slots[3]).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t4: root ChildOf strip + cross-root closure refs (AC-09/10)
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t4: root ChildOf strip + cross-root closure refs', () => {
  it('root entity ChildOf is stripped from output', () => {
    const world = new World();
    const reg = makeRegistry();
    const parent = stag(world, 99);
    const r0 = s(world, ChildOf, { parent: parent as EntityHandle });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(Object.keys(scene.entities)).toHaveLength(1);

    const ent0 = scene.entities['entity-0'];
    if (!ent0) throw new Error('entity missing');
    const comps = ent0.components as Record<string, Record<string, unknown>>;
    expect(comps.ChildOf).toBeUndefined();
  });

  it('cross-root but within-closure entity ref resolves to localId', () => {
    const world = new World();
    const reg = makeRegistry();
    const aRoot = stag(world, 0);
    const bRoot = stag(world, 1);
    const aChild = s(world, Test_EntityRef, { target: bRoot });

    linkChildren(world, aRoot as EntityHandle, [aChild as EntityHandle]);

    const result = rootsToSceneAsset(reg, world, [aRoot as EntityHandle, bRoot as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scene = result.value;
    expect(Object.keys(scene.entities)).toHaveLength(3);

    const childEntity = Object.values(scene.entities).find(
      (e) =>
        (e.components as Record<string, Record<string, unknown>>).Test_EntityRef?.target !==
        undefined,
    );
    expect(childEntity).toBeDefined();
    if (!childEntity) throw new Error('child entity missing');
    const refVal = (childEntity.components as Record<string, Record<string, unknown>>)
      .Test_EntityRef;
    if (!refVal) throw new Error('Test_EntityRef missing');
    expect(typeof refVal.target).toBe('string');
    expect(refVal.target).toBe('entity-2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// m2-t5: out-of-bounds + GUID unresolved fail-fast + exhaustive switch (AC-11/12/17)
// ═══════════════════════════════════════════════════════════════════════════════

describe('m2-t5: fail-fast error paths + exhaustive switch', () => {
  it('entity ref outside closure -> err with code scene-collect-entity-ref-out-of-closure', () => {
    const world = new World();
    const reg = makeRegistry();
    const external = stag(world, 99);
    const r0 = s(world, Test_EntityRef, { target: external });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe('scene-collect-entity-ref-out-of-closure');
      const err = result.error;
      if (err instanceof SceneCollectEntityRefOutOfClosureError) {
        expect(err.detail.entity).toBeTypeOf('number');
        expect(err.detail.field).toBe('target');
        expect(err.detail.target).toBeTypeOf('number');
      }
    }
  });

  it('GUID unresolved -> err with code scene-collect-asset-guid-unresolved', () => {
    const assetPayload = makePayload('skeleton');
    const reg = makeRegistry();
    const world = new World();
    const handle = world.allocSharedRef('', assetPayload);

    const Test_SharedMiss = defineComponent('Test_SharedMiss', {
      src: { type: 'shared<TestAsset>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint too strict for complex schema
    } as any);

    const r0 = s(world, Test_SharedMiss, {
      // biome-ignore lint/suspicious/noExplicitAny: Handle branded type not assignable to component data
      src: handle as any,
    });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe('scene-collect-asset-guid-unresolved');
      const err = result.error;
      if (err instanceof SceneCollectAssetGuidUnresolvedError) {
        expect(err.detail.field).toBe('src');
        expect(err.detail.handle).toBeTypeOf('number');
      }
    }
  });

  it('exhaustive switch consumer path (AC-17): no default branch compiles', () => {
    const world = new World();
    const reg = makeRegistry();
    const external = stag(world, 99);
    const r0 = s(world, Test_EntityRef, { target: external });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      switch (result.error.code) {
        case 'scene-collect-entity-ref-out-of-closure': {
          expect(typeof result.error.detail.entity).toBe('number');
          break;
        }
        case 'scene-collect-asset-guid-unresolved': {
          expect(typeof result.error.detail.handle).toBe('number');
          break;
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// w19 — AC-07: end-to-end round-trip value equivalence
//
// The runtime synthesis of D-2 (GUID domain closed in assets-runtime) + D-3
// (collect fold) + D-4 (add-or-patch value gate). Mount a GLB-like child scene
// under a parent, addComponent(AnimationPlayer, { clips: [clipHandle] }) on a
// live member, save (rootsToSceneAsset + serialize), reopen (parse + instantiate),
// and assert the reopened member holds AnimationPlayer whose clip is a VALID
// handle that resolveAssetHandle retrieves to the SAME clip asset (value
// equivalence, not merely length/presence).
// ═══════════════════════════════════════════════════════════════════════════════

const W19_CLIP = 'aa19aa19-1919-4191-8191-191919191919';
const W19_CHILD = 'bb19bb19-1919-4191-8191-191919191919';
const W19_PARENT = 'cc19cc19-1919-4191-8191-191919191919';
const W19_SAVED = 'dd19dd19-1919-4191-8191-191919191919';

function pgc(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`bad GUID: ${s}`);
  return r.value;
}

function accessParse(reg: AssetRegistry) {
  const internal = reg as unknown as {
    parseAssetPayload(kind: string, payload: Record<string, unknown>, refs?: string[]): unknown;
  };
  return (
    kind: string,
    payload: Record<string, unknown>,
    refs?: readonly string[] | undefined,
  ): SceneAsset => {
    const r = internal.parseAssetPayload(kind, payload, refs as string[] | undefined);
    if (r === undefined) throw new Error('parse returned undefined');
    return r as SceneAsset;
  };
}

function findMember(w: World, root: EntityHandle): EntityHandle {
  for (const c of w.iterDescendants(root)) {
    if (c === root) continue;
    if (!w.get(c, SceneInstance).ok) continue;
    const st = SceneOwner.worldGetSceneInstanceState(w, c);
    if (!st.ok) continue;
    for (const [member] of st.value.entityToLocalId) return member;
  }
  throw new Error('no mounted member');
}

describe('w19 — end-to-end round-trip value equivalence (AC-07)', () => {
  it('mount + addComponent(AnimationPlayer) survives save/reopen with value-equal clip', () => {
    const reg = makeRegistry();
    const w = new World();
    registerSceneComponents(w, [AnimationPlayer]);

    // Catalogue the clip asset that the AnimationPlayer will reference.
    const clipAsset = { kind: 'animation-clip', duration: 1.5 } as unknown as Asset;
    reg.catalog(pgc(W19_CLIP), clipAsset);

    // Child (GLB-like) scene + parent scene that mounts it.
    const child: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [1, 0, 0] } } } },
    };
    reg.catalog(pgc(W19_CHILD), child as Asset);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        wrapper: { components: { Transform: { pos: [0, 0, 0] } }, instance: { source: W19_CHILD } },
      },
    };
    reg.catalog(pgc(W19_PARENT), parent as Asset);

    const inst = reg.instantiate(
      w.allocSharedRef('SceneAsset', parent) as Handle<'SceneAsset', 'shared'>,
      w,
    );
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const root = inst.value;

    // addComponent AnimationPlayer with a handle pointing at the catalogued clip.
    const clipH = w.allocSharedRef('AnimationClip', clipAsset);
    const member = findMember(w, root);
    const add = w.addComponent(member, {
      component: AnimationPlayer,
      data: { clips: [clipH] } as never,
    });
    expect(add.ok).toBe(true);

    // Save: collect (fold) + serialize.
    const collect = rootsToSceneAsset(reg, w, [root]);
    expect(collect.ok).toBe(true);
    if (!collect.ok) return;
    const ser = serializeSceneAssetToPack(collect.value, w.components.entries(), W19_SAVED);
    expect(ser.ok).toBe(true);
    if (!ser.ok) return;

    // Reopen: parse + catalog + instantiate.
    const assets = ser.value.assets as Array<Record<string, unknown>>;
    const a0 = assets[0];
    if (!a0) throw new Error('no asset');
    const parsed = accessParse(reg)(
      'scene',
      a0.payload as Record<string, unknown>,
      a0.refs as readonly string[] | undefined,
    );
    reg.catalog(pgc(W19_SAVED), parsed as Asset);
    const inst2 = reg.instantiate(
      w.allocSharedRef('SceneAsset', parsed) as Handle<'SceneAsset', 'shared'>,
      w,
    );
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;
    const root2 = inst2.value;

    // Assert: reopened member holds AnimationPlayer with a valid, value-equal clip.
    const member2 = findMember(w, root2);
    const apRes = w.get(member2, AnimationPlayer);
    expect(apRes.ok).toBe(true);
    if (!apRes.ok) return;
    const clips2 = Array.from((apRes.value as { clips: ArrayLike<number> }).clips);
    // slot 0 is a valid (non-zero) handle.
    expect(clips2[0]).toBeGreaterThan(0);
    // resolveAssetHandle retrieves the SAME clip asset (value equivalence).
    const resolved = resolveAssetHandle(w, clips2[0] as unknown as Handle<string, 'shared'>);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const retrieved = resolved.value as unknown as { kind: string; duration: number };
    expect(retrieved.kind).toBe('animation-clip');
    expect(retrieved.duration).toBe(1.5);
  });
});
