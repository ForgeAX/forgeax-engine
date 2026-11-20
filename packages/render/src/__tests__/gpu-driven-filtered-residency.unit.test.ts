import { expect, it, vi } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import { BatchTopology, type SubmissionPlan } from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import {
  assemblePreparedPlan,
  type PreparedProductionPlan,
} from '../gpu-driven/production-raster-prepare';
import { RenderScene } from '../scene/render-scene';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

function select(prepared: PreparedProductionPlan, indices: readonly number[]) {
  const batches = indices.map((index) => {
    const batch = prepared.residentSource.batches.at(index);
    if (batch === undefined) throw new Error('missing resident contribution');
    return batch;
  });
  const source: SubmissionPlan = {
    ...prepared.residentSource,
    batches,
    candidateCount: batches.reduce((count, batch) => count + batch.candidates.length, 0),
  };
  return assemblePreparedPlan(prepared.residentSource, prepared.residentRows, source);
}

it.each([
  false,
  true,
])('retains resident filtered partitions and exact windows across execution selection (bindings=%s)', (partitioned) => {
  const f = createFilterPlanFixture({ instances: 65 });
  const prepared = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const bindings = partitioned ? f.bindings : undefined;
  const initial = owner.update(prepared, bindings);
  expect(initial.active).toBe(initial.resident);
  const counters = { ...owner.windowCounters };
  const scan = vi.spyOn(MemberCandidates.prototype, Symbol.iterator);
  try {
    for (let cycle = 0; cycle < 12; cycle++) {
      const hidden = owner.update(select(prepared, []), bindings);
      expect(hidden.resident).toBe(initial.resident);
      expect(hidden.active.batches).toHaveLength(0);
      expect(hidden.active.plan.candidateCount).toBe(0);
      const active = owner.update(select(prepared, [1]), bindings);
      expect(active.resident).toBe(initial.resident);
      for (const batch of active.active.batches) {
        expect(initial.resident.batches.includes(batch)).toBe(true);
        expect(batch.batch.candidates).toBe(
          initial.resident.batches.find((held) => held === batch)?.batch.candidates,
        );
      }
      const restored = owner.update(prepared, bindings);
      expect(restored.resident).toBe(initial.resident);
      expect(restored.active).toBe(initial.resident);
    }
    expect(scan).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
  }
  expect(owner.windowCounters).toEqual(counters);
});

it('takes the actual Mesh execution pair through prepared origins and filtered selection without re-querying it as source', () => {
  const f = createFilterPlanFixture();
  const scene = new RenderScene();
  const topology = new BatchTopology();
  const group = topology.createResidencyGroup();
  topology.apply(
    scene.apply(
      f.slots.map((slot, index) => ({
        kind: 'update' as const,
        entityKey: slot.entityKey,
        snapshot: { ...slot.snapshot, ...(index === 0 ? {} : { residencyGroup: group }) },
      })),
    ),
  );
  const before = topology.query(topology.sourcePlan(), undefined);
  expect(before.resident.batches.length).toBe(3);
  expect(before.active.batches.length).toBe(1);
  expect(before.resident.resident).toBeUndefined();
  expect(before.active.resident).toBeUndefined();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(f.prepare(before.resident, before.active));
  expect(first.resident.batches.length).toBe(3);
  expect(first.active.batches.length).toBe(1);
  topology.setResidencyGroupActive(group, true);
  const after = topology.query(topology.sourcePlan(), undefined);
  expect(after.resident).toBe(before.resident);
  expect(after.active).toBe(after.resident);
  const enabled = owner.update(f.prepare(after.resident, after.active));
  expect(
    enabled.resident.plan.batches.map((batch) => [
      batch.batchId,
      batch.generation,
      batch.visibleBase,
      batch.indirectOffset,
    ]),
  ).toEqual(
    first.resident.plan.batches.map((batch) => [
      batch.batchId,
      batch.generation,
      batch.visibleBase,
      batch.indirectOffset,
    ]),
  );
  expect(enabled.active.batches.length).toBe(3);
});

it('keeps an unready resident contribution from producing active filtered draws', () => {
  const f = createFilterPlanFixture();
  const ready = f.prepare();
  const rows = ready.residentRows.map((row, index) =>
    index === 1 ? Object.freeze({ ...row, fact: undefined }) : row,
  );
  const pending = assemblePreparedPlan(ready.residentSource, rows);
  const owner = new FilteredPlanContributionOwner();
  const selected = owner.update(select(pending, [0]));
  expect(selected.resident.plan.batches.length).toBe(3);
  expect(selected.resident.batches.length).toBe(2);
  expect(selected.active.plan.batches.length).toBe(1);
  expect(selected.active.batches.length).toBe(1);
  expect(selected.active.batches[0]).toBe(selected.resident.batches[0]);
  const unready = owner.update(select(pending, [1]));
  expect(unready.active.batches.length).toBe(0);
  expect(unready.active.plan.batches.at(0)?.visibleCapacity).toBe(0);
});

