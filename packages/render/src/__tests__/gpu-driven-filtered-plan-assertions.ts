import { expect } from 'vitest';
import type { GpuDrivenBatch } from '../gpu-driven/batch-topology';
import type { FilteredProductionPlan } from '../gpu-driven/production-raster-prepare';

function batchFacts(batch: GpuDrivenBatch) {
  const {
    batchId: _id,
    visibleBase: _base,
    indirectOffset: _offset,
    generation: _generation,
    visibleAllocationCapacity: _reserved,
    ...facts
  } = batch;
  return facts;
}

function admittedFacts(value: FilteredProductionPlan) {
  const { visibleCapacity: _capacity, ...plan } = value.plan;
  return {
    ...value,
    plan: { ...plan, batches: plan.batches.map(batchFacts) },
    batches: value.batches.map((row) => ({ ...row, batch: batchFacts(row.batch) })),
    materialBatches: value.materialBatches.map((row) => ({ ...row, batch: batchFacts(row.batch) })),
  };
}

export function expectFilteredPlan(
  value: FilteredProductionPlan,
  reference: FilteredProductionPlan,
): void {
  // Retained commands keep sparse addresses; the stateless reference packs
  // densely. Compare every admission fact, including candidate order and claims.
  // Stable-command-addresses tests check range overlap and GPU consumption.
  expect(admittedFacts(value)).toEqual(admittedFacts(reference));
  expect(value.batches).toHaveLength(value.plan.batches.length);
  for (const [index, row] of value.batches.entries()) {
    expect(row.batch).toBe(value.plan.batches[index]);
    expect(row.mesh).toBe(reference.batches[index]?.mesh);
    expect(row.artifact).toBe(reference.batches[index]?.artifact);
  }
  // Representatives must reference the same prepared rows at the same first
  // occurrence; stripping addresses must not hide a misrouted material batch.
  for (const row of value.materialBatches) expect(value.batches.includes(row)).toBe(true);
  expect(value.materialBatches.map((row) => value.batches.indexOf(row))).toEqual(
    reference.materialBatches.map((row) => reference.batches.indexOf(row)),
  );
}
