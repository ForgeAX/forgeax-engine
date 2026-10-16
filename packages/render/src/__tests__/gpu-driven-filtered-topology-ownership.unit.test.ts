import { expect, it, vi } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

it.each([
  false,
  true,
])('observes a borrowed sibling descriptor during local assembly (frozen LOD: %s)', (frozen) => {
  const fixture = createFilterPlanFixture();
  const source = {
    ...fixture.source,
    batches: fixture.source.batches.map((batch, index) => {
      const { lod, ...facts } = batch;
      return {
        ...facts,
        ...(frozen ? { lod } : {}),
        candidates: batch.candidates.filter((candidate) =>
          index === 2 ? candidate.primitiveIndex === 1 : candidate.primitiveIndex !== 1,
        ),
      };
    }),
  };
  const prepared = fixture.prepare(source);
  const sibling = prepared.batchRows[2]?.source;
  if (sibling === undefined) throw Error('Missing sibling');
  const capacity = sibling.visibleCapacity;
  let fail = false;
  const failure = new Error('borrowed source visibleCapacity');
  Object.defineProperty(sibling, 'visibleCapacity', {
    enumerable: true,
    get() {
      if (fail) throw failure;
      return capacity;
    },
  });
  if (frozen) {
    for (const row of prepared.batchRows) {
      Object.freeze(row.source.key);
      row.source.candidates.forEach(Object.freeze);
      Object.freeze(row.source.candidates);
      if (row.source.prepared !== undefined) {
        Object.freeze(row.source.prepared.identity);
        Object.freeze(row.source.prepared);
      }
      for (const draws of row.facts.values()) {
        for (const fact of draws.values()) {
          if (fact?.lod === undefined) continue;
          Object.freeze(fact.lod.coverages);
          fact.lod.ranges?.forEach(Object.freeze);
          if (fact.lod.ranges !== undefined) Object.freeze(fact.lod.ranges);
          Object.freeze(fact.lod);
        }
      }
      Object.freeze(row.source);
    }
  }
  const owner = new FilteredPlanContributionOwner();
  owner.update(prepared, 'current-values', undefined, fixture.bindings);
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
  // Rejection retires the partial attempt; the same input can be admitted later.
  fail = false;
  const retry = owner.update(changed, 'current-values', undefined, fixture.bindings);
  expect(retry.plan.candidateCount).toBe(4);
  expect(owner.lastWork.projectedBatches).toBe(3);
});

it.each(['every', 'some'])('does not certify LOD arrays with a custom %s getter', (method) => {
  const fixture = createFilterPlanFixture();
  const input = fixture.prepare();
  const read = vi.fn(() => {
    throw new Error('custom array method must not be observed');
  });
  const ranges = [Object.freeze({ first: 3, count: 3, baseVertex: 0 })];
  Object.defineProperty(ranges, method, { get: read });
  Object.freeze(ranges);
  const prepared = {
    ...input,
    batchRows: input.batchRows.map((row) => {
      Object.freeze(row.source.key);
      row.source.candidates.forEach(Object.freeze);
      Object.freeze(row.source.candidates);
      Object.freeze(row.source.lod?.coverages);
      Object.freeze(row.source);
      return {
        ...row,
        facts: new Map(
          [...row.facts].map(([slot, draws]) => [
            slot,
            new Map(
              [...draws].map(([index, fact]) => [
                index,
                fact?.lod === undefined || slot !== 1
                  ? fact
                  : { ...fact, lod: Object.freeze({ ...fact.lod, ranges }) },
              ]),
            ),
          ]),
        ),
      };
    }),
  };
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(prepared, 'current-values', undefined, fixture.bindings);
  const changed = {
    ...prepared,
    batchRows: prepared.batchRows.map((row, index) =>
      index === 1 ? { ...row, facts: new Map(row.facts) } : row,
    ),
  };
  const next = owner.update(changed, 'current-values', undefined, fixture.bindings);
  expect(read).not.toHaveBeenCalled();
  expect(next.batches[1]).not.toBe(first.batches[1]);
  expect(next.plan.batches[1]?.candidates).toBe(first.plan.batches[1]?.candidates);
});
