import * as SceneOwner from '@forgeax/engine-scene';
// feat-20260608-scene-nesting-ecs-fication M2 / w20 (red phase) —
// setSceneOverride / removeSceneOverride / detachSceneMember /
// reattachSceneMember + AC-19 mount-time override apply invariants.
//
// AC anchors:
//   - AC-19 mount-time override apply: world.get(member, Comp).field ===
//     overrideValue AND world.get(root, SceneInstance).state.overrides
//     contains the entry (plan-review F-1 — must assert BOTH the readback
//     AND the state map population);
//   - AC-20 setSceneOverride writes the override + readback equals value;
//     removeSceneOverride rolls back to the source SceneAsset value.
//   - detach/reattach mark the runtime slot in state.detachedLocalIds; member
//     entity remains alive.
//   - setSceneOverride type mismatch -> Err 'scene-override-type-mismatch'
//     with detail.{ comp, field, expectedType, actualType }.

import { defineComponent, World } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { registerSceneComponents } from './helpers/register-scene-components';

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  registerSceneComponents(world);
  return world.allocSharedRef('SceneAsset', asset);
}

describe('AC-19 mount-time override apply (w20)', () => {
  it('mount.overrides land on member entity AND in state.overrides map', () => {
    const world = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [1, 0, 0] } } } },
    };
    const childHandle = registerSceneAsset(world, child);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: {
        instance: {
          components: {},
          instance: {
            source: 'child',
            overrides: [{ target: ['entity-0'], components: { Transform: { pos: [42, 0, 0] } } }],
          },
        },
      },
    };
    const parentHandle = registerSceneAsset(world, parent);
    SceneOwner.worldSetSceneAssetResolver(world, (source) =>
      source === 'child' ? ok(childHandle) : ok(childHandle),
    );
    const r = SceneOwner.worldInstantiateScene(world, parentHandle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    expect(inst.value.mapping).toBeInstanceOf(Uint32Array);
    if (!(inst.value.mapping instanceof Uint32Array)) return;
    const member = inst.value.mapping[1] as unknown as number;
    // Read-back invariant
    const t = world.get(member as never, Transform);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(Array.from(t.value.pos)).toEqual([42, 0, 0]);
    // State-map invariant
    const stateRes = SceneOwner.worldGetSceneInstanceState(world, r.value.root);
    if (!stateRes.ok) throw new Error('getSceneInstanceState failed');
    expect(stateRes.value.overrides.has(1 as never)).toBe(true);
    const fields = stateRes.value.overrides.get(1 as never);
    expect(fields).toBeDefined();
    expect(fields?.has('Transform:pos')).toBe(true);
    expect(fields?.get('Transform:pos')?.value).toEqual([42, 0, 0]);
  });
});

describe('world.setSceneOverride (w20)', () => {
  it('writes override + readback returns the override value', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [1, 0, 0] } } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = SceneOwner.worldInstantiateScene(world, handle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    expect(inst.value.mapping).toBeInstanceOf(Uint32Array);
    if (!(inst.value.mapping instanceof Uint32Array)) return;
    const member = inst.value.mapping[0] as unknown as number;
    const sr = SceneOwner.worldSetSceneOverride(
      world,
      r.value.root,
      member as never,
      Transform,
      'pos',
      [99, 0, 0],
    );
    expect(sr.ok).toBe(true);
    const t = world.get(member as never, Transform);
    if (!t.ok) throw new Error('get t failed');
    expect(Array.from(t.value.pos)).toEqual([99, 0, 0]);
  });

  it('returns scene-override-type-mismatch on bad value type', () => {
    // Transform's fields are all arrays now; the scalar typeof guard only
    // fires for primitive scalar fields, so exercise it via a scalar
    // component instead.
    const Hp = defineComponent('SceneOverrideHp', { hp: 'f32' });
    const world = new World();
    registerSceneComponents(world, [Hp]);
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { SceneOverrideHp: {} } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = SceneOwner.worldInstantiateScene(world, handle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    const member = inst.value.mapping[0] as unknown as number;
    // Pass a string for an f32 field
    const sr = SceneOwner.worldSetSceneOverride(
      world,
      r.value.root,
      member as never,
      Hp,
      'hp',
      'oops' as unknown as number,
    );
    expect(sr.ok).toBe(false);
    if (sr.ok) return;
    const errCode = (sr.error as { code: string }).code;
    expect(errCode).toBe('scene-override-type-mismatch');
  });
});

describe('world.removeSceneOverride (w20)', () => {
  it('rolls back to the source SceneAsset value', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: { pos: [5, 0, 0] } } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = SceneOwner.worldInstantiateScene(world, handle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    const member = inst.value.mapping[0] as unknown as number;
    SceneOwner.worldSetSceneOverride(
      world,
      r.value.root,
      member as never,
      Transform,
      'pos',
      [100, 0, 0],
    );
    const rr = SceneOwner.worldRemoveSceneOverride(
      world,
      r.value.root,
      member as never,
      Transform,
      'pos',
    );
    expect(rr.ok).toBe(true);
    const t = world.get(member as never, Transform);
    if (!t.ok) throw new Error('get failed');
    expect(Array.from(t.value.pos)).toEqual([5, 0, 0]);
  });
});

describe('world.detachSceneMember + reattachSceneMember (w20)', () => {
  it('detach marks the localId; member entity stays alive; reattach unmarks', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: { 'entity-0': { components: { Transform: {} } } },
    };
    const handle = registerSceneAsset(world, asset);
    const r = SceneOwner.worldInstantiateScene(world, handle);
    if (!r.ok) throw new Error('instantiate failed');
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    const member = inst.value.mapping[0] as unknown as number;
    const dr = SceneOwner.worldDetachSceneMember(world, r.value.root, member as never);
    expect(dr.ok).toBe(true);
    const stateRes = SceneOwner.worldGetSceneInstanceState(world, r.value.root);
    if (!stateRes.ok) throw new Error('getSceneInstanceState failed');
    expect(stateRes.value.detachedLocalIds.has(0 as never)).toBe(true);
    // Member still alive
    expect(world.get(member as never, Transform).ok).toBe(true);
    // Reattach
    const rr = SceneOwner.worldReattachSceneMember(world, r.value.root, member as never);
    expect(rr.ok).toBe(true);
    expect(stateRes.value.detachedLocalIds.has(0 as never)).toBe(false);
  });
});
