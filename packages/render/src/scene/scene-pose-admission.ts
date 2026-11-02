import type { FrameArena, MemoryError } from '@forgeax/engine-ecs';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderSceneSlot } from './render-scene-types';
import type { WorldTransformSpan } from './scene-rows';
import { reflectedPose, type SceneSlots } from './scene-slots';

const CHUNK_ROWS = 64;
const FIELDS = 3;

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
  arena: FrameArena,
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
        const slot = slots.slotOf(span.worldId, entity);
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
          if (index % CHUNK_ROWS === 0) {
            const allocated = arena.alloc(Float64Array, CHUNK_ROWS * FIELDS);
            if (!allocated.ok) return allocated;
            chunks.push(allocated.value);
          }
          initial.push(slots.get(slot) as RenderSceneSlot);
          indices[slot] = index;
        } else {
          const chunk = chunks[Math.floor(index / CHUNK_ROWS)] as Float64Array;
          const base = (index % CHUNK_ROWS) * FIELDS;
          const previous = spans[chunk[base] as number] as WorldTransformSpan;
          const previousOffset = chunk[base + 1] as number;
          if (!changedPose(previous.worlds, previousOffset, span.worlds, offset)) continue;
          parity =
            chunk[base + 2] === 1 ||
            reflectedPose(previous.worlds, previousOffset) !== reflectedPose(span.worlds, offset);
        }
        const chunk = chunks[Math.floor(index / CHUNK_ROWS)] as Float64Array;
        const base = (index % CHUNK_ROWS) * FIELDS;
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
  return (index % CHUNK_ROWS) * FIELDS;
}

export function scenePoseChunk(chunks: readonly Float64Array[], index: number): Float64Array {
  return chunks[Math.floor(index / CHUNK_ROWS)] as Float64Array;
}
