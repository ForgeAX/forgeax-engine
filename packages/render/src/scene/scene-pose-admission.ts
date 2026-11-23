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

  constructor(
    private readonly after: readonly RenderSceneSlot[],
    private readonly before: readonly RenderSceneSlot[],
  ) {
    this.firstVersion = after[0]?.version ?? 0;
  }

  get size(): number {
    return this.after.length;
  }

  get(row: RenderSceneSlot): RenderSceneSlot | undefined {
    const index = row.version - this.firstVersion;
    return this.after[index] === row ? this.before[index] : undefined;
  }

  has(row: RenderSceneSlot): boolean {
    return this.get(row) !== undefined;
  }

  values(): MapIterator<RenderSceneSlot> {
    return this.before.values();
  }

  keys(): MapIterator<RenderSceneSlot> {
    return this.after.values();
  }

  *entries(): MapIterator<[RenderSceneSlot, RenderSceneSlot]> {
    for (let i = 0; i < this.size; i++)
      yield [this.after[i] as RenderSceneSlot, this.before[i] as RenderSceneSlot];
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
    for (let i = 0; i < this.size; i++)
      visit.call(
        thisArg,
        this.before[i] as RenderSceneSlot,
        this.after[i] as RenderSceneSlot,
        this,
      );
  }
}

/** Scope-local source coordinates; no arena range survives the synchronous commit. */
export interface StagedScenePoses {
  readonly initial: RenderSceneSlot[];
  readonly chunks: Float64Array[];
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

/** Only the receiver's validated, getter-free, synchronously owned spans enter here. */
export function stageScenePoses(
  slots: SceneSlots,
  spans: readonly WorldTransformSpan[],
  storage: FrameArena | Float64Array,
  indices: (number | object | undefined)[],
): Result<StagedScenePoses, MemoryError> {
  const initial: RenderSceneSlot[] = [];
  const chunks: Float64Array[] = [];
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
        if (slot === undefined) {
          ignored++;
          continue;
        }
        const admitted = indices[slot];
        if (typeof admitted === 'object') throw new Error('Scene commit staging is already active');
        let index = admitted;
        const offset = row * 16;
        let parity: boolean;
        if (index === undefined) {
          const change = slots.comparePose(slot, span.worlds, offset);
          if (change === 'unchanged') continue;
          parity = change === 'parity';
          index = initial.length;
          if (index % SCENE_POSE_CHUNK_ROWS === 0) {
            if (storage instanceof Float64Array) {
              if (index !== 0) throw new RangeError('Scene pose span exceeded its inline capacity');
              chunks.push(storage);
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
          const previous = spans[chunk[base] as number] as WorldTransformSpan;
          const previousOffset = chunk[base + 1] as number;
          if (!changedPose(previous.worlds, previousOffset, span.worlds, offset)) continue;
          parity =
            chunk[base + 2] === 1 ||
            reflectedPose(previous.worlds, previousOffset) !== reflectedPose(span.worlds, offset);
        }
        const chunk = chunks[Math.floor(index / SCENE_POSE_CHUNK_ROWS)] as Float64Array;
        const base = (index % SCENE_POSE_CHUNK_ROWS) * FIELDS;
        chunk[base] = source;
        chunk[base + 1] = offset;
        chunk[base + 2] = parity ? 1 : 0;
      }
    }
    return ok({ initial, chunks, ignored });
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
