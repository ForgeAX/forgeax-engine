import type { FrameArena, MemoryError } from '@forgeax/engine-ecs';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderSceneSlot } from './render-scene-types';
import type { WorldTransformSpan } from './scene-rows';
import { reflectedPose, type SceneSlots } from './scene-slots';

export const SCENE_POSE_CHUNK_ROWS = 64;
// Signed slot (negative for changed winding), source column, source offset.
const FIELDS = 3;

const CHUNK_FLOATS = SCENE_POSE_CHUNK_ROWS * FIELDS;
const ADMITTED = ok(undefined);

type MergePose<T> = (
  entity: number,
  edit: T | undefined,
  span: WorldTransformSpan,
  offset: number,
) => boolean;

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

/** Synchronous Scene-owned scratch. Only issued pose pages outlive the commit. */
export class ScenePoseAdmission {
  private readonly owned: Float64Array[] = [];
  private readonly borrowed: Float64Array[] = [];
  private readonly columns: Readonly<Float32Array>[] = [];
  private active = this.owned;
  count = 0;
  ignored = 0;

  get backingBytes(): number {
    return this.owned.length * CHUNK_FLOATS * Float64Array.BYTES_PER_ELEMENT;
  }

  /** Release borrowed source columns and arena slices at the end of the commit. */
  end(): void {
    this.borrowed.length = 0;
    this.columns.length = 0;
    this.active = this.owned;
    this.count = this.ignored = 0;
  }

  /** Release overflow after a real scene retirement; ordinary edits reuse capacity. */
  trim(liveRows: number): void {
    const chunks = Math.ceil(liveRows / SCENE_POSE_CHUNK_ROWS);
    if (chunks === 0 || 4 * chunks < this.owned.length) this.owned.length = chunks;
  }

  /** A staged structural edit owns its merged pose, including membership changes. */
  stage<T extends object>(
    slots: SceneSlots,
    spans: readonly WorldTransformSpan[],
    indices: (number | T | undefined)[],
    arena?: FrameArena,
    merge?: MergePose<T>,
  ): Result<void, MemoryError> {
    this.active = arena === undefined ? this.owned : this.borrowed;
    try {
      for (const span of spans) {
        const result = this.stageSpan(slots, span, indices, arena, merge);
        if (!result.ok) return result;
      }
      return ADMITTED;
    } finally {
      for (let index = 0; index < this.count; index++) {
        const slot = scenePoseChunk(this.active, index)[scenePoseOffset(index)] as number;
        indices[decodedSlot(slot)] = undefined;
      }
    }
  }

  private stageSpan<T extends object>(
    slots: SceneSlots,
    span: WorldTransformSpan,
    indices: (number | T | undefined)[],
    arena: FrameArena | undefined,
    merge: MergePose<T> | undefined,
  ): Result<void, MemoryError> {
    const chunks = this.active;
    const columns = this.columns;
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
          this.ignored++;
        continue;
      }
      const worlds = span.worlds;
      let index = admitted;
      let parity: boolean;
      if (index === undefined) {
        const change = slots.comparePose(slot, worlds, offset);
        if (change === 'unchanged') continue;
        parity = change === 'parity';
        index = this.count;
        if (Math.floor(index / SCENE_POSE_CHUNK_ROWS) === chunks.length) {
          const reserved = this.appendChunk(arena);
          if (!reserved.ok) return reserved;
        }
        scenePoseChunk(chunks, index)[scenePoseOffset(index)] = slot;
        indices[slot] = index;
        this.count++;
      } else {
        const chunk = chunks[Math.floor(index / SCENE_POSE_CHUNK_ROWS)] as Float64Array;
        const base = (index % SCENE_POSE_CHUNK_ROWS) * FIELDS;
        const previous = columns[chunk[base + 1] as number] as Readonly<Float32Array>;
        const previousOffset = chunk[base + 2] as number;
        if (!changedPose(previous, previousOffset, worlds, offset)) continue;
        parity =
          (chunk[base] as number) < 0 ||
          reflectedPose(previous, previousOffset) !== reflectedPose(worlds, offset);
      }
      const chunk = chunks[Math.floor(index / SCENE_POSE_CHUNK_ROWS)] as Float64Array;
      const base = (index % SCENE_POSE_CHUNK_ROWS) * FIELDS;
      // Keep the column actually observed. A borrowed span getter may replace it on the next read.
      if (columns[columns.length - 1] !== worlds) columns.push(worlds);
      chunk[base] = parity ? -slot - 1 : slot;
      chunk[base + 1] = columns.length - 1;
      chunk[base + 2] = offset;
    }
    return ADMITTED;
  }

  private appendChunk(arena: FrameArena | undefined): Result<void, MemoryError> {
    if (arena === undefined) this.owned.push(new Float64Array(CHUNK_FLOATS));
    else {
      const allocated = arena.alloc(Float64Array, CHUNK_FLOATS);
      if (!allocated.ok) return allocated;
      this.borrowed.push(allocated.value);
    }
    return ADMITTED;
  }

  /** Commit numeric coordinates in admission order while their source lease is active. */
  write(slots: SceneSlots, content: RenderSceneSlot[]): void {
    const { count, columns } = this;
    const chunks = this.active;
    for (let index = 0; index < count; index++) {
      const chunk = scenePoseChunk(chunks, index);
      const base = scenePoseOffset(index);
      const worlds = columns[chunk[base + 1] as number] as Readonly<Float32Array>;
      const address = chunk[base] as number;
      const slot = decodedSlot(address);
      const offset = chunk[base + 2] as number;
      if (address < 0) content.push(slots.writePose(slot, worlds, offset, count - index));
      else slots.writePreparedPose(slot, worlds, offset, count - index);
    }
  }
}

function decodedSlot(address: number): number {
  return address < 0 ? -address - 1 : address;
}

function scenePoseOffset(index: number): number {
  return (index % SCENE_POSE_CHUNK_ROWS) * FIELDS;
}

function scenePoseChunk(chunks: readonly Float64Array[], index: number): Float64Array {
  return chunks[Math.floor(index / SCENE_POSE_CHUNK_ROWS)] as Float64Array;
}
