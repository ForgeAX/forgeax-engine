import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import { hasCapturedTaskMembership } from '../gpu-driven/fixed-task-plan';
import { type RenderResourceScope, renderAsset } from '../publication/resource-scope';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { RenderSystemInternals } from './render-context';

type MeshScene = Pick<PersistentGpuDrivenState, 'plan'>;
type Binding = GpuDrivenBatchBinding;
type ResidencyPolicy = 'prepare' | 'resident-only';
type Resident = MeshGpuHandles | undefined;

/** Material batches may share a mesh. Only the first binding of each mesh supplies its LODs. */
interface MeshRoster {
  readonly bindings: readonly Binding[];
  readonly sources: readonly Binding[];
  readonly handles: readonly number[];
  readonly sourceIndices: readonly number[];
}

function meshRoster(batches: MeshScene['plan']['batches'], previous?: MeshRoster): MeshRoster {
  // Compare binding order even for a borrowed list or a new pose-only execution root.
  // The first difference starts a new roster; enumeration of the frame tree never restarts.
  let bindings: Binding[] | undefined;
  let count = 0;
  for (const batch of batches) {
    const binding = batch.binding;
    if (binding === undefined) continue;
    if (
      bindings === undefined &&
      (previous?.bindings[count] !== binding ||
        previous.handles[previous.sourceIndices[count] as number] !== binding.assetHandle)
    )
      bindings = previous?.bindings.slice(0, count) ?? [];
    bindings?.push(binding);
    count++;
  }
  if (bindings === undefined && previous?.bindings.length === count) return previous;
  bindings ??= previous?.bindings.slice(0, count) ?? [];
  const indices = new Map<number, number>();
  const sources: Binding[] = [];
  const handles: number[] = [];
  const sourceIndices: number[] = [];
  for (const binding of bindings) {
    let index = indices.get(binding.assetHandle);
    if (index === undefined) {
      index = sources.length;
      indices.set(binding.assetHandle, index);
      sources.push(binding);
      handles.push(binding.assetHandle);
    }
    sourceIndices.push(index);
  }
  return { bindings, sources, handles, sourceIndices };
}

function resolveMesh(
  store: RenderSystemInternals['gpuStore'],
  world: RenderResourceScope,
  binding: Binding,
  policy: ResidencyPolicy,
): Resident {
  const handle = binding.assetHandle as AssetHandle<'mesh'>;
  const gpu = store.getMeshGpuHandles(handle, world);
  const lods = binding.lods;
  if (gpu !== undefined) {
    let level = 0;
    while (level < (lods?.length ?? 0) && (gpu.lodRanges?.[level + 1]?.length ?? 0) > 0) level++;
    if (level === (lods?.length ?? 0)) return gpu;
  }
  if (policy === 'resident-only') return undefined;
  const asset = world.resolveAsset<MeshAsset>(handle);
  if (!asset.ok) return gpu;
  const resident = store.ensureResident(
    handle,
    asset.value,
    world,
    lods?.map((guid) => {
      const lod = renderAsset<MeshAsset>(world, guid);
      return lod?.kind === 'mesh' ? lod : undefined;
    }),
  );
  return resident.ok ? resident.value : gpu;
}

interface ResidentFrame {
  plan: WeakRef<MeshScene['plan']> | undefined;
  readonly roster: MeshRoster;
  readonly residents: readonly Resident[];
  readonly table: ReadonlyMap<Binding, MeshGpuHandles>;
}

const residentFrames = new WeakMap<RenderSystemInternals, ResidentFrame>();
const emptyTable: ReadonlyMap<Binding, MeshGpuHandles> = new Map();

/** Read every distinct mesh from the current resource scope. Publish an independent binding
 * snapshot on physical change without rebuilding a per-frame asset-handle lookup. */
export function gpuDrivenMeshesForFrame(
  internals: RenderSystemInternals,
  sourceScope: RenderResourceScope,
  scene: MeshScene | undefined,
  policy: ResidencyPolicy = 'prepare',
): ReadonlyMap<Binding, MeshGpuHandles> {
  if (!scene?.plan.batches.length) {
    residentFrames.delete(internals);
    return emptyTable;
  }
  const previous = residentFrames.get(internals);
  const captured = previous?.plan?.deref() === scene.plan;
  const roster = captured ? previous.roster : meshRoster(scene.plan.batches, previous?.roster);
  const prior = previous?.roster === roster ? previous.residents : undefined;
  let updated: Resident[] | undefined = prior === undefined ? [] : undefined;
  for (let i = 0; i < roster.sources.length; i++) {
    const resident = resolveMesh(
      internals.gpuStore,
      sourceScope,
      roster.sources[i] as Binding,
      policy,
    );
    if (updated === undefined && resident !== prior?.[i]) updated = prior?.slice(0, i);
    updated?.push(resident);
  }
  const plan = captured
    ? previous.plan
    : hasCapturedTaskMembership(scene.plan)
      ? new WeakRef(scene.plan)
      : undefined;
  if (updated === undefined && previous !== undefined) {
    previous.plan = plan;
    return previous.table;
  }
  const residents = updated ?? [];
  const table = new Map<Binding, MeshGpuHandles>();
  let equivalent = previous !== undefined;
  for (let i = 0; i < roster.bindings.length; i++) {
    const binding = roster.bindings[i] as Binding;
    const resident = residents[roster.sourceIndices[i] as number];
    if (resident === undefined) continue;
    table.set(binding, resident);
    if (equivalent && previous?.table.get(binding) !== resident) equivalent = false;
  }
  const published =
    table.size === 0
      ? emptyTable
      : equivalent && previous?.table.size === table.size
        ? previous.table
        : table;
  residentFrames.set(internals, { plan, roster, residents, table: published });
  return published;
}

/** Called by a recording that will consume real geometry queries/commands. */
export function querySceneExecution(scene: PersistentGpuDrivenState): PersistentGpuDrivenState {
  const { queryExecution, ...source } = scene;
  if (queryExecution === undefined) return scene;
  const plans = queryExecution();
  return { ...source, plan: plans.active, residentExecution: plans.resident };
}
