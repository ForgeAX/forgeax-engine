// One World-owned physical store for managed arrays and owned system buffers.
// Identity reuse is independent of whether backing is cached or discarded.
import { err, ok, type Result } from '@forgeax/engine-types';
import { BUFFER_PAGE_BYTES, BufferPages } from './buffer-pages';
import { ManagedBufferOutOfBoundsError, ManagedBufferShrinkNotSupportedError } from './errors';

export const SIZE_CLASSES: readonly number[] = Object.freeze([
  16, 64, 256, 1024, 2048, 4096, 16384, 65536, 262144,
]);
const ZERO = -1;
const DEAD = -2;
const EXTENDED_LENGTH = 0xffff_ffff;
const DEDICATED = SIZE_CLASSES.length;
const EMPTY = new Uint8Array(0);
interface BufferAllocResult {
  readonly id: number;
  readonly view: Uint8Array;
}
export interface BufferPoolStats {
  readonly liveSlots: number;
  readonly slotCapacity: number;
  readonly metadataBytes: number;
  readonly logicalBytes: number;
  readonly liveCapacityBytes: number;
  readonly committedBytes: number;
  readonly idleBytes: number;
  readonly backingAllocations: number;
  readonly copiedBytes: number;
  readonly zeroedBytes: number;
  readonly trimmedBytes: number;
}
function bucketIndex(bytes: number): number {
  if (bytes === 0) return ZERO;
  for (let i = 0; i < SIZE_CLASSES.length; i++) if (bytes <= (SIZE_CLASSES[i] as number)) return i;
  return DEDICATED;
}

export class BufferPool {
  private classes = new Int8Array(64).fill(DEAD);
  private chunkOf = new Uint32Array(64);
  private offsets = new Uint16Array(64);
  private lengths = new Uint32Array(64);
  private readonly extendedLengths = new Map<number, number>();
  private slotCount = 1;
  private readonly freeIds: number[] = [];
  private readonly pages = new BufferPages();
  private readonly owned = new Map<number, ArrayBuffer>();
  private readonly freeBuffers: ArrayBuffer[][] = SIZE_CLASSES.map(() => []);
  private liveCount = 0;
  private ownedBytes = 0;
  private cachedBytes = 0;
  private allocations = 0;
  private copiedBytes = 0;
  private zeroedBytes = 0;
  private trimmedBytes = 0;

  alloc(
    byteLength: number,
    maxCommittedBytes = Infinity,
  ): Result<BufferAllocResult, ManagedBufferOutOfBoundsError> {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return this.failure(byteLength);
    const id = this.freeIds.at(-1) ?? this.slotCount;
    const kind = bucketIndex(byteLength);
    try {
      // Prepare metadata before touching either the identity free list or backing.
      const metadata = this.prepareMetadata(id);
      this.place(id, kind, byteLength, maxCommittedBytes, metadata);
      if (this.freeIds.length > 0) this.freeIds.pop();
      else this.slotCount++;
      this.classes[id] = kind;
      this.writeLength(id, byteLength);
      this.liveCount++;
      return ok({ id, view: this.viewOf(id) });
    } catch {
      return this.failure(byteLength);
    }
  }

  grow(
    id: number,
    bytes: number,
    maxCommittedBytes = Infinity,
  ): Result<Uint8Array, ManagedBufferShrinkNotSupportedError | ManagedBufferOutOfBoundsError> {
    if (!this.isLive(id) || !Number.isSafeInteger(bytes) || bytes < 0) return this.failure(bytes);
    const length = this.lengthOf(id);
    if (bytes < length) return err(new ManagedBufferShrinkNotSupportedError(bytes, length));
    if (bytes <= this.capacityOf(id)) {
      this.writeLength(id, bytes);
      return ok(this.viewOf(id));
    }
    const oldKind = this.classes[id] as number;
    const location =
      (this.chunkOf[id] as number) * BUFFER_PAGE_BYTES + (this.offsets[id] as number);
    const oldBuffer = this.owned.get(id);
    const old = this.viewOf(id);
    const nextKind = bucketIndex(bytes);
    try {
      // Prepare a new range before publishing it. No transfer detaches live data
      // before a later allocation can fail; physical copy cost is observable.
      let nextLocation = 0;
      let buffer: ArrayBuffer;
      if (nextKind < 3) {
        nextLocation = this.acquireCell(nextKind, maxCommittedBytes);
        buffer = this.pages.buffer(nextLocation);
      } else buffer = this.acquireOwned(nextKind, bytes, maxCommittedBytes);
      new Uint8Array(buffer, nextLocation % BUFFER_PAGE_BYTES, length).set(old);
      this.copiedBytes += length;
      if (nextKind < 3) this.owned.delete(id);
      else this.owned.set(id, buffer);
      this.classes[id] = nextKind;
      this.chunkOf[id] = Math.floor(nextLocation / BUFFER_PAGE_BYTES);
      this.offsets[id] = nextLocation % BUFFER_PAGE_BYTES;
      this.writeLength(id, bytes);
      if (oldKind >= 0 && oldKind < 3) this.pages.release(location);
      else if (oldBuffer !== undefined) this.returnOwned(oldKind, oldBuffer);
      return ok(this.viewOf(id));
    } catch {
      return this.failure(bytes);
    }
  }

