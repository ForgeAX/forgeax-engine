import { Update } from '@forgeax/engine-ecs';
import { InputFrameStartScan } from '@forgeax/engine-input';
import { PropagateTransforms } from '@forgeax/engine-scene';
// @forgeax/engine-state -- registerStatesPlugin (M2 / m2w2, M3 / m3w4)
//
// Idempotent plugin that inserts one complete resource per token, pre-registers ScopedTo components, and registers the
// transitionStatesSystem in the ECS schedule. Called automatically by
// createApp in both canvas and assemble forms.
//
// M3 / m3w4: stub replaced with transitionStatesSystem from transition-system.ts.
//
// Decision anchors:
// - requirements F-9: idempotent, canvas + assemble dual-form auto-wire
// - plan-strategy D-6: schedule anchors 'input-frame-start-scan' -> 'transitionStates' -> 'propagateTransforms'
// - plan-strategy D-4: insertResource initial values from token.defaultValue

import { defineSystem, defineSystemSet, type System, type World } from '@forgeax/engine-ecs';
import { getRegisteredTokens, onStateDefined, type StateToken } from './define-state';
import { type StatePayload, stateResource } from './resources';
import { getScopedComponent } from './scoped-component';
import { transitionStatesSystem } from './transition-system';

/** Schedule anchor: system name for the input frame-start scan (registered by {@link @forgeax/engine-input}). */

/** Schedule anchor: system name for the transform-propagation system (registered by {@link @forgeax/engine-runtime}). */

const TRANSITION_STATES_SYSTEM_NAME = 'transitionStates';
export const StateSet = defineSystemSet({ name: 'state' });
interface StateRuntime {
  lifecycle: 'active' | 'retiring' | 'rollback' | 'disposed';
  readonly dispose: () => void;
}
const STATE_RUNTIMES = new WeakMap<World, StateRuntime>();

/**
 * The `transitionStates` system token (M2 — full resource-ification, D-4).
 *
 * Module-level `defineSystem` with the real fn body — no closure, no
 * placeholder. The fn reads `world` from its first parameter (the M1
 * world-first signature) and delegates to {@link transitionStatesSystem}.
 * Anchored `after: [InputFrameStartScan]`, `before: [PropagateTransforms]`
 * and labelled `'state'` (spec §6.2 label-anchor map).
 */
const TransitionStates: System<readonly []> = defineSystem({
  name: TRANSITION_STATES_SYSTEM_NAME,
  queries: [],
  after: [InputFrameStartScan],
  before: [PropagateTransforms],
  fn: transitionStatesSystem,
});

/**
 * Register the state-machine plugin on a {@link World}.
 *
 * Side effects:
 * 1. Pre-registers `__scopedTo__<name>` components for all known tokens.
 * 2. Inserts each token's current/previous index and pending request together.
 * 3. Registers the {@link TransitionStates} system in the schedule.
 *
 * Tokens defined after registration are projected immediately. Repeated calls
 * on the same World are no-ops; the first owner receives the sole disposer.
 */
export function registerStatesPlugin(world: World): () => void {
  const previous = STATE_RUNTIMES.get(world);
  if (previous !== undefined) {
    if (previous.lifecycle !== 'rollback') return () => {};
    previous.dispose();
  }

  const resourceKeys = new Set<import('@forgeax/engine-ecs').Resource<StatePayload>>();
  const componentLeases = new Map<string, () => void>();
  const registerToken = (token: StateToken): void => {
    const scopedComponent = getScopedComponent(token);
    if (!componentLeases.has(token.name)) {
      const lease = world.components.register(scopedComponent);
      if (!lease.ok) throw lease.error;
      componentLeases.set(token.name, () => lease.value.dispose().unwrap());
    }
    const defaultValueIdx = token.nameToIdx.get(token.defaultValue);
    if (defaultValueIdx === undefined) return;

    const stateKey = stateResource(token);
    if (world.hasResource(stateKey)) return;
    resourceKeys.add(stateKey);
    world.insertResource<StatePayload>(stateKey, {
      current: defaultValueIdx,
      previous: defaultValueIdx,
      next: undefined,
    });
  };

  const releaseContributions = (): void => {
    for (const key of resourceKeys) {
      world.removeResource(key);
      resourceKeys.delete(key);
    }
    // A rejected lease remains owned so disposal can be retried.
    for (const [name, lease] of componentLeases) {
      lease();
      componentLeases.delete(name);
    }
  };
  let unsubscribe: (() => void) | undefined;
  const runtime: StateRuntime = {
    lifecycle: 'rollback',
    dispose() {
      if (runtime.lifecycle === 'disposed') return;
      if (runtime.lifecycle === 'active') {
        runtime.lifecycle = 'retiring';
        unsubscribe?.();
        world.removeSystem(Update, TransitionStates);
      }
      releaseContributions();
      runtime.lifecycle = 'disposed';
      STATE_RUNTIMES.delete(world);
    },
  };
  try {
    for (const token of getRegisteredTokens().values()) registerToken(token);
    world.addSystems(Update, StateSet, [TransitionStates]).unwrap();
    runtime.lifecycle = 'active';
    unsubscribe = onStateDefined(registerToken);
    STATE_RUNTIMES.set(world, runtime);
    return runtime.dispose;
  } catch (error) {
    try {
      runtime.dispose();
    } catch (cleanupError) {
      // No disposer reached the caller. Retain that same cleanup owner so a
      // later activation retries retirement before acquiring any new leases.
      runtime.lifecycle = 'rollback';
      STATE_RUNTIMES.set(world, runtime);
      throw cleanupError;
    }
    throw error;
  }
}
