import { describe, expect, it } from 'vitest';
import { createFramePacer } from '../internal/frame-pacer';

/** Drive display callbacks at `refreshMs` (+ optional jitter) and return admitted intervals. */
function admittedIntervals(
  limit: number | null,
  refreshMs: number,
  callbacks: number,
  jitter: (index: number) => number = () => 0,
): number[] {
  const pacer = createFramePacer();
  pacer.setLimit(limit);
  const admitted: number[] = [];
  for (let index = 0; index < callbacks; index++) {
    const now = index * refreshMs + jitter(index);
    if (!pacer.due(now)) continue;
    pacer.admitted(now);
    admitted.push(now);
  }
  return admitted.slice(1).map((time, index) => time - (admitted[index] ?? Number.NaN));
}

describe('frame pacer', () => {
  it('admits every display callback without a limit', () => {
    const intervals = admittedIntervals(null, 1000 / 60, 30);
    expect(intervals).toHaveLength(29);
    for (const step of intervals) expect(step).toBeCloseTo(1000 / 60, 6);
  });

  it.each([60, 120, 240])('paces a 30 FPS limit evenly on a %d Hz display', (hz) => {
    const intervals = admittedIntervals(30, 1000 / hz, hz * 2);
    expect(intervals.length).toBeGreaterThan(50);
    for (const step of intervals) expect(step).toBeCloseTo(1000 / 30, 6);
  });

  it('stays on the even cadence under callback jitter', () => {
    const intervals = admittedIntervals(30, 1000 / 60, 240, (index) => ((index * 7) % 5) - 2);
    for (const step of intervals) {
      expect(step).toBeGreaterThan(1000 / 30 - 5);
      expect(step).toBeLessThan(1000 / 30 + 5);
    }
  });

  it('keeps its vsync tolerance through near-duplicate callbacks', () => {
    // Real hosts deliver a delayed callback followed by an on-time one, and a
    // display a little faster than 60 Hz puts the second refresh just under
    // the 33.3 ms interval. Neither may push the admission to a third refresh.
    const refresh = 1000 / 60.2;
    const times: number[] = [];
    for (let index = 0; index < 600; index++) {
      const vsync = index * refresh + (index % 3 === 0 ? 0.3 : -0.3);
      times.push(vsync);
      if (index % 7 === 0) times.push(vsync + 0.05);
    }
    const pacer = createFramePacer();
    pacer.setLimit(30);
    let previous: number | undefined;
    for (const now of times) {
      if (!pacer.due(now)) continue;
      pacer.admitted(now);
      if (previous !== undefined) expect(now - previous).toBeLessThan(1000 / 30 + 2);
      previous = now;
    }
  });

  it('admits the next callback after a long gap instead of waiting a further interval', () => {
    const pacer = createFramePacer();
    pacer.setLimit(30);
    for (const now of [0, 16.7, 33.3]) if (pacer.due(now)) pacer.admitted(now);
    // A 120 ms stall is followed by display callbacks on the 60 Hz grid.
    expect(pacer.due(153.3)).toBe(true);
    pacer.admitted(153.3);
    expect(pacer.due(170)).toBe(false);
    expect(pacer.due(186.7)).toBe(true);
  });

  it('removes the limit with null and rejects invalid limits', () => {
    const pacer = createFramePacer();
    pacer.setLimit(30);
    expect(pacer.limit()).toBe(30);
    pacer.due(0);
    pacer.admitted(0);
    expect(pacer.due(16.7)).toBe(false);
    pacer.setLimit(null);
    expect(pacer.limit()).toBeNull();
    expect(pacer.due(33.4)).toBe(true);
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => pacer.setLimit(value)).toThrow(RangeError);
  });
});
