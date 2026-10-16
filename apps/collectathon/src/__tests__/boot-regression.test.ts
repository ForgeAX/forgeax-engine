// m6-6 -- R-12 boot-time camera-readiness regression (root cause: spike m6-1).
//
// The human hit `render-system-no-camera` on `pnpm dev`: the camera is spawned by
// the Play state's OnEnter, but Title->Play is two deferred setNextState hops
// (F-08) -- force-Title applies + queues Play on update 1, Play applies +
// spawnCamera on update 2 -- while the frame loop draws unconditionally every
// frame. So the first ~2 frames drew with no Camera entity and fired the error.
//
// main.ts's fix (m6-2): after setNextStateForce(Title), pump world.update(1 / 60).unwrap() until
// Play is live (Camera spawned) BEFORE app.start(), so the very first drawn frame
// already has a Camera. createApp's frame loop owns the draw, and there is no GPU
// in a unit test, so this test cannot drive the real bootstrap end-to-end.
// Instead it models the exact state-machine timing main.ts depends on -- the same
// defineState + OnEnter hops + the BOOT_TRANSITION_PUMP_LIMIT pump loop -- and
// asserts the camera-before-draw invariant that the fix guarantees. If a future
// rewire reintroduces the deferral-without-pump (or changes the hop count past
// the bound), this fails.

import { World } from '@forgeax/engine-ecs';
import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import {
  addOnEnter,
  defineState,
  getState,
  registerStatesPlugin,
  type StateToken,
  setNextState,
  setNextStateForce,
} from '@forgeax/engine-state';
import { describe, expect, it } from 'vitest';

// Mirror of main.ts BOOT_TRANSITION_PUMP_LIMIT (kept local so the test pins the
// timing contract independently of main.ts's module-load side effects).
const BOOT_TRANSITION_PUMP_LIMIT = 8;

// GameState tokens shaped like main.ts's. defineState self-registers globally and
// rejects a duplicate name; registerStatesPlugin(world) snapshots the global
// token set at CALL time, so the tokens MUST be defined at module scope (before
// any registerStatesPlugin call). One distinct token per test avoids
// scoped-component cross-talk between worlds.
type BootState = StateToken<string, 'Title' | 'Play' | 'Win' | 'Lose'>;
const BOOT_STATES: readonly BootState[] = [
  defineState('CollectathonBootTestState1', ['Title', 'Play', 'Win', 'Lose'] as const),
  defineState('CollectathonBootTestState2', ['Title', 'Play', 'Win', 'Lose'] as const),
  defineState('CollectathonBootTestState3', ['Title', 'Play', 'Win', 'Lose'] as const),
];
let bootStateSeq = 0;
function nextBootState(): BootState {
  const s = BOOT_STATES[bootStateSeq];
  bootStateSeq += 1;
  if (s === undefined) throw new Error('boot-regression: ran out of pre-defined state tokens');
  return s;
}

// Wire the minimal Title/Play OnEnter hops main.ts uses: Title OnEnter advances
// to Play (the deferred hop), Play OnEnter spawns the Camera. `spawned` records
// how many Cameras were spawned so a double-entry regression is observable.
function wireBoot(state: BootState, spawned: { count: number }): void {
  addOnEnter(state, 'Title', (w: World) => {
    void setNextState(w, state, 'Play');
  });
  addOnEnter(state, 'Play', (w: World) => {
    w.spawn(
      { component: Transform, data: { pos: [0, 5, 9] } },
      { component: Camera, data: {} },
    ).unwrap();
    spawned.count += 1;
  });
}

// Narrow getState's Result to the current variant name (throws on the err arm,
// which would itself be a registration regression worth failing on).
function currentState(world: World, state: BootState): string {
  const s = getState(world, state);
  if (!s.ok) throw new Error(`getState failed: ${s.error.code}`);
  return s.value;
}

function cameraCount(world: World): number {
  let n = 0;
  const query = world.query({ with: [Camera] }).unwrap();
  for (const _row of query) n += 1;
  return n;
}

// The boot pump main.ts runs before app.start(): force Title, then update until
// Play is live or the bound is hit. Returns the number of updates performed.
function pumpBoot(world: World, state: BootState): number {
  void setNextStateForce(world, state, 'Title');
  let updates = 0;
  for (let i = 0; i < BOOT_TRANSITION_PUMP_LIMIT; i++) {
    const s = getState(world, state);
    if (s.ok && s.value === 'Play') break;
    world.update(1 / 60).unwrap();
    updates += 1;
  }
  return updates;
}

describe('R-12 boot camera readiness (m6-6)', () => {
  it('the bug shape: a single update after force-Title has NO camera yet (deferral)', () => {
    const world = new World();
    registerStatesPlugin(world);
    const state = nextBootState();
    wireBoot(state, { count: 0 });

    // One update applies force-Title + runs Title OnEnter (which only QUEUES
    // Play). The camera is not spawned yet -- this is exactly the window the
    // unconditional frame-loop draw fell into.
    void setNextStateForce(world, state, 'Title');
    world.update(1 / 60).unwrap();
    expect(currentState(world, state)).toBe('Title' satisfies string);
    expect(cameraCount(world)).toBe(0);
  });

  it('the fix: the boot pump leaves a Camera live before the first draw', () => {
    const world = new World();
    registerStatesPlugin(world);
    const state = nextBootState();
    const spawned = { count: 0 };
    wireBoot(state, spawned);

    const updates = pumpBoot(world, state);

    // After the pump, Play is the live state and exactly one Camera exists --
    // i.e. the first frame the loop would draw already has a Camera (no
    // render-system-no-camera window).
    expect(currentState(world, state)).toBe('Play' satisfies string);
    expect(cameraCount(world)).toBeGreaterThanOrEqual(1);
    expect(spawned.count).toBe(1);
    // The Title->Play hops settle well inside the bound (2 updates here), so the
    // pump never burns the full budget -- a hop-count regression would.
    expect(updates).toBeLessThan(BOOT_TRANSITION_PUMP_LIMIT);
  });

  it('boot does not throw (the no-camera draw path is never reached)', () => {
    const world = new World();
    registerStatesPlugin(world);
    const state = nextBootState();
    wireBoot(state, { count: 0 });
    expect(() => pumpBoot(world, state)).not.toThrow();
  });
});
