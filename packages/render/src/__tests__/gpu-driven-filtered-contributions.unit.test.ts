import { expect, it } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import {
  expectFilteredPlanContent as compare,
  createFilterPlanFixture,
  freshFilteredPlan,
} from './gpu-driven-filter-plan-fixture';

it('retains the accepted publication and geometry arrays on an unchanged frame', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p, f.bindings);
  for (let frame = 0; frame < 60; frame++) expect(owner.update({ ...p }, f.bindings)).toBe(first);
  expect(owner.lastWork).toMatchObject({
    projectedBatches: 0,
    projectedCandidates: 0,
    reusedGroups: 3,
  });
  expect(first.plan.batches.at(0)?.candidates).toBe(p.source.batches.at(0)?.candidates);
});

it('rebuilds only changed material execution while retaining object partitions and physical windows', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p, f.bindings);
  const next = {
    ...p,
    batchRows: p.batchRows.map((row, index) =>
      index === 1
        ? {
            ...row,
            fact:
              row.fact === undefined
                ? undefined
                : { ...row.fact, rasterClassKey: 'replacement-program' },
          }
        : row,
    ),
  };
  const accepted = owner.update(next, f.bindings);
  compare(accepted, freshFilteredPlan(next, f.bindings));
  expect(owner.lastWork).toMatchObject({
    projectedBatches: 1,
    projectedCandidates: 0,
    reusedGroups: 2,
  });
  expect(accepted.batches.at(0)).toBe(first.batches.at(0));
  expect(accepted.batches.at(2)).toBe(first.batches.at(2));
  expect(accepted.plan.batches.at(1)?.candidates).toBe(first.plan.batches.at(1)?.candidates);
  expect(accepted.plan.batches.at(1)?.visibleBase).toBe(first.plan.batches.at(1)?.visibleBase);
  expect(accepted.plan.batches.at(1)?.indirectOffset).toBe(
    first.plan.batches.at(1)?.indirectOffset,
  );
});

it('adopts replacement object-binding publications without changing their prior accepted result', () => {
  const f = createFilterPlanFixture({ sharedGeometry: true });
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p, f.bindings);
  const original = first.plan.batches.map((row) => row.candidates);
  const replacement = new Map(f.bindings);
  replacement.set('0:1', 'C');
  const next = owner.update(p, replacement);
  compare(next, freshFilteredPlan(p, replacement));
  expect(next.plan.batches).toHaveLength(3);
  expect(first.plan.batches.map((row) => row.candidates)).toEqual(original);
  expect(owner.lastWork.projectedCandidates).toBe(6);
  compare(owner.update(p, f.bindings), freshFilteredPlan(p, f.bindings));
});

it('advances source revision while preserving unchanged prepared rows', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p);
  const next = { ...p, source: { ...p.source, revision: p.source.revision + 1 } };
  const accepted = owner.update(next);
  expect(accepted.plan.revision).toBe(next.source.revision);
  expect(first.plan.revision).toBe(p.source.revision);
  accepted.batches.forEach((row, index) => {
    expect(row).toBe(first.batches.at(index));
  });
  expect(owner.lastWork.projectedBatches).toBe(0);
  compare(accepted, freshFilteredPlan(next));
});
