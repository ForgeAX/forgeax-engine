import { expect, it } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

it('observes an unchanged source descriptor when a sibling contribution requires assembly', () => {
  const fixture = createFilterPlanFixture();
  const candidates = fixture.source.batches.flatMap((batch) => batch.candidates);
  const prepared = fixture.prepare({
    ...fixture.source,
    batches: fixture.source.batches.map((batch, primitiveIndex) => ({
      ...batch,
      candidates: candidates.filter((candidate) => candidate.primitiveIndex === primitiveIndex),
    })),
  });
  const retained = prepared.batchRows[1];
  if (retained === undefined) throw Error('Missing retained contribution');
  const failure = new Error('source descriptor observation');
  let fail = false;
  let observations = 0;
  const source = new Proxy(retained.source, {
    ownKeys(target) {
      observations++;
      if (fail) throw failure;
      return Reflect.ownKeys(target);
    },
  });
  const input = {
    ...prepared,
    batchRows: prepared.batchRows.map((row, index) => (index === 1 ? { ...row, source } : row)),
  };
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(input, 'current-values', undefined, fixture.bindings);
  expect(observations).toBeGreaterThan(0);
  const changed = {
    ...input,
    batchRows: input.batchRows.map((row, index) =>
      index === 0 ? { ...row, facts: new Map(row.facts) } : row,
    ),
  };
  fail = true;
  const before = observations;
  let caught: unknown;
  try {
    owner.update(changed, 'current-values', undefined, fixture.bindings);
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBe(failure);
  expect(observations).toBeGreaterThan(before);
  fail = false;
  const retry = owner.update(changed, 'current-values', undefined, fixture.bindings);
  expect(retry.plan.candidateCount).toBe(first.plan.candidateCount);
  expect(owner.lastWork.projectedBatches).toBe(changed.batchRows.length);
});
