import { expect, it } from 'vitest';
import type { StandardIrradianceFieldGi } from '../../pipeline/standard-profile';
import { DiffuseGiBudget } from '../../raytracing/diffuse-gi-budget';
import { planIrradianceField, splitProbeBudget } from '../../raytracing/irradiance-field-plan';
import {
  PROBE_ENTRY_FAST,
  PROBE_ENTRY_FRESH,
  PROBE_ENTRY_INDEX,
  ProbeClipmapScheduler,
} from '../../raytracing/probe-clipmap';

const field: StandardIrradianceFieldGi['field'] = {
  region: {
    grid: {
      origin: [-4, -4, -4],
      dimensions: [33, 33, 33],
      spacing: 0.25,
      maxDistance: 2,
      coverageDistance: 1,
    },
    maxInstances: 64,
    maxFieldBytes: 16 * 1024 * 1024,
  },
  probeSpacing: 1,
  raysPerProbe: 64,
  probeBudget: 768,
  hysteresis: 0.9,
  cards: { resolution: 32, maxCaptureBytes: 8 * 1024 * 1024, budget: 64 },
  resolution: 'half',
  radiosity: true,
  clipmap: { levels: 3, dimensions: [8, 4, 8] },
};

it('retains every admitted whole-batch update through the real plan and clipmap schedule', () => {
  const planned = planIrradianceField(field).unwrap();
  expect(planned.probeCount).toBe(768);
  expect(planned.probeBudget).toBe(768);
  expect(planned.levelBudgets).toEqual([256, 256, 256]);
  const work = new ProbeClipmapScheduler(planned).schedule();
  expect(work.count).toBe(768);
  expect(new Set(work.list.subarray(0, work.count)).size).toBe(768);
});

it('conserves admitted integer budgets across zero, low, capacity edges and capped levels', () => {
  for (const levels of [1, 2, 3, 4]) {
    for (const cap of [1, 2, 7, 16, 256]) {
      const requests = new Set([
        0,
        1,
        levels - 1,
        levels,
        cap - 1,
        cap,
        cap + 1,
        levels * cap - 1,
        levels * cap,
        levels * cap + 1,
        1_048_576,
      ]);
      for (const requested of requests) {
        const shares = splitProbeBudget(requested, levels, cap);
        const admitted = Math.min(requested, levels * cap);
        expect(shares, `${requested}/${levels}/${cap}`).toHaveLength(levels);
        expect(shares.reduce((sum, value) => sum + value, 0)).toBe(admitted);
        expect(shares.every((value) => Number.isInteger(value) && value >= 0 && value <= cap)).toBe(
          true,
        );
        expect(
          shares.every((value, level) => level === 0 || value <= (shares[level - 1] ?? 0)),
        ).toBe(true);
        if (admitted >= levels) expect(shares.every((value) => value > 0)).toBe(true);
        else
          expect(shares).toEqual(
            Array.from({ length: levels }, (_, level) => Number(level < admitted)),
          );
      }
    }
  }
});

it('keeps uncapped weighted shares and the public low-budget admission boundary', () => {
  expect(splitProbeBudget(64, 3, 256)).toEqual([37, 18, 9]);
  expect(splitProbeBudget(32, 2, 256)).toEqual([22, 10]);
  expect(splitProbeBudget(4, 4, 256)).toEqual([1, 1, 1, 1]);
  expect(planIrradianceField({ ...field, probeBudget: 0 }).ok).toBe(false);
  expect(planIrradianceField({ ...field, probeBudget: 1 }).ok).toBe(false);
});

it('retains h and ray inputs while cold and committed low/default/full schedules visit every probe', () => {
  for (const hysteresis of [0, 0.5, 0.9, 0.99]) {
    for (const probeBudget of [3, 64, 768, 769]) {
      const planned = planIrradianceField({ ...field, hysteresis, probeBudget }).unwrap();
      expect(planned.hysteresis).toBe(hysteresis);
      expect(planned.raysPerProbe).toBe(64);
      expect(planned.probeBudget).toBe(Math.min(probeBudget, 768));
      const scheduler = new ProbeClipmapScheduler(planned);
      const cold = scheduler.schedule();
      expect(scheduler.schedule()).toBe(cold); // An unsubmitted attempt cannot advance history.
      const counts = new Uint32Array(planned.probeCount);
      const frames = Math.ceil(256 / Math.min(...planned.levelBudgets));
      for (let frame = 0; frame < frames; frame++) {
        const work = scheduler.schedule();
        expect(work.count).toBe(planned.probeBudget);
        const entries = work.list.subarray(0, work.count);
        expect(new Set(entries).size).toBe(work.count);
        for (const entry of entries) {
          const probe = entry & PROBE_ENTRY_INDEX;
          counts[probe] = (counts[probe] ?? 0) + 1;
        }
        scheduler.commit(work);
      }
      // These are submitted CPU schedule counts, not accepted GPU radiance updates.
      expect(counts.every((count) => count > 0)).toBe(true);
      expect(scheduler.schedule()).not.toBe(cold);
      expect(planned.hysteresis).toBe(hysteresis);
    }
  }
});

