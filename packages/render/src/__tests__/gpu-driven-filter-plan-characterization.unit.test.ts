import { expect, it } from 'vitest';
import {
  expectFilteredPlanContent as compare,
  createFilterPlanFixture,
  freshFilteredPlan,
} from './gpu-driven-filter-plan-fixture';

it('keeps distinct geometry sources separate even when native buffers and material are shared', () => {
  const f = createFilterPlanFixture();
  const p = f.prepare();
  const output = freshFilteredPlan(p, f.bindings);
  expect(output.plan.batches).toHaveLength(3);
  expect(output.plan.candidateCount).toBe(6);
  expect(new Set(output.batches.map((row) => row.mesh))).toEqual(new Set([f.mesh]));
  expect(output.materialBatches).toEqual([output.batches.at(0)]);
  output.plan.batches.forEach((batch, index) => {
    expect(batch.candidates.map((row) => [row.primitiveIndex, row.instanceOrdinal])).toEqual([
      [index, 0],
      [index, 1],
    ]);
    expect(batch.lod?.ranges).toEqual([{ first: 3, count: 3, baseVertex: 0 }]);
    const slot = f.slots.at(index);
    if (!slot) throw Error('missing source');
    expect(output.selection.has(slot.snapshot, 0)).toBe(true);
  });
});

it('partitions one shared geometry batch by object bindings in stable source-member order', () => {
  const f = createFilterPlanFixture({ sharedGeometry: true });
  const p = f.prepare();
  const output = freshFilteredPlan(p, f.bindings);
  expect(output.plan.batches).toHaveLength(2);
  expect(
    output.plan.batches.map((batch) =>
      batch.candidates.map((row) => `${row.primitiveIndex}:${row.instanceOrdinal}`),
    ),
  ).toEqual([
    ['0:0', '0:1', '2:0', '2:1'],
    ['1:0', '1:1'],
  ]);
  expect(output.plan.batches.map((batch) => batch.members?.map((row) => row.entityKey))).toEqual([
    [1, 3],
    [2],
  ]);
  expect(output.batches.map((row) => row.materialBindingClass)).toEqual(['A', 'B']);
  compare(output, freshFilteredPlan(p, f.bindings));
});
