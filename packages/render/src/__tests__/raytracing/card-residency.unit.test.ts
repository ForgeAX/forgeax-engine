import { describe, expect, it } from 'vitest';
import { CardCaptureScheduler } from '../../raytracing/card-capture-schedule';
import {
  CARD_RESIDENCY_HYSTERESIS,
  cardResidencyScore,
  rankCardResidency,
} from '../../raytracing/card-residency';
import { DiffuseGiBudget } from '../../raytracing/diffuse-gi-budget';

const box = (center: readonly [number, number, number], half: number) => ({
  min: [center[0] - half, center[1] - half, center[2] - half] as const,
  max: [center[0] + half, center[1] + half, center[2] + half] as const,
});

describe('Card residency priority', () => {
  it('ranks by angular size from the nearest view focus', () => {
    const near = box([2, 0, 0], 0.5);
    const far = box([20, 0, 0], 0.5);
    const big = box([20, 0, 0], 4);
    const focus = [[0, 0, 0]] as const;
    expect(cardResidencyScore(near, focus)).toBeGreaterThan(cardResidencyScore(far, focus));
    expect(cardResidencyScore(big, focus)).toBeGreaterThan(cardResidencyScore(far, focus));
    // A focus inside the bounds saturates at 1.
    expect(cardResidencyScore(near, [[2, 0, 0]])).toBe(1);
    // Any active view counts: a second focus near `far` raises it.
    expect(
      cardResidencyScore(far, [
        [0, 0, 0],
        [19, 0, 0],
      ]),
    ).toBeGreaterThan(cardResidencyScore(far, focus));
    // Without a view, size alone ranks.
    expect(cardResidencyScore(big, [])).toBeGreaterThan(cardResidencyScore(near, []));
  });

  it('orders deterministically: descending score, ties by ascending row', () => {
    const rows = [
      { row: 4, score: 0.5 },
      { row: 1, score: 0.9 },
      { row: 2, score: 0.5 },
      { row: 0, score: 0.1 },
    ];
    expect(rankCardResidency(rows)).toEqual([1, 2, 4, 0]);
    expect(rankCardResidency([...rows].reverse())).toEqual([1, 2, 4, 0]);
    expect(CARD_RESIDENCY_HYSTERESIS).toBeGreaterThan(1);
  });
});

describe('DiffuseGiBudget', () => {
  it('gives a lone view the whole budget and splits it fairly across views', () => {
    const budget = new DiffuseGiBudget();
    const a = {};
    const b = {};
    expect(budget.share(a, 7)).toBe(7);
    budget.claim(a, 1, [0, 0, 0]);
    expect(budget.share(a, 7)).toBe(7);
    budget.claim(b, 1, [5, 0, 0]);
    expect(budget.views).toBe(2);
    const totals: number[] = [];
    let aSum = 0;
    let bSum = 0;
    for (let frame = 2; frame < 12; frame++) {
      budget.claim(a, frame, [0, 0, 0]);
      budget.claim(b, frame, [5, 0, 0]);
      const sa = budget.share(a, 7);
      const sb = budget.share(b, 7);
      totals.push(sa + sb);
      aSum += sa;
      bSum += sb;
      expect(Math.min(sa, sb)).toBeGreaterThanOrEqual(3);
    }
    // The split never exceeds the total; the remainder rotates so neither starves.
    expect(totals.every((t) => t === 7)).toBe(true);
    expect(aSum).toBe(bSum);
    expect(budget.focuses()).toEqual([
      [0, 0, 0],
      [5, 0, 0],
    ]);
  });

  it('drops a view that stopped claiming and keeps at least one unit per view', () => {
    const budget = new DiffuseGiBudget();
    const a = {};
    const b = {};
    const c = {};
    budget.claim(a, 1, [0, 0, 0]);
    budget.claim(b, 1, [0, 0, 0]);
    budget.claim(c, 1, [0, 0, 0]);
    expect(budget.share(a, 2) + budget.share(b, 2) + budget.share(c, 2)).toBeGreaterThanOrEqual(3);
    budget.claim(a, 3, [0, 0, 0]);
    expect(budget.views).toBe(1);
    expect(budget.share(a, 8)).toBe(8);
    budget.claim(b, 3, [0, 0, 0]);
    budget.release(b);
    expect(budget.share(a, 8)).toBe(8);
  });
});

describe('CardCaptureScheduler shares', () => {
  it('clamps the per-frame limit to [1, budget] and slices by it', () => {
    const schedule = new CardCaptureScheduler(10, 4);
    schedule.limit = 2;
    expect(schedule.slice()).toEqual({ first: 0, count: 2, clear: false });
    schedule.limit = 99;
    expect(schedule.limit).toBe(4);
    schedule.limit = 0;
    expect(schedule.limit).toBe(1);
  });

  it('covers a run only after its submitted capture with no recapture pending', () => {
    const schedule = new CardCaptureScheduler(8, 4);
    const run = { first: 2, end: 4 };
    expect(schedule.covers(run)).toBe(false);
    for (let slice = schedule.slice(); slice !== undefined; slice = schedule.slice())
      schedule.commit(slice);
    expect(schedule.covers(run)).toBe(true);
    schedule.queue([{ first: 3, end: 5 }]);
    expect(schedule.covers(run)).toBe(false);
    expect(schedule.covers({ first: 0, end: 2 })).toBe(true);
  });
});