it('conserves an active Field share when another real view claim joins and leaves', () => {
  const planned = planIrradianceField({ ...field, probeBudget: 64 }).unwrap();
  const scheduler = new ProbeClipmapScheduler(planned);
  const budget = new DiffuseGiBudget(),
    first = {},
    second = {};
  budget.claim(first, 0, [0, 0, 0]);
  scheduler.limit = budget.share(first, planned.probeBudget);
  scheduler.commit(scheduler.schedule());
  budget.claim(first, 1, [0, 0, 0]);
  budget.claim(second, 1, [0, 0, 0]);
  scheduler.limit = budget.share(first, planned.probeBudget);
  const shared = scheduler.schedule();
  expect(scheduler.limit).toBe(32);
  expect(shared.count).toBe(32);
  const levels = [0, 0, 0];
  for (const entry of shared.list.subarray(0, shared.count)) {
    const level = Math.floor((entry & PROBE_ENTRY_INDEX) / 256);
    levels[level] = (levels[level] ?? 0) + 1;
  }
  expect(levels).toEqual([19, 9, 4]);
  scheduler.commit(shared);
  budget.release(second);
  budget.claim(first, 2, [0, 0, 0]);
  scheduler.limit = budget.share(first, planned.probeBudget);
  expect(scheduler.schedule().count).toBe(64);
});

it('retains exact admitted active limits through shrink, restore and unsubmitted attempts', () => {
  for (const hysteresis of [0, 0.5, 0.9, 0.99]) {
    for (const probeBudget of [64, 768]) {
      const planned = planIrradianceField({ ...field, hysteresis, probeBudget }).unwrap();
      const scheduler = new ProbeClipmapScheduler(planned);
      for (const requested of [
        0,
        1,
        2,
        3,
        4,
        5,
        31,
        32,
        33,
        63,
        64,
        767,
        768,
        769,
        5,
        probeBudget,
      ]) {
        const previous = scheduler.schedule();
        scheduler.limit = requested;
        const admitted = Math.max(1, Math.min(probeBudget, requested));
        const work = scheduler.schedule();
        const entries = work.list.subarray(0, work.count);
        expect(work.count, `${probeBudget}/${requested}`).toBe(admitted);
        expect(new Set(entries).size).toBe(admitted);
        const counts = [0, 0, 0];
        for (const entry of entries) {
          const level = Math.floor((entry & PROBE_ENTRY_INDEX) / 256);
          counts[level] = (counts[level] ?? 0) + 1;
        }
        if (admitted >= 3) expect(counts).toEqual(splitProbeBudget(admitted, 3, 256));
        else expect(counts.every((count) => count <= 1)).toBe(true);
        expect(counts.every((count) => count >= 0 && count <= 256)).toBe(true);
        expect(planned.hysteresis).toBe(hysteresis);
        expect(planned.raysPerProbe).toBe(64);
        if (previous !== work) {
          scheduler.commit(previous);
          expect(scheduler.schedule()).toBe(work);
        }
        expect(scheduler.schedule()).toBe(work);
        scheduler.commit(work);
        const next = scheduler.schedule();
        expect(next).not.toBe(work);
        scheduler.commit(work);
        expect(scheduler.schedule()).toBe(next);
      }
    }
  }
});

it.each([
  'edit',
  'scroll',
  'edit+scroll',
] as const)('retains the unique admitted frame total when %s work overlaps rotation', (mode) => {
  const planned = planIrradianceField({
    ...field,
    probeBudget: 64,
    clipmap: { levels: 1, dimensions: [8, 4, 8] },
  }).unwrap();
  const origin = planned.origin;
  const focus: [number, number, number] = [origin[0] + 4, origin[1] + 2, origin[2] + 4];
  const scheduler = new ProbeClipmapScheduler(planned, focus);
  scheduler.commit(scheduler.schedule());
  if (mode !== 'scroll') {
    const x = origin[0] + (mode === 'edit+scroll' ? 7 : 0);
    scheduler.queueEdit([
      {
        min: [x - 0.25, origin[1] - 0.25, origin[2] - 0.25],
        max: [x, origin[1], origin[2]],
      },
    ]);
    scheduler.activateEdits();
  }
  if (mode !== 'edit') scheduler.focus([focus[0] + 1, focus[1], focus[2]]);
  const work = scheduler.schedule();
  const entries = work.list.subarray(0, work.count);
  expect(new Set(Array.from(entries, (entry) => entry & PROBE_ENTRY_INDEX)).size).toBe(work.count);
  expect(work.rotation.every((visits) => visits <= 256)).toBe(true);
  if (mode !== 'edit')
    expect(entries.some((entry) => (entry & PROBE_ENTRY_FRESH) !== 0)).toBe(true);
  if (mode !== 'scroll')
    expect(entries.some((entry) => (entry & PROBE_ENTRY_FAST) !== 0)).toBe(true);
  expect(work.count).toBe(planned.probeBudget);
});

