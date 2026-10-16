// @forgeax/engine-animation -- AnimationPlayer cluster error classes.
//
// feat-20260713-animation-state-machine-plugin M1 / w5: the AnimationPlayer SoA
// columns (clips / times / weights / speeds) became variable `array<T>` when the
// fixed 4-slot cap was retired (w4). Variable columns are set field-by-field
// (release-then-alloc per field, plan D-5), so the ECS layer cannot cross-check
// that the four parallel columns stay length-synced. advanceAnimationPlayer
// validates the four lengths once per row at its evaluation entry (the single
// chokepoint, D-5) and rejects a mismatch with the structured error below rather
// than silently zero-padding or truncating (requirements AC-11).

// -- AnimationPlayerSlotLengthMismatchError --------------------------------------

/**
 * Detail for `'animation-player-slot-length-mismatch'`.
 *
 * Carries the observed length of each of the four parallel SoA columns so an
 * AI consumer can see which column desynced without parsing prose.
 */
export interface AnimationPlayerSlotLengthMismatchDetail {
  readonly entity: number;
  readonly clips: number;
  readonly times: number;
  readonly weights: number;
  readonly speeds: number;
}

/**
 * Structured error for AnimationPlayer parallel-column length disagreement.
 *
 * Emitted at advanceAnimationPlayer's evaluation entry when an entity's
 * `clips` / `times` / `weights` / `speeds` columns do not all share the same
 * length. Four-field surface (mirrors the errors/skin.ts convention):
 *   - `.code = 'animation-player-slot-length-mismatch'`
 *   - `.expected` -- clips/times/weights/speeds share one length
 *   - `.hint` -- write all four columns length-synced on every AnimationPlayer
 *     write (variable columns do not tail-pad a short write)
 *   - `.detail = { entity, clips, times, weights, speeds }`
 */
export class AnimationPlayerSlotLengthMismatchError extends Error {
  readonly code = 'animation-player-slot-length-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AnimationPlayerSlotLengthMismatchDetail;

  constructor(detail: AnimationPlayerSlotLengthMismatchDetail) {
    const { entity, clips, times, weights, speeds } = detail;
    const expected = 'AnimationPlayer clips/times/weights/speeds columns share one length';
    const hint = `entity ${entity} AnimationPlayer columns are length-desynced (clips=${clips}, times=${times}, weights=${weights}, speeds=${speeds}); write all four parallel columns at the same length on every AnimationPlayer write -- a variable array<T> column does not tail-pad a short write`;
    super(
      `AnimationPlayer slot length mismatch on entity ${entity}: clips=${clips}, times=${times}, weights=${weights}, speeds=${speeds}`,
    );
    this.name = 'AnimationPlayerSlotLengthMismatchError';
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

// -- AnimationPlayerErrorCode / AnimationPlayerError closed unions ----------------

/**
 * Closed union of AnimationPlayer-cluster error codes. AI users perform
 * exhaustive `switch (err.code)` without default; TS guards completeness.
 */
export type AnimationPlayerErrorCode = 'animation-player-slot-length-mismatch';

/**
 * Closed union of the AnimationPlayer-cluster structured error classes, each
 * carrying an `AnimationPlayerErrorCode` discriminant on `.code`.
 */
export type AnimationPlayerError = AnimationPlayerSlotLengthMismatchError;
