// easing.test.ts — value tests for the easing namespace (solo round 20260713-233409)
//
// Regression guard for the friction that motivated the namespace: forgeax's math had no
// easing functions, so non-linear motion forced hand-rolling curves + the [0,1] clamp.
// These tests pin the polynomial curves and the ElasticInOut endpoint contract:
//   1. endpoints f(0)=0, f(1)=1,
//   2. input clamp: t<0 → 0, t>1 → 1 (saturate, not extrapolate),
//   3. symmetric midpoint f(0.5)=0.5,
//   4. exact polynomial match at sampled t,
//   5. monotonic non-decreasing on [0,1],
//   6. S-shape: below the diagonal early (f(0.25)<0.25), above it late (f(0.75)>0.75).

import { describe, expect, it } from 'vitest';
import { easing } from '../index';

const { cubicInOut, elasticInOut, smoothstep, smootherstep } = easing;

describe('easing.cubicInOut', () => {
  it('matches Bevy cubic in/out and clamps input', () => {
    expect(cubicInOut(-1)).toBe(0);
    expect(cubicInOut(0)).toBe(0);
    expect(cubicInOut(0.25)).toBeCloseTo(0.0625, 12);
    expect(cubicInOut(0.5)).toBeCloseTo(0.5, 12);
    expect(cubicInOut(0.75)).toBeCloseTo(0.9375, 12);
    expect(cubicInOut(1)).toBe(1);
    expect(cubicInOut(2)).toBe(1);
  });
});

describe('easing.smoothstep', () => {
  it('endpoints: f(0)=0, f(1)=1', () => {
    expect(smoothstep(0)).toBeCloseTo(0, 12);
    expect(smoothstep(1)).toBeCloseTo(1, 12);
  });

  it('clamps input to [0,1] (saturate, not extrapolate)', () => {
    expect(smoothstep(-2)).toBe(0);
    expect(smoothstep(5)).toBe(1);
  });

  it('symmetric midpoint f(0.5)=0.5', () => {
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12);
  });

  it('matches 3t² − 2t³ at sampled t', () => {
    for (const t of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
      expect(smoothstep(t)).toBeCloseTo(t * t * (3 - 2 * t), 12);
    }
  });

  it('monotonic non-decreasing on [0,1]', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = smoothstep(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('S-shape: slow-in below diagonal early, slow-out above late', () => {
    expect(smoothstep(0.25)).toBeLessThan(0.25);
    expect(smoothstep(0.75)).toBeGreaterThan(0.75);
  });
});

describe('easing.smootherstep', () => {
  it('endpoints: f(0)=0, f(1)=1', () => {
    expect(smootherstep(0)).toBeCloseTo(0, 12);
    expect(smootherstep(1)).toBeCloseTo(1, 12);
  });

  it('clamps input to [0,1]', () => {
    expect(smootherstep(-1)).toBe(0);
    expect(smootherstep(2)).toBe(1);
  });

  it('symmetric midpoint f(0.5)=0.5', () => {
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 12);
  });

  it('matches 6t⁵ − 15t⁴ + 10t³ at sampled t', () => {
    for (const t of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
      expect(smootherstep(t)).toBeCloseTo(6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3, 12);
    }
  });

  it('S-shape: even flatter endpoints than smoothstep near 0', () => {
    // smootherstep has a flatter start (zero 2nd derivative), so at a small t it eases
    // in LESS than smoothstep (stays closer to 0 longer).
    expect(smootherstep(0.15)).toBeLessThan(smoothstep(0.15));
    expect(smootherstep(0.25)).toBeLessThan(0.25);
    expect(smootherstep(0.75)).toBeGreaterThan(0.75);
  });
});

describe('easing.elasticInOut', () => {
  it('clamps and preserves exact endpoints', () => {
    expect(elasticInOut(-1)).toBe(0);
    expect(elasticInOut(0)).toBe(0);
    expect(elasticInOut(0.5)).toBeCloseTo(0.5, 12);
    expect(elasticInOut(1)).toBe(1);
    expect(elasticInOut(2)).toBe(1);
  });

  it('has the expected overshoot on both halves', () => {
    expect(elasticInOut(0.35)).toBeLessThan(0);
    expect(elasticInOut(0.65)).toBeGreaterThan(1);
  });
});
