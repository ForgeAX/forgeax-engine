// _fixtures.ts — reversed-Z double-precision reference matrices + projection-correctness probe table (T-019, AC-05)
//
// Reference SSOT: `.forgeax-harness/knowledge-base/wiki/reversed-z-projection.md` §7.2 / §7.3 / §7.4.
// Numbers are computed in IEEE-754 float64 (cross-checked against Python's `math` stdlib);
// this library's Float32Array implementation matches within 1e-5 tolerance.
//
// Related: requirements §AC-05 reversed-Z fixture error ≤ 1e-5;
//          research §Finding 6.2 double-precision reference fixture (copied verbatim);
//          wiki/reversed-z-projection.md §7.2 finite + §7.3 infinite + §7.4 projection probes.

/** AC-05 fixed input: fovy=π/4, aspect=16/9, near=0.1, far=100. */
export const PERSPECTIVE_REVERSE_Z_FINITE_INPUT = {
  fovy: Math.PI / 4,
  aspect: 16 / 9,
  near: 0.1,
  far: 100,
} as const;

/**
 * Finite reversed-Z expected matrix (column-major 16 elements, double-precision reference).
 *
 * Numeric derivation:
 *   m[0]  = (1 / tan(π/8)) / (16/9)         = 1.357995128834866
 *   m[5]  = 1 / tan(π/8)                    = 2.414213562373095
 *   m[10] = near / (far - near) = 0.1 / 99.9 = 0.001001001001001001
 *   m[11] = -1
 *   m[14] = near * far / (far - near)        = 0.10010010010010009
 *   m[15] = 0
 */
export const PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED: ReadonlyArray<number> = Object.freeze([
  1.357995128834866,
  0,
  0,
  0, // col 0
  0,
  2.414213562373095,
  0,
  0, // col 1
  0,
  0,
  0.001001001001001001,
  -1, // col 2
  0,
  0,
  0.10010010010010009,
  0, // col 3
]);

/**
 * Infinite reversed-Z expected matrix (fovy=π/4, aspect=16/9, near=0.1, far=Infinity).
 *
 * lim(f→∞) m[10] = 0; lim(f→∞) m[14] = near = 0.1.
 */
export const PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED: ReadonlyArray<number> = Object.freeze([
  1.357995128834866,
  0,
  0,
  0, // col 0
  0,
  2.414213562373095,
  0,
  0, // col 1
  0,
  0,
  0,
  -1, // col 2
  0,
  0,
  0.1,
  0, // col 3
]);

/**
 * Projection-correctness check (reversed-Z finite, near=0.1, far=100):
 * feed z_eye into mat4.perspectiveReverseZ and the table below should produce ndc_z.
 *
 * Derivation: p_clip = M @ [0, 0, z_eye, 1]^T; ndc_z = p_clip[2] / p_clip[3].
 *
 * From wiki §7.4 table (n=0.1, f=100):
 *   z_eye=-0.1   (near) → ndc_z = 1.0
 *   z_eye=-1.0          → ndc_z = 0.09909909909909909
 *   z_eye=-10.0         → ndc_z = 0.009009009009009009
 *   z_eye=-100.0 (far)  → ndc_z = 0.0
 */
export const REVERSE_Z_PROJECTION_PROBES_FINITE: ReadonlyArray<{ z_eye: number; ndc_z: number }> =
  Object.freeze([
    { z_eye: -0.1, ndc_z: 1.0 },
    { z_eye: -1.0, ndc_z: 0.09909909909909909 },
    { z_eye: -10.0, ndc_z: 0.009009009009009009 },
    { z_eye: -100.0, ndc_z: 0.0 },
  ]);

/**
 * Projection-correctness check (reversed-Z infinite, near=0.1, far=Infinity):
 *
 * From wiki §7.4 table: infinite-far yields ndc_z = -near / z_eye = n / |z_eye| for any z_eye < 0.
 *   z_eye=-0.1   (near)              → ndc_z = 1.0
 *   z_eye=-1.0                       → ndc_z = 0.1
 *   z_eye=-10.0                      → ndc_z = 0.01
 *   z_eye=-100.0                     → ndc_z = 0.001
 *   z_eye=-10000.0 (far frustum out) → ndc_z = 1e-5
 */
export const REVERSE_Z_PROJECTION_PROBES_INFINITE: ReadonlyArray<{
  z_eye: number;
  ndc_z: number;
}> = Object.freeze([
  { z_eye: -0.1, ndc_z: 1.0 },
  { z_eye: -1.0, ndc_z: 0.1 },
  { z_eye: -10.0, ndc_z: 0.01 },
  { z_eye: -100.0, ndc_z: 0.001 },
  { z_eye: -10000.0, ndc_z: 1e-5 },
]);

/**
 * AC-05 tolerance: vitest `toBeCloseTo(expected, decimals)` with 5 decimals → ≤ 0.5e-5;
 * float32 arithmetic stays within this tolerance vs the float64 reference.
 */
export const REVERSE_Z_FIXTURE_TOLERANCE = 5;
