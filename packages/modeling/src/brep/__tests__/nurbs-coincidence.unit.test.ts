import { describe, expect, it } from 'vitest';
import {
  type Box3,
  boxesOverlap,
  boxOf,
  coincidenceThreshold,
  inflate,
  mayCoincide,
} from '../nurbs-coincidence.ts';

describe('coincidenceThreshold', () => {
  it('is four times the branch bound when that exceeds the floor', () => {
    expect(coincidenceThreshold(1e-7, 1e-4)).toBeCloseTo(4e-4, 12);
  });

  it('never drops below the analytic tolerance floor', () => {
    expect(coincidenceThreshold(1e-5, 1e-9)).toBe(1e-5);
  });

  it('separates a boundary offset by 2c (not coincident) from c/2 (coincident)', () => {
    const c = coincidenceThreshold(1e-7, 1e-4);
    expect(c / 2 <= c).toBe(true);
    expect(2 * c <= c).toBe(false);
  });
});

describe('boxOf and inflate', () => {
  it('encloses every point and is undefined for none', () => {
    expect(boxOf([])).toBeUndefined();
    expect(
      boxOf([
        [1, -2, 3],
        [-1, 4, 0],
      ]),
    ).toEqual([
      [-1, -2, 0],
      [1, 4, 3],
    ]);
  });

  it('grows every side by the pad', () => {
    expect(
      inflate(
        [
          [0, 0, 0],
          [1, 1, 1],
        ],
        0.5,
      ),
    ).toEqual([
      [-0.5, -0.5, -0.5],
      [1.5, 1.5, 1.5],
    ]);
  });
});

describe('boxesOverlap and mayCoincide', () => {
  const unit: Box3 = [
    [0, 0, 0],
    [1, 1, 1],
  ];
  const far: Box3 = [
    [10, 10, 10],
    [11, 11, 11],
  ];
  const touching: Box3 = [
    [1, 0, 0],
    [2, 1, 1],
  ];

  it('rejects disjoint boxes and accepts touching ones', () => {
    expect(boxesOverlap(unit, far)).toBe(false);
    expect(boxesOverlap(unit, touching)).toBe(true);
  });

  it('skips SSI for an unrelated pair (falsifier F2)', () => {
    expect(mayCoincide(unit, far, 1e-7)).toBe(false);
  });

  it('lets a pair whose boxes overlap reach the march', () => {
    expect(mayCoincide(unit, touching, 1e-7)).toBe(true);
  });

  it('inflates by the march accuracy so a near-miss within tol/100 still passes', () => {
    const near: Box3 = [
      [1 + 1e-9, 0, 0],
      [2, 1, 1],
    ];
    expect(mayCoincide(unit, near, 1e-7)).toBe(true);
  });
});
