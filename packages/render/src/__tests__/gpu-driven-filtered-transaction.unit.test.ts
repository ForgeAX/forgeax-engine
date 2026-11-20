import { RhiError } from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { assemblePreparedPlan, prepareBatchRows } from '../gpu-driven/production-raster-prepare';
import type { StableRangeAllocator } from '../stable-range-allocator';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

function fixture() {
  const f = createFilterPlanFixture({ instances: 65 });
  const p = f.prepare();
  const row = p.residentRows[1];
  const first = p.residentRows[0];
  if (row === undefined || first === undefined) throw Error('missing native rows');
  const active: SubmissionPlan = { ...p.source, batches: [first.origin], candidateCount: 65 };
  const partial = assemblePreparedPlan(p.source, [first], active);
  const owner = new FilteredPlanContributionOwner();
  const publication = owner.update(partial);
  const visible = Reflect.get(owner, 'visibleRanges') as StableRangeAllocator;
  const indirect = Reflect.get(owner, 'indirectRanges') as StableRangeAllocator;
  const input = { plan: p.source, index: 1, row, isCurrent: () => true };
  return { ...f, p, row, first, partial, owner, publication, visible, indirect, input };
}

it('prepares one inactive row without publishing or retiring another row and reuses it on activation', () => {
  const f = fixture();
  f.owner.prepareContribution(f.input).unwrap();
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
  expect(Reflect.get(f.owner, 'rows').size).toBe(2);
  const held = Reflect.get(f.owner, 'rows').get(f.row.source.batchId);
  const hidden = f.owner.update(f.partial);
  expect(hidden.active).toBe(f.publication.active);
  expect(hidden.resident.plan.batches).toContain(held.topology[0]);
  const active = { ...f.p.source, batches: [f.first.origin, f.row.origin], candidateCount: 130 };
  const next = f.owner.update(assemblePreparedPlan(f.p.source, [f.first, f.row], active));
  expect(next.active.plan.batches.at(1)).toBe(held.topology[0]);
  expect(next.active.batches.at(1)).toBe(held.batches[0]);
});

it('rolls back only new ranges when the source guard rejects the completed row', () => {
  const f = fixture();
  const before = [f.visible.allocatedEnd(), f.indirect.allocatedEnd()];
  let checks = 0;
  const result = f.owner.prepareContribution({ ...f.input, isCurrent: () => ++checks < 3 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('stale-generation');
  expect(checks).toBe(3);
  expect([f.visible.allocatedEnd(), f.indirect.allocatedEnd()]).toEqual(before);
  expect(Reflect.get(f.owner, 'rows').size).toBe(1);
  expect(Reflect.get(f.owner, 'failure')).toBeUndefined();
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
  expect(f.owner.update(f.partial)).toBe(f.publication);
  f.owner.prepareContribution(f.input).unwrap();
});

it('rolls back a post-allocation assembly exception and preserves the accepted owner', () => {
  const f = fixture();
  const fault = Error('borrowed projection getter failed');
  let fail = false;
  const source = {
    ...f.row.origin,
    get visibleCapacity() {
      if (fail) throw fault;
      return f.row.origin.visibleCapacity;
    },
  };
  const row = prepareBatchRows(
    source,
    { mesh: undefined, execution: { route: 'none' } },
    f.row.origin,
  );
  const before = [f.visible.allocatedEnd(), f.indirect.allocatedEnd()];
  fail = true;
  expect(() => f.owner.prepareContribution({ ...f.input, row })).toThrow(fault);
  expect([f.visible.allocatedEnd(), f.indirect.allocatedEnd()]).toEqual(before);
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
  expect(Reflect.get(f.owner, 'rows').size).toBe(1);
  expect(Reflect.get(f.owner, 'failure')).toBeUndefined();
  expect(f.owner.update(f.partial)).toBe(f.publication);
});

it.each([
  false,
  true,
])('retains unknown allocator effects and blocks reuse (after effect=%s)', (after) => {
  const f = fixture();
  const fault = Error('indirect allocation failed');
  const allocate = f.indirect.allocate.bind(f.indirect);
  const failure = vi.spyOn(f.indirect, 'allocate').mockImplementation((count) => {
    if (after) allocate(count);
    throw fault;
  });
  expect(() => f.owner.prepareContribution(f.input)).toThrow(fault);
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
  const heldFailure = Reflect.get(f.owner, 'failure');
  expect(heldFailure.causes).toContain(fault);
  const transaction = [...heldFailure.transactions][0];
  expect(transaction.ranges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ allocator: f.indirect, state: 'allocating', start: undefined }),
    ]),
  );
  expect(() => f.owner.update(f.partial)).toThrow(RhiError);
  expect(f.owner.prepareContribution(f.input).ok).toBe(false);
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
  failure.mockRestore();
  f.owner.clear();
  expect(Reflect.get(f.owner, 'failure')).toBeUndefined();
  f.owner.update(f.partial);
  f.owner.prepareContribution(f.input).unwrap();
});

