import { Update } from '@forgeax/engine-ecs';
// @forgeax/engine-state -- transition-system unit tests (M3 / m3w3 + m3w5)
//
// Covers: AC-02 value transition (setNextState -> update -> getState returns new,
// getPreviousState returns old), no-pending zero-overhead no-op, same-state
// no-op preserves entities, despawn tolerance, force flag consumed.
// m3w5: AC-18 multi-token independence, AC-13 schedule anchors.
//
// These tests import the real transitionStatesSystem from m3w4. Until m3w4
// replaces the stub, all transition-behavior tests will fail — this is the TDD red phase.
//
// Decision anchors:
// - requirements AC-02: transition flips State / PreviousState
// - requirements sec 2.4: pending absent -> skip, same-state -> no-op, despawn tolerance
// - requirements AC-18: multi-token same-frame independence
// - requirements AC-13: schedule anchors after input-frame-start-scan, before propagateTransforms
// - plan-strategy D-6: anchor constant literals

import { describe, expect, it } from 'vitest';
import { defineComponent, Entity, type EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, Children, worldInstantiateScene } from '@forgeax/engine-scene';
import { defineState } from '../src/define-state';
import { stateResourceKey, nextStateResourceKey, previousStateResourceKey } from '../src/resources';
import { registerStatesPlugin } from '../src/register-plugin';
import { setNextState, setNextStateForce, getState, getPreviousState } from '../src/set-next-state';
import { addOnEnter } from '../src/on-enter-on-exit';
import { despawnOnExit, despawnOnEnter } from '../src/scoped-component';

const LevelId = defineState('LevelId', ['main-menu', 'tutorial', 'street-a'] as const);
const GameMode = defineState('GameMode', ['menu', 'playing'] as const);
const M29Primary = defineState('M29Primary', ['idle', 'ready'] as const);
const M29Later = defineState('M29Later', ['cold', 'hot'] as const);
const M41Primary = defineState('M41Primary', ['main-menu', 'tutorial'] as const);
const M41Independent = defineState('M41Independent', ['cold', 'warm'] as const);

function makeWorld(): World {
  const world = new World();
  registerStatesPlugin(world);
  return world;
}

function resolveWorldComponent(world: World, name: string) {
  if (name === 'Entity') return Entity;
  const component = world.components.resolve(name);
  if (component === undefined) throw new Error(`Component ${name} is not registered`);
  return component;
}

// ──────────────────────────────────────────────────────────────────────────────
// m3w3: Core transition behavior
// ──────────────────────────────────────────────────────────────────────────────

