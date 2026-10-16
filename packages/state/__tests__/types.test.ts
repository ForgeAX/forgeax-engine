// @forgeax/engine-state -- compile-time narrowing + error exhaustiveness tests (M1 / m1w5)
//
// Covers: StateTokenVariant type utility, StateErrorCode exhaustiveness,
// @ts-expect-error annotations verifying compile-time narrowing,
// State/NextState/PreviousState generic types are distinct.
//
// AC-01: compile-time narrowing verified via @ts-expect-error annotations.

import { describe, expect, it } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { defineState } from '../src/define-state';
import type { StateToken, StateTokenVariant } from '../src/define-state';
import type { StateErrorCode } from '../src/errors';
import { setNextState, setNextStateForce } from '../src/set-next-state';
import { addOnEnter, addOnExit, OnEnter, OnExit } from '../src/on-enter-on-exit';
import { despawnOnEnter, despawnOnExit } from '../src/scoped-component';
import { registerStatesPlugin } from '../src/register-plugin';

describe('types', () => {
  it('StateTokenVariant extracts the correct union from a token', () => {
    const Mode = defineState('Mode', ['idle', 'active', 'paused'] as const);

    type ModeVariant = StateTokenVariant<typeof Mode>;
    //   ^? 'idle' | 'active' | 'paused'

    // Positive assertion: these are all valid variants
    const v1: ModeVariant = 'idle';
    const v2: ModeVariant = 'active';
    const v3: ModeVariant = 'paused';
    expect(v1).toBe('idle');
    expect(v2).toBe('active');
    expect(v3).toBe('paused');

    // Negative @ts-expect-error: this SHOULD be a compile error
    // Uncomment to verify at type-check time:
    // @ts-expect-error - 'invalid' is not in ModeVariant
    // const _bad: ModeVariant = 'invalid';

    // Sanity: verify token structure
    expect(Mode.variants).toHaveLength(3);
  });

  it('PF-1: API signatures narrow variant to the token union (misspelling is a compile error)', () => {
    const Level = defineState('PF1Level', ['menu', 'game'] as const);
    const world = new World();
    registerStatesPlugin(world);

    // Positive: real variants type-check and work at runtime.
    expect(setNextState(world, Level, 'game').ok).toBe(true);
    expect(setNextStateForce(world, Level, 'menu').ok).toBe(true);
    expect(typeof OnEnter(Level, 'game')).toBe('string');
    expect(typeof OnExit(Level, 'menu')).toBe('string');
    const un1 = addOnEnter(Level, 'game', () => {});
    const un2 = addOnExit(Level, 'menu', () => {});
    un1();
    un2();

    // Negative: a misspelled variant is now a COMPILE error on every
    // user-facing signature (PF-1 fix). Each @ts-expect-error fails the
    // type-check if the narrowing regresses to `variant: string`. These lines
    // are compile-only contracts — guarded by `if (false)` so they never run
    // (the bad variants would throw / Result.err at runtime).
    if (false as boolean) {
      // @ts-expect-error - 'menus' is not a PF1Level variant
      setNextState(world, Level, 'menus');
      // @ts-expect-error - 'gam' is not a PF1Level variant
      setNextStateForce(world, Level, 'gam');
      // @ts-expect-error - 'nope' is not a PF1Level variant
      OnEnter(Level, 'nope');
      // @ts-expect-error - 'nope' is not a PF1Level variant
      OnExit(Level, 'nope');
      // @ts-expect-error - 'nope' is not a PF1Level variant
      addOnEnter(Level, 'nope', () => {});
      // @ts-expect-error - 'nope' is not a PF1Level variant
      addOnExit(Level, 'nope', () => {});
      // @ts-expect-error - 'nope' is not a PF1Level variant
      despawnOnExit(world, world.spawn().unwrap(), Level, 'nope');
      // @ts-expect-error - 'nope' is not a PF1Level variant
      despawnOnEnter(world, world.spawn().unwrap(), Level, 'nope');
    }

    // despawnOnExit / despawnOnEnter accept real variants at runtime.
    const entity = world.spawn().unwrap();
    despawnOnExit(world, entity, Level, 'menu');
    const entity2 = world.spawn().unwrap();
    despawnOnEnter(world, entity2, Level, 'game');
  });

  it('StateErrorCode exhaustive switch compiles without default branch', () => {
    // This test verifies that StateErrorCode has exactly 4 members.
    // If a member is added or removed, the switch below will not compile.

    function checkExhaustive(code: StateErrorCode): string {
      switch (code) {
        case 'state-already-defined':
          return 'already';
        case 'state-not-registered':
          return 'not-registered';
        case 'invalid-variant':
          return 'invalid';
        case 'state-default-required':
          return 'default-required';
      }
    }

    expect(checkExhaustive('state-already-defined')).toBe('already');
    expect(checkExhaustive('state-not-registered')).toBe('not-registered');
    expect(checkExhaustive('invalid-variant')).toBe('invalid');
    expect(checkExhaustive('state-default-required')).toBe('default-required');
  });

  it('StateToken brand prevents assignment from plain object', () => {
    const token = defineState('BrandTest', ['on', 'off'] as const);

    // Verify token is not structurally compatible with a plain object
    const plain: StateToken = {
      // @ts-expect-error - missing __forgeaxState brand
      name: 'BrandTest',
      variants: ['on', 'off'],
      nameToIdx: new Map([['on', 0], ['off', 1]]),
      defaultValue: 'on',
    };
    // TypeScript should flag this as an error because __forgeaxState is missing
    // The @ts-expect-error above validates the brand

    // Use the actual token, discard plain
    void plain;
    expect(token.name).toBe('BrandTest');
  });
});