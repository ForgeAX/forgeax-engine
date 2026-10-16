// @forgeax/engine-state -- OnEnter / OnExit callback registry (M4 / m4w2)
//
// OnEnter(token, value) and OnExit(token, value) return branded schedule-label
// strings encoding the token name, transition kind and variant as a JSON tuple.
//
// addOnEnter(token, variant, fn) / addOnExit(token, variant, fn) push fn into a
// per-label callback registry and return an unsubscribe handle. The registry is
// consumed by transitionStatesSystem (m4w4) which dispatches callbacks during
// state transitions.
//
// These labels are NOT ECS schedule labels — they are state-package-internal
// dispatchers. There is no ECS sub-schedule (research F-5); all dispatch happens
// inside transitionStatesSystem itself (plan-strategy D-5).
//
// Decision anchors:
// - plan-strategy D-5: fn[] registry + transition body dispatch, zero ECS change
// - research F-5: ECS has no schedule label / sub-schedule API
// - requirements F-11: OnEnter/OnExit return schedule labels for user-facing API

import type { World } from '@forgeax/engine-ecs';
import type { StateToken, StateTokenVariant } from './define-state';

const ON_ENTER_LABEL_PREFIX = '__OnEnter__';
const ON_EXIT_LABEL_PREFIX = '__OnExit__';

/**
 * Callback type for OnEnter / OnExit hooks.
 *
 * Receives the {@link World} for ECS interaction (e.g. spawning entities,
 * reading Resources). Callbacks fire synchronously inside transitionStatesSystem.
 */
export type StateCallback = (world: World) => void;

/**
 * Unsubscribe handle returned by {@link addOnEnter} / {@link addOnExit}.
 * Call to remove the callback from future dispatch.
 */
export type UnsubscribeHandle = () => void;

/**
 * Each registration object supplies identity independently of its callback.
 */
interface CallbackEntry {
  fn: StateCallback;
}

/**
 * Module-private callback registry.
 *
 * Key: an unambiguous JSON tuple of token name, transition kind and variant.
 * Value: ordered array of callback entries (fired in registration order).
 */
const _registry = new Map<string, CallbackEntry[]>();

function makeLabel(tokenName: string, prefix: string, variant: string): string {
  return JSON.stringify([tokenName, prefix, variant]);
}

/**
 * Returns a branded schedule-label string for an OnEnter hook.
 *
 * The label is NOT an ECS schedule label. It is consumed internally by
 * {@link addOnEnter} and dispatched by transitionStatesSystem during state
 * transition (plan-strategy D-5).
 *
 * @param token - The StateToken defining the state machine.
 * @param variant - The variant whose entry triggers the callback.
 * @returns A unique label string usable with {@link addOnEnter}.
 */
export function OnEnter<T extends StateToken>(token: T, variant: StateTokenVariant<T>): string {
  return makeLabel(token.name, ON_ENTER_LABEL_PREFIX, variant);
}

/**
 * Returns a branded schedule-label string for an OnExit hook.
 *
 * @param token - The StateToken defining the state machine.
 * @param variant - The variant whose exit triggers the callback.
 * @returns A unique label string usable with {@link addOnExit}.
 */
export function OnExit<T extends StateToken>(token: T, variant: StateTokenVariant<T>): string {
  return makeLabel(token.name, ON_EXIT_LABEL_PREFIX, variant);
}

/**
 * Register a callback to fire when `token` transitions into `variant`.
 *
 * @param token - The state machine token.
 * @param variant - The target variant that triggers this callback.
 * @param fn - The callback to invoke (receives World parameter).
 * @returns An unsubscribe handle. Call it to remove the callback from future dispatch.
 */
export function addOnEnter<T extends StateToken>(
  token: T,
  variant: StateTokenVariant<T>,
  fn: StateCallback,
): UnsubscribeHandle {
  const label = OnEnter(token, variant);
  return _add(label, fn);
}

/**
 * Register a callback to fire when `token` transitions away from `variant`.
 *
 * @param token - The state machine token.
 * @param variant - The variant whose exit triggers this callback.
 * @param fn - The callback to invoke (receives World parameter).
 * @returns An unsubscribe handle. Call it to remove the callback from future dispatch.
 */
export function addOnExit<T extends StateToken>(
  token: T,
  variant: StateTokenVariant<T>,
  fn: StateCallback,
): UnsubscribeHandle {
  const label = OnExit(token, variant);
  return _add(label, fn);
}

function _add(label: string, fn: StateCallback): UnsubscribeHandle {
  let entries = _registry.get(label);
  if (!entries) {
    entries = [];
    _registry.set(label, entries);
  }

  const entry = { fn };
  entries.push(entry);

  return () => {
    const list = _registry.get(label);
    if (!list) return;
    const idx = list.indexOf(entry);
    if (idx !== -1) {
      list.splice(idx, 1);
      if (list.length === 0) _registry.delete(label);
    }
  };
}

/**
 * Get all registered callbacks for a given label, in registration order.
 *
 * Returns the callbacks as an array of functions. An empty array means no
 * callbacks are registered for this label. Consumed by transitionStatesSystem
 * during dispatch (m4w4).
 *
 * @param label - An OnEnter or OnExit label string.
 * @returns Array of callback functions (may be empty).
 * @internal
 */
export function getCallbacks(label: string): StateCallback[] {
  const entries = _registry.get(label);
  if (!entries) return [];
  return entries.map((e) => e.fn);
}