it('keeps every admitted clipmap level progressing under tiny alternating multi-view shares', () => {
  const planned = planIrradianceField({
    ...field,
    probeBudget: 3,
    clipmap: { levels: 3, dimensions: [2, 2, 2] },
  }).unwrap();
  const scheduler = new ProbeClipmapScheduler(planned);
  const budget = new DiffuseGiBudget(),
    first = {},
    second = {};
  const counts = [0, 0, 0],
    shares = new Set<number>();
  // Existing sharing acceptance allows 2.5 solo sweeps or 32 extra frames.
  // A solo schedule visits this eight-probe-per-level lattice in eight frames.
  const frames = Math.max(Math.ceil(8 * 2.5), 8 + 32);
  for (let frame = 0; frame < frames; frame++) {
    budget.claim(first, frame, [0, 0, 0]);
    budget.claim(second, frame, [0, 0, 0]);
    const share = budget.share(first, planned.probeBudget);
    shares.add(share);
    scheduler.limit = share;
    const work = scheduler.schedule();
    expect(work.count).toBe(share);
    for (const entry of work.list.subarray(0, work.count)) {
      const level = Math.floor((entry & PROBE_ENTRY_INDEX) / 8);
      counts[level] = (counts[level] ?? 0) + 1;
    }
    scheduler.commit(work);
  }
  expect([...shares].sort()).toEqual([1, 2]);
  expect(
    counts.every((count) => count > 0),
    counts.join(','),
  ).toBe(true);
  expect(counts).toEqual([20, 20, 20]);
});

it('retains fresh-over-edit flags and edit credit while refilling unique rotation slots', () => {
  const planned = planIrradianceField({
    ...field,
    probeBudget: 64,
    clipmap: { levels: 1, dimensions: [8, 4, 8] },
  }).unwrap();
  const origin = planned.origin;
  const focus: [number, number, number] = [origin[0] + 4, origin[1] + 2, origin[2] + 4];
  const scheduler = new ProbeClipmapScheduler(planned, focus);
  scheduler.commit(scheduler.schedule());
  scheduler.focus([focus[0] + 1, focus[1], focus[2]]);
  scheduler.queueEdit([
    {
      min: [origin[0] + 6.75, origin[1] - 0.25, origin[2] - 0.25],
      max: [origin[0] + 7, origin[1], origin[2]],
    },
  ]);
  scheduler.activateEdits();
  const pending = scheduler.pendingPriorityUpdates();
  const work = scheduler.schedule();
  // The clipped edit is x=[4,9), y/z=[0,3); the first32 raw
  // edit ordinals include fresh x=8 cells which satisfy both credits.
  const edits = new Set(
    Array.from(
      { length: 32 },
      (_, i) => (Math.floor(i / 15) * 4 + (Math.floor(i / 5) % 3)) * 8 + ((4 + (i % 5)) % 8),
    ),
  );
  expect(work).toMatchObject({ count: 64, fresh: 32, priority: 32 });
  const indices = [];
  for (const entry of work.list.subarray(0, work.count)) {
    const index = entry & PROBE_ENTRY_INDEX;
    indices.push(index);
    const expected = index % 8 === 0 ? PROBE_ENTRY_FRESH : edits.has(index) ? PROBE_ENTRY_FAST : 0;
    expect((entry & ~PROBE_ENTRY_INDEX) >>> 0).toBe(expected);
  }
  expect(new Set(indices).size).toBe(64);
  expect(work.rotation[0]).toBeLessThanOrEqual(256);
  scheduler.commit(work);
  expect(scheduler.pendingPriorityUpdates()).toBe(pending - 32);
});

it('advances tiny level rotation only on the current committed schedule', () => {
  const planned = planIrradianceField({
    ...field,
    probeBudget: 3,
    clipmap: { levels: 3, dimensions: [2, 2, 2] },
  }).unwrap();
  const scheduler = new ProbeClipmapScheduler(planned);
  const levels = () =>
    Array.from(scheduler.schedule().list.subarray(0, scheduler.schedule().count), (entry) =>
      Math.floor((entry & PROBE_ENTRY_INDEX) / 8),
    );
  scheduler.limit = 1;
  const cancelled = scheduler.schedule();
  expect(levels()).toEqual([0]);
  scheduler.limit = 2;
  const current = scheduler.schedule();
  scheduler.commit(cancelled);
  expect(scheduler.schedule()).toBe(current);
  expect(levels()).toEqual([0, 1]);
  scheduler.commit(current);
  scheduler.commit(current);
  scheduler.limit = 1;
  expect(levels()).toEqual([2]);
  const third = scheduler.schedule();
  scheduler.commit(third);
  expect(levels()).toEqual([0]);
  scheduler.limit = 3;
  const full = scheduler.schedule();
  expect(levels()).toEqual([0, 1, 2]);
  scheduler.commit(full);
  scheduler.limit = 1;
  expect(levels()).toEqual([0]);
});
