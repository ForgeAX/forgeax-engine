import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { GpuScene, GpuSceneResourceFrame, GpuSceneTableBindingTarget } from '../gpu-scene';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import { GPU_SCENE_LAYOUTS } from '../gpu-scene-schema';
import type { MaterialTableBindingPreparation } from '../record/material-bg-assembly-cache';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import {
  type ProductionRasterInputs,
  prepareProductionRasterInputs,
} from './production-raster-inputs';
import type { MaterialAbiRasterAdapter } from './production-raster-material';
import type { GpuDrivenView, ViewStorageTarget } from './view-gpu';
import type { GpuViewInputPreparation } from './view-input-bindings';

/** Capacity-only replacement borrows the actual accepted Inputs; it creates no Inputs candidate. */
export function prepareProductionStorageInputs(
  scene: GpuScene,
  storage: ViewStorageTarget,
  views: readonly GpuDrivenView[],
  read: () => ProductionRasterInputs,
  accept: (
    main: ProductionRasterInputs['main'],
    shadows: ProductionRasterInputs['shadows'],
  ) => void,
): Result<GpuViewInputPreparation, RhiError> {
  const buffer = storage.view.sceneInputBuffer;
  if (buffer === undefined || !storage.isCurrent() || !scene.inputs.isCurrentBuffer(buffer))
    return err(stale());
  return prepareProductionRasterInputs(
    scene,
    { kind: 'current', storage, buffer },
    views,
    read,
    accept,
    storage.isCurrent,
  );
}

/** One Production's actual owned projections, never a complete Renderer claim. */
export function prepareProductionInputBindings(
  scene: GpuScene,
  preparation: GpuSceneInputPreparation,
  views: readonly GpuDrivenView[],
  current: () => boolean,
  finished: (task: GpuViewInputPreparation) => void,
  raster: () => ProductionRasterInputs,
  acceptRaster: (
    main: ProductionRasterInputs['main'],
    shadows: ProductionRasterInputs['shadows'],
  ) => void,
  tables?: GpuSceneTableBindingTarget,
  materialTables?: MaterialTableBindingPreparation,
): Result<GpuViewInputPreparation, RhiError> {
  const target = scene.inputs.preparationTarget(preparation);
  if (target === undefined || views.length === 0 || !current()) return err(stale());
  const leases: GpuViewInputPreparation[] = [];
  let closed = false;
  let observing = false;
  let ownerCurrent: typeof current | undefined = current;
  let onFinished: typeof finished | undefined = finished;
  let inputs: GpuScene['inputs'] | undefined = scene.inputs;
  let buffer: typeof target.buffer | undefined = target.buffer;
  const live = () =>
    !closed && ownerCurrent?.() === true && !closed && leases.every((lease) => lease.isCurrent());
  const release = () => {
    if (closed) return;
    closed = true;
    for (const lease of leases) lease.release();
    leases.length = 0;
    const done = onFinished;
    onFinished = undefined;
    ownerCurrent = undefined;
    inputs = undefined;
    buffer = undefined;
    done?.(api);
  };
  const api: GpuViewInputPreparation = Object.freeze({
    isCurrent: () => {
      if (observing) return false;
      observing = true;
      try {
        return live();
      } finally {
        observing = false;
      }
    },
    publish: () => {
      if (observing) return err(stale());
      observing = true;
      try {
        if (!live() || buffer === undefined || inputs?.isCurrentBuffer(buffer) !== true)
          return err(stale());
        // Every pair was just checked and publishes only private local fields.
        for (const lease of leases) {
          const published = lease.publish();
          if (!published.ok) return published;
        }
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
    const preparedRaster = prepareProductionRasterInputs(
      scene,
      { kind: 'successor', preparation },
      views,
      raster,
      acceptRaster,
      current,
      tables,
      materialTables,
    );
    if (!preparedRaster.ok) return preparedRaster;
    // Raster owns dependent retained/native/window publications; View pairs have
    // independent issuer checks and publish after those dependent qualifications.
    leases.unshift(preparedRaster.value);
    for (const view of views) {
      if (!current()) return err(stale());
      const prepared = view.prepareInputBindings(scene, preparation, tables);
      if (!prepared.ok) return prepared;
      leases.push(prepared.value);
    }
    if (!current() || scene.inputs.preparationTarget(preparation) !== target) return err(stale());
    accepted = true;
    return ok(api);
  } finally {
    if (!accepted) release();
  }
}

export function sameInputViews(a: readonly GpuDrivenView[], b: readonly GpuDrivenView[]): boolean {
  return a.length === b.length && a.every((view, index) => view === b[index]);
}

function stale(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'the idle Production and its unchanged owned View/raster input projections',
    hint: 'release this preparation and retry after ordinary recording settles',
  });
}

export function bindSceneTables(
  raster: MaterialAbiRasterAdapter,
  scene: PersistentGpuDrivenState,
  view: GpuDrivenView,
): void {
  const rowCapacity = scene.scene.rowCapacity;
  raster.ensureSceneTables(
    scene.scene.transformBuffer,
    scene.scene.transformByteLength,
    scene.scene.instanceBuffer,
    rowCapacity * GPU_SCENE_LAYOUTS.instance.stride,
    scene.scene.primitiveBuffer,
    rowCapacity * GPU_SCENE_LAYOUTS.primitive.stride,
    view.visibleSurfaceRowsBuffer,
    // Only morph rows read the arena; rigid scenes keep their raster groups (and
    // retained bundles) stable when the arena reallocates.
    scene.scene.hasMorphRows ? view.sceneInputBuffer : undefined,
    scene.scene.hasMorphRows ? scene.scene.inputs : undefined,
  );
}

export function readSourceResources<T, E>(
  active: Set<GpuSceneResourceFrame>,
  scene: GpuScene,
  consume: (resources: GpuSceneResourceFrame) => Result<T, E>,
): Result<T, E | RhiError> {
  const captured = scene.captureResources();
  if (!captured.ok) return captured;
  const resources = captured.value;
  active.add(resources);
  let result: Result<T, E> | undefined;
  let failure: { readonly cause: unknown } | undefined;
  try {
    result = consume(resources);
  } catch (cause) {
    failure = { cause };
  } finally {
    active.delete(resources);
    try {
      resources.release();
    } catch (cause) {
      failure = {
        cause:
          failure === undefined
            ? cause
            : new AggregateError(
                [failure.cause, cause],
                'Source preparation and read retirement failed',
              ),
      };
    }
  }
  if (failure !== undefined) throw failure.cause;
  if (result === undefined)
    throw new RhiError({
      code: 'internal-error',
      expected: 'one actual Source read result',
      hint: 'preserve the original read-domain failure',
    });
  return result;
}
