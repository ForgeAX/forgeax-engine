// World-owned managed array storage. Small fields use eight radix-4 free
// lists; larger fields allocate dedicated buffers and drop them on release.
// Pooling policy never limits a field to the largest pooled class. Slot IDs
// remain private to ECS and survive archetype migration and growth.

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
export interface BufferAllocResult {
  /** Stable slot id; archetype columns store this u32 in their `buffer:<N>` field. */
  readonly id: number;
  /** Live Uint8Array view of length `byteLength` (D-5 rounding visible only via `view.buffer.byteLength`). */
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

interface SlotState {
  /** Bucket index, SIZE_CLASSES.length for dedicated storage, or -1 for zero length. */
  sizeClassIdx: number;
  /** Underlying ArrayBuffer for the slot's current bucket (zero-length for sizeClassIdx === -1). */
  buffer: ArrayBuffer;
  /** Live view; sliced to `byteLength <= buffer.byteLength`. */
  view: Uint8Array;
  /** Logical byteLength (== view.byteLength). */
  byteLength: number;
  /** false when the slot has been released and its id is parked on the free-list. */
  live: boolean;
}

/**
 * Round `byteLength` up to a bucket index. Returns -1 for the legal zero
 * path; returns `SIZE_CLASSES.length` (out-of-range) for byteLength larger
 * than the top bucket so the caller can use a dedicated allocation.
 */
function bucketIndex(byteLength: number): number {
  if (byteLength === 0) return -1;
  for (let i = 0; i < SIZE_CLASSES.length; i++) {
    const b = SIZE_CLASSES[i];
    if (b !== undefined && byteLength <= b) return i;
  }
  return SIZE_CLASSES.length;
}

/**
 * Per-(slot id) managed Uint8Array store backing the `buffer:<bytes>` schema
 * vocab keyword. Eight size-class free-lists (radix 4); cross-bucket growth
 * uses `ArrayBuffer.transfer` when available with a copy fallback for older
 * runtimes.
 *
 * AI users do not interact with `BufferPool` directly - it sits behind
 * `world.get(e, C).<bufferField>` and the M4 carry-over migrate path. The
 * pool is exposed as a class so World can hold one instance per
 * `new World()` (D-2 per-World lifecycle).
 */
export class BufferPool {
  private readonly slots = new Map<number, SlotState>();
  /**
   * Per-bucket free-lists: `freeBuckets[i]` is a LIFO stack of slot ids
   * whose backing buffer is parked on bucket `i`. Released slots stay on
   * their original bucket's free-list - v1 never moves a slot between
   * buckets on release (D-7 no trim).
   */
  private readonly freeBuckets: number[][] = SIZE_CLASSES.map(() => [] as number[]);
  private nextId = 1;

  /**
   * Allocate a managed buffer slot of at least `byteLength` bytes.
   *
   * Routes:
   *   - invalid byteLength -> structured out-of-bounds error.
   *   - byteLength == 0 -> ok({ id, view: zero-length Uint8Array }) (no bucket).
   *   - byteLength <= 262144 -> ok({ id, view }), bucket = smallest >= byteLength.
   *   - byteLength > 262144 -> a dedicated allocation; allocation failure is structured.
   *
   * D-5: size classes are radix-4 (16 / 64 / 256 / 1K / 4K / 16K / 64K / 256K).
   * Free-list pop reuses the most recently released slot id at the same bucket;
   * miss falls through to a fresh allocation.
   */
  alloc(byteLength: number): Result<BufferAllocResult, ManagedBufferOutOfBoundsError> {
    if (byteLength === 0) {
      const id = this.nextId++;
      const buffer = new ArrayBuffer(0);
      const view = new Uint8Array(buffer);
      this.slots.set(id, { sizeClassIdx: -1, buffer, view, byteLength: 0, live: true });
      return ok({ id, view });
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      return err(new ManagedBufferOutOfBoundsError(byteLength, 0));
    }
    const idx = bucketIndex(byteLength);
    if (idx === SIZE_CLASSES.length) {
      // Large fields are dedicated allocations, not permanently retained
      // pool buckets. Small fields keep exactly the existing allocation cost.
      try {
        const buffer = new ArrayBuffer(byteLength);
        const view = new Uint8Array(buffer);
        const id = this.nextId++;
        this.slots.set(id, { sizeClassIdx: idx, buffer, view, byteLength, live: true });
        return ok({ id, view });
      } catch {
        return err(new ManagedBufferOutOfBoundsError(byteLength, 0));
      }
    }
    const bucketBytes = SIZE_CLASSES[idx];
    /* istanbul ignore next -- bucketIndex returns < SIZE_CLASSES.length here */
    if (bucketBytes === undefined) {
      return err(new ManagedBufferOutOfBoundsError(byteLength, 0));
    }
    // Free-list reuse path: pop the most recently released slot of this bucket.
    const free = this.freeBuckets[idx];
    if (free !== undefined && free.length > 0) {
      const id = free.pop() as number;
      const slot = this.slots.get(id);
      /* istanbul ignore next -- freeBuckets only carries ids that exist in slots */
      if (slot === undefined) {
        return err(new ManagedBufferOutOfBoundsError(byteLength, 0));
      }
      // Re-slice the parked buffer to the new logical length; bucket buffer
      // is reused as-is (D-7 no realloc on release).
      slot.byteLength = byteLength;
      slot.view = new Uint8Array(slot.buffer, 0, byteLength);
      slot.live = true;
      // Defensively clear bytes so AI users never see stale data from the
      // prior tenant of the slot.
      new Uint8Array(slot.buffer).fill(0);
      return ok({ id, view: slot.view });
    }
    // Fresh allocation: bucket bytes (rounded up) -> sliced view of byteLength.
    const id = this.nextId++;
    const buffer = new ArrayBuffer(bucketBytes);
    const view = new Uint8Array(buffer, 0, byteLength);
    this.slots.set(id, {
      sizeClassIdx: idx,
      buffer,
      view,
      byteLength,
      live: true,
    });
    return ok({ id, view });
  }

