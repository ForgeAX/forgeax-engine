import { describe, expect, it } from 'vitest';
import {
  bootstrapMedianInterval,
  driftStats,
  medianInterval,
  pairedDeltaVerdict,
} from '../replay/timing-confidence';

const flat = Array.from({ length: 40 }, (_, i) => 100 + ((i * 7) % 5) - 2);

describe('replay timing confidence', () => {
  it('brackets the median with order statistics and narrows with more samples', () => {
    const small = medianInterval(flat.slice(0, 10));
    const large = medianInterval(flat);
    expect(large.confidence).toBe(0.95);
    expect(large.low).toBeLessThanOrEqual(100);
    expect(large.high).toBeGreaterThanOrEqual(100);
    expect(large.width).toBeLessThanOrEqual(small.width);
  });

  it('spans min..max below six samples and is NaN when empty', () => {
    expect(medianInterval([3, 1, 2])).toMatchObject({ low: 1, high: 3, width: 2 });
    expect(Number.isNaN(medianInterval([]).width)).toBe(true);
  });

  it('bootstraps deterministically', () => {
    expect(bootstrapMedianInterval(flat)).toEqual(bootstrapMedianInterval(flat));
  });

  it('calls a delta significant only when its interval excludes zero', () => {
    const positive = Array.from({ length: 30 }, (_, i) => 5 + (i % 3) - 1);
    const mixed = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 3 : -3) + (i % 5) - 2);
    expect(pairedDeltaVerdict(positive)).toMatchObject({ significant: true });
    expect(pairedDeltaVerdict(positive).ci.low).toBeGreaterThan(0);
    expect(pairedDeltaVerdict(mixed).significant).toBe(false);
  });

  it('reports a flat run as stable and a ramp as drifting', () => {
    expect(driftStats(flat)).toMatchObject({ stable: true });
    const ramp = Array.from({ length: 40 }, (_, i) => 100 + i);
    const drift = driftStats(ramp);
    expect(drift.stable).toBe(false);
    expect(drift.slopePerSample).toBeCloseTo(1);
    expect(drift.secondHalfP50).toBeGreaterThan(drift.firstHalfP50);
    expect(drift.halfShift).toBeGreaterThan(0.05);
    expect(drift.lag1Autocorrelation).toBeGreaterThan(0.9);
  });

  it('needs at least four samples to call a run stable', () => {
    expect(driftStats([1, 1, 1]).stable).toBe(false);
  });
});
