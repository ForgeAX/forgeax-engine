// @forgeax/engine-state -- force-vs-soft unit tests (M4 / m4w3)
//
// TDD red phase: imports addOnEnter / addOnExit from ../src/on-enter-on-exit.ts
// which does not yet exist.
//
// Covers: AC-17 force=true fires full transition (OnExit+OnEnter+despawn) even
// on same-state; force=false same-state no-op skips callbacks; two consecutive
// setNextState calls before transition -> last wins, single pair fires; force
// followed by non-force (force flag consumed per-transition); force to different
// state behaves same as soft.
//
// Decision anchors:
// - requirements AC-17: force same-value runs full transition
// - requirements sec 7: soft same-value no-op (prev===next && !force)
// - plan-strategy D-5: transition body dispatch fires callbacks
// - m4w4: transitionStatesSystem reads force flag from NextState payload

import { describe, expect, it } from 'vitest';
import { Entity, World } from '@forgeax/engine-ecs';
import { defineState } from '../src/define-state';
import { registerStatesPlugin } from '../src/register-plugin';
import { setNextState, setNextStateForce, getState, getPreviousState } from '../src/set-next-state';
import { despawnOnExit, despawnOnEnter } from '../src/scoped-component';
import { addOnEnter, addOnExit } from '../src/on-enter-on-exit';
import { nextStateResourceKey } from '../src/resources';

const LevelId = defineState('LevelId', ['main-menu', 'tutorial', 'street-a'] as const);

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
// AC-17: force=true same-state runs full transition
// ──────────────────────────────────────────────────────────────────────────────