  /**
   * Grow slot `id` to `newBytes`. Returns the post-grow Uint8Array view.
   *
   * Routes (D-6 / D-7):
   *   - newBytes < current  -> err(managed-buffer-shrink-not-supported).
   *   - newBytes == current -> ok(current view) (no-op, identity preserved).
   *   - newBytes > current && same bucket -> ok(re-sliced view) (no transfer).
   *   - newBytes > current && cross bucket -> ok(new view) backed by a fresh
   *     bucket buffer; the prior ArrayBuffer is detached via transfer (ES2024)
   *     or replaced via allocate-and-copy fallback. Old `view`s captured by
   *     the caller become detached / orphaned - callers must use `pool.view(id)`
   *     after grow to read the refreshed view (the `release` loop refreshes
   *     automatically).
   *   - newBytes beyond the last pooled class -> dedicated allocation.
   */
  grow(
    id: number,
    newBytes: number,
  ): Result<Uint8Array, ManagedBufferShrinkNotSupportedError | ManagedBufferOutOfBoundsError> {
    const slot = this.slots.get(id);
    if (slot === undefined) {
      // Treat unknown id as out-of-bounds against a 0-byte slot (closes the
      // surface; AI users hit this only on use-after-release of a slot id).
      return err(new ManagedBufferOutOfBoundsError(newBytes, 0));
    }
    if (newBytes < slot.byteLength) {
      return err(new ManagedBufferShrinkNotSupportedError(newBytes, slot.byteLength));
    }
    if (newBytes === slot.byteLength) {
      return ok(slot.view);
    }
    if (!Number.isSafeInteger(newBytes) || newBytes < 0) {
      return err(new ManagedBufferOutOfBoundsError(newBytes, slot.buffer.byteLength));
    }
    const newIdx = bucketIndex(newBytes);
    if (newBytes <= slot.buffer.byteLength) {
      // Same bucket: re-slice the existing backing ArrayBuffer to the new
      // logical length. No transfer; old view stays valid until next grow.
      slot.byteLength = newBytes;
      slot.view = new Uint8Array(slot.buffer, 0, newBytes);
      return ok(slot.view);
    }
    // Cross-bucket: detach old buffer + carry old bytes into the new bucket.
    const newBucketBytes = SIZE_CLASSES[newIdx] ?? Math.max(newBytes, slot.buffer.byteLength * 2);
    const oldByteLength = slot.byteLength;
    let nextBuffer: ArrayBuffer;
    try {
      if (HAS_TRANSFER) {
        // ES2024 transfer: copy contents into a fresh ArrayBuffer of the new
        // bucket size and detach the source. The transferred buffer keeps the
        // old prefix bytes intact.
        nextBuffer = (
          slot.buffer as unknown as { transfer(newByteLength: number): ArrayBuffer }
        ).transfer(newBucketBytes);
      } /* istanbul ignore next -- fallback only on runtimes without ES2024 transfer() */ else {
        nextBuffer = new ArrayBuffer(newBucketBytes);
        new Uint8Array(nextBuffer).set(new Uint8Array(slot.buffer, 0, oldByteLength));
      }
    } catch {
      return err(new ManagedBufferOutOfBoundsError(newBytes, slot.buffer.byteLength));
    }
    slot.sizeClassIdx = newIdx;
    slot.buffer = nextBuffer;
    slot.byteLength = newBytes;
    slot.view = new Uint8Array(nextBuffer, 0, newBytes);
    return ok(slot.view);
  }

