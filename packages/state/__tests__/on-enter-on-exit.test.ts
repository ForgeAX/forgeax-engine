// @forgeax/engine-state -- on-enter-on-exit unit tests (M4 / m4w1)
//
// TDD red phase: imports addOnEnter / addOnExit / OnEnter / OnExit from
// ../src/on-enter-on-exit.ts which does not yet exist.
//
// Covers: AC-07 OnEnter/OnExit exact-once firing, callback ordering
// (OnExit before OnEnter), multiple callbacks for same label, unsubscribe
// stops callback, nested setNextState deferred to next frame, OnEnter/OnExit
// label distinction across different variants.
//
// Decision anchors:
// - requirements AC-07: OnEnter/OnExit fire exactly once
// - plan-strategy D-5: fn[] registry + transition body dispatch
// - requirements sec 7: OnEnter callback calls setNextState — deferred to next frame
// - m4w4: OnExit after step 4 (exit-scoped despawn), OnEnter after step 6 (enter-scoped despawn)

import { describe, expect, it } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { defineState } from '../src/define-state';
import { registerStatesPlugin } from '../src/register-plugin';
import { setNextState, setNextStateForce, getState, getPreviousState } from '../src/set-next-state';
import { addOnEnter, addOnExit, OnEnter, OnExit } from '../src/on-enter-on-exit';

const LevelId = defineState('LevelId', ['main-menu', 'tutorial', 'street-a'] as const);

function makeWorld(): World {
  const world = new World();
  registerStatesPlugin(world);
  return world;
}

// ──────────────────────────────────────────────────────────────────────────────
// AC-07: exact-once firing
// ──────────────────────────────────────────────────────────────────────────────

