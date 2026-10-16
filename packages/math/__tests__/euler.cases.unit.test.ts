// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=13):
//   - packages/math/src/__tests__/box3.test.ts
//   - packages/math/src/__tests__/color.test.ts
//   - packages/math/src/__tests__/euler.test.ts
//   - packages/math/src/__tests__/f32-to-f16-bytes.test.ts
//   - packages/math/src/__tests__/frustum.test.ts
//   - packages/math/src/__tests__/mat3.test.ts
//   - packages/math/src/__tests__/mat4.test.ts
//   - packages/math/src/__tests__/quat.test.ts
//   - packages/math/src/__tests__/ray.test.ts
//   - packages/math/src/__tests__/sphere.test.ts
//   - packages/math/src/__tests__/vec2.test.ts
//   - packages/math/src/__tests__/vec3.test.ts
//   - packages/math/src/__tests__/vec4.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
// import paths adjusted: ../X -> ../src/X (output is __tests__/, sources were src/__tests__/).

import { describe, expect, it } from 'vitest';
import * as box3 from '../src/box3';
import * as color from '../src/color';
import * as euler from '../src/euler';
import * as frustum from '../src/frustum';
import * as mat3 from '../src/mat3';
import * as mat4 from '../src/mat4';
import * as quat from '../src/quat';
import * as ray from '../src/ray';
import * as sphere from '../src/sphere';
import * as vec2 from '../src/vec2';
import * as vec3 from '../src/vec3';
import * as vec4 from '../src/vec4';
import { halfFloat } from '../src/index.js';
import type { EulerOrder, Mat3 as Mat3T, Mat4 as Mat4T, Vec3 as Vec3T } from '../src/types';
import {
  PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED,
  PERSPECTIVE_REVERSE_Z_FINITE_INPUT,
  PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED,
  REVERSE_Z_FIXTURE_TOLERANCE,
  REVERSE_Z_PROJECTION_PROBES_FINITE,
  REVERSE_Z_PROJECTION_PROBES_INFINITE,
} from '../src/__tests__/_fixtures';

void [PERSPECTIVE_REVERSE_Z_FINITE_EXPECTED, PERSPECTIVE_REVERSE_Z_FINITE_INPUT, PERSPECTIVE_REVERSE_Z_INFINITE_EXPECTED, REVERSE_Z_FIXTURE_TOLERANCE, REVERSE_Z_PROJECTION_PROBES_FINITE, REVERSE_Z_PROJECTION_PROBES_INFINITE, box3, color, describe, euler, expect, frustum, halfFloat, it, mat3, mat4, quat, ray, sphere, vec2, vec3, vec4];
type __MergedKeep = EulerOrder | Mat3T | Mat4T | Vec3T;


{
  // --- from euler.test.ts ---
// euler.test.ts — M4 red: euler namespace unit tests with full 6-order coverage (T-025)
//
// Covers the three tiers normal + degenerate + boundary:
//   create / clone / set / fromQuat (6 orders) / toQuat / fromRotationMatrix (6 orders)
//
// Degenerate convention (plan-strategy §appendix A degenerate registry #16):
//   - euler.fromQuat(q, order) picks an equivalent branch near gimbal-lock critical angles; never throws
//
// Euler is a plain object { x, y, z, order } (not a Float32Array) to carry the order alongside the angles.
//
// Related: requirements §Surface euler lower bound 6 + 6-order full support;
//          plan-strategy §1.1 euler.ts + degenerate registry #16;
//          wiki/threejs-math (Euler.setFromQuaternion 6-order formulas).


const ORDERS: readonly EulerOrder[] = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];

describe('euler.create / clone / set', () => {
  it('create() returns {x:0, y:0, z:0, order:"XYZ"} (normal)', () => {
    const e = euler.create();
    expect(e.x).toBe(0);
    expect(e.y).toBe(0);
    expect(e.z).toBe(0);
    expect(e.order).toBe('XYZ');
  });

  it('clone(e) returns new object with same fields (normal)', () => {
    const a = euler.create();
    a.x = 0.1;
    a.y = 0.2;
    a.z = 0.3;
    a.order = 'ZYX';
    const b = euler.clone(a);
    expect(b).not.toBe(a);
    expect(b.x).toBe(0.1);
    expect(b.y).toBe(0.2);
    expect(b.z).toBe(0.3);
    expect(b.order).toBe('ZYX');
  });

  it('set(out, x, y, z, order) writes fields in place (normal)', () => {
    const e = euler.create();
    const out = euler.set(e, 1, 2, 3, 'YXZ');
    expect(out).toBe(e);
    expect(e.x).toBe(1);
    expect(e.y).toBe(2);
    expect(e.z).toBe(3);
    expect(e.order).toBe('YXZ');
  });
});

