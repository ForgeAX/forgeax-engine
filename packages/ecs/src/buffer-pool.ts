// World-owned managed array storage. Small fields use eight radix-4 free
// lists; larger fields allocate dedicated buffers and drop them on release.
// Pooling policy never limits a field to the largest pooled class. Slot IDs
// remain private to ECS and survive archetype migration and growth.
//
// The three smallest classes carve fixed cells out of shared chunk buffers:
// a per-entity material list must not cost its own ArrayBuffer, backing
// store and slot record. Slot state is struct-of-arrays indexed by id: a slot
// is (class, chunk, offset, length) in typed columns, and a Uint8Array view is
// materialized only when a caller asks for one. Classes above the slabs own
// one ArrayBuffer per slot, kept in a map that only holds those slots.

import { err, ok, type Result } from '@forgeax/engine-types';
import { ManagedBufferOutOfBoundsError, ManagedBufferShrinkNotSupportedError } from './errors';

/**
 * Size-class bucket boundaries in bytes (D-5, radix 4). Frozen tuple - the
 * order is load-bearing: bucket index = ascending position in the array.
 *
 * `alloc(byteLength)` rounds up to `SIZE_CLASSES[i]` for the smallest `i`
 * with `byteLength <= SIZE_CLASSES[i]`. byteLength === 0 is the special path
 * (no bucket); larger requests use dedicated, unpooled allocations.
 */
export const SIZE_CLASSES: readonly number[] = Object.freeze([
  16, 64, 256, 1024, 4096, 16384, 65536, 262144,
]);

/** Result envelope for a fresh alloc - id + initial view. */
interface BufferAllocResult {
  /** Stable slot id; archetype columns store this u32 in their `buffer:<N>` field. */
  readonly id: number;
  /** Live Uint8Array view of length `byteLength` (capacity via `byteCapacity(id)`). */
  readonly view: Uint8Array;
}

/**
 * Module-level cache for `ArrayBuffer.prototype.transfer` support.
 *
 * Mirrors `column.ts` HAS_TRANSFER probe: ES2024 transfer is the zero-copy
 * fast path on Node 22+ / dawn-node / modern browsers; the fallback re-allocs
 * + byte-copies. Both paths preserve the byte-equal carry-over invariant
 * (AC-07).
 */
const HAS_TRANSFER: boolean =
  typeof (ArrayBuffer.prototype as { transfer?: unknown }).transfer === 'function';

/** Classes whose cells live in shared chunks (16, 64 and 256 bytes). */
const SLAB_CLASSES = 3;
const CHUNK_BYTES = 64 * 1024;
/** Slot class markers beside the bucket indexes. */
const ZERO = -1;
const DEDICATED = SIZE_CLASSES.length;
const DEAD = -2;
/** Zero-length slots and dead ids share one empty view; it cannot be written. */
const EMPTY = new Uint8Array(0);

/**
 * Round `byteLength` up to a bucket index. Returns -1 for the legal zero
 * path; returns `SIZE_CLASSES.length` (out-of-range) for byteLength larger
 * than the top bucket so the caller can use a dedicated allocation.
 */
function bucketIndex(byteLength: number): number {
  if (byteLength === 0) return ZERO;
  for (let i = 0; i < SIZE_CLASSES.length; i++) {
    const b = SIZE_CLASSES[i];
    if (b !== undefined && byteLength <= b) return i;
  }
  return DEDICATED;
}

interface Slab {
  /** Index into `chunks` of the chunk being carved, or -1 before the first. */
  chunk: number;
  cursor: number;
  /** Cells abandoned by cross-bucket growth (chunk * CHUNK_BYTES + offset). */
  readonly orphans: number[];
}

const INITIAL_SLOTS = 64;

