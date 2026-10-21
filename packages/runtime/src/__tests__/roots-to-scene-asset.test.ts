import { AnimationPlayer } from '@forgeax/engine-animation';
import {
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { RuntimePackAssetInput } from '@forgeax/engine-pack/runtime';
import { SceneInstance } from '@forgeax/engine-render';
import * as SceneOwner from '@forgeax/engine-scene';
import { ChildOf } from '@forgeax/engine-scene';
import type { AnimationClip, AssetHandle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset, serializeSceneAssetToPack } from '../collect-scene-asset';
import { publishTestAssets } from './helpers/publish-runtime-assets';
import { registerSceneComponents } from './helpers/register-scene-components';
import { testAssets } from './helpers/runtime-assets';

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

function makePayload(): AnimationClip {
  return { kind: 'animation-clip', duration: 1, channels: [] };
}

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

const Test_EntityRef = defineComponent('Test_EntityRef', { target: 'entity' });
const Test_EntityArray = defineComponent('Test_EntityArray', { targets: 'array<entity>' });

describe('m2-t1: forest multi-root BFS closure + localId renumbering', () => {
  it('3-root forest yields all entities in the closure', () => {
    const world = new World();
    const reg = testAssets(world);

    const e0 = stag(world, 0);
    const e1 = stag(world, 1);
    const e2 = stag(world, 2);
    const e3 = stag(world, 3);
    const e4 = stag(world, 4);
    const e5 = stag(world, 5);

    linkChildren(world, e0 as EntityHandle, [e1 as EntityHandle]);
    linkChildren(world, e1 as EntityHandle, [e2 as EntityHandle]);
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
    const reg = testAssets(world);
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
    const reg = testAssets(world);
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
    const reg = testAssets(world);
    const result = rootsToSceneAsset(reg, world, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.entities)).toHaveLength(0);
  });
});