it.each([
  false,
  true,
])('attempts both rollback releases and retains ambiguity (after effect=%s)', (after) => {
  const f = fixture();
  const release = f.visible.release.bind(f.visible);
  const visible = vi.spyOn(f.visible, 'release').mockImplementation((start, count) => {
    if (after) release(start, count);
    throw Error('visible release failed');
  });
  const indirect = vi.spyOn(f.indirect, 'release');
  let checks = 0;
  expect(() => f.owner.prepareContribution({ ...f.input, isCurrent: () => ++checks < 3 })).toThrow(
    AggregateError,
  );
  expect(visible).toHaveBeenCalledTimes(1);
  expect(indirect).toHaveBeenCalledTimes(1);
  const transaction = [...Reflect.get(f.owner, 'failure').transactions][0];
  expect(transaction.ranges[0].state).toBe('releasing');
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
  expect(() => f.owner.update(f.partial)).toThrow(RhiError);
  expect(visible).toHaveBeenCalledTimes(1);
});

it('does not resurrect work or release old ranges into an allocator reset by a guard', () => {
  const f = fixture();
  const release = vi.spyOn(f.visible, 'release');
  let checks = 0;
  const result = f.owner.prepareContribution({
    ...f.input,
    isCurrent: () => {
      if (++checks === 3) f.owner.clear();
      return true;
    },
  });
  expect(result.ok).toBe(false);
  expect(release).not.toHaveBeenCalled();
  expect(Reflect.get(f.owner, 'publication')).toBeUndefined();
  expect(Reflect.get(f.owner, 'rows').size).toBe(0);
  const restored = f.owner.update(f.partial);
  expect(restored.active.plan.batches.at(0)?.visibleBase).toBe(0);
  expect(restored.active.plan.batches.at(0)?.generation).toBeGreaterThan(
    f.publication.active.plan.batches.at(0)?.generation ?? -1,
  );
});

it('rejects callback reentry without clearing the outer accepted cache', () => {
  const f = fixture();
  f.owner
    .prepareContribution({
      ...f.input,
      isCurrent: () => {
        expect(() => f.owner.update(f.partial)).toThrow(RhiError);
        expect(f.owner.prepareContribution(f.input).ok).toBe(false);
        expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
        return true;
      },
    })
    .unwrap();
  expect(Reflect.get(f.owner, 'rows').size).toBe(2);
});

it('refuses active replacement, raw plans and copied rows before allocating a window', () => {
  const f = fixture();
  const allocate = vi.spyOn(f.visible, 'allocate');
  const raw = { ...f.input.plan };
  for (const input of [
    { ...f.input, index: 0, row: f.first },
    { ...f.input, plan: raw },
    { ...f.input, row: { ...f.row } },
    { ...f.input, index: -1 },
  ])
    expect(f.owner.prepareContribution(input).ok).toBe(false);
  expect(allocate).not.toHaveBeenCalled();
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
});

