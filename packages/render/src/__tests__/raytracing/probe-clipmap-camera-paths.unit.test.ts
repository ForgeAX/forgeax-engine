import { expect, it } from 'vitest';
import {
  PROBE_EDIT_SWEEPS,
  PROBE_ENTRY_FAST,
  PROBE_ENTRY_FRESH,
  PROBE_ENTRY_INDEX,
  type ProbeCell,
  type ProbeClipmapPlan,
  ProbeClipmapScheduler,
} from '../../raytracing/probe-clipmap';

const plan: ProbeClipmapPlan = {
  origin: [0, 0, 0],
  spacing: 1,
  dimensions: [4, 2, 2],
  levels: 2,
  levelBudgets: [2, 1],
  probeBudget: 3,
  probeCount: 32,
  follow: true,
};

// Independent integer lattice enumeration: do not call production probeCell/probeIndex.
function cells(min: ProbeCell, dimensions: ProbeCell): ProbeCell[] {
  const out: ProbeCell[] = [];
  for (let z = min[2]; z < min[2] + dimensions[2]; z++)
    for (let y = min[1]; y < min[1] + dimensions[1]; y++)
      for (let x = min[0]; x < min[0] + dimensions[0]; x++) out.push([x, y, z]);
  return out;
}

function slot(level: number, cell: ProbeCell): number {
  const x = ((cell[0] % 4) + 4) % 4;
  const y = ((cell[1] % 2) + 2) % 2;
  const z = ((cell[2] % 2) + 2) % 2;
  return level * 16 + z * 8 + y * 4 + x;
}

const key = (level: number, cell: ProbeCell) => `${level}:${cell.join(',')}`;
const contains = (cell: ProbeCell, min: ProbeCell) =>
  cell.every(
    (v, a) => v >= min[a as 0 | 1 | 2] && v < min[a as 0 | 1 | 2] + plan.dimensions[a as 0 | 1 | 2],
  );

it('keeps valid world identities during partial-scroll reversals, teleports and failed submits', () => {
  const scheduler = new ProbeClipmapScheduler(plan, [2, 1, 1]);
  const stored = new Map<number, string>();
  const windows = () => scheduler.windows();
  for (const [level, row] of windows().entries())
    for (const cell of cells(row.window, plan.dimensions))
      stored.set(slot(level, cell), key(level, cell));

  const validate = () => {
    for (const [level, row] of windows().entries()) {
      const size: ProbeCell = [
        row.max[0] - row.min[0],
        row.max[1] - row.min[1],
        row.max[2] - row.min[2],
      ];
      for (const cell of cells(row.min, size))
        expect(stored.get(slot(level, cell))).toBe(key(level, cell));
    }
  };
  const submit = () => {
    const work = scheduler.schedule();
    expect(scheduler.schedule()).toBe(work); // Failed submit does not spend or advance work.
    expect(work.count).toBeLessThanOrEqual(plan.probeBudget);
    const seen = new Set<number>();
    for (const entry of work.list.subarray(0, work.count)) {
      const index = entry & PROBE_ENTRY_INDEX;
      expect(seen.has(index)).toBe(false);
      seen.add(index);
      const level = Math.floor(index / 16),
        row = windows()[level];
      if (!row) throw Error('Scheduled level must exist');
      const candidates = cells(row.window, plan.dimensions).filter(
        (cell) => slot(level, cell) === index,
      );
      expect(candidates).toHaveLength(1);
      const cell = candidates[0];
      if (!cell) throw Error('A physical slot must name exactly one current world cell');
      expect(entry & PROBE_ENTRY_FAST).toBe(0);
      stored.set(index, key(level, cell));
    }
    scheduler.commit(work);
    validate();
  };

  for (const focus of [
    [3, 1, 1],
    [2, 1, 1],
    [1, 1, 1],
    [3, 2, 2],
    [35, 17, -15],
    [-31, -15, 17],
    [2, 1, 1],
  ] as const) {
    const abandoned = scheduler.schedule();
    const exposed = scheduler.focus(focus);
    expect(exposed).toBeGreaterThan(0);
    const next = scheduler.schedule();
    expect(next).not.toBe(abandoned);
    const pending = scheduler.inspect().pendingExposedProbes;
    scheduler.commit(abandoned); // The abandoned pre-move schedule cannot certify the new window.
    expect(scheduler.inspect().pendingExposedProbes).toBe(pending);
    expect(scheduler.schedule()).toBe(next);
    expect(scheduler.focus(focus)).toBe(0);
    expect(scheduler.schedule()).toBe(next);
    validate();
    submit(); // Deliberately reverse/teleport with a partially completed fresh slab.
  }
  for (let frame = 0; frame < 64 && scheduler.inspect().pendingExposedProbes > 0; frame++) submit();
  expect(scheduler.inspect().pendingExposedProbes).toBe(0);
  for (const row of windows()) {
    expect(row.min).toEqual(row.window);
    expect(row.max).toEqual(row.window.map((v, a) => v + plan.dimensions[a as 0 | 1 | 2]));
  }
});

