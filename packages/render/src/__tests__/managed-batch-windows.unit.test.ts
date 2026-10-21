import { expect, it } from 'vitest';
import type { GpuDrivenBatch, SubmissionPlan } from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { assemblePreparedPlan } from '../gpu-driven/production-raster-prepare';

function batch(id: number): GpuDrivenBatch {
  return Object.freeze<GpuDrivenBatch>({
    batchId: id,
    generation: 0,
    contentEpoch: 0,
    key: {
      assetHandle: id,
      drawKind: 'indexed',
      first: 0,
      count: 3,
      baseVertex: 0,
      materialSlot: 0,
      topology: 'triangle-list',
      pipelineClass: '',
      materialResourceClass: '',
    },
    candidates: Object.freeze([
      { primitiveIndex: id, generation: 0, drawItemIndex: 0, instanceOrdinal: 0 },
    ]),
    visibleBase: id * 64,
    visibleCapacity: 1,
    indirectOffset: id * 20,
  });
}

it('recycles retired windows through churn without moving a surviving command', () => {
  const owner = new FilteredPlanContributionOwner();
  const all = Array.from({ length: 64 }, (_, id) => batch(id));
  let revision = 0;
  const update = (batches: readonly GpuDrivenBatch[]) => {
    const source: SubmissionPlan = {
      revision: revision++,
      batches,
      candidateCount: batches.length,
      visibleCapacity: batches.length * 64,
    };
    return owner.update(
      assemblePreparedPlan(
        source,
        batches.map((source) => ({
          source,
          lod: undefined,
          fact: undefined,
          mesh: undefined,
          meshContentEpoch: undefined,
        })),
        undefined,
      ),
    );
  };
  const old = update(all);
  const last = all[63];
  if (last === undefined) throw new Error('Missing source geometry');
  const retained = update([last]);
  expect(owner.windowCounters).toEqual({ compactions: 0, relocations: 0 });
  expect(retained.plan.visibleCapacity).toBe(64 * 64);
  expect(retained.plan.batches.at(0)?.visibleBase).toBe(63 * 64);
  expect(retained.plan.batches.at(0)?.indirectOffset).toBe(63 * 20);
  expect(retained.plan.batches.at(0)?.candidates).toBe(last.candidates);
  expect(old.plan.batches.at(63)?.visibleBase).toBe(63 * 64);
  expect(retained.plan.batches.at(0)?.generation).toBe(old.plan.batches.at(63)?.generation);
  for (let id = 64; id < 564; id++) {
    const churn = update([last, batch(id)]);
    expect(churn.plan.batches.at(0)?.visibleBase).toBe(63 * 64);
    expect(churn.plan.batches.at(0)?.indirectOffset).toBe(63 * 20);
    expect(churn.plan.batches.at(0)?.generation).toBe(retained.plan.batches.at(0)?.generation);
    expect(churn.plan.batches.at(1)?.visibleBase).toBeLessThan(63 * 64);
    expect(churn.plan.batches.at(1)?.indirectOffset).toBeLessThan(63 * 20);
    expect(churn.plan.visibleCapacity).toBe(64 * 64);
  }
  expect(owner.windowCounters).toEqual({ compactions: 0, relocations: 0 });
  const replacement = update([{ ...last, generation: 1 }]);
  expect(replacement.plan.batches.at(0)?.generation).not.toBe(
    retained.plan.batches.at(0)?.generation,
  );
  owner.clear();
});
