import type { AssetHandle } from '@forgeax/engine-types';
import { testAssets } from './helpers/runtime-assets';
// feat-20260608-scene-nesting-ecs-fication M2 / w19 (red phase) — despawnScene
// + despawnDescendants. Lives under runtime for the same import-isolation
// reason as world-scene-instantiate.test.ts.
//
// Coverage:
//   - despawnScene(root) recursively despawns root + every member;
//   - despawnDescendants(root) despawns descendants but keeps root alive;
//   - despawnDescendants(plain entity) walks the standard ChildOf chain
//     (no SceneInstance required);
//   - opts.keepDetached preserves members marked via detachSceneMember.

import { defineComponent, Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import {
  ChildOf,
  Transform,
  worldDespawnDescendants,
  worldDespawnScene,
  worldDetachSceneMember,
  worldGetSceneInstanceState,
  worldInstantiateScene,
} from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function registerSceneAsset(world: World, asset: SceneAsset): AssetHandle<'scene'> {
  for (const component of [SceneInstance, ChildOf, Transform]) {
    world.components.register(component).unwrap();
  }
  return testAssets(world).create(asset).unwrap();
}

describe('world.despawnScene (w19)', () => {
  it('despawns root + every member', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        'entity-1': { components: { Transform: {} } },
      },
    };
    const handle = registerSceneAsset(world, asset);
    const r = worldInstantiateScene(world, handle);
    if (!r.ok) throw new Error('instantiateScene failed');
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    expect(inst.value.mapping).toBeInstanceOf(Uint32Array);
    if (!(inst.value.mapping instanceof Uint32Array)) return;
    const m0 = inst.value.mapping[0] as unknown as number;
    const m1 = inst.value.mapping[1] as unknown as number;

    const dr = worldDespawnScene(world, r.value.root);
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    expect(dr.value).toBeGreaterThanOrEqual(3); // root + 2 members

    // After despawn, get() on root + members must fail
    expect(world.get(r.value.root, SceneInstance).ok).toBe(false);
    expect(world.get(m0 as never, Transform).ok).toBe(false);
    expect(world.get(m1 as never, Transform).ok).toBe(false);
  });

  it.each([
    true,
    false,
  ])('retires the mount carrier and mapped members with ChildOf registered: %s', (hierarchy) => {
    const world = new World();
    world.components.register(SceneInstance).unwrap();
    world.components.register(Transform).unwrap();
    if (hierarchy) world.components.register(ChildOf).unwrap();
    const assets = testAssets(world);
    const nested = assets
      .create({
        kind: 'scene',
        entities: { member: { components: { Transform: {} } } },
      })
      .unwrap();
    const outer = assets
      .create({
        kind: 'scene',
        entities: { carrier: { components: {}, instance: { source: nested } } },
      })
      .unwrap();
    const { root } = worldInstantiateScene(world, outer).unwrap();
    const [carrier, member] = world.get(root, SceneInstance).unwrap()
      .mapping as unknown as readonly EntityHandle[];
    const [nestedRoot] = worldGetSceneInstanceState(world, root).unwrap().mountRoots;
    if (member === undefined || carrier === undefined || nestedRoot === undefined)
      throw new Error('missing mount ownership fixture');
    expect(world.hasComponent(member, Transform)).toBe(true);
    expect(world.hasComponent(nestedRoot, SceneInstance)).toBe(true);
    const external = world.spawn().unwrap();
    if (hierarchy) world.reparent(member, external, ChildOf, {}).unwrap();

    expect(worldDespawnDescendants(world, root).unwrap()).toBe(3);
    for (const entity of [carrier, member, nestedRoot])
      expect(world.hasComponent(entity, Entity)).toBe(false);
    expect(world.hasComponent(external, Entity)).toBe(true);
    expect(world.hasComponent(root, SceneInstance)).toBe(true);
  });

  it('uses live instance ownership when the physical mapping is empty', () => {
    const world = new World();
    world.components.register(SceneInstance).unwrap();
    world.components.register(Transform).unwrap();
    const source = testAssets(world)
      .create({
        kind: 'scene',
        entities: { member: { components: { Transform: {} } } },
      })
      .unwrap();
    const { root } = worldInstantiateScene(world, source).unwrap();
    const [member] = worldGetSceneInstanceState(world, root).unwrap().entityToLocalId.keys();
    if (member === undefined) throw new Error('missing owned member');
    world.set(root, SceneInstance, { mapping: [] }).unwrap();

    expect(worldDespawnDescendants(world, root).unwrap()).toBe(1);
    expect(world.hasComponent(member, Entity)).toBe(false);
    expect(world.hasComponent(root, SceneInstance)).toBe(true);
  });

  it('keepDetached: true skips members marked detached', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: {
        'entity-0': { components: { Transform: {} } },
        'entity-1': { components: { Transform: {} } },
      },
    };
    const handle = registerSceneAsset(world, asset);
    const r = worldInstantiateScene(world, handle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    expect(inst.value.mapping).toBeInstanceOf(Uint32Array);
    if (!(inst.value.mapping instanceof Uint32Array)) return;
    const member1 = inst.value.mapping[1] as unknown as number;

    const det = worldDetachSceneMember(world, r.value.root, member1 as never);
    expect(det.ok).toBe(true);

    const dr = worldDespawnScene(world, r.value.root, { keepDetached: true });
    expect(dr.ok).toBe(true);
    // Detached member must remain alive
    expect(world.get(member1 as never, Transform).ok).toBe(true);
  });
});

describe('world.despawnDescendants (w19)', () => {
  it('follows Scene children without retiring entities referenced by component data', () => {
    const Links = defineComponent('SceneDespawnReferences', { entities: 'array<entity>' });
    const world = new World();
    const external = world.spawn().unwrap();
    const root = world.spawn({ component: Links, data: { entities: [external] } }).unwrap();
    const child = world.spawn({ component: ChildOf, data: { parent: root } }).unwrap();

    expect(worldDespawnDescendants(world, root).unwrap()).toBe(1);
    expect(world.hasComponent(root, Entity)).toBe(true);
    expect(world.hasComponent(external, Entity)).toBe(true);
    expect(world.hasComponent(child, Entity)).toBe(false);
  });

  it('despawns descendants but keeps root alive', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: {} });
    if (!root.ok) throw new Error('spawn root failed');
    const child = world.spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent: root.value } },
    );
    if (!child.ok) throw new Error('spawn child failed');

    const dr = worldDespawnDescendants(world, root.value);
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    expect(dr.value).toBeGreaterThanOrEqual(1); // child despawned

    // Root must still be alive; child must be dead
    expect(world.get(root.value, Transform).ok).toBe(true);
    expect(world.get(child.value, Transform).ok).toBe(false);
  });

  it('despawnDescendants on a plain entity (no SceneInstance) walks the ChildOf chain', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: {} });
    if (!root.ok) throw new Error('spawn failed');
    const c1 = world.spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent: root.value } },
    );
    if (!c1.ok) throw new Error('spawn failed');
    const c2 = world.spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent: c1.value } },
    );
    if (!c2.ok) throw new Error('spawn failed');

    const dr = worldDespawnDescendants(world, root.value);
    expect(dr.ok).toBe(true);
    expect(world.get(c1.value, Transform).ok).toBe(false);
    expect(world.get(c2.value, Transform).ok).toBe(false);
  });
});
