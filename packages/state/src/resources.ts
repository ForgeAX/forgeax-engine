// @forgeax/engine-state -- Resource key constructors (feat-20260616 M1 / m1w2)
//
// Three Resource keys per StateToken: State (current value), NextState (pending
// transition request), PreviousState (cached last-frame value for OnExit / getPreviousState).
//
// Decision anchors:
// - plan-strategy D-1: Resources are per-token, keyed by __state__ prefix
// - plan-strategy D-4: keys are pure string constructors; Resource CRUD is in registerStatesPlugin M2
// - requirements F-4/F-5/F-6: State / NextState / PreviousState as Resources

import type { StateToken } from './define-state';

const STATE_PREFIX = '__state__';
const NEXT_STATE_PREFIX = '__nextState__';
const PREVIOUS_STATE_PREFIX = '__previousState__';

/**
 * Resource key for the current state value of a token.
 *
 * The {@link StateTokenVariant} is stored; `getState(world, token)` reads
 * this Resource and decodes the index to a variant string.
 */
export function stateResourceKey(token: StateToken): string {
  return `${STATE_PREFIX}${token.name}`;
}

/**
 * Resource key for the pending next-state transition request.
 *
 * Written by `setNextState` / `setNextStateForce` (M2); consumed by
 * `transitionStatesSystem` (M3).
 */
export function nextStateResourceKey(token: StateToken): string {
  return `${NEXT_STATE_PREFIX}${token.name}`;
}

/**
 * Resource key for the previous-frame state value.
 *
 * Written by `transitionStatesSystem` before flipping `State`; read by
 * `getPreviousState(world, token)` (M2).
 */
export function previousStateResourceKey(token: StateToken): string {
  return `${PREVIOUS_STATE_PREFIX}${token.name}`;
}

/** Pending transition stored in the per-token NextState resource. */
export interface NextStatePayload {
  value: number;
  force: boolean;
}
