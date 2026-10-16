// m4-2 -- state-scoped replay-no-leak unit tests (TDD red before m4-6 reset
// wiring in resources.ts + the Title OnEnter reset hook).
//
// AC-11 demands a Win/Lose -> Title -> Play replay start clean: (a) GameProgress
// fully reset (score=0, health=INITIAL_HEALTH, elapsed=0), (b) every Play-scoped
// entity (Core / Guardian / Portal / level / player) despawned with no leftover,
// (c) no stale NextState resource. The despawn half is the engine state plugin's
// job (transitionStatesSystem despawns despawnOnExit entities on the transition
// frame) -- this test drives a REAL headless World through the cycle to prove the
// game's wiring uses it correctly. The reset half is the game's responsibility:
// the Title OnEnter hook must re-insert a fresh GameProgress, and that logic is
// extracted into the pure helper resetProgress(world, total) so it is gate-able
// here.
//
// This test fails until resources.ts exports resetProgress.

import { type Component, defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  defineState,
  despawnOnExit,
  registerStatesPlugin,
  setNextState,
} from '@forgeax/engine-state';
import { describe, expect, it } from 'vitest';

import {
  createGameProgress,
  GAME_PROGRESS_KEY,
  type GameProgress,
  INITIAL_HEALTH,
  resetProgress,
} from '../resources';

// A GameState shaped like main.ts's (Title / Play / Win / Lose). defineState
// self-registers globally; a uniquely-named token avoids cross-test collisions.
const GameState = defineState('CollectathonResetTestState', [
  'Title',
  'Play',
  'Win',
  'Lose',
] as const);

// A stand-in Play entity tag so the scoped despawn is observable via the
// world-local component lease.
const PlayThing = defineComponent('CollectathonResetTestPlayThing', {});

// The per-token ScopedTo component the state plugin registers for GameState.
// World.components.resolve returns it once registerStatesPlugin + a
// despawnOnExit call have created it; throw (rather than non-null assert) if
// absent so a wiring regression fails loudly.
function scopedComponent(world: World): Component {
  const c = world.components.resolve('__scopedTo__CollectathonResetTestState');
  if (c === undefined) throw new Error('scoped component not registered');
  return c;
}

function makeWorld(): World {
  const world = new World();
  registerStatesPlugin(world);
  return world;
}

describe('resetProgress (Title OnEnter scoreboard reset, AC-11)', () => {
  it('re-inserts a fresh GameProgress (score=0, health=INITIAL_HEALTH, elapsed=0)', () => {
    const world = makeWorld();
    // Simulate an ended run: a mutated GameProgress sits in the world.
    const stale = createGameProgress(12);
    stale.score = 12;
    stale.health = 0;
    stale.elapsed = 88.5;
    world.insertResource(GAME_PROGRESS_KEY, stale);

    resetProgress(world, 12);

    const fresh = world.getResource<GameProgress>(GAME_PROGRESS_KEY);
    expect(fresh.score).toBe(0);
    expect(fresh.health).toBe(INITIAL_HEALTH);
    expect(fresh.elapsed).toBe(0);
    expect(fresh.total).toBe(12);
  });

  it('replaces the object (not mutates the old one) so no stale reference survives', () => {
    const world = makeWorld();
    const stale = createGameProgress(5);
    stale.health = 0;
    world.insertResource(GAME_PROGRESS_KEY, stale);

    resetProgress(world, 5);

    const fresh = world.getResource<GameProgress>(GAME_PROGRESS_KEY);
    expect(fresh).not.toBe(stale);
    expect(fresh.health).toBe(INITIAL_HEALTH);
  });

  it('works when no prior GameProgress exists (first Title entry)', () => {
    const world = makeWorld();
    resetProgress(world, 3);
    const fresh = world.getResource<GameProgress>(GAME_PROGRESS_KEY);
    expect(fresh.score).toBe(0);
    expect(fresh.total).toBe(3);
  });
});

describe('Play -> Title -> Play replay leaves no leftover entities (AC-11)', () => {
  it('despawns every Play-scoped entity when leaving Play', () => {
    const world = makeWorld();
    // Enter Play (Title -> Play) so the scoped entities belong to the live state.
    setNextState(world, GameState, 'Play');
    world.update(1 / 60).unwrap();

    const scoped: EntityHandle[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.spawn({ component: PlayThing, data: {} }).unwrap();
      despawnOnExit(world, e, GameState, 'Play');
      scoped.push(e);
    }
    const Scoped = scopedComponent(world);
    // All five are alive + scoped before leaving Play.
    expect(scoped.every((e) => world.get(e, Scoped).ok)).toBe(true);

    // Leave Play (Play -> Title): transitionStatesSystem despawns them.
    setNextState(world, GameState, 'Title');
    world.update(1 / 60).unwrap();

    expect(scoped.some((e) => world.get(e, Scoped).ok)).toBe(false);
    expect(scoped.some((e) => world.get(e, PlayThing).ok)).toBe(false);
  });

  it('a second Play run starts with zero leftover from the first run', () => {
    const world = makeWorld();

    // Run 1: enter Play, spawn scoped entities, reach Title again.
    setNextState(world, GameState, 'Play');
    world.update(1 / 60).unwrap();
    const run1: EntityHandle[] = [];
    for (let i = 0; i < 3; i++) {
      const e = world.spawn({ component: PlayThing, data: {} }).unwrap();
      despawnOnExit(world, e, GameState, 'Play');
      run1.push(e);
    }
    resetProgress(world, 3); // Title OnEnter would call this
    setNextState(world, GameState, 'Title');
    world.update(1 / 60).unwrap();

    // Run 2: enter Play again. The new run must see none of run1's entities.
    setNextState(world, GameState, 'Play');
    world.update(1 / 60).unwrap();
    const Scoped = scopedComponent(world);
    expect(run1.some((e) => world.get(e, Scoped).ok)).toBe(false);

    // And the scoreboard is fresh for run 2.
    const progress = world.getResource<GameProgress>(GAME_PROGRESS_KEY);
    expect(progress.score).toBe(0);
    expect(progress.health).toBe(INITIAL_HEALTH);
  });
});