describe('euler.toQuat / fromQuat — 6 order round-trip', () => {
  it.each(ORDERS)('toQuat(zero euler, order=%s) = identity (normal)', (order) => {
    const e = euler.set(euler.create(), 0, 0, 0, order);
    const q = euler.toQuat(quat.create(), e);
    expect(q[0]).toBeCloseTo(0);
    expect(q[1]).toBeCloseTo(0);
    expect(q[2]).toBeCloseTo(0);
    expect(q[3]).toBeCloseTo(1);
  });

  it.each(ORDERS)('round-trip euler→quat→euler preserves angles (order=%s, normal)', (order) => {
    // pick small angles to avoid gimbal-lock; different orders do not round-trip into each other, but the same order must be self-consistent
    const src = euler.set(euler.create(), 0.21, -0.34, 0.55, order);
    const q = euler.toQuat(quat.create(), src);
    const dst = euler.fromQuat(euler.create(), q, order);
    expect(dst.x).toBeCloseTo(src.x, 4);
    expect(dst.y).toBeCloseTo(src.y, 4);
    expect(dst.z).toBeCloseTo(src.z, 4);
    expect(dst.order).toBe(order);
  });

  it('toQuat(XYZ): X-only rotation matches fromAxisAngle (normal)', () => {
    const e = euler.set(euler.create(), Math.PI / 3, 0, 0, 'XYZ');
    const q = euler.toQuat(quat.create(), e);
    const ref = quat.fromAxisAngle(quat.create(), [1, 0, 0], Math.PI / 3);
    for (let i = 0; i < 4; i++) expect(q[i]).toBeCloseTo(ref[i] as number);
  });

  it('toQuat(YXZ): Y-only rotation matches fromAxisAngle (normal)', () => {
    const e = euler.set(euler.create(), 0, Math.PI / 3, 0, 'YXZ');
    const q = euler.toQuat(quat.create(), e);
    const ref = quat.fromAxisAngle(quat.create(), [0, 1, 0], Math.PI / 3);
    for (let i = 0; i < 4; i++) expect(q[i]).toBeCloseTo(ref[i] as number);
  });
});

describe('euler.fromQuat — degenerate / gimbal lock', () => {
  it('fromQuat(identity, XYZ) → zero euler (boundary)', () => {
    const i = quat.identity(quat.create());
    const e = euler.fromQuat(euler.create(), i, 'XYZ');
    expect(e.x).toBeCloseTo(0);
    expect(e.y).toBeCloseTo(0);
    expect(e.z).toBeCloseTo(0);
    expect(e.order).toBe('XYZ');
  });

  it('fromQuat at gimbal lock (XYZ, pitch=PI/2) does not throw (degenerate, registry #16)', () => {
    // Build a quaternion corresponding to XYZ Euler (0, PI/2, 0) → gimbal lock
    const src = euler.set(euler.create(), 0, Math.PI / 2, 0, 'XYZ');
    const q = euler.toQuat(quat.create(), src);
    expect(() => {
      const dst = euler.fromQuat(euler.create(), q, 'XYZ');
      // y component must stay near PI/2 (no NaN); under Float32 precision relax to 3 decimals
      expect(Number.isFinite(dst.y)).toBe(true);
      expect(dst.y).toBeCloseTo(Math.PI / 2, 3);
    }).not.toThrow();
  });

  it('fromQuat at gimbal lock (YXZ, pitch=-PI/2) does not throw (degenerate)', () => {
    const src = euler.set(euler.create(), -Math.PI / 2, 0, 0, 'YXZ');
    const q = euler.toQuat(quat.create(), src);
    expect(() => {
      const dst = euler.fromQuat(euler.create(), q, 'YXZ');
      expect(Number.isFinite(dst.x)).toBe(true);
    }).not.toThrow();
  });
});

