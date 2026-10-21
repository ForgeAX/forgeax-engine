import { expect, it, vi } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { assemblePreparedPlan, prepareBatchRows } from '../gpu-driven/production-raster-prepare';
import {
  expectFilteredPlanContent as compare,
  createFilterPlanFixture,
  freshFilteredPlan,
} from './gpu-driven-filter-plan-fixture';

it('discards a partial failed projection and preserves the last returned immutable publication', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p, f.bindings);
  const before = first.plan.batches.map((row) => [
    row.visibleBase,
    row.indirectOffset,
    row.candidates,
  ]);
  const fault = Error('material execution preparation failed');
  let fail = true;
  const changed = {
    ...p,
    batchRows: p.batchRows.map((row, index) =>
      index === 1
        ? {
            ...row,
            get fact() {
              if (fail) throw fault;
              return row.fact;
            },
          }
        : { ...row },
    ),
  };
  expect(() => owner.update(changed, f.bindings)).toThrow(fault);
  expect(
    first.plan.batches.map((row) => [row.visibleBase, row.indirectOffset, row.candidates]),
  ).toEqual(before);
  fail = false;
  const next = owner.update(changed, f.bindings);
  compare(next, freshFilteredPlan(changed, f.bindings));
  expect(owner.lastWork.projectedBatches).toBe(3);
});

it('keeps geometry capacity while material execution uses the direct lane and reuses it on return', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p);
  const direct = {
    ...p,
    batchRows: p.batchRows.map((row, index) => (index === 1 ? { ...row, fact: undefined } : row)),
  };
  const off = owner.update(direct);
  expect(off.batches).toHaveLength(2);
  expect(off.plan.batches).toHaveLength(3);
  const source = f.slots.at(1);
  if (!source) throw Error('missing source');
  expect(off.selection.has(source.snapshot, 0)).toBe(false);
  const restored = owner.update(p);
  compare(restored, freshFilteredPlan(p));
  expect(restored.plan.batches.at(1)?.visibleBase).toBe(first.plan.batches.at(1)?.visibleBase);
  expect(restored.plan.batches.at(1)?.indirectOffset).toBe(
    first.plan.batches.at(1)?.indirectOffset,
  );
});

it('retains native LOD projection without reading candidate rows on a quiet update', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p);
  expect(first.plan.batches.at(0)?.lod).toBeDefined();
  expect(first.projectionSource).toBe(first.plan);
  const read = vi.spyOn(MemberCandidates.prototype, Symbol.iterator).mockImplementation(() => {
    throw Error('quiet native LOD must not enumerate candidates');
  });
  try {
    expect(owner.update(p)).toBe(first);
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it('captures direct-lane LOD before source edits and preserves its window on GPU recovery', () => {
  const f = createFilterPlanFixture();
  const native = f.source.batches.at(0);
  if (native === undefined) throw Error('missing source');
  const coverages = [0.5, 0.1];
  const range = { first: 3, count: 3, baseVertex: 0 };
  const source = { ...native, lod: { coverages, ranges: [range], hysteresis: 0.1 } };
  const prepare = () =>
    assemblePreparedPlan(
      { ...f.source, batches: [source] },
      [
        prepareBatchRows(source, {
          mesh: undefined,
          worldKeys: undefined,
          execution: { route: 'none' },
        }),
      ],
      undefined,
    );
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(prepare());
  const old = first.plan.batches.at(0);
  expect(old?.lod).not.toBe(source.lod);
  expect(first.projectionSource).toBe(first.plan);
  coverages[1] = 0.2;
  range.count = 6;
  const next = owner.update(prepare());
  expect(old?.lod?.coverages).toEqual([0.5, 0.1]);
  expect(old?.lod?.ranges?.[0]?.count).toBe(3);
  expect(next.plan.batches.at(0)?.lod?.coverages).toEqual([0.5, 0.2]);
  const restored = owner.update(f.prepare({ ...f.source, batches: [source] }));
  expect(restored.batches).toHaveLength(1);
  expect(restored.plan.batches.at(0)?.visibleBase).toBe(old?.visibleBase);
  expect(restored.plan.batches.at(0)?.indirectOffset).toBe(old?.indirectOffset);
});