/**
 * Per-(slot id) managed byte store backing the `buffer:<bytes>` schema
 * vocab keyword. Eight size-class free-lists (radix 4); cross-bucket growth
 * of an owned buffer uses `ArrayBuffer.transfer` when available, with a
 * copy fallback for older runtimes. Slab cells are copied out instead, since
 * a chunk is shared.
 *
 * AI users do not interact with `BufferPool` directly - it sits behind
 * `world.get(e, C).<bufferField>` and the M4 carry-over migrate path. The
 * pool is exposed as a class so World can hold one instance per
 * `new World()` (D-2 per-World lifecycle). Returned views are transient
 * windows over pool storage, valid until the slot next grows or is released.
 */
export class BufferPool {
  /** Bucket index, `DEDICATED`, `ZERO`, or `DEAD` per slot id. */
  private classes = new Int8Array(INITIAL_SLOTS).fill(DEAD);
  /** 1 while live; 0 when released (parked on a free-list) or dead. */
  private live = new Uint8Array(INITIAL_SLOTS);
  /** Slab slots: index into `chunks`. */
  private chunkOf = new Int32Array(INITIAL_SLOTS);
  /** Slab slots: cell byte offset inside its chunk. */
  private offsets = new Uint32Array(INITIAL_SLOTS);
  /** Logical byte length per slot. */
  private lengths = new Uint32Array(INITIAL_SLOTS);
  /** Allocated slot ids; id 0 is the reserved dead slot. */
  private slotCount = 1;
  /** Shared slab chunks, never released. */
  private readonly chunks: ArrayBuffer[] = [];
  /** Buffers of slots above the slab classes (pooled or dedicated). */
  private readonly owned = new Map<number, ArrayBuffer>();
  /**
   * Per-bucket free-lists: `freeBuckets[i]` is a LIFO stack of slot ids
   * whose cell or buffer is parked on bucket `i`. Released slots stay on
   * their original bucket's free-list - v1 never moves a slot between
   * buckets on release (D-7 no trim).
   */
  private readonly freeBuckets: number[][] = SIZE_CLASSES.map(() => [] as number[]);
  /** Released zero-length ids; they own no storage, so reuse is free. */
  private readonly deadZeroIds: number[] = [];
  private readonly slabs: Slab[] = Array.from({ length: SLAB_CLASSES }, () => ({
    chunk: -1,
    cursor: 0,
    orphans: [],
  }));

  /**
   * Allocate a managed buffer slot of at least `byteLength` bytes.
   *
   * Routes:
   *   - invalid byteLength -> structured out-of-bounds error.
   *   - byteLength == 0 -> ok({ id, view: zero-length Uint8Array }) (no bucket).
   *   - byteLength <= 262144 -> ok({ id, view }), bucket = smallest >= byteLength.
   *   - larger byteLength -> ok({ id, view }) over a dedicated buffer.
   *
   * A parked slot of the same bucket is reused (LIFO) with its bytes zeroed.
   */
  alloc(byteLength: number): Result<BufferAllocResult, ManagedBufferOutOfBoundsError> {
    if (byteLength === 0) {
      // Empty values churn (an array cleared and refilled): recycle their ids.
      const recycled = this.deadZeroIds.pop();
      const id = recycled ?? this.newSlot();
      this.classes[id] = ZERO;
      this.live[id] = 1;
      return ok({ id, view: EMPTY });
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      return err(new ManagedBufferOutOfBoundsError(byteLength, 0));
    }
    const idx = bucketIndex(byteLength);
    if (idx === DEDICATED) {
      // Large fields are dedicated allocations, not permanently retained
      // pool buckets.
      let buffer: ArrayBuffer;
      try {
        buffer = new ArrayBuffer(byteLength);
      } catch {
        return err(new ManagedBufferOutOfBoundsError(byteLength, 0));
      }
      const id = this.newSlot();
      this.owned.set(id, buffer);
      this.classes[id] = DEDICATED;
      this.live[id] = 1;
      this.lengths[id] = byteLength;
      return ok({ id, view: this.viewOf(id) });
    }
    const parked = this.freeBuckets[idx]?.pop();
    if (parked !== undefined) {
      // Clear the whole cell so a new tenant never observes the prior
      // tenant's bytes, then expose the new logical length.
      this.lengths[parked] = SIZE_CLASSES[idx] as number;
      this.viewOf(parked).fill(0);
      this.lengths[parked] = byteLength;
      this.live[parked] = 1;
      return ok({ id: parked, view: this.viewOf(parked) });
    }
    const id = this.newSlot();
    this.place(id, idx, byteLength, 0);
    this.classes[id] = idx;
    this.live[id] = 1;
    this.lengths[id] = byteLength;
    return ok({ id, view: this.viewOf(id) });
  }

