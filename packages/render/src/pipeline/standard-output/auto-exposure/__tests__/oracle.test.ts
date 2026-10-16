import { describe, expect, it } from 'vitest';
import {
  adaptExposure,
  autoExposureTarget,
  bradfordAdaptD65,
  centerWeight,
  weightedLuminanceHistogram,
} from '../oracle';

describe('auto-exposure and color oracle', () => {
  it('uses time-based adaptation independent of frame rate', () => {
    const thirtyHz = Array.from({ length: 30 }, () => 1 / 30).reduce(
      (value, dt) => adaptExposure(value, 2, dt, 3, 1),
      1,
    );
    const sixtyHz = Array.from({ length: 60 }, () => 1 / 60).reduce(
      (value, dt) => adaptExposure(value, 2, dt, 3, 1),
      1,
    );
    expect(thirtyHz).toBeCloseTo(sixtyHz, 5);
    expect(adaptExposure(2, 1, 1 / 60, 0, 0)).toBe(2);
  });

  it('matches the fixed center weighting and rejects non-finite samples', () => {
    expect(centerWeight([1, 1], [3, 3])).toBe(3);
    expect(centerWeight([0, 0], [3, 3])).toBe(1);
    const histogram = weightedLuminanceHistogram(
      [
        [0.18, 0.18, 0.18, 1],
        [Number.NaN, 1, 1, 1],
        [0.18, 0.18, 0.18, 1],
        [0.18, 0.18, 0.18, 1],
      ],
      [2, 2],
      256,
    );
    expect(histogram.reduce((sum, value) => sum + value, 0)).toBe(6);
  });

  it('keeps edge and center weights exact on a non-4-divisible grid', () => {
    const sampleGrid = [3, 2] as const;
    const histogram = weightedLuminanceHistogram(
      [
        [1, 1, 1, 1],
        [Number.NaN, 1, 1, 1],
        [0.18, 0.18, 0.18, 1],
        [Number.POSITIVE_INFINITY, 1, 1, 1],
        [0.18, 0.18, 0.18, 1],
        [Number.NEGATIVE_INFINITY, 1, 1, 1],
      ],
      sampleGrid,
    );
    const expectedWeight =
      centerWeight([0, 0], sampleGrid) +
      centerWeight([2, 0], sampleGrid) +
      centerWeight([1, 1], sampleGrid);
    expect(histogram.reduce((sum, value) => sum + value, 0)).toBe(expectedWeight);
  });

  it('applies compensation and EV range before frame-rate-independent adaptation', () => {
    const histogram = weightedLuminanceHistogram(
      Array.from({ length: 4 }, () => [0.18, 0.18, 0.18, 1] as const),
      [2, 2],
    );
    const target = autoExposureTarget(histogram, 1, [-8, 8], 1);
    expect(target).toBeCloseTo(2, 1);
    expect(autoExposureTarget(histogram, 20, [-2, 2], 1)).toBeCloseTo(4, 6);
    expect(autoExposureTarget(histogram, Number.NaN, [-8, 8], 1)).toBe(1);
    expect(autoExposureTarget(histogram, 1, [8, -8], 1)).toBe(1);
    const thirtyHz = Array.from({ length: 30 }, () => 1 / 30).reduce(
      (value, dt) => adaptExposure(value, target, dt, 3, 1),
      1,
    );
    const sixtyHz = Array.from({ length: 60 }, () => 1 / 60).reduce(
      (value, dt) => adaptExposure(value, target, dt, 3, 1),
      1,
    );
    expect(thirtyHz).toBeCloseTo(sixtyHz, 5);
    expect(adaptExposure(2, target, 1 / 60, 0, 1)).toBe(2);
  });

  it('keeps D65 Bradford adaptation identity and alpha outside color math', () => {
    expect(bradfordAdaptD65([0.25, 0.5, 0.75], 6504)).toEqual([0.25, 0.5, 0.75]);
  });
});
