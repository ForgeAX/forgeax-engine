import { expect, it, vi } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { assemblePreparedPlan } from '../gpu-driven/production-raster-prepare';
import { StableRangeAllocator } from '../stable-range-allocator';
import {
  expectFilteredPlanContent as compare,
  createFilterPlanFixture,
  freshFilteredPlan,
} from './gpu-driven-filter-plan-fixture';

it('does not allocate geometry windows for a local material replacement', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p, f.bindings).active;
  const next = assemblePreparedPlan(
    p.residentSource,
    p.residentRows.map((row, index) => (index === 1 ? { ...row } : row)),
  );
  const expected = freshFilteredPlan(next, f.bindings);
  const allocate = vi.spyOn(StableRangeAllocator.prototype, 'allocate');
  try {
    const result = owner.update(next, f.bindings).active;
    compare(result, expected);
    expect(allocate).not.toHaveBeenCalled();
    expect(result.batches.at(0)).toBe(first.batches.at(0));
    expect(result.batches.at(2)).toBe(first.batches.at(2));
  } finally {
    allocate.mockRestore();
  }
});
