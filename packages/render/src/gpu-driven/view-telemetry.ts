import { decodeSurfaceIndirectParameters } from '../surface/submission-observation';
import { batchLevelStride, batchLodLevelCount } from './batch-layout';
import { admittedRasterBatchCount } from './production-raster-lod';
import type {
  GpuDrivenCullingObservation,
  GpuDrivenLodSelectionInspection,
  LodTelemetryCopy,
} from './view-gpu';
import {
  CAMERA_CULLED_COUNTER_OFFSET,
  COUNTER_STRIDE,
  EARLY_VISIBLE_COUNTER_OFFSET,
  FRUSTUM_CULLED_COUNTER_OFFSET,
  GEOMETRY_WORK_COUNTER_OFFSET,
  INDIRECT_COMMAND_BYTES,
  LEVEL_VISIBLE_COUNTER_OFFSET,
  LOD_COUNTER_OFFSET,
  LOD_ROW_CAPACITY,
  OCCLUSION_CULLED_COUNTER_OFFSET,
  ROOT_GEOMETRY_WORK_COUNTER_OFFSET,
  TEXEL_CULLED_COUNTER_OFFSET,
} from './view-layout';

export function decodeCullingCounts(
  copy: LodTelemetryCopy,
  values: DataView<ArrayBuffer>,
): Pick<GpuDrivenLodSelectionInspection, 'texelCulled' | 'cameraCulled'> & {
  readonly observation?: GpuDrivenCullingObservation;
} {
  let texelCulled = 0;
  let cameraCulled = 0;
  for (let batchIndex = 0; batchIndex < copy.plan.batches.length; batchIndex += 1) {
    const offset = batchIndex * COUNTER_STRIDE;
    texelCulled += values.getUint32(offset + TEXEL_CULLED_COUNTER_OFFSET * 4, true);
    cameraCulled += values.getUint32(offset + CAMERA_CULLED_COUNTER_OFFSET * 4, true);
  }
  const producer = copy.submit?.cullingProducer;
  if (producer === undefined) return { texelCulled, cameraCulled };
  let visible = 0;
  let overflow = false;
  for (let batchIndex = 0; batchIndex < copy.plan.batches.length; batchIndex += 1) {
    const offset = batchIndex * COUNTER_STRIDE;
    const batchOverflow = values.getUint32(offset + 4, true) !== 0;
    overflow ||= batchOverflow;
    if (!batchOverflow) {
      visible += Math.min(
        values.getUint32(offset, true),
        copy.plan.batches.at(batchIndex)?.visibleCapacity ?? 0,
      );
    }
  }
  return {
    texelCulled,
    cameraCulled,
    observation: Object.freeze({
      producer,
      resourceGeneration: copy.resourceGeneration,
      indirectBufferIdentity: copy.indirectBufferIdentity,
      planRevision: copy.plan.revision,
      candidateCount: copy.plan.candidateCount,
      batchCount: copy.plan.batches.length,
      visible,
      overflow,
      texelCulled,
      cameraCulled,
    }),
  };
}

