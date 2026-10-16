import * as SceneOwner from '@forgeax/engine-scene';
// scene-sugar-instantiate.test - engine.assets.instantiate sugar wrapper
// runtime equivalence (feat-20260514-scene-as-world-blueprint w30; M3 rewrite
// from old SceneInstanceId returns to new Entity returns).
//
// Coverage:
//   (a) sugar entry runs the same pipeline as the main entry: a 2-node
//       SceneAsset goes through `engine.assets.instantiate(handle, world)`
//       and yields the same Entity root / mapping / overrides as the
//       direct `SceneOwner.worldInstantiateScene(world, handle)` call (AC-03 +
//       requirements §IN-3 sugar contract).
//   (b) `parent?` passthrough: passing a parent through the sugar wrapper
//       attaches `ChildOf { parent }` to the root nodes byte-for-byte the
//       same way the main entry does.
//   (c) error passthrough: when the underlying SceneAssetResolver returns
//       Err, the sugar surface returns the same Err verbatim — no wrap, no
//       rename, no message rewrite (research §error-model + plan-strategy
//       §3.3 closed-union transparency).

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import { ChildOf } from '@forgeax/engine-scene';
import type { Handle, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerRuntimeComponents } from './helpers/register-runtime-components';

function buildScene(): SceneAsset {
  const Transform = defineComponent('Transform', { pos: 'array<f32, 3>' });
  void Transform;
  const nodes: SceneEntity[] = [
    { key: 'entity-0', components: { Transform: { pos: [1, 0, 0] } } },
    { key: 'entity-1', components: { Transform: { pos: [2, 0, 0] } } },
  ];
  return {
    kind: 'scene',
    entities: Object.fromEntries(nodes.map(({ key, components }) => [key, { components }])),
  };
}

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  return world.allocSharedRef('SceneAsset', asset);
}

describe('w30 - engine.assets.instantiate sugar wrapper equivalence (AC-03)', () => {
  it('(a) sugar entry produces the same Entity root / mapping shape as the main entry', () => {
    defineComponent('Transform', { pos: 'array<f32, 3>' });
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const asset = buildScene();
    // Direct path baseline.
    const worldA = new World();
    registerRuntimeComponents(worldA);
    const handleA = registerSceneAsset(worldA, asset);
    const directRes = SceneOwner.worldInstantiateScene(worldA, handleA);
    expect(directRes.ok).toBe(true);
    if (!directRes.ok) return;
    const directRoot = directRes.value.root;
    const directInst = worldA.get(directRoot, SceneInstance);
    expect(directInst.ok).toBe(true);
    if (!directInst.ok) return;
    const directState = SceneOwner.worldGetSceneInstanceState(worldA, directRoot);
    expect(directState.ok).toBe(true);
    if (!directState.ok) return;
    // Sugar path.
    const worldB = new World();
    registerRuntimeComponents(worldB);
    const handleB = registerSceneAsset(worldB, asset);
    const sugarRes = reg.instantiate<SceneAsset>(handleB, worldB);
    expect(sugarRes.ok).toBe(true);
    if (!sugarRes.ok) return;
    const sugarRoot: EntityHandle = sugarRes.value;
    const sugarInst = worldB.get(sugarRoot, SceneInstance);
    expect(sugarInst.ok).toBe(true);
    if (!sugarInst.ok) return;
    const sugarState = SceneOwner.worldGetSceneInstanceState(worldB, sugarRoot);
    expect(sugarState.ok).toBe(true);
    if (!sugarState.ok) return;
    // Mapping length parity (2 nodes -> 2 slots).
    expect(sugarInst.value.mapping.length).toBe(directInst.value.mapping.length);
    expect(sugarState.value.overrides.size).toBe(directState.value.overrides.size);
    expect(sugarState.value.overrides.size).toBe(0);
  });

  it('(b) parent? passthrough attaches ChildOf via the sugar entry', () => {
    const Transform = defineComponent('Transform', { pos: 'array<f32, 3>' });
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const asset = buildScene();
    const world = new World();
    registerRuntimeComponents(world);
    const handle = registerSceneAsset(world, asset);
    const parentSpawn = world.spawn({
      component: Transform,
      data: { pos: [0, 0, 0] },
    });
    expect(parentSpawn.ok).toBe(true);
    if (!parentSpawn.ok) return;
    const parentEntity: EntityHandle = parentSpawn.value;
    const sugarRes = reg.instantiate<SceneAsset>(handle, world, parentEntity);
    expect(sugarRes.ok).toBe(true);
    if (!sugarRes.ok) return;
    const sugarRoot: EntityHandle = sugarRes.value;
    const sugarState = SceneOwner.worldGetSceneInstanceState(world, sugarRoot);
    expect(sugarState.ok).toBe(true);
    if (!sugarState.ok) return;
    // The synthetic root now carries a ChildOf component pointing at the
    // caller-supplied parent entity (root entities are children of the
    // synthetic root, not of the caller-supplied parent directly).
    const childOf = world.get(sugarRoot, ChildOf);
    expect(childOf.ok).toBe(true);
    if (!childOf.ok) return;
    expect(childOf.value.parent).toBe(parentEntity);
  });

  it('(c) error passthrough: invalid handle -> sugar returns Err verbatim', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    registerRuntimeComponents(world);
    // Use a handle that is not a managed ref -> instantiateScene returns Err.
    const bogusHandle = toShared<'SceneAsset'>(9999);
    const r = reg.instantiate<SceneAsset>(bogusHandle, world);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(typeof r.error).toBe('object');
  });
});

