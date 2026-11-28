import type { TemporalSurface } from '../temporal/gpu';

/**
 * History resurrection snapshots (UE TemporalSuperResolution.cpp:1853-2320, Resurrection*). UE keeps
 * a ring of persistent frames written every `r.TSR.Resurrection.PersistentFrameInterval` frames and
 * resurrects from the oldest one, so a pixel that stays disoccluded for longer than the ordinary
 * history survives can recover the converged result from an earlier frame.
 */

/** Persistent snapshot slots (UE `r.TSR.Resurrection.PersistentFrameCount` = 2). */
export const TSR_RESURRECTION_SLOTS = 2;
/** Committed frames between two snapshot stores (UE PersistentFrameInterval). */
export const TSR_RESURRECTION_INTERVAL = 31;
/** A snapshot younger than this is no better than the ordinary history. */
export const TSR_RESURRECTION_MIN_AGE = 2;
/** Bytes per pixel of one snapshot: FP16 guide (input capacity), FP16 color and RGBA8 stability. */
export const TSR_RESURRECTION_GUIDE_BYTES = 8;
export const TSR_RESURRECTION_OUTPUT_BYTES = 8 + 4;

export interface TsrResurrectionSlot {
  readonly guide: TemporalSurface;
  readonly color: TemporalSurface;
  readonly stability: TemporalSurface;
  /** Unjittered view-projection of the stored frame (UE ClipToResurrectionClip source). */
  readonly viewProjection: Float32Array;
  /** Index of the accepted frame that produced the snapshot; `undefined` while the slot is empty. */
  storedAt: number | undefined;
  inputWidth: number;
  inputHeight: number;
}

/** A store staged by an encoded frame and applied only when its submit is accepted. */
export interface TsrResurrectionStore {
  readonly slot: 0 | 1;
  readonly viewProjection: Float32Array;
  readonly inputWidth: number;
  readonly inputHeight: number;
  /** A camera cut: the stored snapshots belong to another scene and are discarded. */
  readonly reset: boolean;
}

export interface TsrResurrection {
  readonly slots: readonly [TsrResurrectionSlot, TsrResurrectionSlot];
  /** Accepted TSR frames so far, which is also the index of the frame being encoded. */
  frame: number;
  pending: TsrResurrectionStore | undefined;
}

function age(resurrection: TsrResurrection, slot: TsrResurrectionSlot): number {
  return slot.storedAt === undefined
    ? Number.POSITIVE_INFINITY
    : resurrection.frame - slot.storedAt;
}

/** The slot a snapshot is written to: an empty one, otherwise the oldest. */
export function resurrectionStoreSlot(resurrection: TsrResurrection): 0 | 1 {
  const [a, b] = resurrection.slots;
  return age(resurrection, a) >= age(resurrection, b) ? 0 : 1;
}

/** The oldest valid slot that is old enough to differ from the ordinary history, if any. */
export function resurrectionSourceSlot(resurrection: TsrResurrection): 0 | 1 | undefined {
  let source: 0 | 1 | undefined;
  for (const index of [0, 1] as const) {
    const slot = resurrection.slots[index];
    if (slot.storedAt === undefined || age(resurrection, slot) < TSR_RESURRECTION_MIN_AGE) continue;
    if (
      source === undefined ||
      age(resurrection, slot) > age(resurrection, resurrection.slots[source])
    )
      source = index;
  }
  return source;
}

/** Whether this frame must publish a snapshot: a cut, an empty ring, or the interval elapsed. */
export function resurrectionStoreDue(resurrection: TsrResurrection, reset: boolean): boolean {
  if (reset) return true;
  const newest = Math.min(...resurrection.slots.map((slot) => age(resurrection, slot)));
  return newest >= TSR_RESURRECTION_INTERVAL;
}

/**
 * Whether the ring can serve the current frame: a valid camera path, a source old enough, and a
 * snapshot taken at the current input size (a resized input needs a new snapshot first).
 */
export function resurrectionSourceFor(
  resurrection: TsrResurrection,
  input: { readonly width: number; readonly height: number },
  reset: boolean,
): 0 | 1 | undefined {
  if (reset) return undefined;
  const source = resurrectionSourceSlot(resurrection);
  if (source === undefined) return undefined;
  const slot = resurrection.slots[source];
  return slot.inputWidth === input.width && slot.inputHeight === input.height ? source : undefined;
}

/** Apply the staged store of an accepted frame and count the frame. */
export function commitResurrection(resurrection: TsrResurrection): void {
  const store = resurrection.pending;
  resurrection.pending = undefined;
  const frame = resurrection.frame;
  resurrection.frame += 1;
  if (store === undefined) return;
  if (store.reset)
    for (const slot of resurrection.slots) {
      slot.storedAt = undefined;
    }
  const slot = resurrection.slots[store.slot];
  slot.viewProjection.set(store.viewProjection);
  slot.inputWidth = store.inputWidth;
  slot.inputHeight = store.inputHeight;
  slot.storedAt = frame;
}

/** Drop the staged store of a frame that was not submitted. */
export function abortResurrection(resurrection: TsrResurrection): void {
  resurrection.pending = undefined;
}
