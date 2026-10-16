import { describe, expect, it } from 'vitest';
import { CardCaptureScheduler } from '../../raytracing/card-capture-schedule';

describe('CardCaptureScheduler', () => {
  it('captures the atlas in budgeted slices: clear first, then load, then done', () => {
    const schedule = new CardCaptureScheduler(10, 4);
    const slices: unknown[] = [];
    const modes: unknown[] = [];
    for (let frame = 0; frame < 5; frame++) {
      modes.push(schedule.mode());
      const slice = schedule.slice();
      if (slice === undefined) break;
      slices.push(slice);
      schedule.commit(slice);
    }
    expect(slices).toEqual([
      { first: 0, count: 4, clear: false },
      { first: 4, count: 4, clear: false },
      { first: 8, count: 2, clear: false },
    ]);
    expect(modes).toEqual(['clear', 'load', 'load', undefined]);
    expect(schedule.done).toBe(true);
  });

  it('replays an uncommitted slice', () => {
    const schedule = new CardCaptureScheduler(6, 4);
    const first = schedule.slice();
    expect(schedule.slice()).toEqual(first);
    expect(schedule.captured).toBe(0);
  });

  it('queues only already captured edits and recaptures them clearing each slice', () => {
    const schedule = new CardCaptureScheduler(12, 8);
    const head = schedule.slice();
    if (head === undefined) throw new Error('expected a slice');
    schedule.commit(head);
    // Tiles [6, 10) straddle the frontier at 8: only [6, 8) needs a recapture.
    expect(schedule.queue([{ first: 6, end: 10 }])).toBe(2);
    expect(schedule.queue([{ first: 0, end: 3 }])).toBe(3);
    expect(schedule.pendingTiles).toBe(5);
    expect(schedule.slice()).toEqual({ first: 8, count: 4, clear: false });
    schedule.commit({ first: 8, count: 4, clear: false });
    const recaptured: unknown[] = [];
    for (let slice = schedule.slice(); slice !== undefined; slice = schedule.slice()) {
      recaptured.push(slice);
      schedule.commit(slice);
    }
    expect(recaptured).toEqual([
      { first: 0, count: 3, clear: true },
      { first: 6, count: 2, clear: true },
    ]);
    expect(schedule.done).toBe(true);
  });

  it('splits a long edited run by the budget and extends the frontier on growth', () => {
    const schedule = new CardCaptureScheduler(4, 2);
    for (let slice = schedule.slice(); slice !== undefined; slice = schedule.slice())
      schedule.commit(slice);
    schedule.queue([{ first: 0, end: 3 }]);
    schedule.grow(5);
    expect(schedule.mode()).toBe('load');
    expect(schedule.slice()).toEqual({ first: 4, count: 1, clear: false });
    schedule.commit({ first: 4, count: 1, clear: false });
    expect(schedule.slice()).toEqual({ first: 0, count: 2, clear: true });
    schedule.commit({ first: 0, count: 2, clear: true });
    expect(schedule.slice()).toEqual({ first: 2, count: 1, clear: true });
    // A stale clear slice no longer matching the run head is ignored.
    schedule.commit({ first: 0, count: 2, clear: true });
    expect(schedule.pendingTiles).toBe(1);
  });

  it('rejects a non-positive budget', () => {
    expect(() => new CardCaptureScheduler(4, 0)).toThrow();
  });
});