  /**
   * Grow slot `id` to `newBytes`. Returns the post-grow Uint8Array view.
   *
   * Routes (D-6 / D-7):
   *   - newBytes < current  -> err(managed-buffer-shrink-not-supported).
   *   - newBytes == current -> ok(current window) (no-op).
   *   - newBytes > current && fits the cell -> ok(re-sliced view).
   *   - newBytes > current && cross-bucket  -> ok(moved view), bytes carried.
   */
  grow(
    id: number,
    newBytes: number,
  ): Result<Uint8Array, ManagedBufferShrinkNotSupportedError | ManagedBufferOutOfBoundsError> {
    if (!this.isLive(id)) {
      // Treat unknown id as out-of-bounds against a 0-byte slot (closes the
      // surface; AI users hit this only on use-after-release of a slot id).
      return err(new ManagedBufferOutOfBoundsError(newBytes, 0));
    }
    const currentLength = this.lengths[id] as number;
    if (newBytes < currentLength) {
      return err(new ManagedBufferShrinkNotSupportedError(newBytes, currentLength));
    }
    if (newBytes === currentLength) return ok(this.viewOf(id));
    const sizeClass = this.classes[id] as number;
    const capacity = this.capacityOf(id);
    if (!Number.isSafeInteger(newBytes) || newBytes < 0) {
      return err(new ManagedBufferOutOfBoundsError(newBytes, capacity));
    }
    if (newBytes <= capacity) {
      // Same cell or buffer: re-slice; the old view stays valid until next grow.
      this.lengths[id] = newBytes;
      return ok(this.viewOf(id));
    }
    const newIdx = bucketIndex(newBytes);
    const current = this.viewOf(id);
    try {
      if (sizeClass >= 0 && sizeClass < SLAB_CLASSES) {
        // A shared chunk cannot be transferred: copy out and orphan the cell.
        const oldChunk = this.chunkOf[id] as number;
        const oldOffset = this.offsets[id] as number;
        this.place(id, newIdx, newBytes, capacity);
        new Uint8Array(this.storageOf(id, newIdx), this.offsetOf(id, newIdx), newBytes).set(
          current,
        );
        new Uint8Array(this.chunks[oldChunk] as ArrayBuffer, oldOffset, capacity).fill(0);
        this.slabs[sizeClass]?.orphans.push(oldChunk * CHUNK_BYTES + oldOffset);
      } else if (sizeClass === ZERO) {
        this.place(id, newIdx, newBytes, capacity);
      } else {
        const newBucketBytes = SIZE_CLASSES[newIdx] ?? Math.max(newBytes, capacity * 2);
        const buffer = current.buffer;
        let nextBuffer: ArrayBuffer;
        if (HAS_TRANSFER) {
          // ES2024 transfer: copy contents into a fresh ArrayBuffer of the new
          // bucket size and detach the source. The transferred buffer keeps the
          // old prefix bytes intact.
          nextBuffer = (
            buffer as unknown as { transfer(newByteLength: number): ArrayBuffer }
          ).transfer(newBucketBytes);
        } /* istanbul ignore next -- fallback only on runtimes without ES2024 transfer() */ else {
          nextBuffer = new ArrayBuffer(newBucketBytes);
          new Uint8Array(nextBuffer).set(new Uint8Array(buffer, 0, currentLength));
        }
        this.owned.set(id, nextBuffer);
      }
    } catch {
      return err(new ManagedBufferOutOfBoundsError(newBytes, capacity));
    }
    this.classes[id] = newIdx;
    this.lengths[id] = newBytes;
    return ok(this.viewOf(id));
  }

