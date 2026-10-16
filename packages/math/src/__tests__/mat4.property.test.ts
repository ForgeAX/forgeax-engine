// mat4.property.test.ts — fast-check property tests (M5 / T-031, AC-11)
//
// Category coverage (4 cases / 3 categories):
//   - associativity ×1: (A·B)·C ≈ A·(B·C), numRuns:50 (single chained mul ~100ms)
//   - identity ×2: I·M ≈ M, M·I ≈ M
//   - invertibility ×1: M·M⁻¹ ≈ I (restricted to invertibleMat4Arb, TRS composition guards against singular)
//
// numRuns: default 100; chained-mul cases drop to 50 (D-P5 / wiki §7.3).
// EPS: mat4 single mul 1e-4 (EPS_MAT4_MUL); triple chained mul 1e-3 (EPS_MAT4_MUL3).
//
// Related: requirements §AC-11; plan-strategy D-P5; wiki/fast-check-property-test §5.1-§5.3.

import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import * as mat4 from '../mat4';
import type { Vec3 } from '../types';
import {
  EPS_F32,
  EPS_MAT4_MUL,
  EPS_MAT4_MUL3,
  invertibleMat4Arb,
  mat4Arb,
  unitVec3Arb,
  vec3Arb,
} from './_arbs';

// process.env is read via globalThis to avoid pulling in the @types/node devDep (AC-16 / D-P13).
const NUM_RUNS = Number.parseInt(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.PROPERTY_NUM_RUNS ?? '100',
  10,
);
// chained-mul cases drop to 1/2 numRuns, ~100ms × 50 = within 5s (vitest test timeout default)
const NUM_RUNS_TRIPLE = Math.max(10, Math.floor(NUM_RUNS / 2));

function mat4ApproxEq(a: Float32Array, b: Float32Array, eps: number): boolean {
  for (let i = 0; i < 16; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    const scale = Math.max(1, Math.abs(ai), Math.abs(bi));
    if (Math.abs(ai - bi) >= eps * scale) return false;
  }
  return true;
}

describe('mat4 property: associativity', () => {
  test.prop(
    { A: mat4Arb(), B: mat4Arb(), C: mat4Arb() },
    { numRuns: NUM_RUNS_TRIPLE, interruptAfterTimeLimit: 5000 },
  )('(A·B)·C ≈ A·(B·C)', ({ A, B, C }) => {
    const ab = mat4.create();
    mat4.multiply(ab, A, B);
    const left = mat4.create();
    mat4.multiply(left, ab, C);

    const bc = mat4.create();
    mat4.multiply(bc, B, C);
    const right = mat4.create();
    mat4.multiply(right, A, bc);

    return mat4ApproxEq(left, right, EPS_MAT4_MUL3);
  });
});

describe('mat4 property: identity', () => {
  test.prop({ M: mat4Arb() }, { numRuns: NUM_RUNS })('I · M ≈ M', ({ M }) => {
    const I = mat4.create();
    mat4.identity(I);
    const out = mat4.create();
    mat4.multiply(out, I, M);
    return mat4ApproxEq(out, M, EPS_MAT4_MUL);
  });

  test.prop({ M: mat4Arb() }, { numRuns: NUM_RUNS })('M · I ≈ M', ({ M }) => {
    const I = mat4.create();
    mat4.identity(I);
    const out = mat4.create();
    mat4.multiply(out, M, I);
    return mat4ApproxEq(out, M, EPS_MAT4_MUL);
  });
});

describe('mat4 property: invertibility', () => {
  test.prop({ M: invertibleMat4Arb() }, { numRuns: NUM_RUNS })(
    'M · invert(M) ≈ I (restricted to invertible TRS compositions)',
    ({ M }) => {
      const inv = mat4.create();
      mat4.invert(inv, M);
      const I = mat4.create();
      mat4.multiply(I, M, inv);
      const expected = mat4.create();
      mat4.identity(expected);
      // EPS slightly relaxed: TRS scale range [1e-2, 10] × invert error amplification
      return mat4ApproxEq(I, expected, 1e-2);
    },
  );
});

// M1 / t4 — mat4 transform 3-function property +6
//
// 6 cases / 2 per function:
//   - transformVec3: (1) chained composition transformVec3(B*A, v) ≈ transformVec3(B, transformVec3(A, v))
//                    (2) identity unit transformVec3(I, v) ≈ v
//   - transformPoint: (1) equivalent to transformVec3 on an affine m
//                    (2) translation independently testable: transformPoint(T, origin) = t
//   - transformDirection: (1) orthogonal matrices preserve unit length
//                        (2) equivalent to transformVec3 on a pure-rotation m
//
// numRuns: 100 default; EPS aligned with wiki §4.4 recommendation table; interruptAfterTimeLimit:5000.
//
// Related: requirements §3.3 property +8 mandate (mat4 contributes 6 cases) + §6 AC-11 ≥ 20;
//          research Finding 5 template table + plan-strategy §4.2 + §4.3 key test points table row 5.

function vec3ApproxEq(a: Float32Array, b: Float32Array, eps: number): boolean {
  for (let i = 0; i < 3; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    if (!Number.isFinite(ai) || !Number.isFinite(bi)) return false;
    const scale = Math.max(1, Math.abs(ai), Math.abs(bi));
    if (Math.abs(ai - bi) >= eps * scale) return false;
  }
  return true;
}

