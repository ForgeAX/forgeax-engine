import { expect, it } from 'vitest';
import { createFilterPlanFixture, freshFilteredPlan } from './gpu-driven-filter-plan-fixture';

it('freezes accepted rows and keeps prior material facts independent of the next publication', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const first = freshFilteredPlan(p);
  expect(p.batchRows.every(Object.isFrozen)).toBe(true);
  expect(p.batchRows.every((row) => Object.isFrozen(row.fact))).toBe(true);
  f.material.adopt({ ...f.material.snapshot, standardTextureMask: 7 });
  const next = f.prepare();
  const updated = freshFilteredPlan(next);
  expect(updated.batches.every((row) => row.standardTextureMask === 7)).toBe(true);
  expect(first.batches.every((row) => row.standardTextureMask === undefined)).toBe(true);
  expect(first.plan.batches.every(Object.isFrozen)).toBe(true);
});
