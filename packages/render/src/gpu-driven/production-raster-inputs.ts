import { type BindGroup, type Buffer, err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { GpuScene, GpuSceneTableBindingTarget } from '../gpu-scene';
import type { MaterialTableBindingPreparation } from '../record/material-bg-assembly-cache';
import type { SkinTaskBinding } from '../record/skin-tasks';
import type { LiveRasterBatch, LiveRasterCache } from './live-raster';
import {
  type PreparedRasterBundleCache,
  type PreparedRasterWindowPreparation,
  prepareRasterWindows,
} from './prepared-raster-bundle';
import { remapRetainedRasterStorage } from './production-raster-encode';
import type { MaterialAbiRasterAdapter } from './production-raster-material';
import type { ShadowBatchProjections, ShadowProjectionSource } from './production-raster-shadow';
import {
  type GpuRasterInputPreparation,
  type RasterInputDemand,
  rasterInputCurrent,
  rasterInputTarget,
} from './raster-input-bindings';
import type {
  RetainedRasterEncodes,
  RetainedRasterInputPreparation,
} from './retained-raster-encode';
import { publishReadonlyMap } from './shadow-projection-publication';
import type { GpuDrivenView, ViewStorageTarget } from './view-gpu';
import type { GpuViewInputPreparation } from './view-input-bindings';

interface ShadowObservation {
  readonly projections: object;
  readonly filtered: object;
  readonly executions: object;
  readonly artifacts: object;
}

/** Borrowed facts from the actual Production, not a second live-batch authority. */
export interface ProductionRasterInputs {
  readonly rigid: MaterialAbiRasterAdapter | undefined;
  readonly skin: MaterialAbiRasterAdapter | undefined;
  readonly main: LiveRasterCache | undefined;
  readonly shadows: ReadonlyMap<string, ShadowBatchProjections>;
  readonly shadowSources: WeakMap<ShadowBatchProjections, ShadowProjectionSource>;
  readonly unchanged: Map<string, ShadowObservation>;
  readonly retained: RetainedRasterEncodes;
}

function stale(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'complete current Production raster input projections and native bundle mappings',
    hint: 'finish numeric copying and prepare the actual idle main/shadow recording owners',
  });
}

function sameRows<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

function sameOwners(expected: ProductionRasterInputs, now: ProductionRasterInputs): boolean {
  return (
    now.rigid === expected.rigid &&
    now.skin === expected.skin &&
    now.main === expected.main &&
    now.retained === expected.retained &&
    now.shadowSources === expected.shadowSources &&
    now.unchanged === expected.unchanged
  );
}

function sameWindows(
  windows: ReadonlyMap<LiveRasterBatch, LiveRasterBatch['visibleBindGroups']>,
): boolean {
  for (const [live, expected] of windows) if (live.visibleBindGroups !== expected) return false;
  return true;
}

function sameSources(
  state: ProductionRasterInputs,
  sources: ReadonlyMap<ShadowBatchProjections, ShadowProjectionSource | undefined>,
  facts: ReadonlyMap<ShadowBatchProjections, ShadowProjectionSource>,
): boolean {
  for (const [projection, source] of sources) {
    const actual = state.shadowSources.get(projection);
    if (actual !== source) return false;
    const expected = facts.get(projection);
    if (actual === undefined || expected === undefined) continue;
    if (Object.keys(actual).length !== Object.keys(expected).length) return false;
    for (const key of Object.keys(expected) as (keyof ShadowProjectionSource)[])
      if (actual[key] !== expected[key]) return false;
  }
  return true;
}

