import { describe, expect, it } from 'vitest';
import { stationaryEma, temporalMetrics } from './gi-scene-temporal-metrics.fixture';

describe('GI temporal evidence metrics', () => {
  it('preserves a constant signed signal and its independent display scale', () => {
    const metrics = temporalMetrics(
      Array.from({ length: 4 }, () => [-1, 0, 2]),
      2,
    );
    expect(metrics.meanSeries).toEqual([1 / 3, 1 / 3, 1 / 3, 1 / 3]);
    expect(metrics.maxRange).toBe(0);
    expect(metrics.maxAdjacentRms).toBe(0);
    expect(metrics.maxLagTwoRms).toBe(0);
    expect(metrics.maxPeriodTwo).toBe(0);
    expect(metrics.maxHalfDrift).toBe(0);
  });

  it('exposes opposite-phase corruption even when every frame mean is identical', () => {
    const metrics = temporalMetrics(
      [
        [1, 0],
        [0, 1],
        [1, 0],
        [0, 1],
      ],
      1,
    );
    expect(metrics.meanSeries).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(metrics.maxRange).toBe(1);
    expect(metrics.maxAdjacentRms).toBe(1);
    expect(metrics.maxLagTwoRms).toBe(0);
    expect(metrics.maxPeriodTwo).toBe(1);
  });

  it('retains monotonic drift rather than classifying an even/odd difference alone', () => {
    const metrics = temporalMetrics([[1], [0.5], [0.25], [0.125]], 1);
    expect(metrics.maxRange).toBe(0.875);
    expect(metrics.maxAdjacentRms).toBeCloseTo(Math.sqrt(0.328125 / 3), 14);
    expect(metrics.maxLagTwoRms).toBeCloseTo(Math.sqrt(0.703125 / 2), 14);
    expect(metrics.maxPeriodTwo).toBe(0.3125);
    expect(metrics.maxHalfDrift).toBe(0.5625);
  });

  it('rejects missing, nonfinite or incompatible evidence instead of converting it to zero', () => {
    expect(() => temporalMetrics([], 1)).toThrow();
    expect(() => temporalMetrics([[1], [1], [1]], 1)).toThrow();
    expect(() => temporalMetrics([[1], [], [1], [1]], 1)).toThrow();
    expect(() => temporalMetrics([[1], [NaN], [1], [1]], 1)).toThrow();
    expect(() => temporalMetrics([[1], [1], [1], [1]], 0)).toThrow();
  });

  it('uses accepted updates and catches a one-observation counter error', () => {
    expect(stationaryEma(0, 1, 0.5, 0)).toBe(0);
    expect(stationaryEma(0, 1, 0.5, 3)).toBe(7 / 8);
    expect(stationaryEma(0, 1, 0.5, 4)).toBe(15 / 16);
    expect(Math.abs(stationaryEma(0, 1, 0.5, 4) - 7 / 8)).toBe(1 / 16);
    expect(stationaryEma(0, 1, 0, 1)).toBe(1);
    expect(() => stationaryEma(0, 1, 1, 3)).toThrow();
    expect(() => stationaryEma(0, 1, 0.5, 0.5)).toThrow();
  });
});
