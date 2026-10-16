import { describe, expect, it } from 'vitest';
import { splitProbeBudget } from '../../raytracing/irradiance-field-plan';
import {
  clipmapWindow,
  exposedSlabs,
  PROBE_EDIT_SWEEPS,
  PROBE_ENTRY_FAST,
  PROBE_ENTRY_FRESH,
  PROBE_ENTRY_INDEX,
  type ProbeClipmapPlan,
  ProbeClipmapScheduler,
  probeCell,
  probeIndex,
} from '../../raytracing/probe-clipmap';

const plan = (overrides: Partial<ProbeClipmapPlan> = {}): ProbeClipmapPlan => {
  const levels = overrides.levels ?? 3;
  const dimensions = overrides.dimensions ?? ([8, 4, 8] as const);
  const per = dimensions[0] * dimensions[1] * dimensions[2];
  const probeBudget = overrides.probeBudget ?? 64;
  return {
    origin: [0, 0, 0],
    spacing: 1,
    dimensions,
    levels,
    follow: true,
    probeCount: levels * per,
    probeBudget,
    levelBudgets: splitProbeBudget(probeBudget, levels, per),
    ...overrides,
  };
};

const count = (box: { min: readonly number[]; max: readonly number[] }) =>
  [0, 1, 2].reduce((n, a) => n * ((box.max[a] ?? 0) - (box.min[a] ?? 0)), 1);

describe('probe clipmap addressing', () => {
  it('maps a cell to the same storage slot for any window (toroidal)', () => {
    const p = plan();
    for (const window of [
      [0, 0, 0],
      [-3, 5, 11],
      [17, -2, -9],
    ] as const) {
      for (let index = 0; index < p.probeCount; index += 7) {
        const { level, cell } = probeCell(p, window, index);
        expect(probeIndex(p, level, cell)).toBe(index);
        for (let a = 0; a < 3; a++) {
          expect(cell[a]).toBeGreaterThanOrEqual(window[a] ?? 0);
          expect(cell[a]).toBeLessThan((window[a] ?? 0) + (p.dimensions[a as 0 | 1 | 2] ?? 0));
        }
      }
    }
  });

  it('snaps each level window to its own spacing around the focus', () => {
    const p = plan();
    expect(clipmapWindow(p, 0, [10.5, 0, -3.2])).toEqual([6, -2, -8]);
    expect(clipmapWindow(p, 1, [10.5, 0, -3.2])).toEqual([1, -2, -6]);
    expect(clipmapWindow(p, 2, [10.5, 0, -3.2])).toEqual([-2, -2, -5]);
  });

  it('splits the budget by 2^-l and keeps the total', () => {
    expect(splitProbeBudget(64, 3, 1000)).toEqual([37, 18, 9]);
    expect(splitProbeBudget(64, 1, 1000)).toEqual([64]);
    expect(splitProbeBudget(4, 4, 1000)).toEqual([1, 1, 1, 1]);
  });
});

describe('exposed slabs', () => {
  it('covers exactly the window minus the valid box with disjoint boxes', () => {
    const window = { min: [1, -1, 2] as const, max: [9, 3, 10] as const };
    const valid = { min: [1, 0, 2] as const, max: [8, 3, 8] as const };
    const slabs = exposedSlabs(0, valid, window);
    const covered = new Set<string>();
    for (const slab of slabs)
      for (let x = slab.min[0]; x < slab.max[0]; x++)
        for (let y = slab.min[1]; y < slab.max[1]; y++)
          for (let z = slab.min[2]; z < slab.max[2]; z++) {
            const key = `${x},${y},${z}`;
            expect(covered.has(key)).toBe(false);
            covered.add(key);
          }
    expect(covered.size).toBe(count(window) - count(valid));
    // Completing the slabs in order keeps the union a box.
    let lo: number[] = [...valid.min];
    let hi: number[] = [...valid.max];
    for (const slab of slabs) {
      const nlo = lo.map((v, a) => Math.min(v, slab.min[a] ?? 0));
      const nhi = hi.map((v, a) => Math.max(v, slab.max[a] ?? 0));
      expect(count({ min: nlo, max: nhi })).toBe(count({ min: lo, max: hi }) + count(slab));
      lo = nlo;
      hi = nhi;
    }
    expect(lo).toEqual([...window.min]);
    expect(hi).toEqual([...window.max]);
  });
});

