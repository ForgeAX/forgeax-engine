import { describe, expect, it } from 'vitest';
import {
  frameTimes,
  intervalEnvelope,
  intervalUnion,
  percentile,
  timingStats,
} from '../replay/timing-stats';

describe('replay timing statistics', () => {
  it('counts overlapping and touching intervals once in the union', () => {
    const intervals = [
      { begin: 10, end: 20 },
      { begin: 0, end: 5 },
      { begin: 15, end: 30 },
      { begin: 30, end: 32 },
      { begin: 40, end: 41 },
    ];
    expect(intervalUnion(intervals)).toBe(5 + 22 + 1);
    expect(intervalEnvelope(intervals)).toBe(41);
    expect(frameTimes(intervals)).toEqual({ sum: 10 + 5 + 15 + 2 + 1, union: 28, envelope: 41 });
  });

  it('keeps a nested interval inside its parent', () => {
    expect(
      intervalUnion([
        { begin: 0, end: 100 },
        { begin: 10, end: 20 },
      ]),
    ).toBe(100);
  });

  it('ignores empty and inverted intervals', () => {
    const intervals = [
      { begin: 5, end: 5 },
      { begin: 9, end: 3 },
    ];
    expect(frameTimes(intervals)).toEqual({ sum: 0, union: 0, envelope: 0 });
    expect(frameTimes([])).toEqual({ sum: 0, union: 0, envelope: 0 });
  });

  it('uses nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.5)).toBe(10);
    expect(percentile(sorted, 0.95)).toBe(19);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 1)).toBe(20);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('summarizes values regardless of input order', () => {
    const stats = timingStats([4, 2, 8, 6]);
    expect(stats).toMatchObject({ count: 4, min: 2, p50: 4, p95: 8, max: 8, mean: 5 });
    expect(stats.stddev).toBeCloseTo(Math.sqrt(5));
    expect(timingStats([]).count).toBe(0);
    expect(timingStats([]).p50).toBeNaN();
  });
});