function captureProjectionFacts(state: ProductionRasterInputs, visible: ReadonlySet<Buffer>) {
  const liveWindows = new Map<LiveRasterBatch, LiveRasterBatch['visibleBindGroups']>();
  const sources = new Map<ShadowBatchProjections, ShadowProjectionSource | undefined>();
  const sourceFacts = new Map<ShadowBatchProjections, ShadowProjectionSource>();
  if (state.main !== undefined && visible.has(state.main.visibleBuffer))
    for (const live of state.main.value) liveWindows.set(live, live.visibleBindGroups);
  for (const projection of state.shadows.values()) {
    const source = state.shadowSources.get(projection);
    if (source === undefined || !visible.has(source.visibleBuffer)) continue;
    sources.set(projection, source);
    sourceFacts.set(projection, { ...source });
  }
  return { liveWindows, sources, sourceFacts };
}

type MapWindows = (
  groups: readonly BindGroup[],
  identity: object | undefined,
  adapter: MaterialAbiRasterAdapter | undefined,
) => readonly BindGroup[];

function projectMainInputs(
  state: ProductionRasterInputs,
  visible: ReadonlySet<Buffer>,
  map: MapWindows,
  identity: (value: unknown) => unknown,
  captured: ReadonlyMap<LiveRasterBatch, LiveRasterBatch['visibleBindGroups']>,
  pending: Map<LiveRasterBatch, LiveRasterBatch['visibleBindGroups']>,
  caches: Set<LiveRasterBatch['bundles']>,
  storage: ViewStorageTarget | undefined,
): LiveRasterCache | undefined {
  const main = state.main;
  if (main === undefined || !visible.has(main.visibleBuffer)) return main;
  for (const live of main.value) {
    const groups = captured.get(live);
    const skin = live.batch.prepared?.identity.deformation === 'skin';
    const binding = skin ? main.skinBindings : main.rigidBindings;
    const adapter = skin ? state.skin : state.rigid;
    pending.set(
      live,
      groups === undefined
        ? undefined
        : new Map(
            Array.from(groups, ([layout, { early, late }]) => [
              layout,
              {
                ...(early === undefined ? {} : { early: map(early, binding, adapter) }),
                ...(late === undefined ? {} : { late: map(late, binding, adapter) }),
              },
            ]),
          ),
    );
    caches.add(live.bundles);
  }
  return {
    ...main,
    visibleBuffer:
      storage !== undefined && main.visibleBuffer === storage.before.visible
        ? storage.after.visible
        : main.visibleBuffer,
    rigidBindings: identity(main.rigidBindings) as object,
    skinBindings: identity(main.skinBindings) as object | undefined,
  };
}

/** Scope comes from real View buffers and projection issuers, never a cache miss. */
function scopedAdapters(
  state: ProductionRasterInputs,
  scene: GpuScene,
  visible: ReadonlySet<Buffer>,
  target?: GpuSceneTableBindingTarget,
  storage = false,
): Result<readonly MaterialAbiRasterAdapter[], RhiError> {
  const adapters = new Set<MaterialAbiRasterAdapter>();
  const checkRole = (
    adapter: MaterialAbiRasterAdapter | undefined,
    identity: object | undefined,
  ) => {
    if (adapter === undefined || identity !== adapter.visibleBindingIdentity) return false;
    const status = adapter.inputBindingState(scene.inputs, target);
    if (status === 'foreign' || status === 'stale') return false;
    if (status === 'current' || storage) adapters.add(adapter);
    return true;
  };
  const main = state.main;
  if (main !== undefined && visible.has(main.visibleBuffer))
    for (const live of main.value) {
      const skin = live.batch.prepared?.identity.deformation === 'skin';
      if (
        !checkRole(skin ? state.skin : state.rigid, skin ? main.skinBindings : main.rigidBindings)
      )
        return err(stale());
    }
  for (const projections of state.shadows.values()) {
    const source = state.shadowSources.get(projections);
    if (source === undefined) return err(stale());
    if (!visible.has(source.visibleBuffer)) continue;
    for (const projection of projections.values()) {
      const skin = projection.deformation === 'skin';
      if (
        !checkRole(
          skin ? state.skin : state.rigid,
          skin ? source.skinVisibleBindingIdentity : source.visibleBindingIdentity,
        )
      )
        return err(stale());
    }
  }
  return ok([...adapters]);
}

