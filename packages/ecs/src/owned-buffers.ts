import { err, ok, type Result } from '@forgeax/engine-types';
import { ManagedBufferOutOfBoundsError } from './errors';
import {
  type MemoryArray,
  type MemoryArrayConstructor,
  type MemoryBudget,
  MemoryError,
  memoryByteLength,
  memoryLimit,
} from './memory-types';
import { CELL_BYTES, ExtentStore, extentByteOffset } from './storage/extent-store';

const BUFFER_HANDLE: unique symbol = Symbol('ecs.buffer-handle');
export interface BufferHandle<T extends MemoryArray = MemoryArray> {
  readonly [BUFFER_HANDLE]: T;
}

interface Ownership<T extends MemoryArray = MemoryArray> {
  location: number;
  logicalBytes: number;
  readonly ctor: MemoryArrayConstructor<T>;
  active: boolean;
  readers: number;
  view: T | undefined;
}
export interface BufferLease<T extends MemoryArray> {
  readonly view: T;
  release(): Result<void, MemoryError>;
}
export interface BufferReaderStats {
  readonly leases: number;
  readonly pendingRetirements: number;
  readonly leasedBytes: number;
  readonly pendingBytes: number;
  readonly oldestLeaseAgeMs: number;
}
const MAX_CACHED_CAPACITY = 262144;
const DEDICATED_CAPACITIES = [1024, 2048, 4096, 16384, 65536, MAX_CACHED_CAPACITY] as const;
const SIZE_CLASSES = [...CELL_BYTES, ...DEDICATED_CAPACITIES] as const;
const CACHED_CAPACITIES = [...DEDICATED_CAPACITIES].reverse();
function bufferCapacity(bytes: number): number {
  if (bytes === 0) return 0;
  for (const capacity of SIZE_CLASSES) if (bytes <= capacity) return capacity;
  return bytes;
}
export interface OwnedBufferStats {
  readonly liveBuffers: number;
  readonly logicalBytes: number;
  readonly liveCapacityBytes: number;
  readonly committedBytes: number;
  readonly idleBytes: number;
  readonly backingAllocations: number;
  readonly copiedBytes: number;
  readonly zeroedBytes: number;
  readonly trimmedBytes: number;
}
/** Opaque ownership, leases and initialization over an independent backing domain. */
export class OwnedBuffers {
  private readonly store = new ExtentStore();
  private readonly ownership = new WeakMap<object, Ownership>();
  private liveBuffers = 0;
  private logicalBytes = 0;
  private liveCapacityBytes = 0;
  private copied = 0;
  private zeroed = 0;
  private readonly maxBytes: number;
  private readonly retainBytes: number;
  private leased = 0;
  private pending = 0;
  private leasedBytes = 0;
  private pendingBytes = 0;
  private nextLease = 0;
  private readonly freeLeaseIds: number[] = [];
  private readonly leaseStarts = new Map<number, number>();
  constructor(options: MemoryBudget = {}) {
    this.maxBytes = memoryLimit(options.maxBytes, 256 * 1024 * 1024);
    this.retainBytes = Math.min(this.maxBytes, memoryLimit(options.retainBytes, 4 * 1024 * 1024));
  }
  alloc<T extends MemoryArray>(
    ctor: MemoryArrayConstructor<T>,
    count: number,
  ): Result<BufferHandle<T>, MemoryError> {
    const sized = memoryByteLength(ctor, count);
    if (typeof sized !== 'number') return err(sized);
    const capacity = bufferCapacity(sized);
    if (!this.admit(capacity)) return this.budgetFailure(sized);
    let location: number;
    try {
      location = this.allocate(capacity);
    } catch {
      return this.allocationFailure(sized);
    }
    const handle = Object.freeze({ [BUFFER_HANDLE]: undefined as unknown as T });
    const owned: Ownership<T> = {
      location,
      logicalBytes: sized,
      ctor,
      active: true,
      readers: 0,
      view: undefined,
    };
    this.ownership.set(handle, owned);
    this.liveBuffers++;
    this.logicalBytes += sized;
    this.liveCapacityBytes += capacity;
    return ok(handle);
  }
  view<T extends MemoryArray>(handle: BufferHandle<T>): Result<T, MemoryError> {
    const owned = this.validate(handle);
    return owned instanceof MemoryError ? err(owned) : ok(this.viewOf(owned));
  }
  private viewOf<T extends MemoryArray>(owned: Ownership<T>): T {
    if (owned.view === undefined) {
      owned.view = new owned.ctor(
        this.store.bufferAt(owned.location),
        extentByteOffset(owned.location),
        owned.logicalBytes / owned.ctor.BYTES_PER_ELEMENT,
      );
    }
    return owned.view;
  }
  resize<T extends MemoryArray>(handle: BufferHandle<T>, count: number): Result<void, MemoryError> {
    const owned = this.validate(handle);
    if (owned instanceof MemoryError) return err(owned);
    if (owned.readers > 0) return err(new MemoryError({ kind: 'handle', reason: 'borrowed' }));
    const sized = memoryByteLength(owned.ctor, count);
    if (typeof sized !== 'number') return err(sized);
    const oldCapacity = this.store.capacityAt(owned.location);
    if (sized > oldCapacity) {
      const capacity = bufferCapacity(sized);
      if (!this.admit(capacity)) return this.budgetFailure(sized);
      let next: number | undefined;
      try {
        next = this.allocate(capacity, owned.logicalBytes);
        new Uint8Array(this.store.bufferAt(next), extentByteOffset(next), owned.logicalBytes).set(
          new Uint8Array(
            this.store.bufferAt(owned.location),
            extentByteOffset(owned.location),
            owned.logicalBytes,
          ),
        );
      } catch {
        if (next !== undefined) this.store.releaseLocation(next, false);
        return this.allocationFailure(sized);
      }
      this.copied += owned.logicalBytes;
      this.releaseLocation(owned.location, oldCapacity);
      owned.location = next;
      this.liveCapacityBytes += capacity - oldCapacity;
    } else if (sized < owned.logicalBytes) {
      new Uint8Array(
        this.store.bufferAt(owned.location),
        extentByteOffset(owned.location),
        owned.logicalBytes,
      ).fill(0, sized);
      this.zeroed += owned.logicalBytes - sized;
    }
    this.logicalBytes += sized - owned.logicalBytes;
    owned.logicalBytes = sized;
    owned.view = undefined;
    return ok(undefined);
  }
  release(handle: BufferHandle): Result<void, MemoryError> {
    const owned = this.validate(handle);
    if (owned instanceof MemoryError) return err(owned);
    owned.active = false;
    owned.view = undefined;
    if (owned.readers > 0) {
      this.pending++;
      this.pendingBytes += owned.logicalBytes;
    } else {
      this.retire(owned);
    }
    return ok(undefined);
  }
  borrow<T extends MemoryArray>(handle: BufferHandle<T>): Result<BufferLease<T>, MemoryError> {
    const owned = this.validate(handle);
    if (owned instanceof MemoryError) return err(owned);
    const view = this.viewOf(owned);
    if (owned.readers === 0) this.leasedBytes += owned.logicalBytes;
    owned.readers++;
    this.leased++;
    const leaseId = this.freeLeaseIds.pop() ?? ++this.nextLease;
    this.leaseStarts.set(leaseId, Date.now());
    let open = true;
    return ok(
      Object.freeze({
        view,
        release: (): Result<void, MemoryError> => {
          if (!open) return err(new MemoryError({ kind: 'handle', reason: 'lease-released' }));
          open = false;
          owned.readers--;
          this.leased--;
          this.leaseStarts.delete(leaseId);
          this.freeLeaseIds.push(leaseId);
          if (owned.readers === 0) this.leasedBytes -= owned.logicalBytes;
          if (!owned.active && owned.readers === 0) {
            this.pending--;
            this.pendingBytes -= owned.logicalBytes;
            this.retire(owned);
          }
          return ok(undefined);
        },
      }),
    );
  }
  stats(): BufferReaderStats {
    let oldest = Date.now();
    for (const start of this.leaseStarts.values()) oldest = Math.min(oldest, start);
    return {
      leases: this.leased,
      pendingRetirements: this.pending,
      leasedBytes: this.leasedBytes,
      pendingBytes: this.pendingBytes,
      oldestLeaseAgeMs: Math.max(0, Date.now() - oldest),
    };
  }
  /** Bounded idle maintenance; payload and live readers are never moved. */
  maintain(): void {
    this.trimBacking(this.retainBytes, 4);
  }

