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
    const batch = prepared.batch;
    const deformation = batch.prepared?.identity.deformation ?? 'rigid';
    // Bindings describe physical windows, independent of their current
    // candidates/material. Reuse the previous ordered slot only when both
    // LOD phases still address exactly the same resources and ranges.
    // The late base is the view's allocated capacity, fixed per buffer.
    const visibleBindGroups =
      previous !== undefined &&
      cached?.visibleBuffer === visibleBuffer &&
      (deformation === 'skin'
        ? cached.skinBindings === skinBindings
        : cached.rigidBindings === rigidBindings) &&
      (previous.batch.prepared?.identity.deformation ?? 'rigid') === deformation &&
      previous.batch.visibleBase === batch.visibleBase &&
      (previous.batch.visibleAllocationCapacity ?? previous.batch.visibleCapacity) ===
        (batch.visibleAllocationCapacity ?? batch.visibleCapacity) &&
      batchLevelStride(previous.batch) === batchLevelStride(batch) &&
      batchLodLevelCount(previous.batch) === batchLodLevelCount(batch)
        ? previous.visibleBindGroups
        : undefined;
    value.push({
      prepared,
      batch: prepared.batch,
      classKey: prepared.rasterClassKey,
      recordingClassKey: prepared.recordingRasterClassKey,
      mesh: prepared.mesh,
      meshBinding: meshBindings.forMesh(prepared.mesh),
      materialBindingClass: prepared.materialBindingClass,
      visibleBindGroups,
      bundles: previous?.bundles ?? new PreparedRasterBundleCache(),
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