  release(id: number): Result<void, never> {
    if (!this.isLive(id)) return ok(undefined);
    const kind = this.classes[id] as number;
    if (kind >= 0 && kind < 3)
      this.pages.release(
        (this.chunkOf[id] as number) * BUFFER_PAGE_BYTES + (this.offsets[id] as number),
      );
    else {
      const buffer = this.owned.get(id);
      if (buffer !== undefined) this.returnOwned(kind, buffer);
      this.owned.delete(id);
    }
    this.classes[id] = DEAD;
    this.lengths[id] = 0;
    this.extendedLengths.delete(id);
    this.freeIds.push(id);
    this.liveCount--;
    return ok(undefined);
  }

  view(id: number): Uint8Array {
    return this.isLive(id) ? this.viewOf(id) : EMPTY;
  }
  byteCapacity(id: number): number {
    return this.isLive(id) ? this.capacityOf(id) : 0;
  }
  byteLength(id: number): number {
    return this.isLive(id) ? this.lengthOf(id) : 0;
  }
  backingBuffer(id: number): ArrayBuffer | undefined {
    if (!this.isLive(id) || this.classes[id] === ZERO) return undefined;
    return (this.classes[id] as number) < 3
      ? this.pages.pageBuffer(this.chunkOf[id] as number)
      : this.owned.get(id);
  }

  setLogicalLength(
    id: number,
    bytes: number,
  ): Result<Uint8Array, ManagedBufferShrinkNotSupportedError | ManagedBufferOutOfBoundsError> {
    if (
      !this.isLive(id) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.capacityOf(id)
    )
      return this.failure(bytes);
    const old = this.lengthOf(id);
    if (bytes < old) {
      this.viewOf(id).fill(0, bytes);
      this.zeroedBytes += old - bytes;
    }
    this.writeLength(id, bytes);
    return ok(this.viewOf(id));
  }

  /** Only idle backing is dropped; released identities are already independent. */
  trim(retainBytes = 0, pageVisits?: number): number {
    let freed = 0;
    let work = 0;
    const budget = pageVisits ?? Infinity;
    for (let kind = this.freeBuffers.length - 1; kind >= 3; kind--) {
      const bucket = this.freeBuffers[kind] as ArrayBuffer[];
      while (bucket.length > 0 && this.cachedBytes > retainBytes && work < budget) {
        const buffer = bucket.pop() as ArrayBuffer;
        work++;
        this.cachedBytes -= buffer.byteLength;
        this.ownedBytes -= buffer.byteLength;
        this.trimmedBytes += buffer.byteLength;
        freed += buffer.byteLength;
      }
    }
    return (
      freed +
      this.pages.trim(
        Math.max(0, retainBytes - this.cachedBytes),
        pageVisits === undefined ? undefined : Math.max(0, pageVisits - work),
      )
    );
  }

  additionalBytes(bytes: number): number {
    const kind = bucketIndex(bytes);
    if (kind === ZERO) return 0;
    if (kind < 3) return this.pages.requiredBytes(kind);
    return this.freeBuffers[kind]?.length ? 0 : (SIZE_CLASSES[kind] ?? bytes);
  }
  get committedBytes(): number {
    return this.ownedBytes + this.pages.bytes;
  }
  stats(): BufferPoolStats {
    let logicalBytes = 0;
    let liveCapacityBytes = 0;
    for (let id = 1; id < this.slotCount; id++)
      if (this.isLive(id)) {
        logicalBytes += this.lengthOf(id);
        liveCapacityBytes += this.capacityOf(id);
      }
    return {
      liveSlots: this.liveCount,
      slotCapacity: this.classes.length,
      metadataBytes:
        this.classes.byteLength +
        this.chunkOf.byteLength +
        this.offsets.byteLength +
        this.lengths.byteLength,
      logicalBytes,
      liveCapacityBytes,
      committedBytes: this.committedBytes,
      idleBytes: this.cachedBytes + this.pages.idleBytes(),
      backingAllocations: this.allocations + this.pages.allocations,
      copiedBytes: this.copiedBytes,
      zeroedBytes: this.zeroedBytes,
      trimmedBytes: this.trimmedBytes + this.pages.trimmedBytes,
    };
  }
  _liveCount(): number {
    return this.liveCount;
  }

