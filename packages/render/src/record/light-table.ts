import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  DirectLightSlotWriter,
  type DirectLightSnapshot,
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
  private readonly channelMappings: Uint32Array;
  private readonly projectedShadows: Uint8Array;
  /** 1 where the GPU slot holds `words`; a fresh or failed slot is always written. */
  private readonly written: Uint8Array;
  /** CPU image of the written slots, compared bit-exactly before a write. */
  private readonly words: Uint32Array;
  private readonly writer: DirectLightSlotWriter;
  private packedSlots = 0;
  /** Bytes the last `write` uploaded; zero on a steady frame. */
  uploadedBytes = 0;

  constructor(
    private readonly device: RhiDevice,
    private readonly buffer: Buffer,
    private readonly layout: ReflectedDirectLightSlotLayout,
  ) {
    this.written = new Uint8Array(layout.capacity);
    this.channelMappings = new Uint32Array(layout.capacity);
    this.projectedShadows = new Uint8Array(layout.capacity);
    this.words = new Uint32Array(layout.capacity * layout.floatCount);
    this.writer = new DirectLightSlotWriter(layout);
  }

  write(
    local: readonly { readonly source?: DirectLightSnapshot | undefined }[],
    projectorSlot: number | undefined,
    channelMapping = 0,
    projectedShadows?: Uint8Array,
  ): Result<void, LightTableWriteFailure> {
    this.uploadedBytes = 0;
    this.packedSlots = 0;
    if (local.length > this.layout.capacity)
      return err({
        code: 'limit-exceeded',
        expected: 'local lights fit the reflected storage table',
        hint: 'admit lights within the reflected direct light capacity',
        detail: { count: local.length, capacity: this.layout.capacity },
      });
    if (this.sources.length > local.length) this.sources.length = local.length;
    let first = -1;
    for (let slot = 0; slot < local.length; slot += 1) {
      const source = local[slot]?.source;
      const selected = projectorSlot === undefined ? undefined : projectorSlot === slot;
      const projectedChannel = projectedShadows?.[slot] ?? 0;
      if (source === undefined) {
        this.sources[slot] = undefined;
      } else if (
        this.sources[slot] !== source ||
        this.projector[slot] !== selected ||
        this.channelMappings[slot] !== channelMapping ||
        this.projectedShadows[slot] !== projectedChannel
      ) {
        this.writer.write(source, selected, channelMapping, projectedChannel);
        this.packedSlots++;
        if (this.writer.copyChanged(this.words, slot * this.layout.floatCount))
          this.written[slot] = 0;
        this.sources[slot] = source;
        this.projector[slot] = selected;
        this.channelMappings[slot] = channelMapping;
        this.projectedShadows[slot] = projectedChannel;
      }
      if (source !== undefined && this.written[slot] !== 1) {
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

  private upload(first: number, end: number): Result<void, LightTableWriteFailure> {
    const written = this.device.queue.writeBuffer(
      this.buffer,
      first * this.layout.byteSize,
      this.words,
      first * this.layout.floatCount,
      (end - first) * this.layout.floatCount,
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