it('rejects copied execution contributions and stale prepared origins before mutating the window owner', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const source = prepared.residentSource;
  const first = source.batches.at(0);
  if (first === undefined) throw new Error('missing contribution');
  const copied = { ...source, batches: [{ ...first }] };
  expect(() => assemblePreparedPlan(source, prepared.residentRows, copied)).toThrow(
    'exact resident execution',
  );
  const active = select(prepared, [0]).source;
  const stale = prepared.residentRows.map((row, index) =>
    index === 0 ? { ...row, origin: { ...row.origin } } : row,
  );
  expect(() => assemblePreparedPlan(source, stale, active)).toThrow(
    'lost its resident execution origin',
  );
  const owner = new FilteredPlanContributionOwner();
  const current = owner.update(prepared);
  expect(owner.update(prepared)).toBe(current);
});

it('retires only real resident removals and preserves surviving physical windows', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const before = owner.update(prepared);
  const survivingOrigin = prepared.residentSource.batches.at(2);
  const survivingRow = prepared.residentRows.at(2);
  if (survivingOrigin === undefined || survivingRow === undefined)
    throw new Error('missing survivor');
  const source = {
    ...prepared.residentSource,
    batches: [survivingOrigin],
    candidateCount: survivingOrigin.candidates.length,
  };
  const after = owner.update(assemblePreparedPlan(source, [survivingRow]));
  expect(after.resident.plan.batches.at(0)).toBe(before.resident.plan.batches.at(2));
  const row = prepared.residentRows.at(0);
  if (row === undefined) throw new Error('missing retired row');
  const origin = Object.freeze({ ...row.origin, generation: row.origin.generation + 1 });
  const replacement = Object.freeze({
    ...row,
    origin,
    source: Object.freeze({ ...row.source, generation: origin.generation }),
  });
  const next = {
    ...source,
    batches: [origin, survivingOrigin],
    candidateCount: origin.candidates.length + survivingOrigin.candidates.length,
  };
  const readded = owner.update(assemblePreparedPlan(next, [replacement, survivingRow]));
  expect(readded.resident.plan.batches.at(1)).toBe(after.resident.plan.batches.at(0));
  expect(readded.resident.plan.batches.at(0)?.generation).toBeGreaterThan(
    before.resident.plan.batches.at(0)?.generation ?? -1,
  );
});

it('drops all retired resident rows, windows and publications without requiring another partition', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const before = owner.update(select(prepared, []));
  expect(before.resident.plan.batches.length).toBe(3);
  const empty = { ...prepared.residentSource, batches: [], candidateCount: 0, visibleCapacity: 0 };
  const after = owner.update(assemblePreparedPlan(empty, []));
  expect(after.active).toBe(after.resident);
  expect(after.resident.plan.batches.length).toBe(0);
  for (const field of ['rows', 'geometry', 'prepared', 'windows'])
    expect(Reflect.get(owner, field).size).toBe(0);
  expect(Reflect.get(owner, 'publication')).toBe(after);
  owner.clear();
  expect(Reflect.get(owner, 'publication')).toBeUndefined();
});

it('rejects repeated or reordered active contributions instead of silently rewriting their count or order', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const first = prepared.residentSource.batches.at(0);
  const last = prepared.residentSource.batches.at(2);
  if (first === undefined || last === undefined) throw new Error('missing source contributions');
  for (const batches of [
    [first, first],
    [last, first],
  ]) {
    const source = {
      ...prepared.residentSource,
      batches,
      candidateCount: batches.reduce((count, batch) => count + batch.candidates.length, 0),
    };
    expect(() =>
      assemblePreparedPlan(prepared.residentSource, prepared.residentRows, source),
    ).toThrow('unique source order');
  }
  const ordinary = assemblePreparedPlan(
    { ...prepared.source, batches: [first, first] },
    [prepared.residentRows[0], prepared.residentRows[0]].filter((row) => row !== undefined),
  );
  expect(ordinary.batchRows.length).toBe(2); // Existing raw ordinary inputs keep their explicit duplicate observation contract.
});

it('refuses a mismatched active candidate total or reordered resident preparation rows', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const active = select(prepared, [0]).source;
  expect(() =>
    assemblePreparedPlan(prepared.residentSource, prepared.residentRows, {
      ...active,
      candidateCount: active.candidateCount + 1,
    }),
  ).toThrow('candidate total');
  expect(() =>
    assemblePreparedPlan(prepared.residentSource, [...prepared.residentRows].reverse(), active),
  ).toThrow('origin or order');
});

it('rejects an ambiguous ordinary preparation before changing accepted rows or windows', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const accepted = owner.update(prepared);
  const ambiguous = {
    ...prepared,
    batchRows: prepared.batchRows.map((row) => ({ ...row, fact: undefined })),
  };
  expect(() => owner.update(ambiguous)).toThrow('owned assemblePreparedPlan result');
  expect(owner.update(prepared)).toBe(accepted);
  expect(owner.windowCounters).toEqual({ relocations: 0, compactions: 0 });
});

it('rejects a forged explicit empty selection before replacing an accepted resident publication', () => {
  const f = createFilterPlanFixture();
  const prepared = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const accepted = owner.update(prepared);
  const forged = { ...prepared, source: { ...prepared.source }, batchRows: [] };
  expect(() => owner.update(forged)).toThrow('owned assemblePreparedPlan result');
  expect(() => owner.update(Object.freeze({ ...prepared }))).toThrow(
    'owned assemblePreparedPlan result',
  );
  expect(owner.update(prepared)).toBe(accepted);
});