describe('force vs soft same-state transitions', () => {
  it('AC-17: force=true same-variant fires OnExit and OnEnter', () => {
    const world = makeWorld();
    const fired: string[] = [];
    addOnExit(LevelId, 'main-menu', () => {
      fired.push('exit-main-menu');
    });
    addOnEnter(LevelId, 'main-menu', () => {
      fired.push('enter-main-menu');
    });

    setNextStateForce(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    expect(fired).toEqual(['exit-main-menu', 'enter-main-menu']);
  });

  it('AC-17: force=true same-variant despawns scope entities (exit and enter mode)', () => {
    const world = makeWorld();

    const eExit = world.spawn().unwrap();
    despawnOnExit(world, eExit, LevelId, 'main-menu');

    const eEnter = world.spawn().unwrap();
    despawnOnEnter(world, eEnter, LevelId, 'main-menu');

    setNextStateForce(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    expect(world.get(eExit, LevelScoped).ok).toBe(false);
    expect(world.get(eEnter, LevelScoped).ok).toBe(false);
  });

  it('force=true same-state still flips PreviousState and State (same value)', () => {
    const world = makeWorld();

    setNextStateForce(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    // Both PreviousState and State are 'main-menu' after force-same transition
    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('main-menu');
    const ps = getPreviousState(world, LevelId);
    expect(ps.ok && ps.value).toBe('main-menu');
  });

  it('soft setNextState same-variant is no-op: no callbacks, no despawn', () => {
    const world = makeWorld();
    let exitCount = 0;
    let enterCount = 0;
    addOnExit(LevelId, 'main-menu', () => exitCount++);
    addOnEnter(LevelId, 'main-menu', () => enterCount++);

    const entity = world.spawn().unwrap();
    despawnOnExit(world, entity, LevelId, 'main-menu');

    setNextState(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    expect(exitCount).toBe(0);
    expect(enterCount).toBe(0);

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');
    expect(world.get(entity, LevelScoped).ok).toBe(true);
  });

  it('soft setNextState same-variant clears NextState', () => {
    const world = makeWorld();

    setNextState(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    // NextState should be cleared after same-state no-op
    const nsKey = nextStateResourceKey(LevelId);
    const ns = world.getResource<{ value: number; force: boolean } | undefined>(nsKey);
    expect(ns).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Consecutive setNextState before transition
// ──────────────────────────────────────────────────────────────────────────────

describe('consecutive setNextState before transition', () => {
  it('two consecutive setNextState calls before update — last wins, single OnExit/OnEnter pair fires', () => {
    const world = makeWorld();
    const fired: string[] = [];
    addOnExit(LevelId, 'main-menu', () => fired.push('exit-main-menu'));
    addOnEnter(LevelId, 'tutorial', () => fired.push('enter-tutorial'));
    addOnEnter(LevelId, 'street-a', () => fired.push('enter-street-a'));

    // Two consecutive calls — first 'tutorial', then 'street-a'
    setNextState(world, LevelId, 'tutorial');
    setNextState(world, LevelId, 'street-a');

    world.update(1 / 60).unwrap();

    // Only the last overwrite wins: exit main-menu, enter street-a
    expect(fired).toEqual(['exit-main-menu', 'enter-street-a']);

    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('street-a');
  });

  it('three consecutive setNextState calls — last wins', () => {
    const world = makeWorld();
    const fired: string[] = [];
    addOnExit(LevelId, 'main-menu', () => fired.push('exit-main-menu'));
    addOnEnter(LevelId, 'tutorial', () => fired.push('enter-tutorial'));
    addOnEnter(LevelId, 'street-a', () => fired.push('enter-street-a'));

    setNextState(world, LevelId, 'tutorial');
    setNextState(world, LevelId, 'street-a');
    setNextState(world, LevelId, 'tutorial'); // last overwrites

    world.update(1 / 60).unwrap();

    expect(fired).toEqual(['exit-main-menu', 'enter-tutorial']);

    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('tutorial');
  });

  it('consecutive: force then non-force on same frame — last call determines force flag', () => {
    const world = makeWorld();
    const fired: string[] = [];
    addOnExit(LevelId, 'main-menu', () => fired.push('exit'));

    // Force same-state, then non-force different state overwrites
    setNextStateForce(world, LevelId, 'main-menu');
    setNextState(world, LevelId, 'street-a');

    // After overwrite, NextState should have value=street-a, force=false
    // So this is a regular transition main-menu -> street-a
    world.update(1 / 60).unwrap();

    // Force flag from first call was overwritten
    // OnExit(main-menu) fires because we are leaving main-menu (not force scenario)
    expect(fired).toEqual(['exit']);

    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('street-a');
  });

  it('consecutive: non-force then force on same frame — last call determines force=true', () => {
    const world = makeWorld();
    const fired: string[] = [];
    addOnExit(LevelId, 'main-menu', () => fired.push('exit'));

    // Non-force same-state, then force different state overwrites
    setNextState(world, LevelId, 'main-menu');
    setNextStateForce(world, LevelId, 'tutorial');

    world.update(1 / 60).unwrap();

    // Force flag set — even though different values, force means nothing special for different state
    expect(fired).toEqual(['exit']);

    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('tutorial');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// force flag per-transition (not persistent)
// ──────────────────────────────────────────────────────────────────────────────

describe('force flag consumed per-transition', () => {
  it('force flag cleared after transition — next same-state soft is no-op', () => {
    const world = makeWorld();
    let onEnterCount = 0;
    addOnEnter(LevelId, 'tutorial', () => onEnterCount++);

    // First transition: force to tutorial
    setNextStateForce(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();
    expect(onEnterCount).toBe(1);

    // Second: soft same-state (tutorial -> tutorial) — no-op
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();
    expect(onEnterCount).toBe(1); // unchanged — no callback
  });

  it('force to different value behaves same as soft', () => {
    const world = makeWorld();
    const fired: string[] = [];
    addOnExit(LevelId, 'main-menu', () => fired.push('exit-main-menu'));
    addOnEnter(LevelId, 'tutorial', () => fired.push('enter-tutorial'));

    setNextStateForce(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // Different values — force flag irrelevant, same behavior as soft
    expect(fired).toEqual(['exit-main-menu', 'enter-tutorial']);

    const s = getState(world, LevelId);
    expect(s.ok && s.value).toBe('tutorial');
  });

  it('force=true same-state: both OnExit and OnEnter fire for the same variant', () => {
    // This is the soft-restart semantic: force-re-enter the current state
    const world = makeWorld();
    const fired: string[] = [];
    addOnExit(LevelId, 'main-menu', () => fired.push('exit-main-menu'));
    addOnEnter(LevelId, 'main-menu', () => fired.push('enter-main-menu'));

    setNextStateForce(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    expect(fired).toEqual(['exit-main-menu', 'enter-main-menu']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// force + scope despawn combined
// ──────────────────────────────────────────────────────────────────────────────

describe('force + scope despawn combined', () => {
  it('force same-state despawns exit-scoped AND enter-scoped entities for the same variant', () => {
    const world = makeWorld();

    const eExit = world.spawn().unwrap();
    despawnOnExit(world, eExit, LevelId, 'main-menu');

    const eEnter = world.spawn().unwrap();
    despawnOnEnter(world, eEnter, LevelId, 'main-menu');

    // Entity with no scope — survives force-same-transition
    const eSurvivor = world.spawn().unwrap();

    setNextStateForce(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');

    expect(world.get(eExit, LevelScoped).ok).toBe(false);
    expect(world.get(eEnter, LevelScoped).ok).toBe(false);
    expect(world.get(eSurvivor, resolveWorldComponent(world, 'Entity')).ok).toBe(true);
  });

  it('soft same-state does NOT despawn any scope entities', () => {
    const world = makeWorld();

    const eExit = world.spawn().unwrap();
    despawnOnExit(world, eExit, LevelId, 'main-menu');

    const eEnter = world.spawn().unwrap();
    despawnOnEnter(world, eEnter, LevelId, 'main-menu');

    const eSurvivor = world.spawn().unwrap();

    setNextState(world, LevelId, 'main-menu');
    world.update(1 / 60).unwrap();

    const LevelScoped = resolveWorldComponent(world, '__scopedTo__LevelId');

    expect(world.get(eExit, LevelScoped).ok).toBe(true);
    expect(world.get(eEnter, LevelScoped).ok).toBe(true);
    expect(world.get(eSurvivor, resolveWorldComponent(world, 'Entity')).ok).toBe(true);
  });
});
