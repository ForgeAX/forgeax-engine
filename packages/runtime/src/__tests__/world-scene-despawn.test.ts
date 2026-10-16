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

import { World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import {
  ChildOf,
  Transform,
  worldDespawnDescendants,
  worldDespawnScene,
  worldDetachSceneMember,
  worldInstantiateScene,
} from '@forgeax/engine-scene';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  for (const component of [SceneInstance, ChildOf, Transform]) {
    world.components.register(component).unwrap();
  }
  return world.allocSharedRef('SceneAsset', asset);
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
