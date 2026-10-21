import type { GpuDrivenBatch } from './batch-topology';

/** Upper bound of LOD rows per chain; matches the GPU candidate record. */
export const GPU_DRIVEN_LOD_LEVEL_CAPACITY = 8;

/**
 * Consecutive indirect commands (and visible segments) one batch owns: one per
 * selectable LOD level, including the root.
 */
export function batchLodLevelCount(batch: Pick<GpuDrivenBatch, 'lod'>): number {
  const lod = batch.lod;
  if (lod === undefined) return 1;
  return Math.min(
    GPU_DRIVEN_LOD_LEVEL_CAPACITY,
    Math.max(1, lod.coverages.length, (lod.ranges?.length ?? 0) + 1),
  );
}

/** Distance between two level segments of one batch in the visible stream. */
export function batchLevelStride(
  batch: Pick<GpuDrivenBatch, 'visibleCapacity' | 'visibleAllocationCapacity'>,
): number {
  return batch.visibleAllocationCapacity ?? alignInstanceBase(batch.visibleCapacity);
}

/**
 * Visible entries a batch spans: level `l` starts at
 * `visibleBase + l * batchLevelStride(batch)`, so every segment keeps the
 * storage-offset alignment its raster window binding needs.
 */
export function batchVisibleSpan(
  batch: Pick<GpuDrivenBatch, 'lod' | 'visibleCapacity' | 'visibleAllocationCapacity'>,
): number {
  return (
    (batchLodLevelCount(batch) - 1) * batchLevelStride(batch) +
    (batch.visibleAllocationCapacity ?? batch.visibleCapacity)
  );
}

/** Bytes of one indirect command; a batch's level `l` command follows at `+ l * 20`. */
export const GPU_DRIVEN_INDIRECT_COMMAND_BYTES = 20;

function alignInstanceBase(value: number): number {
  // Raster binds each batch's visible-index and compact-transform segment at
  // a static storage-buffer offset. WebGPU requires those offsets to satisfy
  // minStorageBufferOffsetAlignment (256 bytes on the portable baseline), so
  // both the u32 stream (64 entries) and mat4 stream (4 entries) align when
  // the shared instance base is a multiple of 64.
  return Math.ceil(value / 64) * 64;
}
