import type { DynamicGeometryRecordStageLane } from '../dynamic-geometry';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { ValidatedRenderable } from './frame-snapshot';

type RecordStageDrawLane = 'cpu' | 'gpu';

interface PendingDynamicGeometryBinding {
  readonly meshHandle: number;
  lane: DynamicGeometryRecordStageLane;
}

/** Capture the render-stage mesh binding used by the current submitted frame. */
function createDynamicGeometryConsumptionRecorder(
  worlds: readonly RenderResourceScope[],
  bindings: WeakMap<RenderResourceScope, Map<number, PendingDynamicGeometryBinding>>,
): (entry: Pick<ValidatedRenderable, 'source'>, lane?: RecordStageDrawLane) => void {
  return (entry, lane = 'cpu') => {
    const renderable = entry.source;
    if (renderable.assetHandle === undefined) return;
    const world = worlds[renderable.worldId];
    if (world === undefined) return;
    let worldBindings = bindings.get(world);
    if (worldBindings === undefined) {
      worldBindings = new Map();
      bindings.set(world, worldBindings);
    }
    const existing = worldBindings.get(renderable.entityKey);
    if (existing === undefined || existing.meshHandle !== renderable.assetHandle) {
      worldBindings.set(renderable.entityKey, {
        meshHandle: renderable.assetHandle,
        lane,
      });
      return;
    }
    if (existing.lane !== lane) existing.lane = 'mixed';
  };
}

/** Rows a submitted GPU selection draws, answered per query instead of per frame row. */
type GpuOwnedDraws = (worldId: number, entity: number, meshHandle: number) => boolean;

interface GpuOwnedFrameDraws {
  readonly worlds: readonly RenderResourceScope[];
  readonly owns: GpuOwnedDraws;
}

interface DynamicGeometryFrameBindings {
  begin(): void;
  onRenderableDraw(
    worlds: readonly RenderResourceScope[],
  ): (entry: Pick<ValidatedRenderable, 'source'>, lane?: RecordStageDrawLane) => void;
  /** GPU-owned rows that received no per-row receipt in this attempt. */
  onGpuOwnedDraws(worlds: readonly RenderResourceScope[], owns: GpuOwnedDraws): void;
  commit(submitted: boolean): void;
  isConsumed(world: RenderResourceScope, entity: number, meshHandle: number | undefined): boolean;
  recordStageLane(
    world: RenderResourceScope,
    entity: number,
    meshHandle: number | undefined,
  ): DynamicGeometryRecordStageLane | undefined;
}

/** Own the submitted-frame receipt used by dynamic-geometry publication. */
export function createDynamicGeometryFrameBindings(): DynamicGeometryFrameBindings {
  let submitted = new WeakMap<
    RenderResourceScope,
    ReadonlyMap<number, PendingDynamicGeometryBinding>
  >();
  let pending = new WeakMap<RenderResourceScope, Map<number, PendingDynamicGeometryBinding>>();
  let submittedGpu: GpuOwnedFrameDraws | undefined;
  let pendingGpu: GpuOwnedFrameDraws | undefined;
  const recordStageLane = (
    world: RenderResourceScope,
    entity: number,
    meshHandle: number | undefined,
  ): DynamicGeometryRecordStageLane | undefined => {
    if (!Number.isInteger(entity) || meshHandle === undefined) return undefined;
    const binding = submitted.get(world)?.get(entity);
    const cpu = binding?.meshHandle === meshHandle ? binding.lane : undefined;
    const worldId = submittedGpu?.worlds.indexOf(world) ?? -1;
    const gpu =
      worldId >= 0 && submittedGpu?.owns(worldId, entity, meshHandle) === true ? 'gpu' : undefined;
    if (cpu === undefined) return gpu;
    return gpu === undefined || cpu === gpu ? cpu : 'mixed';
  };
  return {
    begin(): void {
      submitted = new WeakMap();
      pending = new WeakMap();
      submittedGpu = undefined;
      pendingGpu = undefined;
    },
    onRenderableDraw(
      worlds,
    ): (entry: Pick<ValidatedRenderable, 'source'>, lane?: RecordStageDrawLane) => void {
      pendingGpu = undefined;
      return createDynamicGeometryConsumptionRecorder(worlds, pending);
    },
    onGpuOwnedDraws(worlds, owns): void {
      pendingGpu = { worlds, owns };
    },
    commit(didSubmit): void {
      if (!didSubmit) return;
      submitted = pending;
      submittedGpu = pendingGpu;
    },
    isConsumed: (world, entity, meshHandle) =>
      recordStageLane(world, entity, meshHandle) !== undefined,
    recordStageLane,
  };
}
