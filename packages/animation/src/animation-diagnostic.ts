import type { World } from '@forgeax/engine-ecs';

export type AnimationDiagnosticCode =
  | 'animation-property-invalid'
  | 'animation-target-missing'
  | 'animation-target-transform-missing'
  | 'animation-target-id-duplicate'
  | 'animation-target-owner-stale'
  | 'animation-channel-missing'
  | 'animation-target-morph-weights-missing'
  | 'animation-morph-weight-count-mismatch';

export interface AnimationDiagnosticDetail {
  readonly player: number;
  readonly clip: number;
  readonly channel: number;
  readonly targetId: string;
  readonly reason:
    | 'property-invalid'
    | 'target-missing'
    | 'transform-missing'
    | 'target-id-duplicate'
    | 'target-stale'
    | 'channel-missing'
    | 'morph-weights-missing'
    | 'morph-weight-count-mismatch';
  readonly target?: number;
  readonly property?: 'translation' | 'rotation' | 'scale' | 'weights' | 'property';
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

export function emitAnimationDiagnostic(world: World, diagnostic: AnimationDiagnostic): void {
  if (!isAnimationDevMode()) return;
  let emitted = emittedKeysByWorld.get(world);
  if (emitted === undefined) {
    emitted = new Set();
    emittedKeysByWorld.set(world, emitted);
  }
  const { player, clip, channel, targetId, reason } = diagnostic.detail;
  const emittedKey = `${player}|${clip}|${channel}|${targetId}|${reason}`;
  if (emitted.has(emittedKey)) return;
  emitted.add(emittedKey);

  const frozen = Object.freeze({
    ...diagnostic,
    detail: Object.freeze({ ...diagnostic.detail }),
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