  private failure(bytes: number): Result<never, ManagedBufferOutOfBoundsError> {
    return err(new ManagedBufferOutOfBoundsError(bytes, this.committedBytes));
  }
  private lengthOf(id: number): number {
    const length = this.lengths[id] as number;
    return length === EXTENDED_LENGTH ? (this.extendedLengths.get(id) as number) : length;
  }
  private writeLength(id: number, bytes: number): void {
    if (bytes >= EXTENDED_LENGTH) {
      this.extendedLengths.set(id, bytes);
      this.lengths[id] = EXTENDED_LENGTH;
    } else {
      this.lengths[id] = bytes;
      this.extendedLengths.delete(id);
    }
  }
  private isLive(id: number): boolean {
    return id > 0 && id < this.slotCount && (this.classes[id] as number) >= ZERO;
  }
  private capacityOf(id: number): number {
    const kind = this.classes[id] as number;
    return kind === ZERO
      ? 0
      : kind < 3
        ? (SIZE_CLASSES[kind] as number)
        : (this.owned.get(id) as ArrayBuffer).byteLength;
  }
  private viewOf(id: number): Uint8Array<ArrayBuffer> {
    const kind = this.classes[id] as number;
    if (kind === ZERO) return EMPTY;
    return new Uint8Array(
      kind < 3
        ? this.pages.pageBuffer(this.chunkOf[id] as number)
        : (this.owned.get(id) as ArrayBuffer),
      kind < 3 ? (this.offsets[id] as number) : 0,
      this.lengthOf(id),
    );
  }
  private prepareMetadata(
    id: number,
  ):
    | [
        Int8Array<ArrayBuffer>,
        Uint32Array<ArrayBuffer>,
        Uint16Array<ArrayBuffer>,
        Uint32Array<ArrayBuffer>,
      ]
    | undefined {
    if (id < this.classes.length) return undefined;
    const capacity = this.classes.length * 2;
    const classes = new Int8Array(capacity).fill(DEAD);
    classes.set(this.classes);
    const chunkOf = new Uint32Array(capacity);
    chunkOf.set(this.chunkOf);
    const offsets = new Uint16Array(capacity);
    offsets.set(this.offsets);
    const lengths = new Uint32Array(capacity);
    lengths.set(this.lengths);
    return [classes, chunkOf, offsets, lengths];
  }
  private place(
    id: number,
    kind: number,
    bytes: number,
    limit: number,
    metadata?: [
      Int8Array<ArrayBuffer>,
      Uint32Array<ArrayBuffer>,
      Uint16Array<ArrayBuffer>,
      Uint32Array<ArrayBuffer>,
    ],
  ): void {
    let location = 0;
    let buffer: ArrayBuffer | undefined;
    if (kind >= 0 && kind < 3) {
      location = this.acquireCell(kind, limit);
    } else if (kind !== ZERO) buffer = this.acquireOwned(kind, bytes, limit);
    if (metadata !== undefined) [this.classes, this.chunkOf, this.offsets, this.lengths] = metadata;
    this.chunkOf[id] = Math.floor(location / BUFFER_PAGE_BYTES);
    this.offsets[id] = location % BUFFER_PAGE_BYTES;
    if (buffer !== undefined) this.owned.set(id, buffer);
  }
  private acquireCell(kind: number, limit: number): number {
    if (this.committedBytes + this.pages.requiredBytes(kind) > limit) this.trim(0);
    if (this.committedBytes + this.pages.requiredBytes(kind) > limit)
      throw new RangeError('buffer budget exceeded');
    const location = this.pages.alloc(kind);
    if (this.pages.needsClear) {
      new Uint8Array(
        this.pages.buffer(location),
        location % BUFFER_PAGE_BYTES,
        SIZE_CLASSES[kind],
      ).fill(0);
      this.zeroedBytes += SIZE_CLASSES[kind] as number;
    }
    return location;
  }
  private acquireOwned(kind: number, bytes: number, limit: number): ArrayBuffer {
    const cached = this.freeBuffers[kind]?.at(-1);
    if (cached !== undefined) {
      new Uint8Array(cached).fill(0);
      this.zeroedBytes += cached.byteLength;
      this.freeBuffers[kind]?.pop();
      this.cachedBytes -= cached.byteLength;
      return cached;
    }
    const capacity = SIZE_CLASSES[kind] ?? bytes;
    if (this.committedBytes + capacity > limit) this.trim(0);
    if (this.committedBytes + capacity > limit) throw new RangeError('buffer budget exceeded');
    const buffer = new ArrayBuffer(capacity);
    this.ownedBytes += capacity;
    this.allocations++;
    return buffer;
  }
  private returnOwned(kind: number, buffer: ArrayBuffer): void {
    if (kind >= 3 && kind < DEDICATED) {
      this.freeBuffers[kind]?.push(buffer);
      this.cachedBytes += buffer.byteLength;
    } else this.ownedBytes -= buffer.byteLength;
  }
}
