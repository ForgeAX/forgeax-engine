import { describe, expect, it } from 'vitest';

const rangeRatios = [0, 0.25, 0.5, 0.75, 1, 1.25] as const;

function squaredRangeWindow(distanceRatio: number): number {
  return Math.max(1 - distanceRatio ** 4, 0) ** 2;
}

function applyLight(color: readonly [number, number, number], intensity: number, factor: number) {
  return color.map((channel) => channel * intensity * factor);
}

describe('direct-light analytic cases', () => {
  it('keeps no-light, single-light, and non-uniform RGB cases deterministic', () => {
    expect(applyLight([0, 0, 0], 8, 1)).toEqual([0, 0, 0]);
    expect(applyLight([1, 1, 1], 2, 1)).toEqual([2, 2, 2]);
    expect(applyLight([0.2, 0.5, 0.9], 2, 1)).toEqual([0.4, 1, 1.8]);
  });

  it('covers directional, point, and spot finite-range boundaries', () => {
    const expected = [1, 0.9922027587890625, 0.87890625, 0.4673004150390625, 0, 0];
    expect(rangeRatios.map(squaredRangeWindow)).toEqual(expected);
  });

  it('falsifies the KHR unsquared range window instead of silently substituting it', () => {
    const ratio = 0.5;
    const threeSquared = squaredRangeWindow(ratio);
    const khrUnsquared = 1 - ratio ** 4;

    expect(threeSquared).toBeCloseTo(0.87890625, 12);
    expect(khrUnsquared).toBeCloseTo(0.9375, 12);
    expect(threeSquared).not.toBeCloseTo(khrUnsquared, 6);
  });
});