describe('transitionStatesSystem', () => {
  it('AC-02: setNextState -> world.update(1 / 60).unwrap() -> getState returns new value, getPreviousState returns old', () => {
    const world = makeWorld();

    // Initial: both State and PreviousState = default ('main-menu', idx 0)
    expect(getState(world, LevelId).ok ? getState(world, LevelId).value : null).toBe('main-menu');

    // Request transition to 'tutorial'
    const r = setNextState(world, LevelId, 'tutorial');
    expect(r.ok).toBe(true);

    // Before update: State still old, NextState pending
    const sBefore = getState(world, LevelId);
    expect(sBefore.ok && sBefore.value).toBe('main-menu');

    const nsKey = nextStateResourceKey(LevelId);
    const nsBefore = world.getResource<{ value: number; force: boolean } | undefined>(nsKey);
    expect(nsBefore).toBeDefined();

    // Run one frame — triggers transitionStatesSystem
    world.update(1 / 60).unwrap();

    // After update: State = new, PreviousState = old, NextState cleared
    const sAfter = getState(world, LevelId);
    expect(sAfter.ok && sAfter.value).toBe('tutorial');

    const psAfter = getPreviousState(world, LevelId);
    expect(psAfter.ok && psAfter.value).toBe('main-menu');

    const nsAfter = world.getResource<{ value: number; force: boolean } | undefined>(nsKey);
    expect(nsAfter).toBeUndefined();
  });

  it('no-pending path: no setNextState called -> transitionStatesSystem zero-overhead continue, no errors', () => {
    const world = makeWorld();

    // Spawn entities — they should survive no-op transition
    const e1 = world.spawn().unwrap();
    const e2 = world.spawn().unwrap();

    // Run update with no pending transition
    world.update(1 / 60).unwrap();

    // State unchanged
    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('main-menu');

    // Entities are still alive (world.get succeeds without StaleEntityError)
    const r1 = world.get(e1, resolveWorldComponent(world, 'Entity'));
    expect(r1.ok).toBe(true);
    const r2 = world.get(e2, resolveWorldComponent(world, 'Entity'));
    expect(r2.ok).toBe(true);

    // NextState remains undefined
    const nsKey = nextStateResourceKey(LevelId);
    const ns = world.getResource<{ value: number; force: boolean } | undefined>(nsKey);
    expect(ns).toBeUndefined();
  });

  it('same-state no-op: prev===next && force=false -> skip transition, NextState cleared, entities preserved', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnExit(world, entity, LevelId, 'main-menu');

    // Request transition to the SAME value (main-menu -> main-menu)
    setNextState(world, LevelId, 'main-menu');

    world.update(1 / 60).unwrap();

    // State unchanged
    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('main-menu');

    // Entity NOT despawned — same-state no-op
    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const eData = world.get(entity, LevelScoped);
    expect(eData.ok).toBe(true);

    // NextState cleared
    const nsKey = nextStateResourceKey(LevelId);
    const ns = world.getResource<{ value: number; force: boolean } | undefined>(nsKey);
    expect(ns).toBeUndefined();
  });

  it('force=true: even same-state flips and runs despawn', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    despawnOnExit(world, entity, LevelId, 'main-menu');

    // Force-flip to same state
    setNextStateForce(world, LevelId, 'main-menu');

    world.update(1 / 60).unwrap();

    // State still 'main-menu' (flipped to same)
    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('main-menu');

    // PreviousState updated
    const ps = getPreviousState(world, LevelId);
    expect(ps.ok && ps.value).toBe('main-menu');

    // Entity with despawnOnExit(main-menu) IS despawned because force=true
    // runs the full transition logic including scope-despawn
    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const eData = world.get(entity, LevelScoped);
    expect(eData.ok).toBe(false);

    // NextState cleared
    const nsKey = nextStateResourceKey(LevelId);
    const ns = world.getResource<{ value: number; force: boolean } | undefined>(nsKey);
    expect(ns).toBeUndefined();
  });

  it('despawnOnExit entity despawned after transition away from exit-value', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    // Scoped: despawn when leaving 'main-menu'
    despawnOnExit(world, entity, LevelId, 'main-menu');

    // Transition to 'tutorial'
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // Entity should be despawned
    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const result = world.get(entity, LevelScoped);
    expect(result.ok).toBe(false);
  });

  it('despawnOnExit entity NOT despawned when transitioning TO its exit-value', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    // Scoped: despawn when leaving 'tutorial'
    despawnOnExit(world, entity, LevelId, 'tutorial');

    // Transition TO 'tutorial'
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // Entity survives — we entered 'tutorial', not left it
    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const result = world.get(entity, LevelScoped);
    expect(result.ok).toBe(true);
  });

  it('despawnOnEnter entity despawned after transition to enter-value', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    // Scoped: despawn when entering 'tutorial'
    despawnOnEnter(world, entity, LevelId, 'tutorial');

    // Transition to 'tutorial'
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // Entity should be despawned
    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const result = world.get(entity, LevelScoped);
    expect(result.ok).toBe(false);
  });

  it('despawnOnEnter entity NOT despawned when transitioning AWAY from enter-value', () => {
    const world = makeWorld();
    const entity = world.spawn().unwrap();

    // Scoped: despawn when entering 'tutorial'
    despawnOnEnter(world, entity, LevelId, 'tutorial');

    // Transition AWAY from 'tutorial' (to 'street-a')
    setNextState(world, LevelId, 'street-a');
    world.update(1 / 60).unwrap();

    // Entity survives — we left 'main-menu' but scoped to 'tutorial'-enter
    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const result = world.get(entity, LevelScoped);
    expect(result.ok).toBe(true);
  });

  it('combined exit and enter: correct entities survive and despawn in same transition', () => {
    const world = makeWorld();

    // Entity A: despawn when leaving 'main-menu'
    const eA = world.spawn().unwrap();
    despawnOnExit(world, eA, LevelId, 'main-menu');
    expect(world.get(eA, resolveWorldComponent(world, '__scopedTo__LevelId')).ok).toBe(true);

    // Entity B: despawn when entering 'tutorial'
    const eB = world.spawn().unwrap();
    despawnOnEnter(world, eB, LevelId, 'tutorial');
    expect(world.get(eB, resolveWorldComponent(world, '__scopedTo__LevelId')).ok).toBe(true);

    // Entity C: no scope (should always survive)
    const eC = world.spawn().unwrap();

    // Transition: main-menu -> tutorial
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');

    // A: despawned (exit main-menu)
    expect(world.get(eA, LevelScoped).ok).toBe(false);

    // B: despawned (enter tutorial)
    expect(world.get(eB, LevelScoped).ok).toBe(false);

    // C: alive (no scope)
    expect(world.get(eC, resolveWorldComponent(world, 'Entity')).ok).toBe(true);
  });

  it('transition ordering: PreviousState written BEFORE State flipped', () => {
    // This is structural — we verify by reading both after transition.
    // Since both are written by the same synchronous system, we verify
    // the post-conditions imply the correct order:
    // PreviousState = old, State = new.
    const world = makeWorld();

    setNextState(world, LevelId, 'street-a');
    world.update(1 / 60).unwrap();

    // Post-transition: PreviousState must be the value BEFORE flip (main-menu)
    const ps = getPreviousState(world, LevelId);
    expect(ps.ok && ps.value).toBe('main-menu');

    // State must be the value AFTER flip (street-a)
    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('street-a');
  });

  it('PreviousState and State are both old after no-pending frame', () => {
    const world = makeWorld();

    // No setNextState — run update
    world.update(1 / 60).unwrap();

    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('main-menu');
    const ps = getPreviousState(world, LevelId);
    expect(ps.ok && ps.value).toBe('main-menu');
  });

  it('force flag consumed after transition', () => {
    const world = makeWorld();

    const result = setNextStateForce(world, LevelId, 'tutorial');
    expect(result.ok).toBe(true);

    // Pending NextState has force=true
    const nsKey = nextStateResourceKey(LevelId);
    const ns = world.getResource<{ value: number; force: boolean } | undefined>(nsKey);
    expect(ns?.force).toBe(true);

    world.update(1 / 60).unwrap();

    // After transition, NextState cleared — force consumed
    const nsAfter = world.getResource<{ value: number; force: boolean } | undefined>(nsKey);
    expect(nsAfter).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// m3w5: Multi-token independence + schedule anchors
// ──────────────────────────────────────────────────────────────────────────────

describe('AC-18: multi-token independence', () => {
  it('two tokens transition independently within the same frame', () => {
    const world = makeWorld();

    // Set transitions for both tokens
    setNextState(world, LevelId, 'tutorial');
    setNextState(world, GameMode, 'playing');

    world.update(1 / 60).unwrap();

    // Verify LevelId
    const s1 = getState(world, LevelId);
    expect(s1.ok && s1.value).toBe('tutorial');
    const ps1 = getPreviousState(world, LevelId);
    expect(ps1.ok && ps1.value).toBe('main-menu');

    // Verify GameMode
    const s2 = getState(world, GameMode);
    expect(s2.ok && s2.value).toBe('playing');
    const ps2 = getPreviousState(world, GameMode);
    expect(ps2.ok && ps2.value).toBe('menu');
  });

  it('ScopedTo entities per-token do not cross-contaminate', () => {
    const world = makeWorld();

    // Entity A: scoped to LevelId 'main-menu' exit
    const eA = world.spawn().unwrap();
    despawnOnExit(world, eA, LevelId, 'main-menu');

    // Entity B: scoped to GameMode 'menu' exit
    const eB = world.spawn().unwrap();
    despawnOnExit(world, eB, GameMode, 'menu');

    // Only transition LevelId, not GameMode
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    const ModeScoped = resolveWorldComponent(world, '__scopedTo__GameMode');

    // Entity A (LevelId scoped) — despawned
    expect(world.get(eA, LevelScoped).ok).toBe(false);

    // Entity B (GameMode scoped) — NOT despawned, LevelId change doesn't affect it
    expect(world.get(eB, ModeScoped).ok).toBe(true);
  });

  it('one token pending, other token no-pending: pending token transitions, other is no-op', () => {
    const world = makeWorld();

    setNextState(world, LevelId, 'tutorial');
    // No setNextState for GameMode

    world.update(1 / 60).unwrap();

    const s1 = getState(world, LevelId);
    expect(s1.ok && s1.value).toBe('tutorial');

    // GameMode unchanged
    const s2 = getState(world, GameMode);
    expect(s2.ok && s2.value).toBe('menu');

    // GameMode NextState remains undefined
    const nsKey = nextStateResourceKey(GameMode);
    const ns = world.getResource<{ value: number; force: boolean } | undefined>(nsKey);
    expect(ns).toBeUndefined();
  });

  it('both tokens set to their default values: same-state no-op on both', () => {
    const world = makeWorld();

    const entity = world.spawn().unwrap();
    despawnOnExit(world, entity, LevelId, 'main-menu');

    setNextState(world, LevelId, 'main-menu');
    setNextState(world, GameMode, 'menu');

    world.update(1 / 60).unwrap();

    // Entity survives — same-state no-op
    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    expect(world.get(entity, LevelScoped).ok).toBe(true);

    // Both states at their defaults
    const s1 = getState(world, LevelId);
    expect(s1.ok && s1.value).toBe('main-menu');
    const s2 = getState(world, GameMode);
    expect(s2.ok && s2.value).toBe('menu');
  });
});

describe('M29: callback partial commit poisons the World', () => {
  it('keeps the committed first token, aborts the later token, and rejects future frames', () => {
    const world = makeWorld();
    const primaryExit = world.spawn().unwrap();
    const primaryEnter = world.spawn().unwrap();
    despawnOnExit(world, primaryExit, M29Primary, 'idle');
    despawnOnEnter(world, primaryEnter, M29Primary, 'ready');

    const fault = new Error('m29 callback fault');
    let faultRuns = 0;
    const removeFault = addOnEnter(M29Primary, 'ready', () => {
      faultRuns += 1;
      throw fault;
    });

    setNextState(world, M29Primary, 'ready');
    setNextState(world, M29Later, 'hot');

    let thrown: unknown;
    try {
      world.update(1 / 60).unwrap();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'system-failed',
      detail: { cause: fault, systemName: 'transitionStates', schedule: 'Update' },
    });
    expect(faultRuns).toBe(1);
    expect(getState(world, M29Primary)).toMatchObject({ ok: true, value: 'ready' });
    expect(getPreviousState(world, M29Primary)).toMatchObject({ ok: true, value: 'idle' });
    expect(getState(world, M29Later)).toMatchObject({ ok: true, value: 'cold' });
    expect(world.get(primaryExit, Entity).ok).toBe(false);
    expect(world.get(primaryEnter, Entity).ok).toBe(false);

    expect(world.execution.health).toBe('poisoned');
    const rejected = world.update(1 / 60);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('world-poisoned');
    removeFault();
  });
});

describe('M41: invalid variant atomic refusal', () => {
  it('leaves the same World unchanged, then permits one valid transition and cleanup', () => {
    const world = makeWorld();
    const exitEntity = world.spawn().unwrap();
    const enterEntity = world.spawn().unwrap();
    despawnOnExit(world, exitEntity, M41Primary, 'main-menu');
    despawnOnEnter(world, enterEntity, M41Primary, 'tutorial');

    let callbackRuns = 0;
    let repairedEntity: EntityHandle | undefined;
    const removeCallback = addOnEnter(M41Primary, 'tutorial', (w) => {
      callbackRuns += 1;
      repairedEntity = w.spawn().unwrap();
      despawnOnExit(w, repairedEntity, M41Primary, 'tutorial');
    });

    const executionSignature = () => {
      const inspection = world.inspect();
      return {
        systems: inspection.systems.map((system) => ({ name: system.name, sets: [...system.sets] })),
        schedules: inspection.schedules.map((schedule) => ({
          name: schedule.schedule.name,
          systems: schedule.systems.map((system) => ({ name: system.name, sets: [...system.sets] })),
        })),
        resourceKeys: [...inspection.resourceKeys].sort(),
      };
    };

    const before = {
      entityCount: world.inspect().entityCount,
      execution: executionSignature(),
      level: getState(world, M41Primary),
      previousLevel: getPreviousState(world, M41Primary),
      independent: getState(world, M41Independent),
      previousIndependent: getPreviousState(world, M41Independent),
    };
    const invalid = String('m41-runtime-invalid');
    const refused = setNextState(world, M41Primary, invalid as never);
    const refusedForce = setNextStateForce(world, M41Primary, invalid as never);

    expect(refused.ok).toBe(false);
    expect(refusedForce.ok).toBe(false);
    expect((refused.error as { code: string; detail: unknown }).code).toBe('invalid-variant');
    expect((refused.error as { code: string; detail: unknown }).detail).toEqual({
      name: 'M41Primary',
      got: invalid,
      valid: ['main-menu', 'tutorial'],
    });
    expect((refusedForce.error as { code: string; detail: unknown }).detail).toEqual({
      name: 'M41Primary',
      got: invalid,
      valid: ['main-menu', 'tutorial'],
    });
    expect(world.getResource<{ value: number; force: boolean } | undefined>(nextStateResourceKey(M41Primary))).toBeUndefined();
    expect(world.inspect().entityCount).toBe(before.entityCount);
    expect(executionSignature()).toEqual(before.execution);
    expect(getState(world, M41Primary)).toEqual(before.level);
    expect(getPreviousState(world, M41Primary)).toEqual(before.previousLevel);
    expect(getState(world, M41Independent)).toEqual(before.independent);
    expect(getPreviousState(world, M41Independent)).toEqual(before.previousIndependent);
    expect(callbackRuns).toBe(0);
    expect(world.get(exitEntity, Entity).ok).toBe(true);
    expect(world.get(enterEntity, Entity).ok).toBe(true);

    world.update(1 / 60).unwrap();
    expect(world.getResource<{ value: number; force: boolean } | undefined>(nextStateResourceKey(M41Primary))).toBeUndefined();
    expect(getState(world, M41Primary)).toMatchObject({ ok: true, value: 'main-menu' });
    expect(getPreviousState(world, M41Primary)).toMatchObject({ ok: true, value: 'main-menu' });
    expect(callbackRuns).toBe(0);
    expect(world.get(exitEntity, Entity).ok).toBe(true);
    expect(world.get(enterEntity, Entity).ok).toBe(true);

    setNextState(world, M41Primary, 'tutorial');
    setNextState(world, M41Independent, 'warm');
    world.update(1 / 60).unwrap();
    expect(getState(world, M41Primary)).toMatchObject({ ok: true, value: 'tutorial' });
    expect(getPreviousState(world, M41Primary)).toMatchObject({ ok: true, value: 'main-menu' });
    expect(getState(world, M41Independent)).toMatchObject({ ok: true, value: 'warm' });
    expect(getPreviousState(world, M41Independent)).toMatchObject({ ok: true, value: 'cold' });
    expect(callbackRuns).toBe(1);
    expect(world.get(exitEntity, Entity).ok).toBe(false);
    expect(world.get(enterEntity, Entity).ok).toBe(false);
    expect(repairedEntity).toBeDefined();
    expect(repairedEntity === undefined ? false : world.get(repairedEntity, Entity).ok).toBe(true);
    expect(world.getResource<{ value: number; force: boolean } | undefined>(nextStateResourceKey(M41Primary))).toBeUndefined();

    setNextState(world, M41Primary, 'main-menu');
    world.update(1 / 60).unwrap();
    expect(repairedEntity === undefined ? false : world.get(repairedEntity, Entity).ok).toBe(false);
    setNextStateForce(world, M41Primary, 'main-menu');
    world.update(1 / 60).unwrap();
    expect(repairedEntity === undefined ? false : world.get(repairedEntity, Entity).ok).toBe(false);
    expect(callbackRuns).toBe(1);
    expect(world.getResource<{ value: number; force: boolean } | undefined>(nextStateResourceKey(M41Primary))).toBeUndefined();

    removeCallback();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// m5w1-b: scoped-root + linkedSpawn cascade-despawn tests
//
// Verify that when a scene root (instantiated via instantiateScene) is marked
// with despawnOnExit, transitioning away from that variant causes:
//   1. The scene root to be despawned
//   2. All ChildOf-linked children (and their descendants) to be cascade-despawned
//      via linkedSpawn=true default
//   3. Player entity without ScopedTo survives
//   4. No separate despawnScene branch exists -- unified world.despawn via
//      linkedSpawn cascade per plan-strategy D-2.
// ──────────────────────────────────────────────────────────────────────────────

describe('scoped-root linkedSpawn cascade-despawn (m5w1)', () => {
  it('scene root with despawnOnExit -> all ChildOf children cascade-despawned', () => {
    const world = new World();
    registerStatesPlugin(world);

    // Build and instantiate a simple scene.
    const nodes: SceneEntity[] = [{ key: 'entity-0', components: {} }];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;

    // Spawn ChildOf-linked children under the root.
    const child1 = world.spawn({ component: ChildOf, data: { parent: root } }).unwrap();
    const child2 = world.spawn({ component: ChildOf, data: { parent: root } }).unwrap();

    // Grandchild under child1 -- a depth-2 descendant of the scene root.
    const grandchild = world.spawn({ component: ChildOf, data: { parent: child1 } }).unwrap();

    // Player entity -- no ScopedTo, should survive.
    const player = world.spawn().unwrap();

    // Mark scene root to be despawned on exit from 'main-menu'.
    despawnOnExit(world, root, LevelId, 'main-menu');

    // Verify all entities are alive before transition.
    const EntityToken = resolveWorldComponent(world, 'Entity');
    expect(world.get(root, EntityToken).ok).toBe(true);
    expect(world.get(child1, EntityToken).ok).toBe(true);
    expect(world.get(child2, EntityToken).ok).toBe(true);
    expect(world.get(grandchild, EntityToken).ok).toBe(true);
    expect(world.get(player, EntityToken).ok).toBe(true);

    // Transition main-menu -> tutorial.
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // State transitioned.
    expect(getState(world, LevelId).ok && getState(world, LevelId).value).toBe('tutorial');

    // Root despawned (via ScopedTo exit).
    expect(world.get(root, EntityToken).ok).toBe(false);

    // Child1 cascade-despawned (linkedSpawn=true reads Children.entities on root).
    expect(world.get(child1, EntityToken).ok).toBe(false);

    // Child2 cascade-despawned.
    expect(world.get(child2, EntityToken).ok).toBe(false);

    // Grandchild also despawned: a scoped SceneInstance root is torn down via
    // world.despawnScene (fully recursive iterDescendants walk), NOT the
    // one-level linkedSpawn cascade. The whole subtree goes, so no descendant is
    // left orphaned with a stale ChildOf -> dead-root ref (the collectathon
    // `hierarchy-broken` regression).
    expect(world.get(grandchild, EntityToken).ok).toBe(false);

    // Player survives -- no ScopedTo component.
    expect(world.get(player, EntityToken).ok).toBe(true);
  });

  it('scene root with despawnOnExit -> SceneInstance mapping nodes despawned', () => {
    const world = new World();
    registerStatesPlugin(world);

    // Build a multi-node scene with mapping entries.
    const nodes: SceneEntity[] = [
      { key: 'entity-0', components: {} },
      { key: 'entity-1', components: {} },
      { key: 'entity-2', components: {} },
    ];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;

    const mapping = readMapping(world, root);
    expect(mapping.length).toBeGreaterThanOrEqual(3);

    // Mark root for exit from 'main-menu'.
    despawnOnExit(world, root, LevelId, 'main-menu');

    // Transition.
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // Root despawned.
    const EntityToken = resolveWorldComponent(world, 'Entity');
    expect(world.get(root, EntityToken).ok).toBe(false);

    // Mapping members cascade-despawned (linkedSpawn=default-true
    // from instantiateScene-created ChildOf links).
    for (let i = 0; i < mapping.length; i++) {
      const member = mapping[i];
      if (member === 0) continue; // skip root sentinel
      expect(world.get(member as unknown as EntityHandle, EntityToken).ok).toBe(false);
    }
  });

  it('scoped-root cascade: player (no ScopedTo) survives multiple transitions', () => {
    const world = new World();
    registerStatesPlugin(world);

    const nodes: SceneEntity[] = [{ key: 'entity-0', components: {} }];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root1 = r.value.root;

    // Spawn a second scene (simulating tutorial variant).
    const handle2 = registerSceneAsset(world, buildScene(nodes));
    const r2 = worldInstantiateScene(world, handle2);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const root2 = r2.value.root;

    const player = world.spawn().unwrap();

    // Scope each root to its respective variant.
    despawnOnExit(world, root1, LevelId, 'main-menu');
    despawnOnExit(world, root2, LevelId, 'tutorial');

    // Transition main-menu -> tutorial.
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    const EntityToken = resolveWorldComponent(world, 'Entity');

    // Root1 despawned.
    expect(world.get(root1, EntityToken).ok).toBe(false);

    // Player alive.
    expect(world.get(player, EntityToken).ok).toBe(true);

    // Spawn a fresh scene for 'main-menu'.
    const r3 = worldInstantiateScene(world, handle);
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const root3 = r3.value.root;
    despawnOnExit(world, root3, LevelId, 'main-menu');

    // Transition back to main-menu.
    setNextState(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    // Root2 (tutorial scene) despawned.
    expect(world.get(root2, EntityToken).ok).toBe(false);

    // Player still alive across both transitions.
    expect(world.get(player, EntityToken).ok).toBe(true);

    // root3 (fresh main-menu scene) alive because we transitioned TO main-menu.
    expect(world.get(root3, EntityToken).ok).toBe(true);
  });
});

describe('AC-13: schedule anchors', () => {
  it('transitionStates system is registered in the schedule', () => {
    const world = makeWorld();

    const systems = world.inspect().systems;
    const names = systems.map((s) => s.name);
    expect(names).toContain('transitionStates');
  });

  it('user system with before:\'transitionStates\' anchor resolves (no error from addSystem)', () => {
    const world = makeWorld();

    // Adding a user system that references 'transitionStates' as anchor
    // should not throw — the anchor name exists.
    world.addSystem(Update, {
      name: 'user-before-transition',
      queries: [],
      fn: () => {},
      before: ['transitionStates'],
    });

    const systems = world.inspect().systems;
    const names = systems.map((s) => s.name);
    expect(names).toContain('user-before-transition');
    expect(names).toContain('transitionStates');
  });

  it('user system with after:\'transitionStates\' anchor resolves (no error from addSystem)', () => {
    const world = makeWorld();

    world.addSystem(Update, {
      name: 'user-after-transition',
      queries: [],
      fn: () => {},
      after: ['transitionStates'],
    });

    const systems = world.inspect().systems;
    const names = systems.map((s) => s.name);
    expect(names).toContain('user-after-transition');
  });

  it('transitionStates system name is a permanent user-facing anchor (C-1)', () => {
    const world = makeWorld();

    // Verify the exact name string is 'transitionStates' — this is the
    // user-facing anchor that requirements C-1 mandates must be preserved.
    const systems = world.inspect().systems;
    const ts = systems.find((s) => s.name === 'transitionStates');
    expect(ts).toBeDefined();
    expect(ts!.name).toBe('transitionStates');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// m5w1: SceneInstance natural-bite verification tests
//   SceneInstance members are NOT despawned by state transitions.
// ──────────────────────────────────────────────────────────────────────────────

import type { Handle, SceneAsset, SceneEntity } from '@forgeax/engine-types';

// SceneInstance must be registered for instantiateScene to resolve it.
// Schema mirrors the runtime definition in @forgeax/engine-runtime
// (feat-20260614: handle<T> -> shared<T>, ref<T> -> unique<T>).
const SceneInstance = defineComponent('SceneInstance', {
  source: { type: 'shared<SceneAsset>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});

function buildScene(nodes: readonly (SceneEntity & { readonly key: string })[]): SceneAsset {
  return {
    kind: 'scene',
    entities: Object.fromEntries(nodes.map((node) => [node.key, { components: node.components, ...(node.instance === undefined ? {} : { instance: node.instance }) }])),
  };
}

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  for (const component of [Children, ChildOf, SceneInstance]) {
    if (world.components.resolve(component.name) === undefined) {
      world.components.register(component).unwrap();
    }
  }
  return world.allocSharedRef('SceneAsset', asset);
}

/** Read mapping from root's SceneInstance component. */
function readMapping(world: World, root: EntityHandle): Uint32Array {
  return (world.get(root, SceneInstance).unwrap() as unknown as { mapping: Uint32Array }).mapping;
}

describe('SceneInstance transition survival (m5w1)', () => {
  it('scene members survive a regular state transition (not scoped to transition token)', () => {
    const world = new World();
    registerStatesPlugin(world);

    // Build a simple 3-node scene
    const nodes: SceneEntity[] = [
      {
        key: 'entity-0',
        components: {}
      },
      {
        key: 'entity-1',
        components: {}
      },
      {
        key: 'entity-2',
        components: {}
      },
    ];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;

    // Collect member entities
    const mapping = readMapping(world, root);
    expect(mapping.length).toBeGreaterThanOrEqual(3);

    // Trigger a state transition on an unrelated token
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // State transition completed
    expect(getState(world, LevelId).ok && getState(world, LevelId).value).toBe('tutorial');

    // All scene members are still alive
    const EntityToken = resolveWorldComponent(world, 'Entity');
    for (let i = 0; i < mapping.length; i++) {
      const member = mapping[i];
      if (member === 0) continue; // skip root
      expect(world.get(member as unknown as EntityHandle, EntityToken).ok).toBe(true);
    }
  });

  it('scene root survives a state transition', () => {
    const world = new World();
    registerStatesPlugin(world);

    const nodes: SceneEntity[] = [
      { key: 'entity-0', components: {} },
    ];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;

    setNextState(world, LevelId, 'street-a');
    world.update(1 / 60).unwrap();

    expect(getState(world, LevelId).ok && getState(world, LevelId).value).toBe('street-a');

    // Root still carries the SceneInstance component
    const SceneInstanceToken = SceneInstance;
    expect(world.get(root, SceneInstanceToken).ok).toBe(true);
  });

  it('scene members survive a forced (same-state) transition', () => {
    const world = new World();
    registerStatesPlugin(world);

    const nodes: SceneEntity[] = [
      { key: 'entity-0', components: {} },
      { key: 'entity-1', components: {} },
    ];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;

    const mapping = readMapping(world, root);
    expect(mapping.length).toBeGreaterThanOrEqual(2);

    // Force-flip to same value
    setNextStateForce(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    const EntityToken = resolveWorldComponent(world, 'Entity');
    for (let i = 0; i < mapping.length; i++) {
      const member = mapping[i];
      if (member === 0) continue;
      expect(world.get(member as unknown as EntityHandle, EntityToken).ok).toBe(true);
    }
  });

  it('scene members survive a transition when a different token has scoped entities', () => {
    const world = new World();
    registerStatesPlugin(world);

    const nodes: SceneEntity[] = [
      { key: 'entity-0', components: {} },
      { key: 'entity-1', components: {} },
    ];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;

    const mapping = readMapping(world, root);

    // Scoped entity: despawn when leaving GameMode.menu
    const strayEntity = world.spawn().unwrap();
    despawnOnExit(world, strayEntity, GameMode, 'menu');

    // Transition GameMode (not LevelId)
    setNextState(world, GameMode, 'playing');
    world.update(1 / 60).unwrap();

    // GameMode transitioned
    expect(getState(world, GameMode).ok && getState(world, GameMode).value).toBe('playing');

    // strayEntity is despawned by the scoped-despawn
    const ModeScoped = resolveWorldComponent(world, '__scopedTo__GameMode');
    expect(world.get(strayEntity, ModeScoped).ok).toBe(false);

    // But scene members are untouched
    const EntityToken = resolveWorldComponent(world, 'Entity');
    for (let i = 0; i < mapping.length; i++) {
      const member = mapping[i];
      if (member === 0) continue;
      expect(world.get(member as unknown as EntityHandle, EntityToken).ok).toBe(true);
    }
  });

  it('multiple transitions do not accumulate damage on scene members', () => {
    const world = new World();
    registerStatesPlugin(world);

    const nodes: SceneEntity[] = [
      { key: 'entity-0', components: {} },
      { key: 'entity-1', components: {} },
    ];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;

    const mapping = readMapping(world, root);

    // Transition back and forth multiple times
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();
    setNextState(world, LevelId, 'street-a');
    world.update(1 / 60).unwrap();
    setNextState(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    const EntityToken = resolveWorldComponent(world, 'Entity');
    for (let i = 0; i < mapping.length; i++) {
      const member = mapping[i];
      if (member === 0) continue;
      expect(world.get(member as unknown as EntityHandle, EntityToken).ok).toBe(true);
    }
  });

  it('SceneInstance mapping is stable across state transitions', () => {
    const world = new World();
    registerStatesPlugin(world);

    const nodes: SceneEntity[] = [
      { key: 'entity-0', components: {} },
      { key: 'entity-1', components: {} },
      { key: 'entity-2', components: {} },
    ];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;

    const mappingBefore = readMapping(world, root);
    expect(mappingBefore.length).toBeGreaterThanOrEqual(3);

    // Trigger transition
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // Mapping unchanged
    const mappingAfter = readMapping(world, root);
    expect(mappingAfter.length).toBe(mappingBefore.length);
    for (let i = 0; i < mappingAfter.length; i++) {
      expect(mappingAfter[i]).toBe(mappingBefore[i]);
    }
  });

  it('scene member entity handles remain valid after transition', () => {
    const world = new World();
    registerStatesPlugin(world);

    // Register Transform to give entities some data
    const Transform = defineComponent('Transform_test_m5w1', {
      pos: 'array<f32, 3>',
    });

    const nodes: SceneEntity[] = [
      {
        key: 'entity-0',
        components: { Transform_test_m5w1: { pos: [1, 2, 3]} },
      },
    ];
    world.components.register(Transform).unwrap();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mapping = readMapping(world, r.value.root);
    expect(mapping.length).toBeGreaterThanOrEqual(1);

    // Read component data before transition
    const memberHandle = mapping[1] as unknown as EntityHandle; // index 1 = first member
    const dataBefore = world.get(memberHandle, Transform).unwrap();
    expect(Array.from(dataBefore.pos)).toEqual([1, 2, 3]);

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // Entity still alive and component data still readable
    const dataAfter = world.get(memberHandle, Transform).unwrap();
    expect(Array.from(dataAfter.pos)).toEqual([1, 2, 3]);
  });

  it('registers a token defined after the state runtime is active', () => {
    const world = makeWorld();
    const LateToken = defineState('LateTokenB2', ['a', 'b'] as const);

    expect(setNextState(world, LateToken, 'b').ok).toBe(true);
    world.update(1 / 60).unwrap();
    const current = getState(world, LateToken);
    expect(current.ok && current.value).toBe('b');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// SceneInstance cascade teardown on scoped despawn (regression)
//
// A scoped entity that is a SceneInstance root must be torn down with
// despawnScene (cascade over its instantiated members), not plain world.despawn.
// Plain despawn does NOT cascade through ChildOf (linkedSpawn=false), so a scoped
// scene root would orphan every member it instantiated. On a state replay the
// orphans linger, their index slots get reused at a new generation, and a
// surviving member's stale ChildOf -> dead-root makes propagateTransforms throw
// `hierarchy-broken` every frame (the collectathon "stuck character once a
// guardian replays the Play state" bug).
//
// SceneInstance / ChildOf are runtime concepts, but the state package may not
// import runtime. The cascade itself (world.despawnScene -> iterDescendants) walks
// any `array<entity>` field, so the test reconstructs the exact shape in pure ECS:
// a `SceneInstance` component with a `mapping: array<entity>` field listing the
// members, plus a `ChildOf` parent ref. This mirrors what assets.instantiate
// builds without pulling in the runtime package.
// ──────────────────────────────────────────────────────────────────────────────

describe('scoped despawn cascades SceneInstance roots fully (regression)', () => {
  // Reuses the module-level SceneInstance + ChildOf (linkedSpawn=true) tokens and
  // the m5w1 buildScene / registerSceneAsset / readMapping helpers -- do NOT
  // redefine those components here (it would overwrite the global registry the
  // other m5w1 tests rely on).
  //
  // Gap this closes vs the existing m5w1 cascade tests: linkedSpawn cascade is
  // intentionally ONE level deep (world.ts _despawnCore passes internal=true to
  // child despawns, so grandchildren are NOT collected -- see the m5w1 test that
  // asserts a grandchild survives). A real instantiated scene (e.g. an FBX rig:
  // root -> Armature -> Hips -> Spine -> ...) is many levels deep, so a plain
  // world.despawn of a scoped scene root would orphan every member below depth 1.
  // The fix routes scoped SceneInstance roots through world.despawnScene, whose
  // iterDescendants walk is fully recursive -- so the WHOLE subtree, mapping
  // members included, is torn down. Orphans are what made propagateTransforms
  // throw `hierarchy-broken` after a Play->Title->Play replay in the collectathon.

  it('a scoped scene root despawns ALL mapping members (full subtree), not just depth-1', () => {
    const world = makeWorld();

    // A multi-node scene -> instantiateScene records every member in mapping.
    const nodes: SceneEntity[] = [
      { key: 'entity-0', components: {} },
      { key: 'entity-1', components: {} },
      { key: 'entity-2', components: {} },
      { key: 'entity-3', components: {} },
    ];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;
    const mapping = Array.from(readMapping(world, root));
    expect(mapping.length).toBeGreaterThanOrEqual(4);

    // ONLY the root is scoped (mirrors the app: members are never individually
    // marked despawnOnExit -- they ride the root's teardown).
    despawnOnExit(world, root, LevelId, 'main-menu');

    // Leave 'main-menu' -> the scoped root is torn down via despawnScene.
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    const EntityToken = resolveWorldComponent(world, 'Entity');
    // Root gone.
    expect(world.get(root, EntityToken).ok).toBe(false);
    // EVERY mapping member gone -- no orphan left with a stale ChildOf -> dead root.
    for (const m of mapping) {
      if (m === 0) continue; // root sentinel
      expect(world.get(m as unknown as EntityHandle, EntityToken).ok).toBe(false);
    }
  });

  it('scoped scene root parented under another scoped entity still tears down its members', () => {
    // Reproduces the collectathon ordering hazard: the scene root is ChildOf a
    // scoped KCC body. If the KCC body is despawned (plain) before the root is
    // cascaded, the root handle dies first and its members orphan. The fix runs
    // SceneInstance teardown FIRST, so order within the batch does not matter.
    const world = makeWorld();

    const kccParent = world.spawn().unwrap();
    despawnOnExit(world, kccParent, LevelId, 'main-menu');

    const nodes: SceneEntity[] = [
      { key: 'entity-0', components: {} },
      { key: 'entity-1', components: {} },
    ];
    const handle = registerSceneAsset(world, buildScene(nodes));
    const r = worldInstantiateScene(world, handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;
    const mapping = Array.from(readMapping(world, root));

    // Parent the scene root under the KCC body, then scope the root too.
    const ChildOfToken = resolveWorldComponent(world, 'ChildOf');
    world.addComponent(root, { component: ChildOfToken, data: { parent: kccParent } });
    despawnOnExit(world, root, LevelId, 'main-menu');

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    const EntityToken = resolveWorldComponent(world, 'Entity');
    expect(world.get(kccParent, EntityToken).ok).toBe(false);
    expect(world.get(root, EntityToken).ok).toBe(false);
    for (const m of mapping) {
      if (m === 0) continue;
      expect(world.get(m as unknown as EntityHandle, EntityToken).ok).toBe(false);
    }
  });
});
