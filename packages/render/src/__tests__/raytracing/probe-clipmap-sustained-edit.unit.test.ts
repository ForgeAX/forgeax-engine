import { expect, it } from 'vitest';
import {
  PROBE_ENTRY_FAST,
  PROBE_ENTRY_INDEX,
  type ProbeClipmapPlan,
  ProbeClipmapScheduler,
} from '../../raytracing/probe-clipmap';

const perLevel = 216;
const edit = { min: [2, 2, 2], max: [2, 2, 2] } as const;

function isEdited(slot: number): boolean {
  const level = Math.floor(slot / perLevel);
  const local = slot % perLevel;
  // The two-spacing margin covers a 5x5x5 box at level 0 and a 4x4x4
  // box at each following level for the fixed world point above.
  const edge = level === 0 ? 5 : 4;
  return local % 6 < edge && Math.floor(local / 6) % 6 < edge && Math.floor(local / 36) < edge;
}

it.each([
  { levels: 1, budget: 1 },
  { levels: 4, budget: 1 },
  { levels: 4, budget: 3 },
])('serves edited and ordinary probes during sustained edits with $levels levels and $budget slots', ({
  levels,
  budget,
}) => {
  const plan: ProbeClipmapPlan = {
    origin: [0, 0, 0],
    spacing: 1,
    dimensions: [6, 6, 6],
    levels,
    follow: false,
    probeCount: levels * perLevel,
    probeBudget: budget,
    levelBudgets: Array.from({ length: levels }, (_, level) => Number(level < budget)),
  };
  const scheduler = new ProbeClipmapScheduler(plan);
  const edited = new Set<number>();
  const ordinary = new Set<number>();
  // The repeated stream is recognized after the first accepted edit.
  // One ordinary slot per four commits can cover the entire fixed lattice.
  const lastFrame = 4 * (plan.probeCount + 1);
  for (let frame = 0; frame < lastFrame; frame++) {
    scheduler.queueEdit([edit]);
    scheduler.activateEdits();
    const work = scheduler.schedule();
    expect(work.count).toBe(budget);
    expect(scheduler.schedule()).toBe(work);
    for (const entry of work.list.subarray(0, work.count)) {
      const slot = entry & PROBE_ENTRY_INDEX;
      expect(slot).toBeLessThan(plan.probeCount);
      if (entry & PROBE_ENTRY_FAST) {
        expect(isEdited(slot)).toBe(true);
        edited.add(slot);
      } else {
        ordinary.add(slot);
      }
    }
    scheduler.commit(work);
  }
  expect(edited.size).toBe(125 + (levels - 1) * 64);
  for (let slot = 0; slot < plan.probeCount; slot++) {
    if (!isEdited(slot)) expect(ordinary.has(slot), `ordinary probe ${slot}`).toBe(true);
  }
});
