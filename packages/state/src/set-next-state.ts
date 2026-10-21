// @forgeax/engine-state -- setNextState / getState / getPreviousState (M2 / m2w4)
//
// Free functions that read and write per-token Resource slots. All return
// Result<T, StateError> (never throw for AI-user call sites per AGENTS.md
// Error model).
//
// Decision anchors:
// - requirements C-3: setNextState returns Result.err, not throw
// - requirements C-4: free functions, not world.x methods
// - requirements F-5/F-6: State / NextState / PreviousState as Resources
// - plan-strategy D-4: State stores variant index (u32), decoded via token.variants

import type { World } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { StateToken, StateTokenVariant } from './define-state';
import type { StateError } from './errors';
import { invalidVariant, stateNotRegistered } from './errors';
import { type StatePayload, stateResourceKey } from './resources';

/**
 * Request a state transition for `token` to `variant` at the next frame.
 *
 * `variant` is narrowed to the token's variant union: a misspelled variant is
 * a compile-time error (`StateTokenVariant<T>`), not just a runtime
 * `invalid-variant` Result.
 */
export function setNextState<T extends StateToken>(
  world: World,
  token: T,
  variant: StateTokenVariant<T>,
): Result<void, StateError> {
  return _runCheckAndWrite(world, token, variant, false);
}

/**
 * Like {@link setNextState} but with `force=true`.
 */
export function setNextStateForce<T extends StateToken>(
  world: World,
  token: T,
  variant: StateTokenVariant<T>,
): Result<void, StateError> {
  return _runCheckAndWrite(world, token, variant, true);
}

function _runCheckAndWrite(
  world: World,
  token: StateToken,
  variant: string,
  force: boolean,
): Result<void, StateError> {
  const key = stateResourceKey(token);
  if (!world.hasResource(key)) {
    return err(stateNotRegistered(token.name));
  }

  const idx = token.nameToIdx.get(variant as never);
  if (idx === undefined) {
    return err(invalidVariant(token.name, variant, token.variants));
  }

  world.insertResource<StatePayload>(key, {
    ...world.getResource<StatePayload>(key),
    next: { value: idx, force },
  });
  return ok(undefined);
}

/**
 * Read the current state value for `token`.
 */
export function getState(world: World, token: StateToken): Result<string, StateError> {
  return readVariant(world, token, 'current');
}

/**
 * Read the previous-frame state value for `token`.
 */
export function getPreviousState(world: World, token: StateToken): Result<string, StateError> {
  return readVariant(world, token, 'previous');
}

function readVariant(
  world: World,
  token: StateToken,
  field: 'current' | 'previous',
): Result<string, StateError> {
  const key = stateResourceKey(token);
  if (!world.hasResource(key)) {
    return err(stateNotRegistered(token.name));
  }
  const idx = world.getResource<StatePayload>(key)[field];
  const variant = token.variants[idx];
  if (variant === undefined) {
    return err(invalidVariant(token.name, String(idx), token.variants));
  }
  return ok(variant);
}
