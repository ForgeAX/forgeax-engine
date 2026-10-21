import type { World } from '@forgeax/engine-ecs';
import type { AnimationChannel } from '@forgeax/engine-types';

const DIAGNOSTIC_CODES = {
  'property-invalid': 'animation-property-invalid',
  'target-missing': 'animation-target-missing',
  'transform-missing': 'animation-target-transform-missing',
  'target-id-duplicate': 'animation-target-id-duplicate',
  'target-stale': 'animation-target-owner-stale',
  'channel-missing': 'animation-channel-missing',
  'morph-weights-missing': 'animation-target-morph-weights-missing',
  'morph-weight-count-mismatch': 'animation-morph-weight-count-mismatch',
} as const;

export type AnimationDiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export interface AnimationDiagnosticDetail {
  readonly player: number;
  readonly clip: number;
  readonly channel: number;
  readonly targetId: string;
  readonly reason: keyof typeof DIAGNOSTIC_CODES;
  readonly target?: number;
  readonly property?: AnimationChannel['property'];
  readonly binding?: string;
  readonly cause?: string;
  readonly expectedWeightCount?: number;
  readonly actualWeightCount?: number;
}

export interface AnimationDiagnostic {
  readonly code: AnimationDiagnosticCode;
  readonly hint: string;
  readonly detail: Readonly<AnimationDiagnosticDetail>;
}

export type AnimationDiagnosticListener = (
  world: World,
  diagnostic: Readonly<AnimationDiagnostic>,
) => void;

const emittedKeysByWorld = new WeakMap<World, Set<string>>();
const listeners = new Set<AnimationDiagnosticListener>();

/** Observe unique channel-level diagnostic facts for editor/runtime projection. */
export function subscribeAnimationDiagnostics(listener: AnimationDiagnosticListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** @internal */
export function isAnimationDevMode(): boolean {
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  if (proc?.env?.NODE_ENV === 'production') return false;
  return Boolean((import.meta as { env?: { DEV?: unknown } }).env?.DEV) || proc !== undefined;
}

export function emitAnimationDiagnostic(
  world: World,
  detail: AnimationDiagnosticDetail,
  hint: string,
): void {
  if (!isAnimationDevMode()) return;
  let emitted = emittedKeysByWorld.get(world);
  if (emitted === undefined) {
    emitted = new Set();
    emittedKeysByWorld.set(world, emitted);
  }
  const { player, clip, channel, targetId, reason } = detail;
  const emittedKey = `${player}|${clip}|${channel}|${targetId}|${reason}`;
  if (emitted.has(emittedKey)) return;
  emitted.add(emittedKey);

  const frozen = Object.freeze({
    code: DIAGNOSTIC_CODES[reason],
    hint,
    detail: Object.freeze({ ...detail }),
  });
  for (const listener of listeners) {
    try {
      listener(world, frozen);
    } catch {
      // Diagnostics must never break animation evaluation.
    }
  }

  console.warn(frozen);
}

/** @internal */
export function _resetAnimationWarnsForTests(world: World): void {
  emittedKeysByWorld.delete(world);
}
