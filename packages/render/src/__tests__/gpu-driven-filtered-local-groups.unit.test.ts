import { expect, it, vi } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { filteredPlan } from '../gpu-driven/production-raster-prepare';
import { StableRangeAllocator } from '../stable-range-allocator';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';
import { expectFilteredPlan } from './gpu-driven-filtered-plan-assertions';

it('keeps unchanged merged allocations out of local contribution preparation', () => {
  const fixture = createFilterPlanFixture();
  const input = fixture.prepare();
  const prepared = {
    ...input,
    batchRows: input.batchRows.map((row) => ({
      ...row,
      facts: new Map(
        [...row.facts].map(([slot, draws]) => [
          slot,
          new Map(
            [...draws].map(([index, fact]) => [
              index,
              fact === undefined ? undefined : { ...fact, lod: undefined },
            ]),
          ),
        ]),
      ),
    })),
  };
  const owner = new FilteredPlanContributionOwner();
  const original = owner.update(prepared, 'current-values', undefined, fixture.bindings);
  // Only the first material group consumes this source partition. Its sibling
  // still needs descriptor observation during assembly, but no range sizing.
  const changed = {
    ...prepared,
    batchRows: prepared.batchRows.map((row, index) =>
      index === 1 ? { ...row, facts: new Map(row.facts) } : row,
    ),
  };
  const allocate = vi.spyOn(StableRangeAllocator.prototype, 'allocate');
  try {
    const next = owner.update(changed, 'current-values', undefined, fixture.bindings);
    expectFilteredPlan(next, filteredPlan(changed, undefined, fixture.bindings));
    expect(owner.lastWork).toMatchObject({ projectedBatches: 1, reusedGroups: 1 });
    expect(allocate).not.toHaveBeenCalled();
    expect(next.plan.batches[1]?.candidates).toBe(original.plan.batches[1]?.candidates);
    expect(next.plan.batches[1]?.visibleBase).toBe(original.plan.batches[1]?.visibleBase);
    expect(next.plan.batches[1]?.indirectOffset).toBe(original.plan.batches[1]?.indirectOffset);
  } finally {
    allocate.mockRestore();
  }
});

it('keeps borrowed LOD observations live when an unchanged sibling group is assembled', () => {
  const fixture = createFilterPlanFixture();
  const input = fixture.prepare();
  let fail = false;
  const failure = new Error('borrowed LOD observation');
  const coverages = new Proxy([1, 0.5], {
    get(target, key, receiver) {
      if (fail && key === 'length') throw failure;
      return Reflect.get(target, key, receiver);
    },
  });
  const prepared = {
    ...input,
    batchRows: input.batchRows.map((row) => ({
      ...row,
      facts: new Map(
        [...row.facts].map(([slot, draws]) => [
          slot,
          new Map(
            [...draws].map(([index, fact]) => [
              index,
              fact === undefined || slot !== 1
                ? fact
                : { ...fact, lod: { ...fact.lod, coverages } },
            ]),
          ),
        ]),
      ),
    })),
  };
  const owner = new FilteredPlanContributionOwner();
  const original = owner.update(prepared, 'current-values', undefined, fixture.bindings);
  const changed = {
    ...prepared,
    batchRows: prepared.batchRows.map((row, index) =>
      index === 1 ? { ...row, facts: new Map(row.facts) } : row,
    ),
  };
  fail = true;
  expect(() => owner.update(changed, 'current-values', undefined, fixture.bindings)).toThrow(
    failure,
  );
  fail = false;
  const retry = owner.update(changed, 'current-values', undefined, fixture.bindings);
  expectFilteredPlan(retry, filteredPlan(changed, undefined, fixture.bindings));
  expect(retry.plan.candidateCount).toBe(original.plan.candidateCount);
  expect(owner.lastWork.projectedBatches).toBe(changed.batchRows.length);
});