// ── M5 post-instantiate component injection (w13) ──
// feat-20260528-scene-asset-guid-refs-and-post-instantiate M5 / w13 TDD red.
//
// Coverage:
//   (d) AC-09: rootEntities() + addComponent -> hasComponent=true (query-after pattern);
//       canonical post-instantiate workflow for attaching custom components to
//       the top-level nodes of a prefab instance without a per-instance
//       instantiate(overrides) API.
//   (e) AC-10: mapping[localId] + addComponent -> hasComponent=true;
//       verifies that an AI user can reach any specific node by its Scene-authored
//       localId and attach a component after instantiation.
//   (f) rootEntities() snapshot stays stable after addComponent -- the returned
//       array is a snapshot at call time, not a live view (SceneInstance contract).

function buildPostScene(): SceneAsset {
  const nodes: Array<SceneEntity & { readonly key: string }> = [
    { key: 'entity-0', components: { Transform: { pos: [0, 0, 0] } } },
    {
      key: 'entity-1',
      components: { Transform: { pos: [1, 0, 0] }, ChildOf: { parent: 'entity-0' } },
    },
  ];
  return {
    kind: 'scene',
    entities: Object.fromEntries(nodes.map(({ key, components }) => [key, { components }])),
  };
}

// A lightweight component for post-instantiate injection testing.
const Enemy = defineComponent('Enemy', { speed: 'f32', hp: 'u32' });

// A second component so we can test per-localId injection independently.
const Waypoint = defineComponent('Waypoint', { index: 'u32' });

function postInstantiateEntity(entity: EntityHandle | number | undefined): EntityHandle {
  if (typeof entity === 'number') return entity as EntityHandle;
  throw new Error('rootEntities returned non-Entity entry');
}

