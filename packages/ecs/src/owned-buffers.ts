import { err, ok, type Result } from '@forgeax/engine-types';
import type { BufferPool } from './buffer-pool';
import {
  type MemoryArray,
  type MemoryArrayConstructor,
  type MemoryBudget,
  MemoryError,
  memoryByteLength,
  memoryLimit,
} from './memory-types';

const BUFFER_HANDLE: unique symbol = Symbol('ecs.buffer-handle');
export interface BufferHandle<T extends MemoryArray = MemoryArray> {
  readonly [BUFFER_HANDLE]: T;
}

interface Ownership<T extends MemoryArray = MemoryArray> {
  readonly owner: OwnedBuffers;
  readonly id: number;
  readonly ctor: MemoryArrayConstructor<T>;
  active: boolean;
  readers: number;
  view: T | undefined;
}
// Capability state only: all payload, slot and backing facts remain in BufferPool.
const OWNERSHIP = new WeakMap<object, Ownership>();
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
/** A capability over the World's existing pool, not another physical store. */
export class OwnedBuffers {
  private readonly maxBytes: number;
  private readonly retainBytes: number;
  private leased = 0;
  private pending = 0;
  private leasedBytes = 0;
  private pendingBytes = 0;
  private nextLease = 0;
  private readonly freeLeaseIds: number[] = [];
  private readonly leaseStarts = new Map<number, number>();
  constructor(
    private readonly pool: BufferPool,
    options: MemoryBudget = {},
  ) {
    this.maxBytes = memoryLimit(options.maxBytes, 256 * 1024 * 1024);
    this.retainBytes = Math.min(this.maxBytes, memoryLimit(options.retainBytes, 4 * 1024 * 1024));
  }
  alloc<T extends MemoryArray>(
    ctor: MemoryArrayConstructor<T>,
    count: number,
  ): Result<BufferHandle<T>, MemoryError> {
    const sized = memoryByteLength(ctor, count);
    if (typeof sized !== 'number') return err(sized);
    const budget = this.admit(sized);
    if (!budget.ok) return budget;
    const allocated = this.pool.alloc(sized, this.maxBytes);
    if (!allocated.ok)
      return err(
        new MemoryError({
          kind: 'allocation',
          requestedBytes: sized,
          cause: allocated.error,
        }),
      );
    const handle = Object.freeze({ [BUFFER_HANDLE]: undefined as unknown as T });
    OWNERSHIP.set(handle, {
      owner: this,
      id: allocated.value.id,
      ctor,
      active: true,
      readers: 0,
      view: undefined,
    });
    return ok(handle);
  }
  view<T extends MemoryArray>(handle: BufferHandle<T>): Result<T, MemoryError> {
    const valid = this.validate(handle);
    if (!valid.ok) return valid;
    return ok(this.viewOf(valid.value));
  }
  private viewOf<T extends MemoryArray>(owned: Ownership<T>): T {
    if (owned.view === undefined) {
      const bytes = this.pool.view(owned.id);
      owned.view = new owned.ctor(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.byteLength / owned.ctor.BYTES_PER_ELEMENT,
      );
    }
    return owned.view;
  }
  resize<T extends MemoryArray>(handle: BufferHandle<T>, count: number): Result<void, MemoryError> {
    const valid = this.validate(handle);
    if (!valid.ok) return valid;
    const owned = valid.value;
    if (owned.readers > 0) return err(new MemoryError({ kind: 'handle', reason: 'borrowed' }));
    const sized = memoryByteLength(owned.ctor, count);
    if (typeof sized !== 'number') return err(sized);
    if (sized > this.pool.byteCapacity(owned.id)) {
      const budget = this.admit(sized);
      if (!budget.ok) return budget;
    }
    const resized =
      sized <= this.pool.byteCapacity(owned.id)
        ? this.pool.setLogicalLength(owned.id, sized)
        : this.pool.grow(owned.id, sized, this.maxBytes);
    if (!resized.ok)
      return err(
        new MemoryError({ kind: 'allocation', requestedBytes: sized, cause: resized.error }),
      );
    owned.view = undefined;
    return ok(undefined);
  }
  release(handle: BufferHandle): Result<void, MemoryError> {
    const valid = this.validate(handle);
    if (!valid.ok) return valid;
    const owned = valid.value;
    owned.active = false;
    owned.view = undefined;
    if (owned.readers > 0) {
      this.pending++;
      this.pendingBytes += this.pool.byteLength(owned.id);
    } else {
      this.pool.release(owned.id);
      this.maintain();
    }
    return ok(undefined);
  }
  borrow<T extends MemoryArray>(handle: BufferHandle<T>): Result<BufferLease<T>, MemoryError> {
    const valid = this.validate(handle);
    if (!valid.ok) return valid;
    const owned = valid.value;
    const view = this.viewOf(owned);
    if (owned.readers === 0) this.leasedBytes += this.pool.byteLength(owned.id);
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
          if (owned.readers === 0) this.leasedBytes -= this.pool.byteLength(owned.id);
          if (!owned.active && owned.readers === 0) {
            this.pending--;
            this.pendingBytes -= this.pool.byteLength(owned.id);
            this.pool.release(owned.id);
            this.maintain();
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
    this.pool.trim(this.retainBytes, 4);
  }

  private admit(bytes: number): Result<void, MemoryError> {
    if (this.pool.committedBytes + this.pool.additionalBytes(bytes) > this.maxBytes)
      this.pool.trim(0);
    return this.pool.committedBytes + this.pool.additionalBytes(bytes) > this.maxBytes
      ? err(new MemoryError({ kind: 'budget', requestedBytes: bytes, limitBytes: this.maxBytes }))
      : ok(undefined);
  }
  private validate<T extends MemoryArray>(
    handle: BufferHandle<T>,
  ): Result<Ownership<T>, MemoryError> {
    const owned = OWNERSHIP.get(handle);
    if (owned === undefined || owned.owner !== this)
      return err(new MemoryError({ kind: 'handle', reason: 'wrong-owner' }));
    return owned.active
      ? ok(owned as Ownership<T>)
      : err(new MemoryError({ kind: 'handle', reason: 'released' }));
  }
}
