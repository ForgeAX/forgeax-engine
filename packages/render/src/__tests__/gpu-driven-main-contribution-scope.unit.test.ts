import { expect, it } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { assemblePreparedPlan } from '../gpu-driven/production-raster-prepare';
import {
  expectFilteredPlanContent as compare,
  createFilterPlanFixture,
  freshFilteredPlan,
} from './gpu-driven-filter-plan-fixture';

it('depends on accepted execution and bindings without a caller-maintained version fence', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p).active;
  expect(
    owner.update(assemblePreparedPlan(p.residentSource, p.residentRows), new Map()).active,
  ).toBe(first);
  const next = assemblePreparedPlan(
    p.residentSource,
    p.residentRows.map((row, index) => (index === 0 ? { ...row, fact: undefined } : row)),
  );
  const accepted = owner.update(next).active;
  expect(accepted.batches).toHaveLength(2);
  compare(accepted, freshFilteredPlan(next));
  expect(owner.lastWork.projectedCandidates).toBe(0);
});
