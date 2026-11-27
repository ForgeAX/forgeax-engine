import type { AssetHandle, MeshAsset } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import { materialBindingLayout } from '../gpu-driven/fixed-task-plan';
import { type RenderResourceScope, renderAsset } from '../publication/resource-scope';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { RenderSystemInternals } from './render-context';

type MeshScene = Pick<PersistentGpuDrivenState, 'plan'>;
type Binding = GpuDrivenBatchBinding;
type ResidencyPolicy = 'prepare' | 'resident-only';
type Resident = MeshGpuHandles | undefined;

/** Material batches may share a mesh. Only the first binding of each mesh supplies its LODs. */
interface MeshRoster {
  readonly borrowedOrder: readonly Binding[] | undefined;
  readonly sources: readonly Binding[];
  readonly handles: readonly number[];
  readonly indices: ReadonlyMap<Binding, number>;
}

/** A borrowed batch list can edit its binding handle in place. Inspect its actual order once. */
function borrowedBindings(
  batches: MeshScene['plan']['batches'],
  previous: MeshRoster | undefined,
): readonly Binding[] {
  const prior = previous?.borrowedOrder;
  let order: Binding[] | undefined = prior === undefined ? [] : undefined;
  let count = 0;
  for (const batch of batches) {
    const binding = batch.binding;
    if (binding === undefined) continue;
    if (
      order === undefined &&
      prior !== undefined &&
      (prior[count] !== binding ||
        previous?.handles[previous.indices.get(binding) as number] !== binding.assetHandle)
    )
      order = prior.slice(0, count);
    order?.push(binding);
    count++;
  }
  return order ?? (count === prior?.length ? prior : (prior?.slice(0, count) ?? []));
}

function meshRoster(
  batches: MeshScene['plan']['batches'],
  layout: symbol | undefined,
  previous?: MeshRoster,
): MeshRoster {
  const order = layout === undefined ? borrowedBindings(batches, previous) : undefined;
  if (order !== undefined && order === previous?.borrowedOrder) return previous;
  const byHandle = new Map<number, number>();
  const sources: Binding[] = [];
  const handles: number[] = [];
  const indices = new Map<Binding, number>();
  function append(binding: Binding) {
    const handle = binding.assetHandle;
    let index = byHandle.get(handle);
    if (index === undefined) {
      index = sources.length;
      byHandle.set(handle, index);
      sources.push(binding);
      if (order !== undefined) handles.push(handle);
    }
    indices.set(binding, index);
  }
  if (order !== undefined) {
    for (const binding of order) append(binding);
  } else {
    for (const batch of batches) {
      const binding = batch.binding;
      if (binding === undefined) continue;
      append(binding);
    }
  }
  return { borrowedOrder: order, sources, handles, indices };
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

/** The binding address belongs to the roster. Only the physical mesh columns vary by issuance. */
class IssuedMeshes implements ReadonlyMap<Binding, MeshGpuHandles> {
  constructor(
    private readonly indices: ReadonlyMap<Binding, number>,
    private readonly residents: readonly MeshGpuHandles[],
  ) {}

  static issue(
    roster: MeshRoster,
    residents: readonly Resident[],
    present: number,
  ): ReadonlyMap<Binding, MeshGpuHandles> {
    if (present === 0) return emptyTable;
    if (present === residents.length)
      return new IssuedMeshes(roster.indices, residents as readonly MeshGpuHandles[]);
    // An old frame may retain only the bindings whose physical meshes it actually received.
    const ready = new Map<Binding, MeshGpuHandles>();
    for (const [binding, index] of roster.indices) {
      const mesh = residents[index];
      if (mesh !== undefined) ready.set(binding, mesh);
    }
    return ready;
  }
  get size(): number {
    return this.indices.size;
  }
  get(binding: Binding): Resident {
    const index = this.indices.get(binding);
    return index === undefined ? undefined : this.residents[index];
  }
  has(binding: Binding): boolean {
    return this.indices.has(binding);
  }
  *entries(): MapIterator<[Binding, MeshGpuHandles]> {
    for (const [binding, index] of this.indices)
      yield [binding, this.residents[index] as MeshGpuHandles];
  }
  keys(): MapIterator<Binding> {
    return this.indices.keys();
  }
  *values(): MapIterator<MeshGpuHandles> {
    for (const index of this.indices.values()) yield this.residents[index] as MeshGpuHandles;
  }
  [Symbol.iterator](): MapIterator<[Binding, MeshGpuHandles]> {
    return this.entries();
  }
  forEach(
    visit: (value: MeshGpuHandles, key: Binding, map: ReadonlyMap<Binding, MeshGpuHandles>) => void,
    thisArg?: unknown,
  ): void {
    for (const [binding, index] of this.indices) {
      visit.call(thisArg, this.residents[index] as MeshGpuHandles, binding, this);
    }
  }
}

interface ResidentFrame {
  layout: symbol | undefined;
  readonly roster: MeshRoster;
  readonly residents: readonly Resident[];
  readonly table: ReadonlyMap<Binding, MeshGpuHandles>;
}

const residentFrames = new WeakMap<RenderSystemInternals, ResidentFrame>();
const emptyTable: ReadonlyMap<Binding, MeshGpuHandles> = new Map();

/** Read each distinct physical mesh in the current scope, including on pose-only frames. */
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
  const batches = scene.plan.batches;
  const previous = residentFrames.get(internals);
  const layout = materialBindingLayout(batches);
  const roster =
    layout !== undefined && previous?.layout === layout
      ? previous.roster
      : meshRoster(batches, layout, previous?.roster);
  const prior = previous?.roster === roster ? previous.residents : undefined;
  let updated: Resident[] | undefined = prior === undefined ? [] : undefined;
  let present = 0;
  for (let i = 0; i < roster.sources.length; i++) {
    const resident = resolveMesh(
      internals.gpuStore,
      sourceScope,
      roster.sources[i] as Binding,
      policy,
    );
    if (resident !== undefined) present++;
    if (updated === undefined && resident !== prior?.[i]) updated = prior?.slice(0, i);
    updated?.push(resident);
  }
  if (updated === undefined && previous !== undefined) {
    previous.layout = layout;
    return previous.table;
  }
  const residents = updated ?? [];
  const table = IssuedMeshes.issue(roster, residents, present);
  residentFrames.set(internals, { layout, roster, residents, table });
  return table;
}

/** Called by a recording that will consume real geometry queries/commands. */
export function querySceneExecution(scene: PersistentGpuDrivenState): PersistentGpuDrivenState {
  const { queryExecution, ...source } = scene;
  if (queryExecution === undefined) return scene;
  const plans = queryExecution();
  return { ...source, plan: plans.active, residentExecution: plans.resident };
}
