import { Update } from '@forgeax/engine-ecs';
// @forgeax/engine-state -- registerStatesPlugin (M2 / m2w2, M3 / m3w4)
//
// Idempotent plugin that inserts per-token Resources (State / NextState /
// PreviousState), pre-registers ScopedTo components, and registers the
// transitionStatesSystem in the ECS schedule. Called automatically by
// createApp in both canvas and assemble forms.
//
// M3 / m3w4: stub replaced with transitionStatesSystem from transition-system.ts.
//
// Decision anchors:
// - requirements F-9: idempotent, canvas + assemble dual-form auto-wire
// - plan-strategy D-6: schedule anchors 'input-frame-start-scan' -> 'transitionStates' -> 'propagateTransforms'
// - plan-strategy D-4: insertResource initial values from token.defaultValue

import { defineSystem, defineSystemSet, type SystemHandle, type World } from '@forgeax/engine-ecs';
import { getRegisteredTokens, onStateDefined, type StateToken } from './define-state';
import {
  type NextStatePayload,
  nextStateResourceKey,
  previousStateResourceKey,
  stateResourceKey,
} from './resources';
import { getScopedComponent } from './scoped-component';
import { transitionStatesSystem } from './transition-system';

/** Schedule anchor: system name for the input frame-start scan (registered by {@link @forgeax/engine-input}). */
const FRAME_START_SCAN_SYSTEM_NAME = 'input-frame-start-scan' as const;

/** Schedule anchor: system name for the transform-propagation system (registered by {@link @forgeax/engine-runtime}). */
const PROPAGATE_TRANSFORMS_SYSTEM = 'propagateTransforms' as const;

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
 * Anchored `after: ['input-frame-start-scan']`, `before: ['propagateTransforms']`
 * and labelled `'state'` (spec §6.2 label-anchor map).
 */
export const TransitionStates: SystemHandle<readonly []> = defineSystem({
  name: TRANSITION_STATES_SYSTEM_NAME,
  queries: [],
  after: [FRAME_START_SCAN_SYSTEM_NAME],
  before: [PROPAGATE_TRANSFORMS_SYSTEM],
  fn: transitionStatesSystem,
});

/**
 * Register the state-machine plugin on a {@link World}.
 *
 * Side effects:
 * 1. Pre-registers `__scopedTo__<name>` components for all known tokens.
 * 2. For each globally registered {@link StateToken}: inserts three Resources
 *    ({@link State} = defaultValue index, {@link NextState} = undefined,
 *    {@link PreviousState} = defaultValue index).
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

  const resourceKeys = new Set<string>();
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

    const stateKey = stateResourceKey(token);
    const nextKey = nextStateResourceKey(token);
    const previousKey = previousStateResourceKey(token);
    if (world.hasResource(stateKey)) return;
    resourceKeys.add(stateKey);
    resourceKeys.add(nextKey);
    resourceKeys.add(previousKey);
    world.insertResource(stateKey, defaultValueIdx);
    world.insertResource(nextKey, undefined as NextStatePayload | undefined);
    world.insertResource(previousKey, defaultValueIdx);
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
        world.removeSystem(Update, TRANSITION_STATES_SYSTEM_NAME);
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