  /**
   * Release slot `id` back to its bucket's free-list. Releasing an unknown id
   * is a no-op - World's release loop drives this and idempotency keeps the
   * despawn chain free of bookkeeping noise. Bucket free-lists are NEVER
   * trimmed in v1 (D-7 no trim).
   */
  release(id: number): Result<void, never> {
    const slot = this.slots.get(id);
    if (slot === undefined) return ok(undefined);
    if (!slot.live) return ok(undefined);
    slot.live = false;
    if (slot.sizeClassIdx >= 0 && slot.sizeClassIdx < SIZE_CLASSES.length) {
      const bucket = this.freeBuckets[slot.sizeClassIdx];
      if (bucket !== undefined) bucket.push(id);
    } else {
      // Zero-length or dedicated slot: drop the slot record entirely so
      // the id is not retained.
      this.slots.delete(id);
    }
    return ok(undefined);
  }

  /**
   * Return the live view for slot `id`. Used by World after `grow` to
   * refresh the column's stored view reference. Returns a zero-length view
   * for unknown / released ids so callers never crash on use-after-release.
   */
  view(id: number): Uint8Array {
    const slot = this.slots.get(id);
    if (slot === undefined || !slot.live) return new Uint8Array(0);
    return slot.view;
  }

  /**
   * Return the bucket-rounded byte capacity for slot `id` --- i.e.
   * `SIZE_CLASSES[slot.sizeClassIdx]`. Used by managed-buffer view callers
   * (D-4 no-cache: re-queried per accessor). Returns `0` for the zero-length
   * (`alloc(0)`) slot; returns `0` for unknown / released ids (mirrors
   * `view(id)` use-after-release semantics).
   */
  byteCapacity(id: number): number {
    const slot = this.slots.get(id);
    if (slot === undefined || !slot.live) return 0;
    if (slot.sizeClassIdx < 0) return 0;
    return slot.buffer.byteLength;
  }

  /**
   * Reset the logical byteLength of slot `id` to `newByteLength` while
   * keeping the same bucket allocation (no transfer, no release). Only
   * legal when `newByteLength <= bucketBytes`; the slot's bucket index
   * does not move (D-7 v1 forbids cross-bucket shrink). Used by managed-
   * buffer clear paths so the slot retains its `byteCapacity` while the
   * live view becomes zero-length. Bytes past the new logical length are
   * zero-filled defensively.
   *
   * Returns `err(ManagedBufferShrinkNotSupportedError)` when called on a
   * `sizeClassIdx === -1` slot (alloc(0)) with `newByteLength > 0`, or
   * when `newByteLength` exceeds the bucket capacity.
   */
  setLogicalLength(
    id: number,
    newByteLength: number,
  ): Result<Uint8Array, ManagedBufferShrinkNotSupportedError | ManagedBufferOutOfBoundsError> {
    const slot = this.slots.get(id);
    if (slot === undefined) {
      return err(new ManagedBufferOutOfBoundsError(newByteLength, 0));
    }
    if (slot.sizeClassIdx < 0) {
      // alloc(0) slot has no bucket; only newByteLength === 0 is legal.
      if (newByteLength === 0) {
        slot.byteLength = 0;
        slot.view = new Uint8Array(slot.buffer);
        return ok(slot.view);
      }
      return err(new ManagedBufferOutOfBoundsError(newByteLength, 0));
    }
    const bucketBytes = slot.buffer.byteLength;
    if (newByteLength > bucketBytes) {
      return err(new ManagedBufferOutOfBoundsError(newByteLength, bucketBytes));
    }
    // Zero-fill the prefix bytes that fall past the new logical length so
    // AI users never see stale tail bytes through a future grow.
    if (newByteLength < slot.byteLength) {
      new Uint8Array(slot.buffer, newByteLength, slot.byteLength - newByteLength).fill(0);
    }
    slot.byteLength = newByteLength;
    slot.view = new Uint8Array(slot.buffer, 0, newByteLength);
    return ok(slot.view);
  }

  /** @internal Diagnostic count of live slots. Exposed for tests + inspector. */
  _liveCount(): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.live) n += 1;
    return n;
  }
}
