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
  const meshes = new Map<GpuDrivenBatchBinding, MeshGpuHandles>();
  const resolved = new Map<string, MeshGpuHandles | undefined>();
  for (const batch of scene?.plan.batches ?? []) {
    const binding = batch.binding;
    if (binding === undefined) continue;
    const world = worlds[binding.worldId];
    if (world === undefined) continue;
    const key = `${binding.worldId}:${binding.assetHandle}`;
    if (!resolved.has(key)) {
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
      resolved.set(key, gpu);
    }
    const gpu = resolved.get(key);
    if (gpu !== undefined) meshes.set(binding, gpu);
  }
  return meshes;
}

/** Called by a recording that will consume real geometry queries/commands. */
export function querySceneExecution(scene: PersistentGpuDrivenState): PersistentGpuDrivenState {
  const { queryPlan, ...source } = scene;
  return queryPlan === undefined ? scene : { ...source, plan: queryPlan() };
}
