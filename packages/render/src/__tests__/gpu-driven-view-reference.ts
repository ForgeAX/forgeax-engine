/** Test-owned CPU oracle for the GPU-driven visibility protocol. */
import { box3, frustum, mat4 } from '@forgeax/engine-math';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import type { RenderSceneSlot } from '../scene/render-scene';

export const INDEXED_INDIRECT_STRIDE = 20;

export interface GpuDrivenViewReferenceResult {
  readonly visibleInstanceIndices: Uint32Array;
  readonly batchCounters: Uint32Array;
  readonly indirectArgs: ArrayBuffer;
  readonly candidateCount: number;
  readonly rejectedCount: number;
  readonly visibleCount: number;
  readonly overflowedBatches: readonly number[];
}

/** CPU oracle for the storage-buffer compute protocol and WebGL2 fallback semantics. */
export function classifyGpuDrivenView(
  plan: SubmissionPlan,
  slots: readonly RenderSceneSlot[],
  planes: Float32Array,
  capacityByBatch?: ReadonlyMap<number, number>,
): GpuDrivenViewReferenceResult {
  const bySlot = new Map(slots.map((slot) => [slot.slot, slot]));
  const visibleInstanceIndices = new Uint32Array(plan.visibleCapacity);
  const batchCounters = new Uint32Array(plan.batches.length);
  const indirectArgs = new ArrayBuffer(
    (plan.batches.reduce((maximum, batch) => Math.max(maximum, batch.batchId), -1) + 1) *
      INDEXED_INDIRECT_STRIDE,
  );
  const args = new DataView(indirectArgs);
  const overflowedBatches: number[] = [];
  const instanceStartByPrimitive = new Map<number, number>();
  let nextInstance = 0;
  for (const slot of [...slots].sort((left, right) => left.slot - right.slot)) {
    instanceStartByPrimitive.set(slot.slot, nextInstance);
    nextInstance += slot.snapshot.instances?.instanceCount ?? 1;
  }
  let candidateCount = 0;
  let rejectedCount = 0;
  let visibleCount = 0;

  for (let batchIndex = 0; batchIndex < plan.batches.length; batchIndex += 1) {
    const batch = plan.batches[batchIndex];
    if (batch === undefined) continue;
    const capacity = capacityByBatch?.get(batch.batchId) ?? batch.visibleCapacity;
    let count = 0;
    for (const candidate of batch.candidates) {
      candidateCount += 1;
      const slot = bySlot.get(candidate.primitiveIndex);
      if (slot === undefined || slot.generation !== candidate.generation) {
        rejectedCount += 1;
        continue;
      }
      const bounds = slot.snapshot.localAabb;
      if (bounds === undefined) {
        rejectedCount += 1;
        continue;
      }
      const worldBounds = box3.create();
      const local = slot.snapshot.instances?.transforms.subarray(
        candidate.instanceOrdinal * 16,
        candidate.instanceOrdinal * 16 + 16,
      );
      const world =
        local?.length === 16
          ? mat4.multiply(
              mat4.create(),
              slot.snapshot.transform.world as unknown as mat4.Mat4Like,
              local as unknown as mat4.Mat4Like,
            )
          : slot.snapshot.transform.world;
      box3.transformBox3(
        worldBounds,
        bounds,
        world as unknown as Parameters<typeof box3.transformBox3>[2],
      );
      if (!frustum.intersectsBox(planes as frustum.Frustum, worldBounds as box3.Box3Like)) {
        rejectedCount += 1;
        continue;
      }
      if (count >= capacity) {
        if (!overflowedBatches.includes(batch.batchId)) overflowedBatches.push(batch.batchId);
        continue;
      }
      visibleInstanceIndices[batch.visibleBase + count] =
        (instanceStartByPrimitive.get(candidate.primitiveIndex) ?? 0) + candidate.instanceOrdinal;
      count += 1;
      visibleCount += 1;
    }
    batchCounters[batchIndex] = count;
    const offset = batch.indirectOffset;
    args.setUint32(offset, batch.key.count, true);
    args.setUint32(offset + 4, count, true);
    args.setUint32(offset + 8, batch.key.first, true);
    if (batch.key.drawKind === 'indexed') args.setInt32(offset + 12, batch.key.baseVertex, true);
    else args.setUint32(offset + 12, 0, true);
    args.setUint32(offset + 16, 0, true);
  }

  return {
    visibleInstanceIndices,
    batchCounters,
    indirectArgs,
    candidateCount,
    rejectedCount,
    visibleCount,
    overflowedBatches,
  };
}
