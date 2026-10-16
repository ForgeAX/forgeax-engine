// @forgeax/engine-picking — pick error model (feat-20260529-picking-raycasting-screen-to-entity M3 / w9).
//
// PickError code owner + derived PickErrorCode projection. The screen-to-entity
// `pick(...)` free function returns `undefined` for the recoverable miss path (no ray
// hit) and surfaces a structured PickError ONLY for the one unrecoverable precondition
// failure: the supplied cameraEntity does not hold a `Camera` component, so no view /
// projection matrix can be built. Separating the error channel (PickError) from the
// normal miss channel (undefined) lets AI users branch with `if (hit)` for the common
// case and inspect `.code` for the precondition failure (charter P3).
//
// D-1: a NEW closed union rather than reusing RuntimeErrorCode. RuntimeErrorCode's 8
// members are all render / skin / shadow domain; folding a picking precondition into it
// would dilute its semantic focus. A dedicated single-member union keeps the picking
// error surface cohesive and additively evolvable (AGENTS.md Error model minor add-only).
//
// Related: requirements AC-11 (structured error signal) + AC-13 (closed-union SSOT);
//          plan-strategy D-1; plan-tasks.json w9 acceptanceCheck; charter P3.

/**
 * Detail for the `PickError` camera-component-missing code.
 *
 * Carries the offending camera entity (packed `Entity` u32) so AI consumers can read
 * `.detail.cameraEntity` by property access (charter P4) — no string parsing of the
 * human-facing message.
 */
export interface PickCameraMissingDetail {
  readonly cameraEntity: number;
}

/**
 * Structured error for the picking precondition failure: the supplied `cameraEntity`
 * does not hold a `Camera` component, so `pick()` cannot build the view / projection
 * matrices needed to unproject the screen coordinate.
 *
 * Three-field structured surface per the AGENTS.md error model + `.detail`:
 *   - `.code = 'camera-component-missing'` (closed `PickErrorCode`)
 *   - `.expected` — the expected precondition (camera entity carries a `Camera`)
 *   - `.hint` — an actionable `world.set` recovery directive
 *   - `.detail = { cameraEntity }` — the offending entity (charter P4)
 *
 * Surfaced (not the normal miss path): a no-hit ray returns `undefined` from `pick()`;
 * this error is reserved for the unrecoverable precondition (charter P3 explicit failure,
 * separate channel from the recoverable miss).
 */
export class PickError extends Error {
  readonly code = 'camera-component-missing';
  readonly expected: string;
  readonly hint: string;
  readonly detail: PickCameraMissingDetail;

  constructor(cameraEntity: number) {
    const expected = 'cameraEntity holds a Camera component';
    const hint =
      `cameraEntity ${cameraEntity} has no Camera component; spawn or attach one before ` +
      'picking, e.g. world.set(cameraEntity, Camera, { fov: Math.PI / 4, aspect, near, far })';
    super(`pick: cameraEntity ${cameraEntity} has no Camera component`);
    this.name = 'PickError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { cameraEntity };
  }
}

/**
 * Closed union of picking precondition error codes, derived from the PickError owner.
 *
 * AI users perform exhaustive `switch (err.code)` without a default; TS guards completeness.
 */
export type PickErrorCode = PickError['code'];
