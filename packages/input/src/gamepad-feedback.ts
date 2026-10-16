/** Realm-neutral, bounded output. Targets come only from the frozen input scan. */
export interface GamepadFeedbackTarget {
  readonly attachment: number;
  readonly index: number;
  readonly generation: number;
}
export interface GamepadRumble {
  readonly durationMs: number;
  readonly strongMagnitude: number;
  readonly weakMagnitude: number;
}
export type GamepadFeedbackIntent = {
  readonly id: number;
  readonly target: GamepadFeedbackTarget;
} & ({ readonly kind: 'play'; readonly effect: GamepadRumble } | { readonly kind: 'stop' });
export type GamepadFeedbackStatus =
  | 'complete'
  | 'preempted'
  | 'invalid'
  | 'unsupported'
  | 'disconnected'
  | 'stale'
  | 'hidden'
  | 'busy'
  | 'rejected'
  | 'timeout'
  | 'disposed'
  | 'result-overflow';
export interface GamepadFeedbackResult {
  readonly id: number;
  readonly status: GamepadFeedbackStatus;
  /** POD native rejection name/message, never the native exception. */
  readonly detail?: string;
}
export const GAMEPAD_FEEDBACK_KEY = 'GamepadFeedback' as const;
export const GAMEPAD_FEEDBACK_CAPACITY = 32;
export const GAMEPAD_FEEDBACK_MAX_DURATION_MS = 10_000;
export function validGamepadRumble(effect: GamepadRumble): boolean {
  return (
    effect != null &&
    Number.isFinite(effect.durationMs) &&
    effect.durationMs > 0 &&
    effect.durationMs <= GAMEPAD_FEEDBACK_MAX_DURATION_MS &&
    Number.isFinite(effect.strongMagnitude) &&
    effect.strongMagnitude >= 0 &&
    effect.strongMagnitude <= 1 &&
    Number.isFinite(effect.weakMagnitude) &&
    effect.weakMagnitude >= 0 &&
    effect.weakMagnitude <= 1
  );
}
export type GamepadFeedbackAdmission =
  | { readonly ok: true; readonly id: number }
  | { readonly ok: false; readonly reason: 'invalid' | 'capacity' | 'disposed' };
export interface GamepadFeedback {
  play(target: GamepadFeedbackTarget, effect: GamepadRumble): GamepadFeedbackAdmission;
  stop(target: GamepadFeedbackTarget): GamepadFeedbackAdmission;
  /** Poll terminal results in arrival order. Polling releases their capacity. */
  readResults(): readonly GamepadFeedbackResult[];
  /** Transport seams: both arrays contain POD only. */
  drainIntents(): readonly GamepadFeedbackIntent[];
  acceptResults(results: readonly GamepadFeedbackResult[], lost?: number): void;
  dispose(): void;
}
export function createGamepadFeedback(): GamepadFeedback {
  let nextId = 1;
  let disposed = false;
  let intents: GamepadFeedbackIntent[] = [];
  let results: GamepadFeedbackResult[] = [];
  let droppedDiagnostics = 0;
  const pending = new Set<number>();
  function enqueue(
    target: GamepadFeedbackTarget,
    effect?: GamepadRumble,
  ): GamepadFeedbackAdmission {
    if (disposed) return { ok: false, reason: 'disposed' };
    if (
      !target ||
      !Number.isSafeInteger(target.attachment) ||
      target.attachment <= 0 ||
      !Number.isSafeInteger(target.index) ||
      target.index < 0 ||
      !Number.isSafeInteger(target.generation) ||
      target.generation <= 0 ||
      (effect !== undefined && !validGamepadRumble(effect))
    )
      return { ok: false, reason: 'invalid' };
    if (pending.size + results.length >= GAMEPAD_FEEDBACK_CAPACITY)
      return { ok: false, reason: 'capacity' };
    const id = nextId++;
    pending.add(id);
    const ownedTarget = Object.freeze({ ...target });
    intents.push(
      effect === undefined
        ? { id, target: ownedTarget, kind: 'stop' }
        : { id, target: ownedTarget, kind: 'play', effect: Object.freeze({ ...effect }) },
    );
    return { ok: true, id };
  }
  return {
    play: (target, effect) =>
      validGamepadRumble(effect) ? enqueue(target, effect) : { ok: false, reason: 'invalid' },
    stop: (target) => enqueue(target),
    drainIntents() {
      const out = intents;
      intents = [];
      return out;
    },
    readResults() {
      const out = results;
      results = [];
      droppedDiagnostics = 0;
      return out;
    },
    acceptResults(incoming, lost = 0) {
      for (const result of incoming) {
        if (pending.delete(result.id)) {
          results.push(Object.freeze({ ...result }));
        } else if (result.id === 0) {
          if (pending.size + results.length < GAMEPAD_FEEDBACK_CAPACITY * 2) {
            results.push(Object.freeze({ ...result }));
          } else {
            // Never evict an authored terminal to make room for lifecycle evidence.
            const diagnostic = results.findIndex((item) => item.id === 0);
            if (diagnostic >= 0) results.splice(diagnostic, 1);
            droppedDiagnostics++;
            results.push({
              id: 0,
              status: 'result-overflow',
              detail: `Dropped ${droppedDiagnostics} lifecycle diagnostics. Latest: ${result.status}: ${result.detail ?? ''}`,
            });
          }
        }
      }
      if (lost > 0) {
        for (const id of pending) results.push({ id, status: 'result-overflow' });
        pending.clear();
        intents = [];
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      intents = [];
      for (const id of pending) results.push({ id, status: 'disposed' });
      pending.clear();
    },
  };
}
