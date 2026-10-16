import { Update } from '../src/schedule-token';
// feat-20260618-ecs-module-mechanism M1 / w3 (AC-05):
// runIf: () => false skips the system silently -- neither the query nor fn run
// (fn call count = 0). runIf undefined (omitted) runs the system normally.
// The skip is silent: no state added, no skip counter exposed.
//
// Constraints (requirements OOS-6 / plan-strategy D-8): runIf skip is silent,
// adds no state, exposes no skip diagnostics.

import { describe, expect, it } from 'vitest';
import { defineComponent } from '../src/component';
import { defineSystem } from '../src/index';
import { World } from '../src/world';

describe('runif-skip.test.ts', () => {
  it('AC-05: runIf returning false skips fn entirely (count = 0)', () => {
    let calls = 0;
    let queryTouched = 0;
    const A = defineComponent('W3SkipA', { x: 'f32' });
    const token = defineSystem({
      name: 'w3-skip',
      queries: [{ with: [A] }],
      runIf: () => false,
      fn: (_world, queryResults) => {
        calls += 1;
        for (const _b of queryResults[0]) queryTouched += 1;
      },
    });

    const world = new World();
    world.spawn({ component: A, data: { x: 1 } });
    world.addSystem(Update, token);
    world.update();

    expect(calls).toBe(0);
    expect(queryTouched).toBe(0);
  });

  it('AC-05: runIf omitted (undefined) runs fn normally', () => {
    let calls = 0;
    const B = defineComponent('W3RunB', { x: 'f32' });
    const token = defineSystem({
      name: 'w3-run',
      queries: [{ with: [B] }],
      fn: () => {
        calls += 1;
      },
    });

    const world = new World();
    world.spawn({ component: B, data: { x: 1 } });
    world.addSystem(Update, token);
    world.update();

    expect(calls).toBe(1);
  });

  it('AC-05: runIf can flip across updates (false then true)', () => {
    let calls = 0;
    let gate = false;
    const C = defineComponent('W3FlipC', { x: 'f32' });
    const token = defineSystem({
      name: 'w3-flip',
      queries: [],
      runIf: () => gate,
      fn: () => {
        calls += 1;
      },
    });

    const world = new World();
    world.addSystem(Update, token);
    world.update();
    expect(calls).toBe(0);
    gate = true;
    world.update();
    expect(calls).toBe(1);
  });
});
