import { expect, it } from 'vitest';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

it('material adoption keeps a large shared geometry source out of candidate projection', () => {
  const f = createFilterPlanFixture({ sharedGeometry: true, instances: 4096 });
  const p = f.prepare();
  const owner = new FilteredPlanContributionOwner();
  const first = owner.update(p);
  const candidates = p.source.batches.at(0)?.candidates;
  if (!candidates) throw Error('missing candidates');
  const next = {
    ...p,
    batchRows: p.batchRows.map((row) => ({
      ...row,
      fact:
        row.fact === undefined
          ? undefined
          : { ...row.fact, material: { ...row.fact.material, standardTextureMask: 2 } },
    })),
  };
  const result = owner.update(next);
  expect(result.plan.candidateCount).toBe(12288);
  expect(result.plan.batches.at(0)?.candidates).toBe(candidates);
  expect(owner.lastWork).toMatchObject({
    projectedBatches: 1,
    projectedCandidates: 0,
    copiedCandidates: 0,
  });
  expect(result.materialBatches).toHaveLength(1);
  expect(first.batches.at(0)?.standardTextureMask).not.toBe(2);
});
