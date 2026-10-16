// _arbs.ts — fast-check arbitrary factories + ε-tolerance comparison helpers (M5 / T-031)
//
// Shared by the three property files vec3.property.test.ts / mat4.property.test.ts /
// quat.property.test.ts. The leading underscore prevents vitest's default glob
// `**/*.test.ts` from running this file as a test (source: wiki/fast-check-property-test §7.1).
//
// Design anchors:
//   - safeFloat: noNaN + noDefaultInfinity, prevents NaN from making ε comparisons
//     spuriously pass/fail (wiki §3.1 + §8 anti-pattern #1)
//   - vec3Arb / vec4Arb: same shape as the Float32Array.of branded factories (packages/math/src/vec3.ts)
//   - unitVec3Arb: spherical sampling, filter hit rate > 99% (len² > 1e-12 almost always)
//   - unitQuatArb: 4D-sphere Marsaglia / generic normalization + filter, 4D unit Hopf
//   - invertibleMat4Arb: composed from TRS rather than 16 random elements (wiki §3.3)
//   - approxEq / vec3ApproxEq / mat4ApproxEq / quatApproxEq: ε-tolerance helpers,
//     EPS chosen from wiki §4.4 recommendation table (annotated inline below)
//
// brand cast: this file lives under packages/math/src/__tests__/, which is inside
// lint-brand-cast.mjs's allow-list (the packages/math/src/ prefix is OK).
//
// Related: requirements §AC-11 property ≥ 12 / ≥ 5 categories / ≤ 4 per category;
//          plan-strategy D-P5 numRuns default 100;
//          wiki/fast-check-property-test §3 / §4 / §5 / §7.

import { fc } from '@fast-check/vitest';
import * as mat4 from '../mat4';
import type { Mat4, Quat, Vec3, Vec4 } from '../types';

// ---------- ε constants (wiki §4.4 recommendation table) ----------

/** Float32 single add/sub; ULP ≈ 1.19e-7, leaves an 8× margin. */
export const EPS_F32 = 1e-5;

/** Float32 mat4 × mat4: chained accumulation of 16 muls + 12 adds. */
export const EPS_MAT4_MUL = 1e-4;

/** Float32 mat4 × mat4 × mat4: associativity test accumulates 3 multiplications on each side. */
export const EPS_MAT4_MUL3 = 1e-3;

/** Quat slerp endpoint / single-step numeric path. */
export const EPS_QUAT = 1e-5;

// ---------- single-value generators ----------

/** General 32-bit safe scalar: noNaN + noDefaultInfinity, lies in [-1e3, 1e3]. */
export const safeFloat = (min = -1e3, max = 1e3): fc.Arbitrary<number> =>
  fc.float({
    noNaN: true,
    noDefaultInfinity: true,
    // fast-check 4.x: min/max must be 32-bit representable, otherwise it throws
    min: Math.fround(min),
    max: Math.fround(max),
  });

/** Safe scalar for matrix elements: [-10, 10], prevents mat4×mat4 element values from inflating ε. */
export const matFloat = (): fc.Arbitrary<number> =>
  fc.float({
    noNaN: true,
    noDefaultInfinity: true,
    min: Math.fround(-10),
    max: Math.fround(10),
  });

/** Scale component: keeps away from 0 to avoid singularities ([1e-2, 10] ∪ [-10, -1e-2]). */
export const nonZeroScale = (): fc.Arbitrary<number> =>
  fc.oneof(
    fc.float({
      noNaN: true,
      noDefaultInfinity: true,
      min: Math.fround(1e-2),
      max: Math.fround(10),
    }),
    fc.float({
      noNaN: true,
      noDefaultInfinity: true,
      min: Math.fround(-10),
      max: Math.fround(-1e-2),
    }),
  );

// ---------- Float32Array vectors ----------

/** Generic vec3: three independent safeFloat components. */
export const vec3Arb = (): fc.Arbitrary<Vec3> =>
  fc
    .tuple(safeFloat(), safeFloat(), safeFloat())
    .map(([x, y, z]) => Float32Array.of(x, y, z) as Vec3);

/** Generic vec4. */
export const vec4Arb = (): fc.Arbitrary<Vec4> =>
  fc
    .tuple(safeFloat(), safeFloat(), safeFloat(), safeFloat())
    .map(([x, y, z, w]) => Float32Array.of(x, y, z, w) as Vec4);

/** Non-zero vec3 (len² > 1e-6 to avoid normalize fall-back). */
export const nonZeroVec3Arb = (): fc.Arbitrary<Vec3> =>
  vec3Arb().map((v) => {
    const x = v[0] as number;
    const y = v[1] as number;
    const z = v[2] as number;
    const len2 = x * x + y * y + z * z;
    return len2 < 1e-6 ? (Float32Array.of(1, 0, 0) as Vec3) : v;
  });

/** Scale vector: each component nonZeroScale, used by TRS compose. */
export const scaleVec3Arb = (): fc.Arbitrary<Vec3> =>
  fc
    .tuple(nonZeroScale(), nonZeroScale(), nonZeroScale())
    .map(([x, y, z]) => Float32Array.of(x, y, z) as Vec3);

/** Unit vec3: normalized non-zero vec3. */
export const unitVec3Arb = (): fc.Arbitrary<Vec3> =>
  nonZeroVec3Arb().map((v) => {
    const x = v[0] as number;
    const y = v[1] as number;
    const z = v[2] as number;
    const inv = 1 / Math.hypot(x, y, z);
    return Float32Array.of(x * inv, y * inv, z * inv) as Vec3;
  });

// ---------- unit quaternion ----------

/** Unit quaternion: 4D-sphere sampling (filter hit rate ≈ 1 since random 4D points have len² > 1e-12). */
export const unitQuatArb = (): fc.Arbitrary<Quat> =>
  fc
    .tuple(safeFloat(-1, 1), safeFloat(-1, 1), safeFloat(-1, 1), safeFloat(-1, 1))
    .map(([x, y, z, w]) => {
      const len2 = x * x + y * y + z * z + w * w;
      if (len2 < 1e-12) return Float32Array.of(0, 0, 0, 1) as Quat;
      const inv = 1 / Math.sqrt(len2);
      return Float32Array.of(x * inv, y * inv, z * inv, w * inv) as Quat;
    });

// ---------- Mat4 ----------

/** Generic mat4: 16 independent elements ∈ [-10, 10], associativity / identity friendly. */
export const mat4Arb = (): fc.Arbitrary<Mat4> =>
  fc
    .array(matFloat(), { minLength: 16, maxLength: 16 })
    .map((arr) => Float32Array.from(arr) as Mat4);

/**
 * Invertible mat4: composed from TRS (translation × rotation × scale) so det ≠ 0 is guaranteed.
 * Random 16 elements are almost always singular, invert returns identity → invertibility test always fails.
 */
export const invertibleMat4Arb = (): fc.Arbitrary<Mat4> =>
  fc.tuple(vec3Arb(), unitQuatArb(), scaleVec3Arb()).map(([t, r, s]) => {
    const out = mat4.create();
    return mat4.compose(out, t, r, s);
  });