describe('m2-t2: entity / array<entity> -> localId', () => {
  it('entity field round-trips as localId, not raw handle', () => {
    const world = new World();
    const reg = testAssets(world);

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
    const reg = testAssets(world);

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

describe('m2-t3: asset<> / array<asset<>> -> GUID', () => {
  it('asset<> scalar field resolves to GUID string (no handleToGuid param)', async () => {
    const assetPayload = makePayload();
    const world = new World();
    const reg = testAssets(world);
    const guid = AssetGuid.parse('d0000000-d000-0000-0000-000000000001');
    if (!guid.ok) throw new Error('guid parse failed');
    publishTestAssets(reg, [
      { guid: AssetGuid.format(guid.value), kind: 'animation-clip', payload: assetPayload },
    ]);

    const handle = (await reg.load(AssetGuid.format(guid.value), 'animation-clip')).unwrap();

    const Test_HasShared = defineComponent('Test_HasShared', {
      ref: { type: 'asset<animation-clip>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent generic constraint is too strict for complex schema types like asset<>
    } as any);

    const r0 = s(world, Test_HasShared, {
      ref: handle,
      // biome-ignore lint/suspicious/noExplicitAny: Handle<> branded type is not directly assignable to component data field for schema 'asset<>'
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

  it('array<asset<>> field resolves each element to GUID', async () => {
    const assetA = makePayload();
    const assetB = makePayload();
    const world = new World();
    const reg = testAssets(world);
    const guidA = AssetGuid.parse('d0000000-d000-0000-0000-000000000001');
    const guidB = AssetGuid.parse('e0000000-e000-0000-0000-000000000001');
    if (!guidA.ok || !guidB.ok) throw new Error('guid parse failed');
    publishTestAssets(reg, [
      { guid: AssetGuid.format(guidA.value), kind: 'animation-clip', payload: assetA },
      { guid: AssetGuid.format(guidB.value), kind: 'animation-clip', payload: assetB },
    ]);

    const hA = (await reg.load(AssetGuid.format(guidA.value), 'animation-clip')).unwrap();
    const hB = (await reg.load(AssetGuid.format(guidB.value), 'animation-clip')).unwrap();

    const Test_HasSharedArray = defineComponent('Test_HasSharedArray', {
      sources: { type: 'array<asset<animation-clip>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for complex schema types like array<asset<>>
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

  it('EMPTY array<asset<>> collects WITHOUT throwing (default-material fallback)', () => {
    const world = new World();
    const reg = testAssets(world);

    const Test_HasSharedArray = defineComponent('Test_EmptyMaterials', {
      sources: { type: 'array<asset<animation-clip>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for array<asset<>>
    } as any);

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
    if (comps !== undefined) {
      expect(comps.sources as unknown[]).toEqual([]);
    }
  });

  it('an unsourced handle in an asset array returns a structured collection error', () => {
    const world = new World();
    const reg = testAssets(world);
    const uncataloged = makePayload();
    const h = reg.create(uncataloged).unwrap();

    const Test_HasSharedArray = defineComponent('Test_UncatMaterials', {
      sources: { type: 'array<asset<animation-clip>>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for array<asset<>>
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

  it('scalar asset<> field left at NULL sentinel (handle 0) is OMITTED, not an error', () => {
    const world = new World();
    const reg = testAssets(world);

    const Test_UnsetScalar = defineComponent('Test_UnsetScalarShared', {
      ref: { type: 'asset<animation-clip>' },
      tag: { type: 'f32', default: 7 },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for asset<>
    } as any);

    const r0 = s(world, Test_UnsetScalar, { tag: 42 });

    const result = rootsToSceneAsset(reg, world, [r0 as EntityHandle]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ent0 = result.value.entities['entity-0'];
    if (!ent0) throw new Error('entity 0 missing');
    const comps = (ent0.components as Record<string, Record<string, unknown>>)
      .Test_UnsetScalarShared;
    if (!comps) throw new Error('Test_UnsetScalarShared missing');
    expect(comps.ref).toBeUndefined();
    expect(comps.tag).toBe(42);
  });

  it('array<asset<T>,N> with NULL sentinel slots preserves POSITION (does not compact)', async () => {
    const assetA = makePayload();
    const world = new World();
    const reg = testAssets(world);
    const guidA = AssetGuid.parse('d0000000-d000-0000-0000-000000000009');
    if (!guidA.ok) throw new Error('guid parse failed');
    publishTestAssets(reg, [
      { guid: AssetGuid.format(guidA.value), kind: 'animation-clip', payload: assetA },
    ]);

    const hA = (await reg.load(AssetGuid.format(guidA.value), 'animation-clip')).unwrap();

    const Test_SparseArray = defineComponent('Test_SparseSharedArray', {
      slots: { type: 'array<asset<animation-clip>, 4>' },
      // biome-ignore lint/suspicious/noExplicitAny: defineComponent constraint is too strict for array<asset<>,N>
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
    expect(slots).toHaveLength(4);
    expect(slots[0]).toBe(0);
    expect(slots[1]).toBe(0);
    expect(slots[2]).toBe(AssetGuid.format(guidA.value));
    expect(slots[3]).toBe(0);
  });
});

describe('m2-t4: root ChildOf strip + cross-root closure refs', () => {
  it('root entity ChildOf is stripped from output', () => {
    const world = new World();
    const reg = testAssets(world);
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
    const reg = testAssets(world);
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

describe('m2-t5: fail-fast error paths + exhaustive switch', () => {
  it('entity ref outside closure -> err with code scene-collect-entity-ref-out-of-closure', () => {
    const world = new World();
    const reg = testAssets(world);
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
    const assetPayload = makePayload();
    const world = new World();
    const reg = testAssets(world);
    const handle = reg.create(assetPayload).unwrap();

    const Test_SharedMiss = defineComponent('Test_SharedMiss', {
      src: { type: 'asset<animation-clip>' },
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
    const reg = testAssets(world);
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

const W19_CLIP = 'aa19aa19-1919-4191-8191-191919191919';
const W19_CHILD = 'bb19bb19-1919-4191-8191-191919191919';
const W19_SAVED = 'dd19dd19-1919-4191-8191-191919191919';

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
  it('mount + addComponent(AnimationPlayer) survives save/reopen with value-equal clip', async () => {
    const w = new World();
    registerSceneComponents(w, [AnimationPlayer]);
    const reg = testAssets(w);
    const clipAsset: AnimationClip = { kind: 'animation-clip', duration: 1.5, channels: [] };
    const child: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [1, 0, 0] } } } },
    };
    const sources: RuntimePackAssetInput[] = [
      { guid: W19_CLIP, kind: 'animation-clip', payload: clipAsset },
      { guid: W19_CHILD, kind: 'scene', payload: child },
    ];
    publishTestAssets(reg, sources);
    const source = (await reg.load(W19_CHILD, 'scene')).unwrap();
    const clip = (await reg.load(W19_CLIP, 'animation-clip')).unwrap();
    const parent = reg
      .create({
        kind: 'scene',
        entities: {
          wrapper: { components: { Transform: { pos: [0, 0, 0] } }, instance: { source } },
        },
      })
      .unwrap();
    const root = reg.instantiate(parent, w).unwrap();
    w.addComponent(findMember(w, root), {
      component: AnimationPlayer,
      data: { clips: [clip] },
    }).unwrap();
    const collected = rootsToSceneAsset(reg, w, [root]).unwrap();
    const packed = serializeSceneAssetToPack(collected, w.components.entries(), W19_SAVED).unwrap();
    const reopenedWorld = new World();
    registerSceneComponents(reopenedWorld, [AnimationPlayer]);
    const reopenedAssets = testAssets(reopenedWorld);
    try {
      publishTestAssets(reopenedAssets, [
        ...sources,
        ...(packed.assets as RuntimePackAssetInput[]),
      ]);
      const scene = (await reopenedAssets.load(W19_SAVED, 'scene')).unwrap();
      const reopenedRoot = reopenedAssets.instantiate(scene, reopenedWorld).unwrap();
      const reopened = reopenedWorld
        .get(findMember(reopenedWorld, reopenedRoot), AnimationPlayer)
        .unwrap();
      const reopenedClip = reopened.clips[0] as AssetHandle<'animation-clip'>;
      expect(reopenedClip).toBeGreaterThan(0);
      expect(reopenedAssets.guidOf(reopenedClip)).toBe(W19_CLIP);
      expect(reopenedAssets.read(reopenedClip).unwrap()).toEqual(clipAsset);
    } finally {
      reopenedAssets.dispose();
      reg.dispose();
    }
  });
});
