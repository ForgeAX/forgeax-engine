import { expect, it } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import {
  expectFilteredPlanContent as compare,
  createFilterPlanFixture,
  freshFilteredPlan,
} from './gpu-driven-filter-plan-fixture';

it('source removal, reorder and reinsert match independent fresh projection without mutating prior results', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p, f.bindings);
  const before = first.plan.batches.map((row) => row.candidates);
  for (const rows of [[...p.batchRows].reverse(), p.batchRows.slice(1), p.batchRows]) {
    const next = {
      ...p,
      source: { ...p.source, batches: rows.map((row) => row.source) },
      batchRows: rows,
    };
    compare(owner.update(next, f.bindings), freshFilteredPlan(next, f.bindings));
  }
  expect(first.plan.batches.map((row) => row.candidates)).toEqual(before);
});
