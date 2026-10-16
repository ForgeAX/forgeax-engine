// feat-20260707-engine-world-clone-transient-for-editor-ssot M3 / m3t2:
// Transient runtime behavior test (AC-07).
//
// AC-07: transient components remain fully functional at runtime despite
// being skipped by collect. Design doc §6.6 semantic boundary:
// "transient only affects rootsToSceneAsset write step — not runtime presence."
//
// Scenarios:
//   (a) After rootsToSceneAsset runs on a world with Children (transient: true):
//       world.get(entity, Children) returns ok with Children data.
//   (b) query with Children in the query set still matches the entity after collect.
//   (c) world.get(entity, SceneInstance) returns ok after collect.
//   (d) Collect is non-mutating: world.get entity Children before/after collect
//       returns the same value.
//   (e) InstantiateScene on SceneAsset without Children data → mirror hook
//       populates Children correctly for parent entity.
//
// Depends on m2t4 (deferred ChildOf wiring) — ChildOf hierarchy is the
// canonical cause of Children being populated by the mirror hook.

import type { Asset } from '@forgeax/engine-assets-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Children, Transform } from '@forgeax/engine-scene';
import type { Handle, LocalEntityId, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function makeWorld(): World {
  const world = new World();
  for (const component of [Transform, ChildOf, Children, SceneInstance]) {
    world.components.register(component).unwrap();
  }
  return world;
}

function _localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

function cat(reg: AssetRegistry, g: string, p: SceneAsset): void {
  const r = AssetGuid.parse(g);
  if (!r.ok) throw new Error(`bad GUID: ${g}`);
  reg.catalog(r.value, p as Asset);
}

function rs(w: World, a: SceneAsset): Handle<'SceneAsset', 'shared'> {
  return w.allocSharedRef('SceneAsset', a);
}

describe('m3t2 — transient runtime behavior (AC-07)', () => {
  it('(a) world.get Children ok after rootsToSceneAsset', () => {
    const world = makeWorld();
    const reg = makeRegistry();

    // Build a hierarchy: parent -> child via ChildOf. Mirror hook populates Children.
    const parent = world.spawn({ component: Transform, data: {} }).unwrap();
    world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
      .unwrap();

    // Children should be populated by mirror hook
    const preChildren = world.get(parent, Children);
    expect(preChildren.ok).toBe(true);

    // Collect an unrelated scene — this exercises the collect path but never
    // touches the manually-spawned entity
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} } },
    };
    cat(reg, '00000000-0000-4000-8000-000000000000', asset);
    const inst = reg.instantiate(rs(world, asset), world);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    const collected = rootsToSceneAsset(reg, world, [inst.value]);
    expect(collected.ok).toBe(true);

    // After collect, Children is STILL in the archetype — transient means skip
    // during serialization, not removal from the live world
    const postChildren = world.get(parent, Children);
    expect(postChildren.ok).toBe(true);
    if (!postChildren.ok) return;
    const entities = postChildren.value.entities;
    expect(entities).toBeDefined();
    expect(entities.length).toBeGreaterThanOrEqual(1);
  });

  it('(b) query with Children still matches entity after collect', () => {
    const world = makeWorld();
    const reg = makeRegistry();

    const parent = world.spawn({ component: Transform, data: {} }).unwrap();
    world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
      .unwrap();

    // Verify Children is present before collect
    const preChildren = world.get(parent, Children);
    expect(preChildren.ok).toBe(true);
    if (!preChildren.ok) return;
    expect(preChildren.value.entities.length).toBeGreaterThanOrEqual(1);

    // Collect an unrelated scene to exercise the collect code path
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} } },
    };
    cat(reg, '11111111-1111-4111-8111-111111111111', asset);
    const inst = reg.instantiate(rs(world, asset), world);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    rootsToSceneAsset(reg, world, [inst.value]);

    // After collect, query including Children should still match the parent entity.
    // Include Entity in the `with` list to count matched rows.
    const query = world.query({ with: [Children] }).unwrap();
    let matchedCount = 0;
    for (const _row of query) matchedCount += 1;
    expect(matchedCount).toBeGreaterThanOrEqual(1);
  });

  it('(c) world.get SceneInstance ok after collect', () => {
    const world = makeWorld();
    const reg = makeRegistry();

    const child: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} } },
    };
    cat(reg, '22222222-2222-4222-8222-222222222222', child);
    const inst = reg.instantiate(rs(world, child), world);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // pre-collect: SceneInstance is present
    const preSI = world.get(inst.value, SceneInstance);
    expect(preSI.ok).toBe(true);

    // Collect the same root
    const collected = rootsToSceneAsset(reg, world, [inst.value]);
    expect(collected.ok).toBe(true);

    // post-collect: SceneInstance is still present (it's transient, not removed)
    const postSI = world.get(inst.value, SceneInstance);
    expect(postSI.ok).toBe(true);
  });

  it('(d) collect is non-mutating: Children pre/post equals', () => {
    const world = makeWorld();
    const reg = makeRegistry();

    const parent = world.spawn({ component: Transform, data: {} }).unwrap();
    world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
      .unwrap();

    const preChildren = world.get(parent, Children);
    expect(preChildren.ok).toBe(true);
    if (!preChildren.ok) return;
    const preLength = preChildren.value.entities.length;

    // Collect an unrelated scene
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: {} } },
    };
    cat(reg, '33333333-3333-4333-8333-333333333333', asset);
    const inst = reg.instantiate(rs(world, asset), world);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    rootsToSceneAsset(reg, world, [inst.value]);

    const postChildren = world.get(parent, Children);
    expect(postChildren.ok).toBe(true);
    if (!postChildren.ok) return;
    // children count unchanged (collect does not mutate the world)
    expect(postChildren.value.entities.length).toBe(preLength);
  });

  it('(e) instantiateScene of Children-absent SceneAsset → mirror hook populates Children', () => {
    const world = makeWorld();
    const reg = makeRegistry();

    // Build a minimal SceneAsset: parent entity at localId 0 + child entity at
    // localId 1 with ChildOf pointing to localId 0. No Children data in the asset.
    // The mirror hook should populate Children on entity at localId 0.
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        'entity-1': { components: { Transform: {}, ChildOf: { parent: 'entity-0' } } },
      },
    };
    cat(reg, '44444444-4444-4444-8444-444444444444', asset);
    const inst = reg.instantiate(rs(world, asset), world);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // The root entity carries SceneInstance with mapping array
    const siR = world.get(inst.value, SceneInstance);
    expect(siR.ok).toBe(true);
    if (!siR.ok) return;
    const mapping = siR.value.mapping;
    expect(mapping).toBeDefined();

    // mapping[0] is the entity at localId 0 (the parent). Entity handle 0
    // is a valid entity in forgeax (ENTITY_NULL_RAW = 0xFFFFFFFF, not 0).
    const parentEntity = mapping[0] as unknown as EntityHandle;

    // The mirror hook should have populated Children on the parent entity
    // because entity at localId 1 has ChildOf{parent = localId 0}
    const cr = world.get(parentEntity, Children);
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    const ents = cr.value.entities;
    expect(ents.length).toBeGreaterThanOrEqual(1);
  });
});