describe('mat4.transformVec3 property (t4)', () => {
  test.prop({ v: vec3Arb() }, { numRuns: NUM_RUNS })(
    'identity unit: transformVec3(I, v) ≈ v',
    ({ v }) => {
      const I = mat4.identity(mat4.create());
      const out = new Float32Array(3) as Vec3;
      mat4.transformVec3(out, I, v);
      return vec3ApproxEq(out, v, EPS_F32);
    },
  );

  test.prop(
    { A: invertibleMat4Arb(), B: invertibleMat4Arb(), v: vec3Arb() },
    { numRuns: NUM_RUNS, interruptAfterTimeLimit: 5000 },
  )(
    'chained composition: transformVec3(B*A, v) ≈ transformVec3(B, transformVec3(A, v))',
    ({ A, B, v }) => {
      const BA = mat4.create();
      mat4.multiply(BA, B, A);
      const left = new Float32Array(3) as Vec3;
      mat4.transformVec3(left, BA, v);
      const tmp = new Float32Array(3) as Vec3;
      mat4.transformVec3(tmp, A, v);
      const right = new Float32Array(3) as Vec3;
      mat4.transformVec3(right, B, tmp);
      return vec3ApproxEq(left, right, EPS_MAT4_MUL);
    },
  );
});

describe('mat4.transformPoint property (t4)', () => {
  test.prop({ M: invertibleMat4Arb(), v: vec3Arb() }, { numRuns: NUM_RUNS })(
    'equivalent to transformVec3 on an affine m (alias)',
    ({ M, v }) => {
      const a = new Float32Array(3) as Vec3;
      const b = new Float32Array(3) as Vec3;
      mat4.transformVec3(a, M, v);
      mat4.transformPoint(b, M, v);
      return vec3ApproxEq(a, b, EPS_F32);
    },
  );

  test.prop({ t: vec3Arb() }, { numRuns: NUM_RUNS })(
    'translation independently testable: transformPoint(T(t), origin) = t',
    ({ t }) => {
      const T = mat4.fromTranslation(mat4.create(), t);
      const origin = Float32Array.of(0, 0, 0);
      const out = new Float32Array(3) as Vec3;
      mat4.transformPoint(out, T, origin);
      return vec3ApproxEq(out, t, EPS_F32);
    },
  );
});

describe('mat4.transformDirection property (t4)', () => {
  test.prop({ axis: unitVec3Arb(), dir: unitVec3Arb() }, { numRuns: NUM_RUNS })(
    'orthogonal matrices preserve unit length: |transformDirection(R, dir)| ≈ 1',
    ({ axis, dir }) => {
      const R = mat4.fromRotation(mat4.create(), axis, 0.7);
      const out = new Float32Array(3) as Vec3;
      mat4.transformDirection(out, R, dir);
      const len = Math.hypot(out[0] as number, out[1] as number, out[2] as number);
      return Math.abs(len - 1) < EPS_F32 * 10;
    },
  );

  test.prop({ axis: unitVec3Arb(), dir: unitVec3Arb() }, { numRuns: NUM_RUNS })(
    'equivalent to transformVec3 on a pure-rotation m (normalize does not affect unit length)',
    ({ axis, dir }) => {
      const R = mat4.fromRotation(mat4.create(), axis, 0.5);
      const a = new Float32Array(3) as Vec3;
      const b = new Float32Array(3) as Vec3;
      mat4.transformVec3(a, R, dir);
      mat4.transformDirection(b, R, dir);
      return vec3ApproxEq(a, b, EPS_F32 * 10);
    },
  );
});

// G-4 — projectPoint duality with unproject (roadmap 2026-06-15 game-demo-engine-gaps)
//
// Two cases:
//   (1) intent-revealing alias: projectPoint(out, v, VP) ≡ transformVec3(out, VP, v)
//       — sanity check the wrapper does not introduce divergence vs the underlying op
//   (2) round-trip on a realistic view-projection (lookAt + perspective):
//       unproject(projectPoint(v, VP), invVP) ≈ v for v inside the frustum.
//       Restricted to in-frustum points — extreme invertibleMat4Arb matrices amplify
//       f32 error past any reasonable epsilon, and HUD anchoring only ever cares about
//       points the camera can actually see.
describe('mat4.projectPoint property (G-4 dual of unproject)', () => {
  test.prop({ VP: invertibleMat4Arb(), v: vec3Arb() }, { numRuns: NUM_RUNS })(
    'projectPoint(out, v, VP) ≡ transformVec3(out, VP, v)',
    ({ VP, v }) => {
      const a = new Float32Array(3) as Vec3;
      const b = new Float32Array(3) as Vec3;
      mat4.projectPoint(a, v, VP);
      mat4.transformVec3(b, VP, v);
      return vec3ApproxEq(a, b, EPS_F32);
    },
  );

  test.prop(
    {
      // sample world points roughly inside the frustum the VP below describes.
      v: fc
        .tuple(
          fc.float({ min: -2, max: 2, noNaN: true }),
          fc.float({ min: -2, max: 2, noNaN: true }),
          fc.float({ min: -8, max: -2, noNaN: true }),
        )
        .map(([x, y, z]) => Float32Array.of(x, y, z) as Vec3),
    },
    { numRuns: NUM_RUNS },
  )('round-trip on a realistic view-projection: unproject(projectPoint(v, VP)) ≈ v', ({ v }) => {
    const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 100);
    const VP = mat4.create();
    mat4.multiply(VP, proj, view);
    const invVP = mat4.create();
    mat4.invert(invVP, VP);

    const ndc = new Float32Array(3) as Vec3;
    mat4.projectPoint(ndc, v, VP);
    const back = new Float32Array(3) as Vec3;
    mat4.unproject(back, ndc, invVP);
    // round-trip across two w-divides + invert; relax to EPS_MAT4_MUL3 (1e-3).
    return vec3ApproxEq(back, v, EPS_MAT4_MUL3);
  });
});

void fc;
void expect;
