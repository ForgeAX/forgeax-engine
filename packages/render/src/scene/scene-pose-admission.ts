import type { FrameArena, MemoryError } from '@forgeax/engine-ecs';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderSceneSlot } from './render-scene-types';
import type { WorldTransformSpan } from './scene-rows';
import { reflectedPose, type SceneSlots } from './scene-slots';

export const SCENE_POSE_CHUNK_ROWS = 64;
const FIELDS = 3;

export function createInlineScenePoseChunk(): Float64Array {
  return new Float64Array(SCENE_POSE_CHUNK_ROWS * FIELDS);
}

/** Each committed pose consumes exactly one consecutive SceneSlots version in admission order.
 * The prior rows are already required for temporal history. Their paired version addresses
 * implement the delta lookup for arbitrary entity order without a second per-row index. */
export class PreviousPoseRows implements ReadonlyMap<RenderSceneSlot, RenderSceneSlot> {
  private readonly firstVersion: number;
  private readonly start: number;

  constructor(
    private readonly after: readonly RenderSceneSlot[],
    private readonly before: readonly RenderSceneSlot[],
    private readonly structural?: ReadonlyMap<RenderSceneSlot, RenderSceneSlot>,
  ) {
    this.start = after.length - before.length;
    this.firstVersion = after[this.start]?.version ?? 0;
  }

  get size(): number {
    return (this.structural?.size ?? 0) + this.before.length;
  }

  get(row: RenderSceneSlot): RenderSceneSlot | undefined {
    const index = row.version - this.firstVersion;
    return index >= 0 && this.after[this.start + index] === row
      ? this.before[index]
      : this.structural?.get(row);
  }

  has(row: RenderSceneSlot): boolean {
    return this.get(row) !== undefined;
  }

  values(): MapIterator<RenderSceneSlot> {
    return this.structural === undefined ? this.before.values() : this.orderedRows(false);
  }

  keys(): MapIterator<RenderSceneSlot> {
    return this.structural === undefined ? this.after.values() : this.orderedRows(true);
  }

  private *orderedRows(keys: boolean): MapIterator<RenderSceneSlot> {
    if (this.structural !== undefined)
      yield* keys ? this.structural.keys() : this.structural.values();
    const rows = keys ? this.after : this.before;
    for (let i = keys ? this.start : 0; i < rows.length; i++) yield rows[i] as RenderSceneSlot;
  }

  *entries(): MapIterator<[RenderSceneSlot, RenderSceneSlot]> {
    if (this.structural !== undefined) yield* this.structural;
    for (let i = 0; i < this.before.length; i++)
      yield [this.after[this.start + i] as RenderSceneSlot, this.before[i] as RenderSceneSlot];
  }

  [Symbol.iterator](): MapIterator<[RenderSceneSlot, RenderSceneSlot]> {
    return this.entries();
  }

  forEach(
    visit: (
      value: RenderSceneSlot,
      key: RenderSceneSlot,
      map: ReadonlyMap<RenderSceneSlot, RenderSceneSlot>,
    ) => void,
    thisArg?: unknown,
  ): void {
    this.structural?.forEach((before, after) => {
      visit.call(thisArg, before, after, this);
    });
    for (let i = 0; i < this.before.length; i++)
      visit.call(
        thisArg,
        this.before[i] as RenderSceneSlot,
        this.after[this.start + i] as RenderSceneSlot,
        this,
      );
  }
}

/** Scope-local source coordinates; no arena range survives the synchronous commit. */
export interface StagedScenePoses {
  readonly initial: RenderSceneSlot[];
  readonly chunks: Float64Array[];
  readonly columns: readonly Readonly<Float32Array>[];
  readonly ignored: number;
}

function changedPose(
  before: ArrayLike<number>,
  beforeOffset: number,
  after: ArrayLike<number>,
  afterOffset: number,
): boolean {
  for (let lane = 0; lane < 16; lane++)
    if (before[beforeOffset + lane] !== (after[afterOffset + lane] ?? 0)) return true;
  return false;
}

