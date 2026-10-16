// @forgeax/engine-state -- run conditions (feat-20260618 M3 / w25)
//
// inState(token, variant) returns a (world: World) => boolean predicate
// suitable for SystemDescriptor.runIf. The predicate reads the state token's
// current value from the World resource store.
//
// Decision anchors:
// - requirements section "inState factory" -- single factory, no and/or/not
//   combiners (OOS-7); returns (world) => boolean
// - research Finding 3 -- reuse stateResourceKey + hasResource + getResource<number>
// - plan-strategy D-8 -- runIf receives World, inState returns the predicate

import type { World } from '@forgeax/engine-ecs';
import type { StateToken } from './define-state';
import { stateResourceKey } from './resources';

/**
 * Create a run-condition predicate that passes when the state machine
 * identified by `token` is in the given `variant`.
 *
 * The predicate reads the current state index from the World resource store
 * (keyed by {@link stateResourceKey}) and compares it against the variant's
 * index in `token.nameToIdx`.
 *
 * If the state resource has not been inserted yet (state not activated), the
 * predicate returns `false` -- the system is skipped silently.
 *
 * @example
 * ```ts
 * const GameState = defineState('GameState', ['Menu', 'Playing', 'Paused'] as const);
 *
 * const S = defineSystem({
 *   name: 'gameplay',
 *   queries: [{ with: [Transform] }],
 *   runIf: inState(GameState, 'Playing'),
 *   fn: (world, queryResults, commands) => { ... },
 * });
 * ```
 *
 * @param token - The state token returned by {@link defineState}.
 * @param variant - The variant name to check against (must be a member of token.variants).
 * @returns A predicate `(world: World) => boolean` suitable for `SystemDescriptor.runIf`.
 */
export function inState(token: StateToken, variant: string): (world: World) => boolean {
  const key = stateResourceKey(token);
  const expectedIdx = token.nameToIdx.get(variant);
  // If the variant string is not in the token's vocabulary, the predicate
  // always returns false -- the system will never run. This is a programmer
  // error (typo in variant name) but we don't throw at definition time
  // because the predicate is a closure evaluated each frame; a throw here
  // would kill the entire schedule.
  if (expectedIdx === undefined) {
    return (_world: World) => false;
  }
  return (world: World) => {
    if (!world.hasResource(key)) return false;
    const currentIdx = world.getResource<number>(key);
    return currentIdx === expectedIdx;
  };
}