/** Captures only existing demand; future graph/material windows still require preparation. */
export function prepareProductionRasterInputs(
  scene: GpuScene,
  input: RasterInputDemand,
  views: readonly GpuDrivenView[],
  read: () => ProductionRasterInputs,
  accept: (main: LiveRasterCache | undefined, shadows: ProductionRasterInputs['shadows']) => void,
  current: () => boolean,
  tables?: GpuSceneTableBindingTarget,
  materialPreparation?: MaterialTableBindingPreparation,
): Result<GpuViewInputPreparation, RhiError> {
  let materialTables = materialPreparation;
  let tableTarget = tables;
  let before: ProductionRasterInputs | undefined = read();
  let readOwner: typeof read | undefined = read;
  let acceptOwner: typeof accept | undefined = accept;
  let ownerCurrent: typeof current | undefined = current;
  let inputs: GpuScene['inputs'] | undefined = scene.inputs;
  let targetInput: RasterInputDemand | undefined = input;
  const visibleFacts = new Map(views.map((view) => [view, view.visibleBuffer] as const));
  const skinFacts = new Map(
    views.map((view) => {
      const binding = view.skinTaskBinding();
      return [view, binding === undefined ? undefined : { ...binding }] as const;
    }),
  );
  const visible = new Set<Buffer>();
  const storage = input.kind === 'current' ? input.storage : undefined;
  for (const buffer of visibleFacts.values()) {
    if (buffer === undefined) return err(stale());
    visible.add(buffer);
  }
  const scoped = scopedAdapters(before, scene, visible, tables, input.kind === 'current');
  if (!scoped.ok) return scoped;
  const adapters = [...scoped.value];
  let snapshot: ProductionRasterInputs | undefined;
  const materialTasks: GpuRasterInputPreparation[] = [];
  const materialsByIdentity = new Map<object, GpuRasterInputPreparation>();
  const bundleTasks: PreparedRasterWindowPreparation[] = [];
  let retained: RetainedRasterInputPreparation | undefined;
  const remaps = new Map<unknown, unknown>();
  const windows = new Map<BindGroup, BindGroup>();
  const { liveWindows, sources, sourceFacts } = captureProjectionFacts(before, visible);
  const nextWindows = new Map<LiveRasterBatch, LiveRasterBatch['visibleBindGroups']>();
  const observations = new Map(before.unchanged);
  const shadowRows = new Map(before.shadows);
  let nextShadows: ProductionRasterInputs['shadows'] | undefined = before.shadows;
  let nextMain = before.main;
  const nextSources: (readonly [ShadowBatchProjections, ShadowProjectionSource])[] = [];
  const nextObservations: (readonly [string, ShadowObservation])[] = [];
  let closed = false;
  let ready = false;
  let observing = false;
  const tableCurrent = () =>
    tableTarget === undefined ||
    (tableTarget.owner.inputs === inputs && tableTarget.owner.capacityTargetMatches(tableTarget));
  const stagingCurrent = () => !closed && tableCurrent();
  const rootCurrent = () => {
    if (
      !stagingCurrent() ||
      ownerCurrent?.() !== true ||
      !stagingCurrent() ||
      before === undefined ||
      readOwner === undefined
    )
      return false;
    const expected = before;
    const now = readOwner();
    for (const [view, buffer] of visibleFacts) if (view.visibleBuffer !== buffer) return false;
    if (!sameSkinTasks(skinFacts)) return false;
    if (
      closed ||
      !sameOwners(expected, now) ||
      !sameRows(shadowRows, now.shadows) ||
      !sameRows(observations, now.unchanged) ||
      !sameWindows(liveWindows) ||
      !sameSources(now, sources, sourceFacts)
    )
      return false;
    return true;
  };
  // Qualify the captured Production at transaction boundaries. Native bind
  // group creation also checks it before issuing another allocation. Bundle
  // and retained command staging use their own receipts until publication.
  const allCurrent = () =>
    rootCurrent() &&
    materialTasks.every((task) => task.isCurrent()) &&
    (materialTables?.isCurrent() ?? true) &&
    bundleTasks.every((task) => task.isCurrent()) &&
    (retained?.isCurrent() ?? true);
  const release = () => {
    closed = true;
    ready = false;
    retained?.release();
    retained = undefined;
    materialTables?.release();
    materialTables = undefined;
    tableTarget = undefined;
    for (const task of bundleTasks) task.release();
    for (const task of materialTasks) task.release();
    bundleTasks.length = 0;
    materialTasks.length = 0;
    remaps.clear();
    windows.clear();
    liveWindows.clear();
    nextWindows.clear();
    sources.clear();
    sourceFacts.clear();
    observations.clear();
    shadowRows.clear();
    nextSources.length = 0;
    nextObservations.length = 0;
    visibleFacts.clear();
    skinFacts.clear();
    visible.clear();
    materialsByIdentity.clear();
    adapters.length = 0;
    snapshot = undefined;
    before = undefined;
    readOwner = undefined;
    acceptOwner = undefined;
    ownerCurrent = undefined;
    inputs = undefined;
    targetInput = undefined;
    nextMain = undefined;
    nextShadows = undefined;
  };
  const prepareMaterials = (): Result<void, RhiError> => {
    const source = inputs,
      candidate = targetInput;
    if (source === undefined || candidate === undefined) return err(stale());
    for (const adapter of adapters) {
      if (!rootCurrent()) return err(stale());
      const task = adapter.prepareInputBindings(
        source,
        candidate,
        [...visible],
        rootCurrent,
        tables,
      );
      if (!task.ok) return task;
      materialTasks.push(task.value);
      const identity = task.value.bindingIdentity();
      if (identity === undefined) return err(stale());
      remaps.set(adapter.visibleBindingIdentity, identity);
      materialsByIdentity.set(adapter.visibleBindingIdentity, task.value);
    }
    return ok(undefined);
  };
  const api: GpuViewInputPreparation = Object.freeze({
    isCurrent: () => {
      if (observing) return false;
      observing = true;
      try {
        return ready && allCurrent();
      } finally {
        observing = false;
      }
    },
    publish: () => {
      if (observing) return err(stale());
      observing = true;
      try {
        const activeInputs = inputs;
        const target =
          targetInput === undefined
            ? undefined
            : activeInputs === undefined
              ? undefined
              : rasterInputTarget(activeInputs, targetInput);
        // After Inputs commits, its private target is consumed; each material
        // task checks the exact accepted target and actual current buffer.
        if (
          !ready ||
          !allCurrent() ||
          activeInputs === undefined ||
          before === undefined ||
          nextShadows === undefined ||
          acceptOwner === undefined ||
          (target !== undefined && !activeInputs.isCurrentBuffer(target.buffer))
        )
          return err(stale());
        const held = retained?.publish();
        if (held !== undefined && !held.ok) return held;
        const bundles = publishBindings(bundleTasks);
        if (!bundles.ok) return bundles;
        const materials = publishBindings(materialTasks);
        if (!materials.ok) return materials;
        for (const [live, groups] of nextWindows) live.visibleBindGroups = groups;
        for (const [projection, source] of nextSources)
          before.shadowSources.set(projection, source);
        for (const [key, observation] of nextObservations) before.unchanged.set(key, observation);
        const owners = publishBindings([materialTables]);
        if (!owners.ok) return owners;
        acceptOwner(nextMain, nextShadows);
        release();
        return ok(undefined);
      } finally {
        observing = false;
      }
    },
    release,
  });
  let accepted = false;
  try {
    if (!rootCurrent()) return err(stale());
    // Even a rigid-only scene preserves the original View-only pre-copy path.
    if (adapters.length === 0) {
      ready = true;
      accepted = true;
      return ok(api);
    }
    if (!rasterInputAvailable(scene, input)) return err(stale());
    remapPhysicalInputs(remaps, scene, tables, storage);
    snapshot = before;
    const preparedMaterials = prepareMaterials();
    if (!preparedMaterials.ok) return preparedMaterials;
    const mapWindow = (window: BindGroup) => {
      const cached = windows.get(window);
      if (cached !== undefined) return cached;
      for (const task of materialTasks) {
        const replacement = task.replacement(window);
        if (replacement !== undefined) {
          windows.set(window, replacement);
          return replacement;
        }
      }
      throw new RhiError({
        code: 'rhi-descriptor-invalid',
        expected:
          storage === undefined
            ? 'a retained Scene raster window'
            : 'a retained View raster window',
        hint: 'resolve the bundle window in the original raster binding owner',
      });
    };
    const mapMaterial = (group: BindGroup): BindGroup => {
      if (materialTables === undefined) return group;
      const mapped = materialTables.replacement(group);
      if (mapped === undefined) throw stale();
      remaps.set(group, mapped);
      return mapped;
    };
    const mapWindows = (
      groups: readonly BindGroup[],
      binding: object | undefined,
      adapter: MaterialAbiRasterAdapter | undefined,
    ) => {
      if (
        adapter !== undefined &&
        adapters.includes(adapter) &&
        binding !== adapter.visibleBindingIdentity
      )
        throw stale();
      const task = binding === undefined ? undefined : materialsByIdentity.get(binding);
      return prepareRasterWindows(
        groups.map((window) => {
          const replacement = task === undefined ? window : task.replacement(window);
          if (replacement === undefined) throw stale();
          windows.set(window, replacement);
          return replacement;
        }),
      );
    };
    const caches = new Set<LiveRasterBatch['bundles']>();
    const identity = (value: unknown) => remaps.get(value) ?? value;
    nextMain = projectMainInputs(
      snapshot,
      visible,
      mapWindows,
      identity,
      liveWindows,
      nextWindows,
      caches,
      storage,
    );
    const shadowNext = new Map<string, ShadowBatchProjections>();
    for (const [key, projections] of shadowRows) {
      const source = sourceFacts.get(projections);
      if (source === undefined) {
        shadowNext.set(key, projections);
        continue;
      }
      const next = publishReadonlyMap(
        new Map(
          [...projections].map(([id, projection]) => {
            caches.add(projection.bundles);
            const binding =
              projection.deformation === 'skin'
                ? source.skinVisibleBindingIdentity
                : source.visibleBindingIdentity;
            const owner = snapshot;
            if (owner === undefined) throw stale();
            const adapter = projection.deformation === 'skin' ? owner.skin : owner.rigid;
            return [
              id,
              {
                ...projection,
                visibleBindGroups: mapWindows(projection.visibleBindGroups, binding, adapter),
              },
            ] as const;
          }),
        ),
      );
      shadowNext.set(key, next);
      nextSources.push([
        next,
        {
          ...source,
          visibleBuffer: identity(source.visibleBuffer) as Buffer,
          visibleBindingIdentity: identity(source.visibleBindingIdentity) as object,
          skinVisibleBindingIdentity: identity(source.skinVisibleBindingIdentity) as
            | object
            | undefined,
        },
      ]);
      const observation = observations.get(key);
      if (observation !== undefined)
        nextObservations.push([key, { ...observation, projections: next }]);
    }
    nextShadows = publishReadonlyMap(shadowNext);
    const preparedBundles = prepareBundles(
      caches,
      bundleTasks,
      mapWindow,
      mapMaterial,
      stagingCurrent,
      storage,
    );
    if (!preparedBundles.ok) return preparedBundles;
    const mapped = snapshot.retained.prepareInputs(
      remaps,
      (bundle) => {
        for (const task of bundleTasks) {
          const replacement = task.replacement(bundle);
          if (replacement !== undefined) return replacement;
        }
        return undefined;
      },
      stagingCurrent,
      (values) => remapRetainedRasterStorage(values, storage),
    );
    if (!mapped.ok) return mapped;
    retained = mapped.value;
    if (!allCurrent()) return err(stale());
    ready = true;
    accepted = true;
    return ok(api);
  } catch (cause) {
    if (cause instanceof RhiError) return err(cause);
    throw cause;
  } finally {
    if (!accepted) release();
  }
}

