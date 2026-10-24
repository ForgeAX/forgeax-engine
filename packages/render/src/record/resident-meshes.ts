import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import { type RenderResourceScope, renderAsset } from '../publication/resource-scope';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { RenderSystemInternals } from './render-context';

/** Prepare resident geometry once per shared mesh, without visiting scene members. */
export function gpuDrivenMeshesForFrame(
  internals: RenderSystemInternals,
  worlds: readonly RenderResourceScope[],
  scene: Pick<PersistentGpuDrivenState, 'plan' | 'meshes'> | undefined,
): ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles> {
  // One resolution per world and mesh; numeric keys avoid a string per batch.
  const resolved = new Map<number, Map<number, MeshGpuHandles | null>>();
  const resolve = (
    binding: GpuDrivenBatchBinding,
    world: RenderResourceScope,
  ): MeshGpuHandles | undefined => {
    let byAsset = resolved.get(binding.worldId);
    if (byAsset === undefined) {
      byAsset = new Map();
      resolved.set(binding.worldId, byAsset);
    }
    const known = byAsset.get(binding.assetHandle);
    if (known !== undefined) return known ?? undefined;
    const handle = binding.assetHandle as AssetHandle<'mesh'>;
    let gpu = internals.gpuStore.getMeshGpuHandles(handle, world);
    const lods = binding.lods;
    const needsLodResidency =
      lods?.some((_, level) => (gpu?.lodRanges?.[level + 1]?.length ?? 0) === 0) === true;
    if (gpu === undefined || needsLodResidency) {
      const asset = world.resolveAsset<MeshAsset>(handle);
      if (asset.ok) {
        const lodMeshes = lods?.map((guid) => renderAsset<MeshAsset>(world, guid));
        const resident = internals.gpuStore.ensureResident(
          handle,
          asset.value,
          world,
          lodMeshes?.map((lod) => (lod?.kind === 'mesh' ? lod : undefined)),
        );
        if (resident.ok) gpu = resident.value;
      }
    }
    byAsset.set(binding.assetHandle, gpu ?? null);
    return gpu;
  };
  // Downstream preparation keys on this table's identity; keep it while every
  // binding still resolves to the same resident handles. A fixed plan has a
  // fixed binding roster, so only its handles are compared.
  const previous = residentTables.get(internals);
  const batches = scene?.plan.batches;
  if (previous !== undefined && batches !== undefined && previous.batches?.deref() === batches) {
    let same = true;
    for (const batch of batches) {
      const binding = batch.binding;
      if (binding === undefined) continue;
      const world = worlds[binding.worldId];
      if (world === undefined) continue;
      const gpu = resolve(binding, world);
      if (gpu !== undefined && previous.table.get(binding) !== gpu) {
        same = false;
        break;
      }
      if (gpu === undefined && previous.table.has(binding)) {
        same = false;
        break;
      }
    }
    if (same) return previous.table;
  }
  const meshes = new Map<GpuDrivenBatchBinding, MeshGpuHandles>();
  for (const batch of batches ?? []) {
    const binding = batch.binding;
    if (binding === undefined) continue;
    const world = worlds[binding.worldId];
    if (world === undefined) continue;
    const gpu = resolve(binding, world);
    if (gpu !== undefined) meshes.set(binding, gpu);
  }
  if (previous !== undefined && previous.table.size === meshes.size) {
    let same = true;
    for (const [binding, gpu] of meshes)
      if (previous.table.get(binding) !== gpu) {
        same = false;
        break;
      }
    if (same) {
      residentTables.set(internals, { batches: weakBatches(batches), table: previous.table });
      return previous.table;
    }
  }
  residentTables.set(internals, { batches: weakBatches(batches), table: meshes });
  return meshes;
}

const residentTables = new WeakMap<
  object,
  {
    /** Weak: the table never keeps an earlier plan reachable. */
    readonly batches: WeakRef<object> | undefined;
    readonly table: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  }
>();

function weakBatches(batches: object | undefined): WeakRef<object> | undefined {
  return batches === undefined ? undefined : new WeakRef(batches);
}

/** Called by a recording that will consume real geometry queries/commands. */
export function querySceneExecution(scene: PersistentGpuDrivenState): PersistentGpuDrivenState {
  const { queryPlan, ...source } = scene;
  return queryPlan === undefined ? scene : { ...source, plan: queryPlan() };
}
