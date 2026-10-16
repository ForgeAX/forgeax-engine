// _internal/epsilon.ts — EPS constant family SSOT (D-P14)
//
// Centralizes all numeric tolerances; prevents scattered hard-coded constants.
// Not exported through src/index.ts (D-P13 _internal does not leave the package);
// indirectly covered by the vec/mat/quat tests that consume it.
//
// Rationale:
//   - EPS_NORMALIZE: lengths below this are treated as zero vectors; normalize falls back to a zero
//     vector. 1e-12 follows the consensus of glam-rs and wgpu-matrix, avoiding single-precision
//     Float32 noise misjudgments.
//   - EPS_DET: threshold for declaring a determinant singular. 1e-8 leaves safe headroom over the
//     single-precision ULP near 1.0 (~1.19e-7) (research §Finding 4.2 ε-tolerance table).
//   - EPS_QUAT_PARALLEL: near-collinear input check for fromUnitVectors / slerp (D-P18).
//   - EPS_SLERP_DOT_LIMIT: slerp falls back to nlerp when |dot| ≥ 1-EPS, avoiding acos blowup (D-P6).
//
// Related: plan-strategy D-P14 EPS constants centralized; research §Finding 3 glam epsilon choice +
//          §Finding 4.2 ε-tolerance table.

/** Vector lengths below this value are treated as zero (normalize fall-back). */
export const EPS_NORMALIZE = 1e-12;

/** Matrix determinants below this value are treated as singular (invert falls back to identity, D-P1). */
export const EPS_DET = 1e-8;

/** Threshold for treating two unit vectors as nearly collinear / opposite (fromUnitVectors / slerp inputs). */
export const EPS_QUAT_PARALLEL = 1e-6;

/** In quat.slerp, |dot| above this value is treated as endpoint coincidence; falls back to nlerp (D-P6). */
export const EPS_SLERP_DOT_LIMIT = 1e-6;
