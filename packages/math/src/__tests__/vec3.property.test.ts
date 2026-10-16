// vec3.property.test.ts — fast-check property tests (M5 / T-031, AC-11)
//
// Category coverage:
//   - normalize idempotence ×2: |n(v)|≈1, n(n(v))≈n(v)
//   - identity ×1: v + 0 ≈ v (vec3.add identity)
//
// Total cases: 3. numRuns defaults to 100 (D-P5); the PROPERTY_NUM_RUNS env can override to 1000 (nightly).
// Degenerate input: normalize takes nonZeroVec3Arb (the zero vector is already mapper-repaired to [1,0,0]
// to avoid ε comparisons hitting NaN).
//
// Related: requirements §AC-11; plan-strategy D-P5; wiki/fast-check-property-test §5.4.

import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';
import * as vec3 from '../vec3';
import { EPS_F32, nonZeroVec3Arb, vec3Arb } from './_arbs';

// numRuns defaults to 100; nightly overrides to 1000 via env (D-P5).
// process.env is read via globalThis to avoid pulling in the @types/node devDep (AC-16 / D-P13).
const NUM_RUNS = Number.parseInt(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.PROPERTY_NUM_RUNS ?? '100',
  10,
);

describe('vec3 property: normalize idempotence', () => {
  test.prop({ v: nonZeroVec3Arb() }, { numRuns: NUM_RUNS })(
    '|normalize(v)| ≈ 1 (v non-zero)',
    ({ v }) => {
      const out = vec3.create();
      vec3.normalize(out, v);
      const len = Math.hypot(out[0] as number, out[1] as number, out[2] as number);
      // one sqrt + one div, wiki §4.4 recommends 1e-5
      return Math.abs(len - 1) < EPS_F32;
    },
  );

  test.prop({ v: nonZeroVec3Arb() }, { numRuns: NUM_RUNS })(
    'normalize(normalize(v)) ≈ normalize(v) (idempotent)',
    ({ v }) => {
      const n1 = vec3.create();
      vec3.normalize(n1, v);
      const n2 = vec3.create();
      vec3.normalize(n2, n1);
      // accumulated error of two normalizations stays within 1e-6
      return (
        Math.abs((n1[0] as number) - (n2[0] as number)) < 1e-6 &&
        Math.abs((n1[1] as number) - (n2[1] as number)) < 1e-6 &&
        Math.abs((n1[2] as number) - (n2[2] as number)) < 1e-6
      );
    },
  );
});

describe('vec3 property: identity', () => {
  test.prop({ v: vec3Arb() }, { numRuns: NUM_RUNS })('v + 0 ≈ v (additive identity)', ({ v }) => {
    const zero = vec3.create();
    const out = vec3.create();
    vec3.add(out, v, zero);
    // adding 0 is strictly equal (no float rounding), but keep ε to guard the -0 / +0 corner
    return (
      Math.abs((out[0] as number) - (v[0] as number)) < EPS_F32 &&
      Math.abs((out[1] as number) - (v[1] as number)) < EPS_F32 &&
      Math.abs((out[2] as number) - (v[2] as number)) < EPS_F32
    );
  });
});

// avoid unused import warning when fc is not directly referenced in body
void fc;
// explicitly import expect to silence typecheck complaints under some vitest configs
void expect;
