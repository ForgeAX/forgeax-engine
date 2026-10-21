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

interface DynamicGeometryFrameBindings {
  begin(): void;
  onRenderableDraw(
    worlds: readonly RenderResourceScope[],
  ): (entry: Pick<ValidatedRenderable, 'source'>, lane?: RecordStageDrawLane) => void;
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
  return {
    begin(): void {
      submitted = new WeakMap();
      pending = new WeakMap();
    },
    onRenderableDraw(
      worlds,
    ): (entry: Pick<ValidatedRenderable, 'source'>, lane?: RecordStageDrawLane) => void {
      return createDynamicGeometryConsumptionRecorder(worlds, pending);
    },
    commit(didSubmit): void {
      if (didSubmit) submitted = pending;
    },
    isConsumed(world, entity, meshHandle): boolean {
      if (!Number.isInteger(entity) || meshHandle === undefined) return false;
      return submitted.get(world)?.get(entity)?.meshHandle === meshHandle;
    },
    recordStageLane(world, entity, meshHandle): DynamicGeometryRecordStageLane | undefined {
      if (!Number.isInteger(entity) || meshHandle === undefined) return undefined;
      const binding = submitted.get(world)?.get(entity);
      if (binding?.meshHandle !== meshHandle) return undefined;
      return binding.lane;
    },
  };
}
