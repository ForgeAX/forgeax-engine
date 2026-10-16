import { Update } from '@forgeax/engine-ecs';
// feat-20260618-ecs-module-mechanism M3 / w21 (AC-06):
// inState(token, variant) integration test -- defines a state token, builds a
// system with runIf: inState(...), drives update(), and verifies the system
// runs or is skipped according to the current state.
//
// TDD: w21 depends on w25 (inState factory impl). The test will be RED until
// w25 is committed and the module resolves cleanly.
//
// Constraints:
// - requirements OOS-7 -- only inState factory in 2a; no and/or/not combiners
// - requirements section "edge cases" -- inState returns false when state not activated
// - plan-strategy D-8 -- runIf receives World, inState returns (world)=>boolean

import { defineSystem, World } from '@forgeax/engine-ecs';
import { defineComponent } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { defineState } from '../src/define-state';
import { inState } from '../src/conditions';
import { registerStatesPlugin } from '../src/register-plugin';
import { setNextState } from '../src/set-next-state';

describe('conditions.test.ts', () => {
  describe('AC-06: inState basic predicate', () => {
    it('returns true when state matches variant', () => {
      const S = defineState('AC06_Basic', ['A', 'B'] as const);
      const pred = inState(S, 'A');

      const world = new World();
      world.insertResource('__state__AC06_Basic', 0); // idx 0 = 'A'

      expect(pred(world)).toBe(true);
    });

    it('returns false when state does NOT match variant', () => {
      const S = defineState('AC06_Mismatch', ['X', 'Y'] as const);
      const pred = inState(S, 'X');

      // Current idx = 1 ('Y'), but predicate checks for 'X' (idx 0).
      const world = new World();
      world.insertResource('__state__AC06_Mismatch', 1);

      expect(pred(world)).toBe(false);
    });

    it('returns false when state resource is absent (not activated)', () => {
      const S = defineState('AC06_Unactivated', ['On', 'Off'] as const);
      const pred = inState(S, 'On');

      const world = new World();
      // No insertResource -- resource key absent.

      expect(pred(world)).toBe(false);
    });

    it('returns false for unknown variant (not in token.variants)', () => {
      const S = defineState('AC06_UnknownVariant', ['Red', 'Green'] as const);
      const pred = inState(S, 'Blue'); // Blue not in ['Red', 'Green']

      const world = new World();
      world.insertResource('__state__AC06_UnknownVariant', 0);

      // Unknown variant: predicate always returns false.
      expect(pred(world)).toBe(false);
    });
  });

  describe('AC-06: inState as runIf in schedule integration', () => {
    it('system with runIf inState runs when state matches', () => {
      const GameState = defineState('AC06_Game', ['Menu', 'Playing'] as const);
      let calls = 0;

      const PlaySystem = defineSystem({
        name: 'ac06-play',
        queries: [],
        runIf: inState(GameState, 'Playing'),
        fn: () => { calls += 1; },
      });

      const world = new World();
      registerStatesPlugin(world);
      setNextState(world, GameState, 'Playing');
      world.update(1 / 60).unwrap(); // First update: transitionStates applies setNextState.
      world.addSystem(Update, PlaySystem);

      // Now Playing is active. Drive one more update -- the system should run.
      world.update(1 / 60).unwrap();
      expect(calls).toBe(1);
    });

    it('system with runIf inState is SKIPPED when state does NOT match', () => {
      const GameState = defineState('AC06_NonMatch', ['Idle', 'Active'] as const);
      let calls = 0;

      const ActiveSystem = defineSystem({
        name: 'ac06-active-only',
        queries: [],
        runIf: inState(GameState, 'Active'),
        fn: () => { calls += 1; },
      });

      const world = new World();
      registerStatesPlugin(world);
      // Default state is 'Idle' -- not 'Active'.
      world.addSystem(Update, ActiveSystem);
      world.update(1 / 60).unwrap();

      // runIf returns false, system body never executes.
      expect(calls).toBe(0);
    });
  });
});