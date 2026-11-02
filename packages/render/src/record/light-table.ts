import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type DirectLightSnapshot,
  packDirectLightSlot,
  type ReflectedDirectLightSlotLayout,
} from '../light-buffer-layout';

/** A failed slot-range write: the RHI cause, or the slot range the queue rejected. */
export interface LightTableWriteFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}

/**
 * The packed DirectLightSlot records one storage Cluster bundle holds on the
 * GPU. A frame passes its local lights in slot order; only slots whose light
 * record (or projector selection) changed are packed, and only slots whose
 * packed bytes differ are written, coalesced into contiguous ranges. A steady
 * frame packs and writes nothing.
 *
 * Light records are immutable: the light owner replaces a light's record when
 * it changes and keeps its identity otherwise, so identity decides what to pack.
 */
export class LightTable {
  /** Per slot: the record and projector selection the GPU slot was written from. */
  private readonly sources: (DirectLightSnapshot | undefined)[] = [];
  private readonly projector: (boolean | undefined)[] = [];
  /** 1 where the GPU slot holds `words`; a fresh or failed slot is always written. */
  private readonly written: Uint8Array;
  /** CPU image of the written slots, compared bit-exactly before a write. */
  private readonly words: Uint32Array;
  private readonly floats: Float32Array;
  private packedSlots = 0;
  /** Bytes the last `write` uploaded; zero on a steady frame. */
  uploadedBytes = 0;

  constructor(
    private readonly device: RhiDevice,
    private readonly buffer: Buffer,
    private readonly layout: ReflectedDirectLightSlotLayout,
  ) {
    this.written = new Uint8Array(layout.capacity);
    this.words = new Uint32Array(layout.capacity * layout.floatCount);
    this.floats = new Float32Array(this.words.buffer);
  }

  write(
    local: readonly { readonly source?: DirectLightSnapshot | undefined }[],
    projectorSlot: number | undefined,
  ): Result<void, LightTableWriteFailure> {
    this.uploadedBytes = 0;
    this.packedSlots = 0;
    let first = -1;
    for (let slot = 0; slot < local.length; slot += 1) {
      const source = local[slot]?.source;
      const selected = projectorSlot === undefined ? undefined : projectorSlot === slot;
      const dirty =
        source !== undefined &&
        (this.sources[slot] !== source || this.projector[slot] !== selected) &&
        this.pack(slot, source, selected);
      if (dirty) {
        if (first < 0) first = slot;
        continue;
      }
      if (first >= 0) {
        const written = this.upload(first, slot);
        if (!written.ok) return written;
        first = -1;
      }
    }
    return first >= 0 ? this.upload(first, local.length) : ok(undefined);
  }

  inspect(): { readonly packedSlots: number; readonly uploadedBytes: number } {
    return Object.freeze({ packedSlots: this.packedSlots, uploadedBytes: this.uploadedBytes });
  }

  /** Pack one slot into the CPU image; false when its bytes are already on the GPU. */
  private pack(slot: number, source: DirectLightSnapshot, selected: boolean | undefined): boolean {
    this.packedSlots += 1;
    this.sources[slot] = source;
    this.projector[slot] = selected;
    const packed = new Uint32Array(packDirectLightSlot(source, this.layout, selected).buffer);
    const floatCount = this.layout.floatCount;
    const offset = slot * floatCount;
    let changed = this.written[slot] !== 1;
    for (let index = 0; index < floatCount; index += 1) {
      if (this.words[offset + index] === packed[index]) continue;
      this.words[offset + index] = packed[index] as number;
      changed = true;
    }
    return changed;
  }

  private upload(first: number, end: number): Result<void, LightTableWriteFailure> {
    const written = this.device.queue.writeBuffer(
      this.buffer,
      first * this.layout.byteSize,
      this.floats.subarray(first * this.layout.floatCount, end * this.layout.floatCount),
    );
    if (!written.ok) {
      // The GPU slots are unknown: repack and rewrite them on the next write.
      for (let slot = first; slot < end; slot += 1) {
        this.sources[slot] = undefined;
        this.written[slot] = 0;
      }
      return err(written.error);
    }
    this.written.fill(1, first, end);
    this.uploadedBytes += (end - first) * this.layout.byteSize;
    return ok(undefined);
  }
}
