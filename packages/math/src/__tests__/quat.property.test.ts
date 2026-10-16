// quat.property.test.ts — fast-check property tests (M5 / T-031, AC-11)
//
// Category coverage (5 cases / 4 categories):
//   - identity ×1: q·1 = q (quat multiplicative identity)
//   - invertibility ×1: q·conjugate(q) ≈ identity (for unit quaternions, conjugate equals inverse)
//   - normalize idempotence ×1: |normalize(q)| ≈ 1
//   - slerp endpoints ×2: slerp(a,b,0) ≈ a, slerp(a,b,1) ≈ b
//
// quat equivalence: q ≡ -q (same rotation), so endpoint comparison uses |dot(a,b)| ≈ 1 (wiki §4.3).
//
// Related: requirements §AC-11; plan-strategy D-P5 / D-P6; wiki/fast-check-property-test §5.5.

import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import * as quat from '../quat';
import type { Vec3 } from '../types';
import { EPS_F32, EPS_QUAT, unitQuatArb, unitVec3Arb, vec3Arb, vec4Arb } from './_arbs';

// process.env is read via globalThis to avoid pulling in the @types/node devDep (AC-16 / D-P13).
const NUM_RUNS = Number.parseInt(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.PROPERTY_NUM_RUNS ?? '100',
  10,
);

/** quat equivalence comparison: |dot(a,b)| ≈ 1 (double cover q ≡ -q). */
function quatEquivalent(a: Float32Array, b: Float32Array, eps: number): boolean {
  const d =
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number) +
    (a[3] as number) * (b[3] as number);
  return Math.abs(Math.abs(d) - 1) < eps;
}

describe('quat property: identity', () => {
  test.prop({ q: unitQuatArb() }, { numRuns: NUM_RUNS })('q · identity ≈ q', ({ q }) => {
    const I = quat.create();
    quat.identity(I);
    const out = quat.create();
    quat.multiply(out, q, I);
    return quatEquivalent(out, q, EPS_QUAT);
  });
});

describe('quat property: invertibility', () => {
  test.prop({ q: unitQuatArb() }, { numRuns: NUM_RUNS })(
    'q · conjugate(q) ≈ identity (unit quaternion)',
    ({ q }) => {
      const c = quat.create();
      quat.conjugate(c, q);
      const out = quat.create();
      quat.multiply(out, q, c);
      const expected = quat.create();
      quat.identity(expected);
      return quatEquivalent(out, expected, EPS_QUAT);
    },
  );
});

describe('quat property: normalize idempotence', () => {
  test.prop({ raw: vec4Arb() }, { numRuns: NUM_RUNS })(
    '|normalize(q)| ≈ 1 (any non-zero quaternion)',
    ({ raw }) => {
      // Reuse vec4Arb as un-normalized quat material; the zero vector is mapper-repaired to identity
      const x = raw[0] as number;
      const y = raw[1] as number;
      const z = raw[2] as number;
      const w = raw[3] as number;
      const len2 = x * x + y * y + z * z + w * w;
      const src =
        len2 < 1e-12
          ? quat.identity(quat.create())
          : (Float32Array.of(x, y, z, w) as unknown as ReturnType<typeof quat.create>);
      const out = quat.create();
      quat.normalize(out, src);
      const len = Math.hypot(
        out[0] as number,
        out[1] as number,
        out[2] as number,
        out[3] as number,
      );
      return Math.abs(len - 1) < EPS_F32;
    },
  );
});

describe('quat property: slerp endpoints', () => {
  test.prop({ a: unitQuatArb(), b: unitQuatArb() }, { numRuns: NUM_RUNS })(
    'slerp(a, b, 0) ≈ a',
    ({ a, b }) => {
      const out = quat.create();
      quat.slerp(out, a, b, 0);
      return quatEquivalent(out, a, EPS_QUAT);
    },
  );

  test.prop({ a: unitQuatArb(), b: unitQuatArb() }, { numRuns: NUM_RUNS })(
    'slerp(a, b, 1) ≈ b',
    ({ a, b }) => {
      const out = quat.create();
      quat.slerp(out, a, b, 1);
      return quatEquivalent(out, b, EPS_QUAT);
    },
  );
});

// M1 / t5 — quat.transformVec3 property +2
//
// 2 cases:
//   - length preservation |q*v*q⁻¹| ≈ |v| (restricted to unitQuatArb, keeps q unit-length premise)
//   - identity unit transformVec3(quat.identity(), v) ≈ v
//
// numRuns: 100 default; EPS 1e-5; use the unitQuatArb factory to avoid random q triggering
// implicit-scale degeneracy (R-2 countermeasure).
//
// Related: requirements §3.3 property +8 (quat contributes 2 cases) + §6 AC-11;
//          research Finding 5 row 4 + Finding 3 (unit q length preservation 100%);
//          plan-strategy §3 R-2 + §4.3 key test points table row 4.

describe('quat.transformVec3 property (t5)', () => {
  test.prop({ q: unitQuatArb(), v: vec3Arb() }, { numRuns: NUM_RUNS })(
    'length preservation: |q · v · q⁻¹| ≈ |v| (q unit-length premise)',
    ({ q, v }) => {
      const out = new Float32Array(3) as Vec3;
      quat.transformVec3(out, q, v);
      const lenIn = Math.hypot(v[0] as number, v[1] as number, v[2] as number);
      const lenOut = Math.hypot(out[0] as number, out[1] as number, out[2] as number);
      // relative error: scale = max(1, lenIn)
      const scale = Math.max(1, lenIn);
      return Math.abs(lenOut - lenIn) < EPS_F32 * scale;
    },
  );

  test.prop({ v: unitVec3Arb() }, { numRuns: NUM_RUNS })(
    'identity unit: transformVec3(identity, v) ≈ v',
    ({ v }) => {
      const I = quat.identity(quat.create());
      const out = new Float32Array(3) as Vec3;
      quat.transformVec3(out, I, v);
      const dx = (out[0] as number) - (v[0] as number);
      const dy = (out[1] as number) - (v[1] as number);
      const dz = (out[2] as number) - (v[2] as number);
      return Math.abs(dx) < EPS_F32 && Math.abs(dy) < EPS_F32 && Math.abs(dz) < EPS_F32;
    },
  );
});

void fc;
void expect;
