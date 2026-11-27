import { expect, it, vi } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { assemblePreparedPlan } from '../gpu-driven/production-raster-prepare';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

function selection(source: SubmissionPlan, indices: readonly number[]): SubmissionPlan {
  const batches = indices.map((index) => {
    const batch = source.batches.at(index);
    if (batch === undefined) throw Error('missing execution contribution');
    return batch;
  });
  return {
    ...source,
    batches,
    candidateCount: batches.reduce((count, batch) => count + batch.candidates.length, 0),
  };
}

it('preserves exact inactive native contributions omitted from this pass preparation', () => {
  const f = createFilterPlanFixture({ instances: 65 });
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const initial = owner.update(p);
  const counters = { ...owner.windowCounters };
  const scan = vi.spyOn(MemberCandidates.prototype, Symbol.iterator);
  try {
    for (let cycle = 0; cycle < 5; cycle++) {
      const partial = assemblePreparedPlan(
        p.residentSource,
        p.residentRows.slice(0, 1),
        selection(p.source, [0]),
      );
      const next = owner.update(partial);
      expect(next.resident).toBe(initial.resident);
      expect(next.active.batches).toEqual(initial.active.batches.slice(0, 1));
      expect(next.active.plan.candidateCount).toBe(65);
      expect(owner.update(p).resident).toBe(initial.resident);
    }
    expect(scan).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
  }
  expect(owner.windowCounters).toEqual(counters);
});

it('withdraws a cached pass when its exact native contribution is active but no longer prepared', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const before = owner.update(p);
  const hidden = owner.update(
    assemblePreparedPlan(p.source, p.residentRows.slice(0, 1), selection(p.source, [0])),
  );
  expect(hidden.resident).toBe(before.resident);
  const noPass = owner.update(assemblePreparedPlan(p.source, p.residentRows.slice(0, 1)));
  expect(noPass.active).toBe(noPass.resident);
  expect(noPass.active.batches).toEqual(before.active.batches.slice(0, 1));
  expect(Reflect.get(owner, 'rows').size).toBe(1);
});

it('does not retain missing contributions across an object binding change', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  owner.update(p, f.bindings);
  const partial = assemblePreparedPlan(
    p.source,
    p.residentRows.slice(0, 1),
    selection(p.source, [0]),
  );
  const changed = owner.update(partial, new Map([['1', 'replacement']]));
  expect(changed.resident.plan.batches.length).toBe(1);
  expect(Reflect.get(owner, 'rows').size).toBe(1);
});

it('does not infer unchanged inactive binding facts from a mutable Map identity', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  owner.update(p, f.bindings);
  f.bindings.set('2', 'replacement');
  const partial = assemblePreparedPlan(
    p.source,
    p.residentRows.slice(0, 1),
    selection(p.source, [0]),
  );
  const next = owner.update(partial, f.bindings);
  expect(next.resident.plan.batches.length).toBe(1);
  expect(Reflect.get(owner, 'rows').size).toBe(1);
});

it('retires omitted raw observations instead of treating readonly identity as native custody', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const raw = { ...p.source };
  const owner = new FilteredPlanContributionOwner();
  owner.update(assemblePreparedPlan(raw, p.residentRows));
  const next = owner.update(
    assemblePreparedPlan(raw, p.residentRows.slice(0, 1), selection(raw, [0])),
  );
  expect(next.resident.plan.batches.length).toBe(1);
});

it.each([
  'repeat',
  'reverse',
] as const)('preserves ordinary %s rows with a native source', (kind) => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p);
  const rows = (kind === 'repeat' ? [0, 0] : [1, 0]).map((index) => {
    const row = p.residentRows[index];
    if (row === undefined) throw Error('missing source row');
    return row;
  });
  const next = owner.update(assemblePreparedPlan(p.source, rows));
  expect(next.active).toBe(next.resident);
  expect(next.active.plan.candidateCount).toBe(4);
  expect(next.active.plan.batches).toEqual([
    first.active.plan.batches.at(kind === 'repeat' ? 0 : 1),
    first.active.plan.batches.at(0),
  ]);
});

it('uses the fresh complete native roster to retire a removed inactive row without moving survivors', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const before = owner.update(p);
  const activeOrigin = p.source.batches.at(0);
  const removed = f.slots.at(1);
  if (activeOrigin === undefined || removed === undefined) throw Error('missing native rows');
  const partial = () => {
    const resident = f.topology.query(f.topology.sourcePlan(), undefined).resident;
    const index = [...resident.batches].indexOf(activeOrigin);
    if (index < 0) throw Error('missing native survivor');
    return assemblePreparedPlan(resident, p.residentRows.slice(0, 1), selection(resident, [index]));
  };
  expect(owner.update(partial()).resident).toBe(before.resident);
  f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: removed.entityKey }]));
  const retired = owner.update(partial());
  expect(retired.resident.plan.batches).toEqual([
    before.resident.plan.batches.at(0),
    before.resident.plan.batches.at(2),
  ]);
  expect(Reflect.get(owner, 'rows').size).toBe(2);
  f.topology.apply(
    f.scene.apply([{ kind: 'update', entityKey: removed.entityKey, snapshot: removed.snapshot }]),
  );
  const reinserted = owner.update(partial());
  expect(reinserted.resident.plan.batches).toEqual(retired.resident.plan.batches);
  expect(reinserted.resident.plan.revision).toBeGreaterThan(retired.resident.plan.revision);
  expect(Reflect.get(owner, 'rows').size).toBe(2);
  const complete = f.topology.query(f.topology.sourcePlan(), undefined).resident;
  const rebuilt = owner.update(f.prepare(complete));
  expect(rebuilt.resident.batches).toHaveLength(3);
  const survivors = [before.resident.plan.batches.at(0), before.resident.plan.batches.at(2)];
  for (const survivor of survivors) {
    if (survivor === undefined) throw Error('missing survivor');
    const current = [...rebuilt.resident.plan.batches].find(
      (batch) => batch.batchId === survivor.batchId,
    );
    expect(current).toMatchObject({
      generation: survivor.generation,
      visibleBase: survivor.visibleBase,
      indirectOffset: survivor.indirectOffset,
    });
  }
  const added = [...rebuilt.resident.plan.batches].find((batch) =>
    survivors.every((survivor) => survivor?.batchId !== batch.batchId),
  );
  expect(added?.generation).toBeGreaterThan(before.resident.plan.batches.at(1)?.generation ?? -1);
});