  /**
   * Release slot `id` back to its bucket's free-list. Releasing an unknown id
   * is a no-op - World's release loop drives this and idempotency keeps the
   * despawn chain free of bookkeeping noise. Bucket free-lists are NEVER
   * trimmed in v1 (D-7 no trim).
   */
  release(id: number): Result<void, never> {
    if (!this.isLive(id)) return ok(undefined);
    this.live[id] = 0;
    const sizeClass = this.classes[id] as number;
    if (sizeClass >= 0 && sizeClass < DEDICATED) {
      this.freeBuckets[sizeClass]?.push(id);
    } else {
      // Zero-length or dedicated slot: drop its storage so nothing is retained.
      if (sizeClass === ZERO) this.deadZeroIds.push(id);
      this.classes[id] = DEAD;
      this.lengths[id] = 0;
      this.owned.delete(id);
    }
    return ok(undefined);
  }

  /**
   * Materialize a transient view for slot `id`. Returns a zero-length view
   * for unknown / released ids so callers never crash on use-after-release.
   */
  view(id: number): Uint8Array {
    return this.isLive(id) ? this.viewOf(id) : EMPTY;
  }

  /**
   * Return the bucket-rounded byte capacity for slot `id`. Returns `0` for the
   * zero-length (`alloc(0)`) slot and for unknown / released ids (mirrors
   * `view(id)` use-after-release semantics).
   */
  byteCapacity(id: number): number {
    return this.isLive(id) ? this.capacityOf(id) : 0;
  }

  /** Logical byte length of slot `id` without materializing a view. */
  byteLength(id: number): number {
    return this.isLive(id) ? (this.lengths[id] as number) : 0;
  }

  /** Backing ArrayBuffer of a live sized slot, for aliasing checks without a view. */
  backingBuffer(id: number): ArrayBuffer | undefined {
    if (!this.isLive(id)) return undefined;
    const sizeClass = this.classes[id] as number;
    return sizeClass === ZERO ? undefined : this.storageOf(id, sizeClass);
  }

  /**
   * Reset the logical byteLength of slot `id` to `newByteLength` while
   * keeping the same bucket allocation (no transfer, no release). Only
   * legal when `newByteLength <= capacity`; the slot's bucket index does not
   * move (D-7 v1 forbids cross-bucket shrink). Bytes past the new logical
   * length are zeroed so a later grow never exposes stale tail bytes.
   */
  setLogicalLength(
    id: number,
    newByteLength: number,
  ): Result<Uint8Array, ManagedBufferShrinkNotSupportedError | ManagedBufferOutOfBoundsError> {
    if (!this.isLive(id)) {
      return err(new ManagedBufferOutOfBoundsError(newByteLength, 0));
    }
    const sizeClass = this.classes[id] as number;
    const capacity = this.capacityOf(id);
    if (!Number.isSafeInteger(newByteLength) || newByteLength < 0) {
      return err(new ManagedBufferOutOfBoundsError(newByteLength, capacity));
    }
    if (sizeClass === ZERO) {
      // alloc(0) slot has no bucket; only newByteLength === 0 is legal.
      if (newByteLength === 0) return ok(EMPTY);
      return err(new ManagedBufferOutOfBoundsError(newByteLength, 0));
    }
    if (newByteLength > capacity) {
      return err(new ManagedBufferOutOfBoundsError(newByteLength, capacity));
    }
    if (newByteLength < (this.lengths[id] as number)) this.viewOf(id).fill(0, newByteLength);
    this.lengths[id] = newByteLength;
    return ok(this.viewOf(id));
  }