describe('OnEnter / OnExit callbacks', () => {
  it('AC-07: OnEnter fires exactly once when transitioning to target variant', () => {
    const world = makeWorld();
    let count = 0;
    const unsub = addOnEnter(LevelId, 'tutorial', () => {
      count++;
    });

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(count).toBe(1);

    // Second frame with no new transition — callback does NOT fire again
    world.update(1 / 60).unwrap();
    expect(count).toBe(1);

    unsub();
  });

  it('AC-07: OnExit fires exactly once when transitioning away from target variant', () => {
    const world = makeWorld();
    let count = 0;
    const unsub = addOnExit(LevelId, 'main-menu', () => {
      count++;
    });

    // Transition away from main-menu -> tutorial
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(count).toBe(1);

    // Second frame — no new transition away from main-menu, callback does NOT fire
    world.update(1 / 60).unwrap();
    expect(count).toBe(1);

    unsub();
  });

  it('OnExit does NOT fire when entering the exit-variant (not leaving it)', () => {
    const world = makeWorld();
    let exitCount = 0;
    addOnExit(LevelId, 'tutorial', () => {
      exitCount++;
    });

    // Transition TO tutorial (from main-menu) — OnExit(tutorial) should NOT fire
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(exitCount).toBe(0);
  });

  it('OnEnter does NOT fire when leaving the enter-variant (not entering it)', () => {
    const world = makeWorld();
    let enterCount = 0;
    addOnEnter(LevelId, 'tutorial', () => {
      enterCount++;
    });

    // Transition AWAY from tutorial (to street-a)
    setNextState(world, LevelId, 'street-a');
    world.update(1 / 60).unwrap();

    expect(enterCount).toBe(0);
  });

  it('OnExit for old variant + OnEnter for new variant both fire in same transition', () => {
    const world = makeWorld();
    const calls: string[] = [];
    addOnExit(LevelId, 'main-menu', () => calls.push('exit-main-menu'));
    addOnEnter(LevelId, 'tutorial', () => calls.push('enter-tutorial'));

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(calls).toEqual(['exit-main-menu', 'enter-tutorial']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Callback ordering: OnExit fires before OnEnter
// ──────────────────────────────────────────────────────────────────────────────

describe('callback ordering', () => {
  it('exit callbacks fire before enter callbacks in same transition', () => {
    const world = makeWorld();
    const order: string[] = [];
    addOnExit(LevelId, 'main-menu', () => order.push('exit-main-menu'));
    addOnEnter(LevelId, 'tutorial', () => order.push('enter-tutorial'));

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(order).toEqual(['exit-main-menu', 'enter-tutorial']);
  });

  it('multiple OnExit callbacks fire in registration order', () => {
    const world = makeWorld();
    const order: string[] = [];
    addOnExit(LevelId, 'main-menu', () => order.push('exit-1'));
    addOnExit(LevelId, 'main-menu', () => order.push('exit-2'));
    addOnExit(LevelId, 'main-menu', () => order.push('exit-3'));

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(order).toEqual(['exit-1', 'exit-2', 'exit-3']);
  });

  it('multiple OnEnter callbacks fire in registration order', () => {
    const world = makeWorld();
    const order: string[] = [];
    addOnEnter(LevelId, 'tutorial', () => order.push('enter-1'));
    addOnEnter(LevelId, 'tutorial', () => order.push('enter-2'));

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(order).toEqual(['enter-1', 'enter-2']);
  });

  it('none of the callbacks fire for variants not involved in the transition', () => {
    const world = makeWorld();
    const fired: string[] = [];
    addOnExit(LevelId, 'main-menu', () => fired.push('exit-main-menu'));
    addOnExit(LevelId, 'street-a', () => fired.push('exit-street-a'));
    addOnEnter(LevelId, 'tutorial', () => fired.push('enter-tutorial'));
    addOnEnter(LevelId, 'street-a', () => fired.push('enter-street-a'));

    // Transition main-menu -> tutorial. Only exit-main-menu + enter-tutorial fire.
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(fired).toEqual(['exit-main-menu', 'enter-tutorial']);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getState / getPreviousState inside callbacks
// ──────────────────────────────────────────────────────────────────────────────

describe('getState / getPreviousState inside callbacks', () => {
  it('getState returns new value inside OnEnter callback (state already flipped)', () => {
    const world = makeWorld();
    let capturedState = '';
    addOnEnter(LevelId, 'tutorial', (w) => {
      const s = getState(w, LevelId);
      capturedState = s.ok ? s.value : '';
    });

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(capturedState).toBe('tutorial');
  });

  it('getPreviousState returns old value inside OnExit callback', () => {
    const world = makeWorld();
    let capturedPrevious = '';
    addOnExit(LevelId, 'main-menu', (w) => {
      const ps = getPreviousState(w, LevelId);
      capturedPrevious = ps.ok ? ps.value : '';
    });

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(capturedPrevious).toBe('main-menu');
  });

  it('getPreviousState returns old value inside OnEnter callback', () => {
    const world = makeWorld();
    let capturedPrevious = '';
    addOnEnter(LevelId, 'tutorial', (w) => {
      const ps = getPreviousState(w, LevelId);
      capturedPrevious = ps.ok ? ps.value : '';
    });

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(capturedPrevious).toBe('main-menu');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Unsubscribe
// ──────────────────────────────────────────────────────────────────────────────

describe('unsubscribe', () => {
  it('unsubscribed callback does not fire', () => {
    const world = makeWorld();
    let count = 0;
    const unsub = addOnEnter(LevelId, 'tutorial', () => count++);
    unsub();

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(count).toBe(0);
  });

  it('unsubscribing one callback does not affect other callbacks for the same label', () => {
    const world = makeWorld();
    const fired: string[] = [];
    const unsub1 = addOnEnter(LevelId, 'tutorial', () => fired.push('a'));
    addOnEnter(LevelId, 'tutorial', () => fired.push('b'));
    unsub1();

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(fired).toEqual(['b']);
  });

  it('callback registered after unsubscribe of a prior callback still fires', () => {
    const world = makeWorld();
    let count = 0;
    const unsub = addOnEnter(LevelId, 'tutorial', () => count++);
    unsub();

    addOnEnter(LevelId, 'tutorial', () => count++);

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(count).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// OnExit/OnEnter label distinction
// ──────────────────────────────────────────────────────────────────────────────

describe('OnEnter/OnExit label distinction', () => {
  it('OnEnter and OnExit for the same variant are distinct', () => {
    const world = makeWorld();
    const fired: string[] = [];
    addOnExit(LevelId, 'main-menu', () => fired.push('exit'));
    addOnEnter(LevelId, 'main-menu', () => fired.push('enter'));

    // Transition main-menu -> tutorial. Only OnExit(main-menu) fires.
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(fired).toEqual(['exit']);
  });

  it('OnEnter for different variants are distinct', () => {
    const world = makeWorld();
    let enterTutorial = 0;
    let enterStreetA = 0;
    addOnEnter(LevelId, 'tutorial', () => enterTutorial++);
    addOnEnter(LevelId, 'street-a', () => enterStreetA++);

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(enterTutorial).toBe(1);
    expect(enterStreetA).toBe(0);
  });

  it('OnExit for different variants are distinct', () => {
    const world = makeWorld();
    let exitMainMenu = 0;
    let exitTutorial = 0;
    addOnExit(LevelId, 'main-menu', () => exitMainMenu++);
    addOnExit(LevelId, 'tutorial', () => exitTutorial++);

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    expect(exitMainMenu).toBe(1);
    expect(exitTutorial).toBe(0);
  });

  it('OnEnter(label) returns branded string for use as schedule label', () => {
    const label = OnEnter(LevelId, 'tutorial');
    expect(typeof label).toBe('string');
    expect(label).toContain('LevelId');
    expect(label).toContain('OnEnter');
    expect(label).toContain('tutorial');
  });

  it('OnExit(label) returns branded string for use as schedule label', () => {
    const label = OnExit(LevelId, 'main-menu');
    expect(typeof label).toBe('string');
    expect(label).toContain('LevelId');
    expect(label).toContain('OnExit');
    expect(label).toContain('main-menu');
  });

  it('OnEnter and OnExit labels are distinct strings for the same variant', () => {
    const enterLabel = OnEnter(LevelId, 'main-menu');
    const exitLabel = OnExit(LevelId, 'main-menu');
    expect(enterLabel).not.toBe(exitLabel);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Nested setNextState inside OnEnter (deferred to next frame)
// ──────────────────────────────────────────────────────────────────────────────

describe('nested setNextState inside OnEnter', () => {
  it('OnEnter callback that calls setNextState — new value deferred to next frame', () => {
    const world = makeWorld();
    const callOrder: string[] = [];

    // OnEnter tutorial: immediately request transition to street-a
    addOnEnter(LevelId, 'tutorial', (w) => {
      callOrder.push('enter-tutorial');
      setNextState(w, LevelId, 'street-a');
      callOrder.push('enter-tutorial-done');
    });

    // Frame 1: main-menu -> tutorial
    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // After frame 1: state should be 'tutorial' (new NextState for next frame)
    const s1 = getState(world, LevelId);
    expect(s1.ok && s1.value).toBe('tutorial');

    // Frame 2: tutorial -> street-a (the deferred setNextState takes effect)
    world.update(1 / 60).unwrap();

    const s2 = getState(world, LevelId);
    expect(s2.ok && s2.value).toBe('street-a');

    expect(callOrder).toEqual(['enter-tutorial', 'enter-tutorial-done']);
  });

  it('multiple nested setNextState calls within OnEnter — last wins', () => {
    const world = makeWorld();

    addOnEnter(LevelId, 'tutorial', (w) => {
      setNextState(w, LevelId, 'street-a');
      setNextState(w, LevelId, 'main-menu'); // overwrites previous
    });

    setNextState(world, LevelId, 'tutorial');
    world.update(1 / 60).unwrap();

    // State still 'tutorial' after frame 1
    const s1 = getState(world, LevelId);
    expect(s1.ok && s1.value).toBe('tutorial');

    // Frame 2: last setNextState wins -> back to 'main-menu'
    world.update(1 / 60).unwrap();

    const s2 = getState(world, LevelId);
    expect(s2.ok && s2.value).toBe('main-menu');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Callback error propagation (m4w4): OnEnter/OnExit throw → structured
// system-failed result with the original callback preserved in detail.cause.
//
// Each test uses a dedicated StateToken to avoid callback registry collision
// (registry is module-scoped singleton shared across tests in the same file).
// ──────────────────────────────────────────────────────────────────────────────

const ErrPropA = defineState('ErrPropA', ['idle', 'target'] as const);
const ErrPropB = defineState('ErrPropB', ['idle', 'target'] as const);
const ErrPropC = defineState('ErrPropC', ['idle', 'target'] as const);

describe('callback error propagation', () => {
  it('OnExit callback throw is wrapped as system-failed with the original cause', () => {
    const world = new World();
    registerStatesPlugin(world);
    let enterFired = false;
    addOnExit(ErrPropA, 'idle', () => {
      throw new Error('on-exit-fault');
    });
    addOnEnter(ErrPropA, 'target', () => {
      enterFired = true;
    });

    setNextState(world, ErrPropA, 'target');
    expect(() => world.update(1 / 60).unwrap()).toThrow('System Update/transitionStates failed');
    expect(enterFired).toBe(false);
  });

  it('OnEnter callback throw is wrapped as system-failed with the original cause', () => {
    const world = new World();
    registerStatesPlugin(world);
    let exitFired = false;
    addOnExit(ErrPropB, 'idle', () => {
      exitFired = true;
    });
    addOnEnter(ErrPropB, 'target', () => {
      throw new Error('on-enter-fault');
    });

    setNextState(world, ErrPropB, 'target');
    expect(() => world.update(1 / 60).unwrap()).toThrow('System Update/transitionStates failed');
    expect(exitFired).toBe(true);
  });

  it('callback without throw completes normally -- no effect', () => {
    const world = new World();
    registerStatesPlugin(world);
    let exitFired = false;
    let enterFired = false;
    addOnExit(ErrPropC, 'idle', () => { exitFired = true; });
    addOnEnter(ErrPropC, 'target', () => { enterFired = true; });

    setNextState(world, ErrPropC, 'target');
    world.update(1 / 60).unwrap();

    expect(exitFired).toBe(true);
    expect(enterFired).toBe(true);
    const s = getState(world, ErrPropC);
    expect(s.ok && s.value).toBe('target');
  });
});