function sameSkinTasks(facts: ReadonlyMap<GpuDrivenView, SkinTaskBinding | undefined>): boolean {
  for (const [view, expected] of facts) {
    const now = view.skinTaskBinding();
    if (
      expected === undefined
        ? now !== undefined
        : now === undefined ||
          now.data !== expected.data ||
          now.auxiliary !== expected.auxiliary ||
          now.dataOffset !== expected.dataOffset ||
          now.auxiliaryOffset !== expected.auxiliaryOffset ||
          now.dataSize !== expected.dataSize ||
          now.auxiliarySize !== expected.auxiliarySize
    )
      return false;
  }
  return true;
}

function publishBindings(
  tasks: readonly (Pick<GpuViewInputPreparation, 'publish'> | undefined)[],
): Result<void, RhiError> {
  for (const task of tasks) {
    if (task === undefined) continue;
    const result = task.publish();
    if (!result.ok) return result;
  }
  return ok(undefined);
}

function prepareBundles(
  caches: ReadonlySet<PreparedRasterBundleCache>,
  tasks: PreparedRasterWindowPreparation[],
  mapWindow: (group: BindGroup) => BindGroup,
  mapMaterial: (group: BindGroup) => BindGroup,
  current: () => boolean,
  storage?: ViewStorageTarget,
): Result<void, RhiError> {
  for (const cache of caches) {
    const result = cache.prepareBindings((binding) => {
      // A View capacity change only replaces that View's physical buffers.
      // Retained variants for another View already have their actual bindings.
      if (storage !== undefined && binding.indirect !== storage.before.indirect) return binding;
      return {
        ...binding,
        windows: binding.windows.map(mapWindow),
        material: mapMaterial(binding.material),
        indirect: storage?.after.indirect ?? binding.indirect,
        indirectOffset:
          storage !== undefined && binding.indirectOffset >= storage.previousLateIndirectBase
            ? binding.indirectOffset - storage.previousLateIndirectBase + storage.lateIndirectBase
            : binding.indirectOffset,
      };
    }, current);
    if (!result.ok) return result;
    tasks.push(result.value);
  }

  return ok(undefined);
}

function rasterInputAvailable(scene: GpuScene, input: RasterInputDemand): boolean {
  const target = rasterInputTarget(scene.inputs, input);
  return target !== undefined && rasterInputCurrent(scene.inputs, input, target.buffer);
}
function remapPhysicalInputs(
  remaps: Map<unknown, unknown>,
  scene: GpuScene,
  tables: GpuSceneTableBindingTarget | undefined,
  storage: ViewStorageTarget | undefined,
): void {
  if (tables !== undefined) {
    remaps.set(scene.tableBindingIdentity, tables.identity);
    remaps.set(scene.primitiveBuffer, tables.primitiveBuffer);
    remaps.set(scene.instanceBuffer, tables.instanceBuffer);
    remaps.set(scene.transformBuffer, tables.transformBuffer);
    remaps.set(scene.materialBuffer, tables.materialBuffer);
  }
  if (storage !== undefined) {
    remaps.set(storage.before.visible, storage.after.visible);
    remaps.set(storage.before.view, storage.after.view);
    remaps.set(storage.before.indirect, storage.after.indirect);
  }
}
