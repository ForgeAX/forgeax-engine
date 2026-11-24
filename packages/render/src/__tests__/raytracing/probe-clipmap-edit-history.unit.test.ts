import { expect, it } from 'vitest';
import {
  PROBE_EDIT_SWEEPS,
  PROBE_ENTRY_FAST,
  PROBE_ENTRY_INDEX,
  type ProbeClipmapPlan,
  ProbeClipmapScheduler,
  probeCell,
} from '../../raytracing/probe-clipmap';

const plan: ProbeClipmapPlan = {
  origin: [0, 0, 0],
  spacing: 1,
  dimensions: [4, 2, 2],
  levels: 1,
  levelBudgets: [4],
  probeBudget: 4,
  probeCount: 16,
  follow: true,
};

it.each([
  { name: 'complete sweep +x', frames: 4, focus: [3, 1, 1] as const, budget: 4 },
  { name: 'partial sweep +x', frames: 1, focus: [3, 1, 1] as const, budget: 4 },
  { name: 'complete sweep -x', frames: 4, focus: [1, 1, 1] as const, budget: 4 },
  { name: 'partial sweep +y', frames: 3, focus: [2, 2, 1] as const, budget: 4 },
  { name: 'second partial sweep +z', frames: 5, focus: [2, 1, 2] as const, budget: 4 },
  { name: 'three-axis scroll', frames: 3, focus: [3, 2, 2] as const, budget: 4 },
  { name: 'one-probe budget', frames: 19, focus: [3, 1, 1] as const, budget: 1 },
  { name: 'unchanged window', frames: 3, focus: [2, 1, 1] as const, budget: 4 },
  { name: 'whole-batch budget', frames: 1, focus: [3, 1, 1] as const, budget: 16 },
])('preserves each surviving world-cell edit count: $name', ({ frames, focus, budget }) => {
  const input = { ...plan, probeBudget: budget, levelBudgets: [budget] };
  const scheduler = new ProbeClipmapScheduler(input, [2, 1, 1]);
  const visits = new Map<string, number>();
  const remaining: string[] = [];
  let scrolled = false;
  const submit = () => {
    const work = scheduler.schedule();
    const window = scheduler.windows()[0]?.window;
    if (!window) throw Error('Actual scheduled window required');
    expect(work.count).toBe(budget);
    const entries = work.list.subarray(0, work.count);
    expect(new Set(Array.from(entries, (entry) => entry & PROBE_ENTRY_INDEX)).size).toBe(
      work.count,
    );
    for (const entry of entries) {
      if (!(entry & PROBE_ENTRY_FAST)) continue;
      const cell = probeCell(input, window, entry & PROBE_ENTRY_INDEX).cell;
      const key = cell.join(',');
      if (scrolled) remaining.push(key);
      visits.set(key, (visits.get(key) ?? 0) + 1);
    }
    scheduler.commit(work);
  };
  scheduler.queueEdit([{ min: [0, 0, 0], max: [4, 2, 2] }]);
  scheduler.activateEdits();
  for (let frame = 0; frame < frames; frame++) submit();
  scheduler.focus(focus);
  scrolled = true;
  for (let frame = 0; frame < 128 && scheduler.pendingPriorityUpdates() > 0; frame++) submit();
  expect(scheduler.pendingPriorityUpdates()).toBe(0);
  const window = scheduler.windows()[0]?.window;
  if (!window) throw Error('Current world-cell window required');
  const oldTasks: string[] = [];
  for (let sweep = 0; sweep < PROBE_EDIT_SWEEPS; sweep++)
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) oldTasks.push([x, y, z].join(','));
  const retainedTasks = oldTasks
    .slice(frames * budget)
    .filter((key) =>
      key
        .split(',')
        .every(
          (coordinate, axis) =>
            Number(coordinate) >= (window[axis] ?? 0) &&
            Number(coordinate) < (window[axis] ?? 0) + (input.dimensions[axis] ?? 0),
        ),
    );
  expect(remaining).toEqual(retainedTasks); // No reordered work or budget for evicted cells.
  let checked = 0;
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 4; x++) {
        const cell = [x, y, z];
        if (
          !cell.every(
            (coordinate, axis) =>
              coordinate >= (window[axis] ?? 0) &&
              coordinate < (window[axis] ?? 0) + (input.dimensions[axis] ?? 0),
          )
        )
          continue;
        expect(visits.get(cell.join(',')), `world cell ${cell.join(',')}`).toBe(PROBE_EDIT_SWEEPS);
        checked++;
      }
  expect(checked).toBeGreaterThan(0);
});

it('preserves an unchanged edit box cursor when only its containing window scrolls', () => {
  const input: ProbeClipmapPlan = {
    ...plan,
    dimensions: [8, 6, 6],
    probeCount: 288,
    probeBudget: 7,
    levelBudgets: [7],
  };
  const scheduler = new ProbeClipmapScheduler(input, [4, 3, 3]);
  scheduler.queueEdit([{ min: [4, 3, 3], max: [4, 3, 3] }]);
  scheduler.activateEdits();
  expect(scheduler.priorityProbes()).toBe(125);
  for (let frame = 0; frame < 7; frame++) scheduler.commit(scheduler.schedule());
  const pending = scheduler.pendingPriorityUpdates();
  expect(pending).toBe(3 * 125 - 49);
  scheduler.focus([5, 3, 3]); // Window x=[1,9), edited x=[2,7) stays intact.
  expect(scheduler.priorityProbes()).toBe(125);
  expect(scheduler.pendingPriorityUpdates()).toBe(pending);
});