  /** @internal Diagnostic count of live slots. Exposed for tests + inspector. */
  _liveCount(): number {
    let n = 0;
    for (let id = 1; id < this.slotCount; id++) n += this.live[id] as number;
    return n;
  }

  private isLive(id: number): boolean {
    return id > 0 && id < this.slotCount && this.live[id] === 1;
  }

  private viewOf(id: number): Uint8Array<ArrayBuffer> {
    const sizeClass = this.classes[id] as number;
    if (sizeClass === ZERO || sizeClass === DEAD) return EMPTY;
    return new Uint8Array(
      this.storageOf(id, sizeClass),
      this.offsetOf(id, sizeClass),
      this.lengths[id] as number,
    );
  }

  private storageOf(id: number, sizeClass: number): ArrayBuffer {
    return sizeClass < SLAB_CLASSES
      ? (this.chunks[this.chunkOf[id] as number] as ArrayBuffer)
      : (this.owned.get(id) as ArrayBuffer);
  }

  private offsetOf(id: number, sizeClass: number): number {
    return sizeClass < SLAB_CLASSES ? (this.offsets[id] as number) : 0;
  }

  private capacityOf(id: number): number {
    const sizeClass = this.classes[id] as number;
    if (sizeClass === ZERO || sizeClass === DEAD) return 0;
    if (sizeClass < SLAB_CLASSES) return SIZE_CLASSES[sizeClass] as number;
    return (this.owned.get(id) as ArrayBuffer).byteLength;
  }

  private newSlot(): number {
    const id = this.slotCount;
    if (id === this.classes.length) this.growSlots(id * 2);
    this.slotCount = id + 1;
    this.lengths[id] = 0;
    return id;
  }

  private growSlots(capacity: number): void {
    const classes = new Int8Array(capacity).fill(DEAD);
    classes.set(this.classes);
    const live = new Uint8Array(capacity);
    live.set(this.live);
    const chunkOf = new Int32Array(capacity);
    chunkOf.set(this.chunkOf);
    const offsets = new Uint32Array(capacity);
    offsets.set(this.offsets);
    const lengths = new Uint32Array(capacity);
    lengths.set(this.lengths);
    this.classes = classes;
    this.live = live;
    this.chunkOf = chunkOf;
    this.offsets = offsets;
    this.lengths = lengths;
  }

  /**
   * Point slot `id` at zeroed storage for bucket `idx`: a chunk cell for slab
   * classes, otherwise a bucket-sized (or dedicated) buffer. Coordinates are
   * written only after the allocation succeeded. `previousCapacity` sizes
   * the dedicated fallback when growth leaves the pooled classes.
   */
  private place(id: number, idx: number, byteLength: number, previousCapacity: number): void {
    if (idx >= 0 && idx < SLAB_CLASSES) {
      const slab = this.slabs[idx] as Slab;
      const cellBytes = SIZE_CLASSES[idx] as number;
      const orphan = slab.orphans.pop();
      if (orphan !== undefined) {
        this.chunkOf[id] = Math.floor(orphan / CHUNK_BYTES);
        this.offsets[id] = orphan % CHUNK_BYTES;
        return;
      }
      if (slab.chunk < 0 || slab.cursor + cellBytes > CHUNK_BYTES) {
        this.chunks.push(new ArrayBuffer(CHUNK_BYTES));
        slab.chunk = this.chunks.length - 1;
        slab.cursor = 0;
      }
      this.chunkOf[id] = slab.chunk;
      this.offsets[id] = slab.cursor;
      slab.cursor += cellBytes;
      return;
    }
    const bucketBytes = SIZE_CLASSES[idx] ?? Math.max(byteLength, previousCapacity * 2);
    this.owned.set(id, new ArrayBuffer(bucketBytes));
  }
}
