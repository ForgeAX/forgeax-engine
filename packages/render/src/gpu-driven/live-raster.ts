import type { BindGroup, Buffer } from '@forgeax/engine-rhi';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { batchLevelStride, batchLodLevelCount } from './batch-layout';
import type { GpuDrivenBatch } from './batch-topology';
import { PreparedRasterBundleCache } from './prepared-raster-bundle';
import type { FilteredProductionPlan, PreparedBatch } from './production-raster-prepare';
import { type RasterMeshBinding, RasterMeshBindings } from './raster-mesh-bindings';

/** One filtered batch as the compiled raster encoder reads it on each frame. */
export interface LiveRasterBatch {
  /** The filtered row this live batch projects; an identical row keeps this owner. */
  readonly prepared?: PreparedBatch;
  readonly batch: GpuDrivenBatch;
  readonly classKey: string;
  readonly recordingClassKey: string;
  readonly mesh: MeshGpuHandles;
  readonly meshBinding: RasterMeshBinding;
  readonly materialBindingClass: string;
  /** Complete LOD windows, retained independently for the two visible regions. */
  visibleBindGroups: { early?: readonly BindGroup[]; late?: readonly BindGroup[] } | undefined;
  readonly bundles: PreparedRasterBundleCache;
  /**
   * Stable while every input a recorded command reads is unchanged; candidate
   * membership and counts are GPU-culled data and never replace it.
   */
  readonly command: object;
}

export interface LiveRasterCache {
  readonly filtered: FilteredProductionPlan;
  readonly visibleBuffer: Buffer;
  readonly rigidBindings: object;
  readonly skinBindings: object | undefined;
  readonly value: readonly LiveRasterBatch[];
  readonly meshBindings: RasterMeshBindings;
}

/** Bind shared geometry and material classes without reading any candidate. */
export function projectLiveRaster(
  cached: LiveRasterCache | undefined,
  filtered: FilteredProductionPlan,
  visibleBuffer: Buffer,
  rigidBindings: object,
  skinBindings: object | undefined,
): LiveRasterCache {
  if (cached?.filtered === filtered) {
    if (
      cached.visibleBuffer === visibleBuffer &&
      cached.rigidBindings === rigidBindings &&
      cached.skinBindings === skinBindings
    )
      return cached;
    // Content writes keep the bindings. Physical replacement resets only
    // the affected adapter's windows, without revisiting candidate rows.
    for (const live of cached.value) {
      if (
        cached.visibleBuffer !== visibleBuffer ||
        (live.batch.prepared?.identity.deformation === 'skin'
          ? cached.skinBindings !== skinBindings
          : cached.rigidBindings !== rigidBindings)
      ) {
        live.visibleBindGroups = undefined;
      }
    }
    return { ...cached, visibleBuffer, rigidBindings, skinBindings };
  }
  const value: LiveRasterBatch[] = [];
  const meshBindings = new RasterMeshBindings();
  const previousById = new Map(cached?.value.map((live) => [live.batch.batchId, live]));
  const samePhysical =
    cached?.visibleBuffer === visibleBuffer &&
    cached.rigidBindings === rigidBindings &&
    cached.skinBindings === skinBindings;
  for (const prepared of filtered.batches) {
    const retained = previousById.get(prepared.batch.batchId);
    // An identical filtered row under unchanged physical bindings projects
    // exactly the retained owner; keep it and its mesh import row.
    if (
      samePhysical &&
      retained?.prepared === prepared &&
      retained.meshBinding === meshBindings.adopt(retained.meshBinding)
    ) {
      previousById.delete(prepared.batch.batchId);
      value.push(retained);
      continue;
    }
    const previous =
      retained?.batch.generation === prepared.batch.generation ? retained : undefined;
    const visibleBindGroups =
      previous !== undefined &&
      sameWindowBindings(cached, visibleBuffer, rigidBindings, skinBindings, prepared.batch) &&
      sameWindows(previous.batch, prepared.batch)
        ? previous.visibleBindGroups
        : undefined;
    value.push({
      prepared,
      batch: prepared.batch,
      classKey: prepared.rasterClassKey,
      recordingClassKey: prepared.recordingRasterClassKey,
      mesh: prepared.mesh,
      meshBinding: meshBindings.forMesh(prepared.mesh, cached?.meshBindings),
      materialBindingClass: prepared.materialBindingClass,
      visibleBindGroups,
      bundles: previous?.bundles ?? new PreparedRasterBundleCache(),
      command:
        previous !== undefined &&
        visibleBindGroups !== undefined &&
        sameCommandInputs(previous, prepared)
          ? previous.command
          : {},
    });
  }
  return {
    filtered,
    visibleBuffer,
    rigidBindings,
    skinBindings,
    value: Object.freeze(value),
    meshBindings,
  };
}

/** Whether a row records the same draw commands as the retained live batch of its id. */
function sameCommandInputs(previous: LiveRasterBatch, prepared: PreparedBatch): boolean {
  const left = previous.batch;
  const right = prepared.batch;
  return (
    previous.classKey === prepared.rasterClassKey &&
    previous.recordingClassKey === prepared.recordingRasterClassKey &&
    previous.materialBindingClass === prepared.materialBindingClass &&
    previous.mesh === prepared.mesh &&
    left.key.drawKind === right.key.drawKind &&
    left.key.topology === right.key.topology &&
    left.key.materialPass === right.key.materialPass &&
    left.key.materialSlot === right.key.materialSlot &&
    left.binding?.material === right.binding?.material &&
    left.indirectOffset === right.indirectOffset &&
    (left.visibleCapacity === 0) === (right.visibleCapacity === 0) &&
    (left.lod?.coverages.length ?? 0) === (right.lod?.coverages.length ?? 0)
  );
}

/** Whether the batch's visible-window adapter is physically unchanged. */
function sameWindowBindings(
  cached: LiveRasterCache | undefined,
  visibleBuffer: Buffer,
  rigidBindings: object,
  skinBindings: object | undefined,
  batch: GpuDrivenBatch,
): boolean {
  return (
    cached?.visibleBuffer === visibleBuffer &&
    (batch.prepared?.identity.deformation === 'skin'
      ? cached.skinBindings === skinBindings
      : cached.rigidBindings === rigidBindings)
  );
}

/**
 * Bindings describe physical windows, independent of their current
 * candidates/material. Reuse the previous ordered slot only when both LOD
 * phases still address exactly the same resources and ranges. The late base
 * is the view's allocated capacity, fixed per buffer.
 */
function sameWindows(previous: GpuDrivenBatch, batch: GpuDrivenBatch): boolean {
  return (
    (previous.prepared?.identity.deformation ?? 'rigid') ===
      (batch.prepared?.identity.deformation ?? 'rigid') &&
    previous.visibleBase === batch.visibleBase &&
    (previous.visibleAllocationCapacity ?? previous.visibleCapacity) ===
      (batch.visibleAllocationCapacity ?? batch.visibleCapacity) &&
    batchLevelStride(previous) === batchLevelStride(batch) &&
    batchLodLevelCount(previous) === batchLodLevelCount(batch)
  );
}