it('retires only its own inactive row for an explicit negative Pass contribution', () => {
  const f = fixture();
  f.owner.prepareContribution(f.input).unwrap();
  f.owner.prepareContribution({ ...f.input, row: undefined }).unwrap();
  expect(Reflect.get(f.owner, 'rows').size).toBe(1);
  expect(Reflect.get(f.owner, 'windows').size).toBe(1);
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
  expect(f.owner.update(f.partial)).toBe(f.publication);
});

it.each([
  'negative',
  'replacement',
] as const)('rejects source loss during %s old-window retirement', (kind) => {
  const f = fixture();
  f.owner.prepareContribution(f.input).unwrap();
  let current = true;
  const release = f.visible.release.bind(f.visible);
  const retired = vi.spyOn(f.visible, 'release').mockImplementation((start, count) => {
    release(start, count);
    current = false;
  });
  const row =
    kind === 'negative'
      ? undefined
      : prepareBatchRows(
          {
            ...f.row.origin,
            lod: {
              coverages: [0.5, 0.2, 0.1],
              ranges: [
                { first: 3, count: 3, baseVertex: 0 },
                { first: 6, count: 3, baseVertex: 0 },
              ],
            },
          },
          { mesh: undefined, execution: { route: 'none' } },
          f.row.origin,
        );
  const result = f.owner.prepareContribution({ ...f.input, row, isCurrent: () => current });
  expect(retired).toHaveBeenCalled();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('stale-generation');
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
  expect(f.owner.update(f.partial).active).toBe(f.publication.active);
});

it('protects accepted active membership after the caller mutates a raw source array', () => {
  const f = fixture();
  const batches = [f.first.origin];
  const raw = { ...f.p.source, batches, candidateCount: 65 };
  const owner = new FilteredPlanContributionOwner();
  const publication = owner.update(assemblePreparedPlan(raw, [f.first]));
  batches.length = 0;
  const row = prepareBatchRows(
    { ...f.first.origin, lod: { coverages: [0.5, 0.2] } },
    { mesh: undefined, execution: { route: 'none' } },
    f.first.origin,
  );
  const result = owner.prepareContribution({ ...f.input, index: 0, row });
  expect(result.ok).toBe(false);
  expect(Reflect.get(owner, 'publication')).toBe(publication);
  expect(Reflect.get(owner, 'rows').get(f.first.source.batchId).row).toBe(f.first);
});

function duplicatedSource() {
  const f = fixture();
  const other = f.p.residentRows[2];
  if (other === undefined) throw Error('missing third raw contribution');
  const repeated = {
    ...f.row,
    source: { ...f.row.source, batchId: f.first.source.batchId },
    origin: { ...f.row.origin, batchId: f.first.source.batchId },
  };
  const raw = { ...f.p.source, batches: [f.first.origin, repeated.origin, other.origin] };
  const owner = new FilteredPlanContributionOwner();
  const publication = owner.update(
    assemblePreparedPlan(raw, [f.first, repeated, other]),
    f.bindings,
  );
  return { ...f, owner, publication };
}

it('does not reuse a removed duplicate partition before the ordinary pass finishes', () => {
  const f = duplicatedSource();
  const batches = [...f.publication.active.plan.batches];
  expect(batches).toHaveLength(3);
  expect(new Set(batches.map((batch) => batch.visibleBase)).size).toBe(3);
  expect(new Set(batches.map((batch) => batch.indirectOffset)).size).toBe(3);
  expect(new Set(batches.map((batch) => batch.batchId)).size).toBe(3);
});

it('does not lend an old active duplicate window to a background contribution', () => {
  const f = duplicatedSource();
  const result = f.owner.prepareContribution(f.input);
  expect(result.ok).toBe(false);
  expect(Reflect.get(f.owner, 'publication')).toBe(f.publication);
  expect(Reflect.get(f.owner, 'rows').has(f.row.source.batchId)).toBe(false);
});
