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
  return prepareMesh(store, world, handle, lods) ?? gpu;
}

// Only a missing physical lane resolves source assets or captures the scope for LOD lookup.
function prepareMesh(
  store: RenderSystemInternals['gpuStore'],
  world: RenderResourceScope,
  handle: AssetHandle<'mesh'>,
  lods: Binding['lods'],
): Resident {
  const asset = world.resolveAsset<MeshAsset>(handle);
  if (!asset.ok) return undefined;
  const resident = store.ensureResident(
    handle,
    asset.value,
    world,
    lods?.map((guid) => {
      const lod = renderAsset<MeshAsset>(world, guid);
      return lod?.kind === 'mesh' ? lod : undefined;
    }),
  );
  return resident.ok ? resident.value : undefined;
}

/** The binding address belongs to the roster. Only the physical mesh columns vary by issuance. */
class IssuedMeshes implements ReadonlyMap<Binding, MeshGpuHandles> {
  static readonly empty = new IssuedMeshes(new Map(), []);

  private constructor(
    private readonly indices: ReadonlyMap<Binding, number>,
    private readonly residents: readonly Resident[],
  ) {}

  static issue(
    roster: MeshRoster,
    residents: readonly Resident[],
    present: number,
    previous: IssuedMeshes | undefined,
  ): IssuedMeshes {
    if (present === 0) return IssuedMeshes.empty;
    if (previous !== undefined) return new IssuedMeshes(previous.indices, residents);
    if (present === residents.length) return new IssuedMeshes(roster.indices, residents);
    // A retained incomplete issue must not hold the missing bindings from the full roster.
    const ready = new Map<Binding, number>();
    roster.indices.forEach((index, binding) => {
      if (residents[index] !== undefined) ready.set(binding, index);
    });
    return new IssuedMeshes(ready, residents);
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
  readonly table: IssuedMeshes;
}

const residentFrames = new WeakMap<RenderSystemInternals, ResidentFrame>();

/** Read each distinct physical mesh in the current scope, including on pose-only frames. */
export function gpuDrivenMeshesForFrame(
  internals: RenderSystemInternals,
  sourceScope: RenderResourceScope,
  scene: MeshScene | undefined,
  policy: ResidencyPolicy = 'prepare',
): ReadonlyMap<Binding, MeshGpuHandles> {
  if (!scene?.plan.batches.length) {
    residentFrames.delete(internals);
    return IssuedMeshes.empty;
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
  let membershipChanged = prior === undefined;
  for (let i = 0; i < roster.sources.length; i++) {
    const resident = resolveMesh(
      internals.gpuStore,
      sourceScope,
      roster.sources[i] as Binding,
      policy,
    );
    if (resident !== undefined) present++;
    const before = prior?.[i];
    if (resident !== before) {
      if (updated === undefined) updated = prior?.slice(0, i);
      membershipChanged ||= (resident === undefined) !== (before === undefined);
    }
    updated?.push(resident);
  }
  if (updated === undefined && previous !== undefined) {
    previous.layout = layout;
    return previous.table;
  }
  const residents = updated ?? [];
  const table = IssuedMeshes.issue(
    roster,
    residents,
    present,
    membershipChanged ? undefined : previous?.table,
  );
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