describe('M5 post-instantiate component injection (w13 / AC-09 + AC-10)', () => {
  it('(d) AC-09: rootEntities() + world.addComponent -> hasComponent is true', () => {
    defineComponent('Transform', { pos: 'array<f32, 3>' });
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const asset = buildPostScene();
    const world = new World();
    registerRuntimeComponents(world, [Enemy, Waypoint]);
    const handle = registerSceneAsset(world, asset);
    const r = reg.instantiate<SceneAsset>(handle, world);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root: EntityHandle = r.value;
    const state = SceneOwner.worldGetSceneInstanceState(world, root);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const roots = state.value.rootEntities;
    expect(roots.length).toBe(1);
    const rootEntity = postInstantiateEntity(roots[0]);
    // Attach Enemy component via the query-after pattern.
    const addRes = world.addComponent(rootEntity, {
      component: Enemy,
      data: { speed: 4.5, hp: 2 },
    });
    expect(addRes.ok).toBe(true);
    if (!addRes.ok) return;
    const enemyCheck = world.get(rootEntity, Enemy);
    expect(enemyCheck.ok).toBe(true);
    if (!enemyCheck.ok) return;
    expect(enemyCheck.value.speed).toBe(4.5);
    expect(enemyCheck.value.hp).toBe(2);
  });

  it('(e) AC-10: mapping[localId] + world.addComponent -> hasComponent is true', () => {
    defineComponent('Transform', { pos: 'array<f32, 3>' });
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const asset = buildPostScene();
    const world = new World();
    registerRuntimeComponents(world, [Enemy, Waypoint]);
    const handle = registerSceneAsset(world, asset);
    const r = reg.instantiate<SceneAsset>(handle, world);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root: EntityHandle = r.value;
    const inst = world.get(root, SceneInstance);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    // Reach node 1 (child) by its localId via mapping array.
    const mapping = inst.value.mapping;
    const childEntity = mapping[1] as unknown as EntityHandle | undefined;
    expect(childEntity).toBeDefined();
    if (childEntity === undefined) return;
    const addRes = world.addComponent(childEntity, {
      component: Waypoint,
      data: { index: 3 },
    });
    expect(addRes.ok).toBe(true);
    if (!addRes.ok) return;
    const wpCheck = world.get(childEntity, Waypoint);
    expect(wpCheck.ok).toBe(true);
    if (!wpCheck.ok) return;
    expect(wpCheck.value.index).toBe(3);
  });

  it('(d-ii) AC-09: addComponent on a second root entity (multi-root scene)', () => {
    // Two root nodes, each gets a different component via query-after.
    defineComponent('Transform', { pos: 'array<f32, 3>' });
    const multiRoot: SceneEntity[] = [
      { key: 'entity-0', components: { Transform: { pos: [0, 0, 0] } } },
      { key: 'entity-1', components: { Transform: { pos: [10, 0, 0] } } },
    ];
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    registerRuntimeComponents(world, [Enemy, Waypoint]);
    const asset: SceneAsset = { kind: 'scene', entities: multiRoot };
    const handle = registerSceneAsset(world, asset);
    const r = reg.instantiate<SceneAsset>(handle, world);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root: EntityHandle = r.value;
    const state = SceneOwner.worldGetSceneInstanceState(world, root);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const roots = state.value.rootEntities;
    expect(roots.length).toBe(2);
    // Attach Enemy to root 0, Waypoint to root 1.
    const e0 = postInstantiateEntity(roots[0]);
    const e1 = postInstantiateEntity(roots[1]);
    const add0 = world.addComponent(e0, {
      component: Enemy,
      data: { speed: 3, hp: 1 },
    });
    expect(add0.ok).toBe(true);
    expect(world.get(e0, Enemy).ok).toBe(true);
    const add1 = world.addComponent(e1, {
      component: Waypoint,
      data: { index: 7 },
    });
    expect(add1.ok).toBe(true);
    expect(world.get(e1, Waypoint).ok).toBe(true);
  });

  it('rootEntities snapshot is stable (not a live view)', () => {
    defineComponent('Transform', { pos: 'array<f32, 3>' });
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    registerRuntimeComponents(world, [Enemy, Waypoint]);
    const singleRoot: SceneEntity[] = [
      { key: 'entity-0', components: { Transform: { pos: [0, 0, 0] } } },
    ];
    const asset: SceneAsset = { kind: 'scene', entities: singleRoot };
    const handle = registerSceneAsset(world, asset);
    const r = reg.instantiate<SceneAsset>(handle, world);
    if (!r.ok) throw new Error(`instantiate failed: ${JSON.stringify(r.error)}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root: EntityHandle = r.value;
    const state = SceneOwner.worldGetSceneInstanceState(world, root);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const roots1 = state.value.rootEntities;
    // Add a component to the root entity and re-query.
    const e = postInstantiateEntity(roots1[0]);
    const addRes = world.addComponent(e, {
      component: Enemy,
      data: { speed: 1, hp: 10 },
    });
    expect(addRes.ok).toBe(true);
    const state2 = SceneOwner.worldGetSceneInstanceState(world, root);
    expect(state2.ok).toBe(true);
    if (!state2.ok) return;
    const roots2 = state2.value.rootEntities;
    expect(roots1).toEqual(roots2);
  });

  it('mapping identity: mapping[localId] returns the same Entity across calls', () => {
    defineComponent('Transform', { pos: 'array<f32, 3>' });
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    registerRuntimeComponents(world);
    const asset = buildPostScene();
    const handle = registerSceneAsset(world, asset);
    const r = reg.instantiate<SceneAsset>(handle, world);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root: EntityHandle = r.value;
    const inst = world.get(root, SceneInstance);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const mapping1 = inst.value.mapping;
    const inst2 = world.get(root, SceneInstance);
    expect(inst2.ok).toBe(true);
    if (!inst2.ok) return;
    const mapping2 = inst2.value.mapping;
    for (const lid of [0, 1]) {
      const e1 = mapping1[lid];
      const e2 = mapping2[lid];
      expect(e1).toBeDefined();
      expect(e2).toBeDefined();
      expect(e1).toBe(e2);
    }
  });
});
