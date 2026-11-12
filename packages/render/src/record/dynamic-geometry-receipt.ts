import type { DynamicGeometryRecordStageLane } from '../dynamic-geometry';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { ValidatedRenderable } from './frame-snapshot';

type RecordStageDrawLane = 'cpu' | 'gpu';

interface RecordedBinding {
  meshHandle: number;
  lane: DynamicGeometryRecordStageLane;
  generation: number;
}
interface WorldBindings {
  readonly values: Map<number, RecordedBinding>;
  active: number;
}

/** One side of the accepted/pending receipt; stable entities keep their cells. */
class FrameBindings {
  private generation = 1;
  private frameToken: object = {};
  private current = new WeakMap<RenderResourceScope, WorldBindings>();
  private previous = new WeakMap<RenderResourceScope, WorldBindings>();
  private latestWorld: RenderResourceScope | undefined;
  private latestTable: WorldBindings | undefined;

  begin(): void {
    // Unread scopes disappear without enumerating their entities or retaining Worlds.
    this.previous = this.generation === 0x3fffffff ? new WeakMap() : this.current;
    this.current = new WeakMap();
    this.seal();
    this.generation = this.generation === 0x3fffffff ? 1 : this.generation + 1;
  }

  clear(): void {
    this.current = new WeakMap();
    this.previous = new WeakMap();
    this.seal();
    this.generation = 1;
  }

  /** Submitted facts stay readable, but callbacks and strong lookup hints end here. */
  seal(): void {
    this.frameToken = {};
    this.latestWorld = undefined;
    this.latestTable = undefined;
  }

  get token(): object {
    return this.frameToken;
  }

  record(
    world: RenderResourceScope,
    entity: number,
    meshHandle: number,
    lane: RecordStageDrawLane,
    token: object,
  ): void {
    // A callback from an older use must never write into the recycled pending side.
    if (token !== this.frameToken) return;
    const generation = this.generation;
    let table = world === this.latestWorld ? this.latestTable : undefined;
    if (table === undefined) {
      table = this.current.get(world);
      if (table === undefined) {
        table = this.previous.get(world) ?? { values: new Map(), active: 0 };
        // Geometric rebuilding removes cold entity cells without a per-frame sweep.
        if (table.values.size > table.active * 2) table.values.clear();
        table.active = 0;
        this.current.set(world, table);
      }
      this.latestWorld = world;
      this.latestTable = table;
    }
    let binding = table.values.get(entity);
    if (binding === undefined) {
      binding = { meshHandle, lane, generation };
      table.values.set(entity, binding);
      table.active++;
    } else if (binding.generation !== generation) {
      binding.meshHandle = meshHandle;
      binding.lane = lane;
      binding.generation = generation;
      table.active++;
    } else if (binding.meshHandle !== meshHandle) {
      binding.meshHandle = meshHandle;
      binding.lane = lane;
    } else if (binding.lane !== lane) binding.lane = 'mixed';
  }

  get(world: RenderResourceScope, entity: number): RecordedBinding | undefined {
    const binding = this.current.get(world)?.values.get(entity);
    return binding?.generation === this.generation ? binding : undefined;
  }
}

/** Capture the render-stage mesh binding used by the current submitted frame. */
function createDynamicGeometryConsumptionRecorder(
  worlds: readonly RenderResourceScope[],
  bindings: FrameBindings,
): DynamicGeometryDrawRecorder {
  const token = bindings.token;
  return (entry, lane = 'cpu') => {
    const renderable = entry.source;
    if (renderable.assetHandle === undefined) return;
    const world = worlds[renderable.worldId];
    if (world !== undefined)
      bindings.record(world, renderable.entityKey, renderable.assetHandle, lane, token);
  };
}

/** Rows a submitted GPU selection draws, answered per query instead of per frame row. */
type GpuOwnedDraws = (worldId: number, entity: number, meshHandle: number) => boolean;

interface GpuOwnedFrameDraws {
  readonly worlds: readonly RenderResourceScope[];
  readonly owns: GpuOwnedDraws;
}

export type DynamicGeometryDrawRecorder = (
  entry: Pick<ValidatedRenderable, 'source'>,
  lane?: RecordStageDrawLane,
) => void;

/**
 * One view's submitted-frame receipt for dynamic-geometry publication. Draws
 * write the pending side; the `dynamic-geometry-commit` RenderCommit system
 * promotes it for an accepted attempt and `dynamic-geometry-reset` discards
 * whatever a rejected attempt left.
 */
export class DynamicGeometryReceipt {
  private submitted = new FrameBindings();
  private pending = new FrameBindings();
  private submittedGpu: GpuOwnedFrameDraws | undefined;
  private pendingGpu: GpuOwnedFrameDraws | undefined;

  onRenderableDraw(worlds: readonly RenderResourceScope[]): DynamicGeometryDrawRecorder {
    this.pendingGpu = undefined;
    return createDynamicGeometryConsumptionRecorder(worlds, this.pending);
  }

  /** GPU-owned rows that received no per-row receipt in this attempt. */
  onGpuOwnedDraws(worlds: readonly RenderResourceScope[], owns: GpuOwnedDraws): void {
    this.pendingGpu = { worlds, owns };
  }

  /** The accepted attempt's draws become the submitted receipt. */
  commit(): void {
    const reusable = this.submitted;
    this.submitted = this.pending;
    this.submitted.seal();
    this.submittedGpu = this.pendingGpu;
    this.pending = reusable;
    this.pending.begin();
    this.pendingGpu = undefined;
  }

  /** A rejected attempt leaves no receipt: neither its draws nor the previous frame's. */
  clear(): void {
    this.submitted.clear();
    this.pending.clear();
    this.submittedGpu = undefined;
    this.pendingGpu = undefined;
  }

  isConsumed(world: RenderResourceScope, entity: number, meshHandle: number | undefined): boolean {
    return this.recordStageLane(world, entity, meshHandle) !== undefined;
  }

  recordStageLane(
    world: RenderResourceScope,
    entity: number,
    meshHandle: number | undefined,
  ): DynamicGeometryRecordStageLane | undefined {
    if (!Number.isInteger(entity) || meshHandle === undefined) return undefined;
    const binding = this.submitted.get(world, entity);
    const cpu = binding?.meshHandle === meshHandle ? binding.lane : undefined;
    const worldId = this.submittedGpu?.worlds.indexOf(world) ?? -1;
    const gpu =
      worldId >= 0 && this.submittedGpu?.owns(worldId, entity, meshHandle) === true
        ? 'gpu'
        : undefined;
    if (cpu === undefined) return gpu;
    return gpu === undefined || cpu === gpu ? cpu : 'mixed';
  }
}