export function decodeLodSelection(
  copy: LodTelemetryCopy,
  values: DataView<ArrayBuffer>,
  batchCapacity: number,
  indirectCapacity: number,
): GpuDrivenLodSelectionInspection {
  const plan = copy.plan;
  let visible = 0;
  let overflow = false;
  let geometryWork = 0;
  let rootGeometryWork = 0;
  let texelCulled = 0;
  let cameraCulled = 0;
  let frustumCulled = 0;
  let occlusionCulled = 0;
  let lateVisible = 0;
  const actualMembers: Array<{
    readonly batchId: number;
    readonly primitiveIndex: number;
    readonly generation: number;
    readonly drawItemIndex: number;
    readonly instanceOrdinal: number;
  }> = [];
  const histogram = new Map<number, number>();
  let batchIndex = 0;
  let firstCandidate = 0;
  for (const batch of plan.batches) {
    const offset = batchIndex++ * COUNTER_STRIDE;
    const batchOverflow = values.getUint32(offset + 4, true) !== 0;
    const batchVisible = batchOverflow
      ? 0
      : Math.min(values.getUint32(offset, true), batch?.visibleCapacity ?? 0);
    // Visible items carry their candidate row (z) in the submitted plan, so
    // each record names the (slot, generation) encoded with this copy and
    // never consults the current allocation; joins drop stale generations.
    const batchFirst = firstCandidate;
    firstCandidate += batch.candidates.length;
    const levels = batch === undefined || batchOverflow ? 0 : batchLodLevelCount(batch);
    for (let level = 0; level < levels; level += 1) {
      if (batch === undefined) break;
      const segmentBase = batch.visibleBase + level * batchLevelStride(batch);
      const segmentVisible = Math.min(
        values.getUint32(offset + (LEVEL_VISIBLE_COUNTER_OFFSET + level) * 4, true),
        batch.visibleCapacity,
      );
      for (let visibleIndex = 0; visibleIndex < segmentVisible; visibleIndex += 1) {
        const visibleOffset = batchCapacity * COUNTER_STRIDE + (segmentBase + visibleIndex) * 16;
        const ordinal = values.getUint32(visibleOffset + 8, true) - batchFirst;
        const candidate =
          ordinal >= 0 && ordinal < batch.candidates.length
            ? batch.candidates.at(ordinal)
            : undefined;
        if (candidate !== undefined) {
          actualMembers.push({
            batchId: batch.batchId,
            primitiveIndex: candidate.primitiveIndex,
            generation: candidate.generation,
            drawItemIndex: batch.binding?.drawItemIndex ?? candidate.drawItemIndex,
            instanceOrdinal: candidate.instanceOrdinal,
          });
        }
      }
    }
    visible += batchVisible;
    overflow ||= batchOverflow;
    geometryWork += values.getUint32(offset + GEOMETRY_WORK_COUNTER_OFFSET * 4, true);
    rootGeometryWork += values.getUint32(offset + ROOT_GEOMETRY_WORK_COUNTER_OFFSET * 4, true);
    texelCulled += values.getUint32(offset + TEXEL_CULLED_COUNTER_OFFSET * 4, true);
    cameraCulled += values.getUint32(offset + CAMERA_CULLED_COUNTER_OFFSET * 4, true);
    frustumCulled += values.getUint32(offset + FRUSTUM_CULLED_COUNTER_OFFSET * 4, true);
    if (copy.occlusion && !batchOverflow && batch !== undefined) {
      occlusionCulled += values.getUint32(offset + OCCLUSION_CULLED_COUNTER_OFFSET * 4, true);
      for (let level = 0; level < batchLodLevelCount(batch); level += 1) {
        const total = Math.min(
          values.getUint32(offset + (LEVEL_VISIBLE_COUNTER_OFFSET + level) * 4, true),
          batch.visibleCapacity,
        );
        const early = values.getUint32(offset + (EARLY_VISIBLE_COUNTER_OFFSET + level) * 4, true);
        lateVisible += Math.max(0, total - early);
      }
    }
    for (let level = 0; level < LOD_ROW_CAPACITY; level += 1) {
      const count = values.getUint32(offset + (LOD_COUNTER_OFFSET + level) * 4, true);
      if (count > 0) histogram.set(level, (histogram.get(level) ?? 0) + count);
    }
  }
  const candidateCount = plan.candidateCount;
  const surfaceReadback = copy.surfaceReadbackSnapshot?.();
  const surfaceIndirectReadback =
    surfaceReadback === undefined
      ? undefined
      : decodeSurfaceIndirectParameters({
          bytes: values.buffer,
          byteOffset: copy.indirectReadbackOffset,
          byteLength: indirectCapacity * INDIRECT_COMMAND_BYTES,
          indirectBufferIdentity: copy.indirectBufferIdentity,
          recording: surfaceReadback,
        });
  return Object.freeze({
    resourceGeneration: copy.resourceGeneration,
    candidateCount,
    batchCount: plan.batches.length,
    // Selector-only batches remain in the plan/readback but the production
    // raster skips them. Report the actual nonzero-admission command count
    // (one per LOD level) so a benchmark cannot mistake selector batches
    // for raster draws.
    indirectDrawCount: admittedRasterBatchCount(plan),
    visible,
    // A LOD histogram counts candidates that reached the selector, while
    // `visible` is the actual compacted submission count. Occlusion is the
    // difference between those candidate/visibility totals; using the
    // histogram here would mislabel a visible candidate dropped only by an
    // indirect-capacity overflow as occluded.
    occluded: Math.max(0, candidateCount - visible),
    overflow,
    lodHistogram: Object.freeze(
      [...histogram.entries()]
        .sort(([left], [right]) => left - right)
        .map(([level, count]) => Object.freeze({ level, count })),
    ),
    batches: Object.freeze(
      plan.batches.map((batch, batchIndex) => {
        const offset = batchIndex * COUNTER_STRIDE;
        const batchHistogram = new Map<number, number>();
        for (let level = 0; level < LOD_ROW_CAPACITY; level += 1) {
          const count = values.getUint32(offset + (LOD_COUNTER_OFFSET + level) * 4, true);
          if (count > 0) batchHistogram.set(level, count);
        }
        const batchOverflow = values.getUint32(offset + 4, true) !== 0;
        const batchVisible = batchOverflow
          ? 0
          : Math.min(values.getUint32(offset, true), batch.visibleCapacity);
        return Object.freeze({
          batchId: batch.batchId,
          candidateCount: batch.candidates.length,
          visible: batchVisible,
          occluded: Math.max(0, batch.candidates.length - batchVisible),
          overflow: batchOverflow,
          lodHistogram: Object.freeze(
            [...batchHistogram.entries()]
              .sort(([left], [right]) => left - right)
              .map(([level, count]) => Object.freeze({ level, count })),
          ),
        });
      }),
    ),
    geometryWork,
    rootGeometryWork,
    texelCulled,
    cameraCulled,
    frustumCulled,
    ...(copy.occlusion
      ? { occlusion: Object.freeze({ culled: occlusionCulled, late: lateVisible }) }
      : {}),
    actualMembers: Object.freeze(actualMembers),
    ...(surfaceReadback === undefined ? {} : { surfaceReadback }),
    ...(surfaceIndirectReadback === undefined
      ? {}
      : surfaceIndirectReadback.ok
        ? { surfaceIndirectParameters: surfaceIndirectReadback.value }
        : { surfaceIndirectReadbackError: surfaceIndirectReadback.error }),
    ...(copy.submit === undefined ? {} : { submit: copy.submit }),
  });
}