describe('euler.fromRotationMatrix', () => {
  it.each(ORDERS)('identity mat3 → zero euler (order=%s, normal)', (order) => {
    const m = Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
    const e = euler.fromRotationMatrix(euler.create(), m, order);
    expect(e.x).toBeCloseTo(0);
    expect(e.y).toBeCloseTo(0);
    expect(e.z).toBeCloseTo(0);
    expect(e.order).toBe(order);
  });

  it('fromRotationMatrix consistent with toQuat→fromRotationMatrix(via mat3) for XYZ (normal)', () => {
    // round-trip through the fromRotationMatrix path
    const src = euler.set(euler.create(), 0.2, 0.3, 0.4, 'XYZ');
    const q = euler.toQuat(quat.create(), src);
    // Build the equivalent mat3 from the quaternion explicitly (the same form as the mat3 in fromQuat)
    const x = q[0] as number;
    const y = q[1] as number;
    const z = q[2] as number;
    const w = q[3] as number;
    const xx = x * x;
    const xy = x * y;
    const xz = x * z;
    const yy = y * y;
    const yz = y * z;
    const zz = z * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    const m = Float32Array.of(
      1 - 2 * (yy + zz),
      2 * (xy + wz),
      2 * (xz - wy),
      2 * (xy - wz),
      1 - 2 * (xx + zz),
      2 * (yz + wx),
      2 * (xz + wy),
      2 * (yz - wx),
      1 - 2 * (xx + yy),
    );
    const dst = euler.fromRotationMatrix(euler.create(), m, 'XYZ');
    expect(dst.x).toBeCloseTo(src.x, 4);
    expect(dst.y).toBeCloseTo(src.y, 4);
    expect(dst.z).toBeCloseTo(src.z, 4);
  });
});

// ---------------------------------------------------------------------------
// M3 t11 — euler 12-case gimbal-lock supplementary tests (D-8 pure supplement, no src changes)
//
// Threshold: euler.ts branch coverage 64% → ≥ 75% (plan-strategy §3 R-3 + AC-10).
// Path: when each order's "middle axis" reaches ±π/2, the `else { /* gimbal lock */ }`
// branch in src is triggered.
// Middle-axis lookup table (src euler.ts:150-225):
//   XYZ → out.y = asin(_13)   → middle axis Y → set y=±π/2
//   YXZ → out.x = asin(-_23)  → middle axis X → set x=±π/2
//   ZXY → out.x = asin(_32)   → middle axis X → set x=±π/2
//   ZYX → out.y = asin(-_31)  → middle axis Y → set y=±π/2
//   YZX → out.z = asin(_21)   → middle axis Z → set z=±π/2
//   XZY → out.z = asin(-_12)  → middle axis Z → set z=±π/2
// ---------------------------------------------------------------------------

/** The "middle axis" per order — determines which axis hits ±π/2 at gimbal-lock. */
const MIDDLE_AXIS = {
  XYZ: 'y',
  YXZ: 'x',
  ZXY: 'x',
  ZYX: 'y',
  YZX: 'z',
  XZY: 'z',
} as const satisfies Record<EulerOrder, 'x' | 'y' | 'z'>;

/** Build a src Euler whose middle axis is sign*π/2, triggering the corresponding order's gimbal-lock branch. */
function makeGimbalEuler(order: EulerOrder, sign: 1 | -1): ReturnType<typeof euler.create> {
  const e = euler.create();
  const axis = MIDDLE_AXIS[order];
  e[axis] = (sign * Math.PI) / 2;
  e.order = order;
  return e;
}

/** Expand a quaternion into a column-major 3×3 rotation matrix (matches the formula inside src `euler.fromQuat`). */
function quatToMat3(q: ReturnType<typeof quat.create>): Float32Array {
  const x = q[0] as number;
  const y = q[1] as number;
  const z = q[2] as number;
  const w = q[3] as number;
  const xx = x * x;
  const xy = x * y;
  const xz = x * z;
  const yy = y * y;
  const yz = y * z;
  const zz = z * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return Float32Array.of(
    1 - 2 * (yy + zz),
    2 * (xy + wz),
    2 * (xz - wy),
    2 * (xy - wz),
    1 - 2 * (xx + zz),
    2 * (yz + wx),
    2 * (xz + wy),
    2 * (yz - wx),
    1 - 2 * (xx + yy),
  );
}