/** Changed pose rows use numeric coordinates. A structural operation already staged for
 * the same identity owns its merged pose, including newly created or removed rows. */
export function stageScenePoses<T extends object>(
  slots: SceneSlots,
  spans: readonly WorldTransformSpan[],
  storage: FrameArena | Float64Array,
  indices: (number | T | undefined)[],
  merge?: (
    entity: number,
    edit: T | undefined,
    span: WorldTransformSpan,
    offset: number,
  ) => boolean,
): Result<StagedScenePoses, MemoryError> {
  const initial: RenderSceneSlot[] = [];
  const chunks: Float64Array[] = [];
  const columns: Readonly<Float32Array>[] = [];
  let ignored = 0;
  try {
    for (let source = 0; source < spans.length; source++) {
      const span = spans[source] as WorldTransformSpan;
      const count = span.rows?.length ?? span.entities.length;
      for (let cursor = 0; cursor < count; cursor++) {
        const row = span.rows?.[cursor] ?? cursor;
        const entity = span.entities[row];
        if (entity === undefined) continue;
        const slot = slots.slotOf(entity);
        const admitted = slot === undefined ? undefined : indices[slot];
        const offset = row * 16;
        if (slot === undefined || typeof admitted === 'object') {
          if (typeof admitted === 'object' && merge === undefined)
            throw new Error('Scene commit staging is already active');
          if (!merge?.(entity, typeof admitted === 'object' ? admitted : undefined, span, offset))
            ignored++;
          continue;
        }
        const worlds = span.worlds;
        let index = admitted;
        let parity: boolean;
        if (index === undefined) {
          const change = slots.comparePose(slot, worlds, offset);
          if (change === 'unchanged') continue;
          parity = change === 'parity';
          index = initial.length;
          if (index % SCENE_POSE_CHUNK_ROWS === 0) {
            if (storage instanceof Float64Array) {
              chunks.push(index === 0 ? storage : createInlineScenePoseChunk());
            } else {
              const allocated = storage.alloc(Float64Array, SCENE_POSE_CHUNK_ROWS * FIELDS);
              if (!allocated.ok) return allocated;
              chunks.push(allocated.value);
            }
          }
          initial.push(slots.get(slot) as RenderSceneSlot);
          indices[slot] = index;
        } else {
          const chunk = chunks[Math.floor(index / SCENE_POSE_CHUNK_ROWS)] as Float64Array;
          const base = (index % SCENE_POSE_CHUNK_ROWS) * FIELDS;
          const previous = columns[chunk[base] as number] as Readonly<Float32Array>;
          const previousOffset = chunk[base + 1] as number;
          if (!changedPose(previous, previousOffset, worlds, offset)) continue;
          parity =
            chunk[base + 2] === 1 ||
            reflectedPose(previous, previousOffset) !== reflectedPose(worlds, offset);
        }
        const chunk = chunks[Math.floor(index / SCENE_POSE_CHUNK_ROWS)] as Float64Array;
        const base = (index % SCENE_POSE_CHUNK_ROWS) * FIELDS;
        // Keep the column actually observed. A borrowed span getter may replace it on the next read.
        if (columns[columns.length - 1] !== worlds) columns.push(worlds);
        chunk[base] = columns.length - 1;
        chunk[base + 1] = offset;
        chunk[base + 2] = parity ? 1 : 0;
      }
    }
    return ok({ initial, chunks, columns, ignored });
  } finally {
    for (const row of initial) indices[row.slot] = undefined;
  }
}

/** Coordinates for one changed identity in admission order. */
export function scenePoseOffset(index: number): number {
  return (index % SCENE_POSE_CHUNK_ROWS) * FIELDS;
}

export function scenePoseChunk(chunks: readonly Float64Array[], index: number): Float64Array {
  return chunks[Math.floor(index / SCENE_POSE_CHUNK_ROWS)] as Float64Array;
}