describe('ProbeClipmapScheduler', () => {
  it('rotates every level within its budget and visits each probe once per cycle', () => {
    const p = plan({ follow: false, levels: 2, probeBudget: 32 });
    const scheduler = new ProbeClipmapScheduler(p);
    const seen = new Map<number, number>();
    for (let frame = 0; frame < 16; frame++) {
      const work = scheduler.schedule();
      expect(work.count).toBeLessThanOrEqual(p.probeBudget);
      expect(new Set(work.list.subarray(0, work.count)).size).toBe(work.count);
      for (const entry of work.list.subarray(0, work.count))
        seen.set(entry, (seen.get(entry) ?? 0) + 1);
      scheduler.commit(work);
    }
    // Level 0 (256 probes, 21/frame) and level 1 (11/frame) are both visited.
    expect([...seen.keys()].some((k) => k < 256)).toBe(true);
    expect([...seen.keys()].some((k) => k >= 256)).toBe(true);
  });

  it('a one-cell scroll re-traces exactly the exposed slab, fresh, then extends validity', () => {
    const p = plan({ levels: 1, probeBudget: 64 });
    const scheduler = new ProbeClipmapScheduler(p, [0.5, 0.5, 0.5]);
    const before = scheduler.windows()[0];
    expect(scheduler.focus([1.5, 0.5, 0.5])).toBe(4 * 8);
    const after = scheduler.windows()[0];
    expect(after?.window[0]).toBe((before?.window[0] ?? 0) + 1);
    // Sampling excludes the exposed slab until it is traced.
    expect(after?.max[0]).toBe((after?.window[0] ?? 0) + 7);
    const work = scheduler.schedule();
    expect(work.fresh).toBe(32);
    const fresh = [...work.list.subarray(0, work.fresh)];
    for (const entry of fresh) {
      expect(entry & PROBE_ENTRY_FRESH).not.toBe(0);
      const { cell } = probeCell(p, after?.window ?? [0, 0, 0], entry & PROBE_ENTRY_INDEX);
      expect(cell[0]).toBe((after?.window[0] ?? 0) + 7);
    }
    // Rotation never repeats a fresh probe in the same dispatch.
    const plain = new Set([...work.list.subarray(0, work.count)].map((e) => e & PROBE_ENTRY_INDEX));
    expect(plain.size).toBe(work.count);
    // A failed submit replays the same schedule.
    expect(scheduler.schedule()).toBe(work);
    scheduler.commit(work);
    const done = scheduler.windows()[0];
    expect(done?.min).toEqual(after?.window);
    expect(done?.max[0]).toBe((after?.window[0] ?? 0) + 8);
    expect(scheduler.inspect().pendingExposedProbes).toBe(0);
    expect(scheduler.schedule().fresh).toBe(0);
  });

  it('budgets a large jump over several frames and keeps unrelated levels', () => {
    const p = plan({ levels: 2, probeBudget: 40 });
    const scheduler = new ProbeClipmapScheduler(p, [0, 0, 0]);
    // Level 0 shifts 3 cells (3 * 4 * 8 = 96 probes), level 1 one cell (32 probes).
    const exposed = scheduler.focus([3, 0, 0]);
    expect(exposed).toBe(128);
    let frames = 0;
    while (scheduler.inspect().pendingExposedProbes > 0) {
      const work = scheduler.schedule();
      expect(work.count).toBeLessThanOrEqual(40);
      scheduler.commit(work);
      frames++;
    }
    expect(frames).toBe(Math.ceil(exposed / 40));
    const rows = scheduler.windows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.min).toEqual(row.window);
      expect(row.max).toEqual(row.window.map((v, a) => v + p.dimensions[a as 0 | 1 | 2]));
    }
  });

  it('sweeps edited probes with fast hysteresis only after activation', () => {
    const p = plan({ follow: false, levels: 1, probeBudget: 64 });
    const scheduler = new ProbeClipmapScheduler(p);
    scheduler.queueEdit([{ min: [3.2, 0, 3.2], max: [3.8, 1, 3.8] }]);
    expect(scheduler.schedule().priority).toBe(0);
    const probes = scheduler.priorityProbes();
    expect(probes).toBeGreaterThan(0);
    expect(scheduler.pendingPriorityUpdates()).toBe(PROBE_EDIT_SWEEPS * probes);
    scheduler.activateEdits();
    let updates = 0;
    for (let frame = 0; frame < 20 && scheduler.pendingPriorityUpdates() > 0; frame++) {
      const work = scheduler.schedule();
      for (const entry of work.list.subarray(work.fresh, work.fresh + work.priority))
        expect(entry & PROBE_ENTRY_FAST).not.toBe(0);
      updates += work.priority;
      scheduler.commit(work);
    }
    expect(updates).toBe(PROBE_EDIT_SWEEPS * probes);
  });
});