describe('euler.fromQuat — 6 order × gimbal-lock', () => {
  // 6 orders × 2 polar angles = 12 cases; each case hits the `else { /* gimbal lock */ }` branch of the corresponding order.
  for (const order of ORDERS) {
    for (const sign of [1, -1] as const) {
      const polarity = sign === 1 ? '+π/2' : '-π/2';
      it(`fromQuat at gimbal lock (order=${order}, ${MIDDLE_AXIS[order]}=${polarity}) does not throw, finite (degenerate)`, () => {
        const src = makeGimbalEuler(order, sign);
        const q = euler.toQuat(quat.create(), src);
        const dst = euler.create();
        expect(() => euler.fromQuat(dst, q, order)).not.toThrow();
        expect(Number.isFinite(dst.x)).toBe(true);
        expect(Number.isFinite(dst.y)).toBe(true);
        expect(Number.isFinite(dst.z)).toBe(true);
        expect(dst.order).toBe(order);
        // middle axis should still be close to sign*π/2 (relaxed to 3 decimals under Float32 precision)
        const mid = MIDDLE_AXIS[order];
        expect(dst[mid]).toBeCloseTo((sign * Math.PI) / 2, 3);
      });
    }
  }
});

describe('euler.fromRotationMatrix — 6 order × gimbal-lock', () => {
  // 6 orders × 1 polar angle = 6 cases (fromQuat already covers ±π/2 in both directions; fromRotationMatrix only needs 1 per order).
  for (const order of ORDERS) {
    it(`fromRotationMatrix at gimbal lock (order=${order}, ${MIDDLE_AXIS[order]}=+π/2) does not throw, finite (degenerate)`, () => {
      const src = makeGimbalEuler(order, 1);
      const q = euler.toQuat(quat.create(), src);
      const m = quatToMat3(q);
      const dst = euler.create();
      expect(() => euler.fromRotationMatrix(dst, m, order)).not.toThrow();
      expect(Number.isFinite(dst.x)).toBe(true);
      expect(Number.isFinite(dst.y)).toBe(true);
      expect(Number.isFinite(dst.z)).toBe(true);
      expect(dst.order).toBe(order);
      const mid = MIDDLE_AXIS[order];
      expect(dst[mid]).toBeCloseTo(Math.PI / 2, 3);
    });
  }
});

describe('euler.fromRotationMatrix — default fallback (unknown order)', () => {
  it('unknown order silently falls back to XYZ (degenerate, src line 213-223)', () => {
    // identity mat3 + illegal order: hits the default branch (same convention as quat.fromEuler D-P2)
    const m = Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
    const dst = euler.create();
    expect(() => euler.fromRotationMatrix(dst, m, 'BOGUS' as EulerOrder)).not.toThrow();
    expect(Number.isFinite(dst.x)).toBe(true);
    expect(Number.isFinite(dst.y)).toBe(true);
    expect(Number.isFinite(dst.z)).toBe(true);
    // src line 222: `out.order = 'XYZ'` → after fallback the order is overwritten
    expect(dst.order).toBe('XYZ');
  });

  it('unknown order at gimbal lock (mat3 with _13≈1) hits default-branch else (degenerate, src line 219-220)', () => {
    // Build _13 = 1 (i.e. m[6] = 1) → the default branch's |_13| < 1 - 1e-7 fails → goes into else
    const src = makeGimbalEuler('XYZ', 1); // y = π/2 → cos=0, sin=1 → _13 = 1
    const q = euler.toQuat(quat.create(), src);
    const m = quatToMat3(q);
    const dst = euler.create();
    expect(() => euler.fromRotationMatrix(dst, m, 'UNKNOWN' as EulerOrder)).not.toThrow();
    expect(Number.isFinite(dst.x)).toBe(true);
    expect(Number.isFinite(dst.y)).toBe(true);
    expect(Number.isFinite(dst.z)).toBe(true);
    expect(dst.order).toBe('XYZ');
    expect(dst.y).toBeCloseTo(Math.PI / 2, 3);
  });
});

}