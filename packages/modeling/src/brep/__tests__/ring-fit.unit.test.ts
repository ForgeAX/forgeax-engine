import { describe, expect, it } from 'vitest';
import { curvePoint, type NurbsCurve } from '../../nurbs.ts';
import {
  measureRingFit,
  RING_CIRCLE,
  RING_FIT_SAFETY,
  ringCircleParam,
  ringTrimCurve,
} from '../ring-fit.ts';

const TWO_PI = 2 * Math.PI;

describe('rational circle parameter inverse', () => {
  it('recovers the circle angle from the parameter for ~200 angles, boundaries included', () => {
    const angles: number[] = [];
    for (let i = 0; i < 196; i++) angles.push((TWO_PI * i) / 196);
    for (let q = 0; q <= 4; q++) angles.push((q * Math.PI) / 2);
    angles.push(TWO_PI - 1e-12, 0, Math.PI / 4, (3 * Math.PI) / 4);
    let maxErr = 0;
    for (const theta of angles) {
      const u = ringCircleParam(theta);
      const p = curvePoint(RING_CIRCLE as NurbsCurve, u);
      const angle = Math.atan2(p[1], p[0]);
      const expected = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
      const got = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
      const err = Math.min(Math.abs(got - expected), TWO_PI - Math.abs(got - expected));
      maxErr = Math.max(maxErr, err);
    }
    expect(maxErr).toBeLessThan(1e-14);
  });

  it('maps quarter boundaries onto knot values 0, 1/4, 1/2, 3/4, 1', () => {
    for (let q = 0; q < 4; q++) {
      expect(ringCircleParam((q * Math.PI) / 2)).toBeCloseTo(q / 4, 15);
    }
    expect(ringCircleParam(TWO_PI - 1e-12)).toBeGreaterThan(0.999);
    expect(ringCircleParam(TWO_PI - 1e-12)).toBeLessThanOrEqual(1);
  });
});

/**
 * Per-rung u-error upper bounds over the 4x-denser sample set. Measured maxima: 1.34e-8, 5.60e-10,
 * 4.44e-12, 2.51e-14 for 1, 2, 4, 8 sub-intervals per quarter; each bound leaves about one decade.
 */
const U_ERROR_BOUND: readonly [number, number][] = [
  [1, 1e-7],
  [2, 1e-9],
  [4, 1e-11],
  [8, 1e-13],
];

describe('ring trim degree-7 knot refinement ladder', () => {
  it.each(U_ERROR_BOUND)('rung k=%i keeps the theta to u error under its bound', (k, bound) => {
    expect(measureRingFit(k).uError).toBeLessThan(bound);
  });

  it('the accepted trim meets the 3D margin tol * RING_FIT_SAFETY at the ring radius', () => {
    const radius = 0.7;
    const tol = 1e-9;
    const trim = ringTrimCurve(radius, tol, 0.5);
    expect(trim.ok).toBe(true);
    const { chordError } = measureRingFit(4);
    expect(radius * chordError).toBeLessThanOrEqual(tol * RING_FIT_SAFETY);
  });

  it('returns brep-tol-exceeded with the measured error when no rung meets the tolerance', () => {
    const r = ringTrimCurve(0.7, 1e-16, 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('model-partial');
      expect(r.error.detail).toMatchObject({ brep: 'brep-tol-exceeded', subdivisions: 8 });
      expect(r.error.detail).toHaveProperty('measured');
    }
  });
});