  /** Drop only idle backing; live handles and leases retain their exact extents. */
  trim(): number {
    return this.trimBacking(0);
  }
  private trimBacking(retainBytes: number, visits = Infinity): number {
    let freed = 0;
    if (this.store.idleDedicatedBytes > retainBytes) {
      for (const capacity of CACHED_CAPACITIES) {
        const bytes = this.store.trimDedicatedCapacity(capacity, retainBytes, visits);
        freed += bytes;
        visits -= bytes / capacity;
      }
    }
    return (
      freed + this.store.trimPages(Math.max(0, retainBytes - this.store.idleDedicatedBytes), visits)
    );
  }
  memoryStats(): OwnedBufferStats {
    const backing = this.store.backingStats();
    return {
      liveBuffers: this.liveBuffers,
      logicalBytes: this.logicalBytes,
      liveCapacityBytes: this.liveCapacityBytes,
      committedBytes: backing.committedBytes,
      idleBytes: backing.idleBytes,
      backingAllocations: backing.backingAllocations,
      copiedBytes: this.copied,
      zeroedBytes: this.zeroed,
      trimmedBytes: backing.trimmedBytes,
    };
  }
  private retire(owned: Ownership): void {
    const capacity = this.store.capacityAt(owned.location);
    this.releaseLocation(owned.location, capacity);
    this.liveBuffers--;
    this.logicalBytes -= owned.logicalBytes;
    this.liveCapacityBytes -= capacity;
    this.maintain();
  }
  private allocate(capacity: number, overwrittenPrefix = 0): number {
    const location = this.store.allocate(capacity);
    try {
      if (this.store.reused) {
        const count = capacity - overwrittenPrefix;
        new Uint8Array(
          this.store.bufferAt(location),
          extentByteOffset(location) + overwrittenPrefix,
          count,
        ).fill(0);
        this.zeroed += count;
      }
    } catch (cause) {
      this.store.releaseLocation(location, false);
      throw cause;
    }
    return location;
  }
  private releaseLocation(location: number, capacity: number): void {
    this.store.releaseLocation(location, capacity <= MAX_CACHED_CAPACITY);
  }
  private allocationFailure(bytes: number): Result<never, MemoryError> {
    return err(
      new MemoryError({
        kind: 'allocation',
        requestedBytes: bytes,
        cause: new ManagedBufferOutOfBoundsError(bytes, this.store.committedBytes),
      }),
    );
  }
  private admit(capacity: number): boolean {
    if (this.store.committedBytes + this.store.additionalBytes(capacity) <= this.maxBytes)
      return true;
    this.trim();
    return this.store.committedBytes + this.store.additionalBytes(capacity) <= this.maxBytes;
  }
  private budgetFailure(bytes: number): Result<never, MemoryError> {
    return err(
      new MemoryError({ kind: 'budget', requestedBytes: bytes, limitBytes: this.maxBytes }),
    );
  }
  private validate<T extends MemoryArray>(handle: BufferHandle<T>): Ownership<T> | MemoryError {
    const owned = this.ownership.get(handle);
    if (owned === undefined) return new MemoryError({ kind: 'handle', reason: 'wrong-owner' });
    return owned.active
      ? (owned as Ownership<T>)
      : new MemoryError({ kind: 'handle', reason: 'released' });
  }
}