it.each([
  {
    name: 'partial forward then reverse',
    before: 1,
    path: [
      [3, 1, 1],
      [2, 1, 1],
      [1, 1, 1],
    ],
  },
  {
    name: 'whole sweep then negative reversal',
    before: 4,
    path: [
      [1, 1, 1],
      [2, 1, 1],
      [3, 1, 1],
    ],
  },
  {
    name: 'teleport drops old tasks and return never revives them',
    before: 1,
    path: [
      [34, 1, 1],
      [2, 1, 1],
    ],
  },
] as const)('retains only unfinished world-cell tasks: $name', ({ before, path }) => {
  const input: ProbeClipmapPlan = {
    ...plan,
    levels: 1,
    levelBudgets: [4],
    probeBudget: 4,
    probeCount: 16,
  };
  const scheduler = new ProbeClipmapScheduler(input, [2, 1, 1]);
  let remaining = Array.from({ length: PROBE_EDIT_SWEEPS }, () =>
    cells([0, 0, 0], plan.dimensions),
  ).flat();
  scheduler.queueEdit([{ min: [0, 0, 0], max: [4, 2, 2] }]);
  scheduler.activateEdits();
  const submit = () => {
    const work = scheduler.schedule(),
      row = scheduler.windows()[0];
    if (!row) throw Error('Current submitted window must exist');
    const actual = [...work.list.subarray(0, work.count)]
      .filter((entry) => (entry & PROBE_ENTRY_FAST) !== 0)
      .map((entry) =>
        cells(row.window, plan.dimensions).find(
          (cell) => slot(0, cell) === (entry & PROBE_ENTRY_INDEX),
        ),
      );
    expect(actual).toEqual(remaining.slice(0, actual.length));
    expect(work.priority).toBe(actual.length);
    remaining = remaining.slice(actual.length);
    scheduler.commit(work);
    expect(scheduler.pendingPriorityUpdates()).toBe(remaining.length);
  };
  for (let frame = 0; frame < before; frame++) submit();
  for (const focus of path) {
    scheduler.focus(focus);
    const row = scheduler.windows()[0];
    if (!row) throw Error('Recentered window must exist');
    remaining = remaining.filter((cell) => contains(cell, row.window));
    expect(scheduler.pendingPriorityUpdates()).toBe(remaining.length);
    submit();
  }
  for (let frame = 0; frame < 64 && remaining.length > 0; frame++) submit();
  expect(remaining).toHaveLength(0);
  expect(scheduler.pendingPriorityUpdates()).toBe(0);
  const final = scheduler.schedule();
  expect(
    [...final.list.subarray(0, final.count)].every((entry) => (entry & PROBE_ENTRY_FAST) === 0),
  ).toBe(true);
  expect(final.fresh).toBe(
    [...final.list.subarray(0, final.count)].filter((entry) => (entry & PROBE_ENTRY_FRESH) !== 0)
      .length,
  );
});
