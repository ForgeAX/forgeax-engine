import {
  err,
  type Handle,
  handleGeneration,
  handleSlot,
  isRetiredSlot,
  MAX_SLOT,
  ok,
  pack,
  type Result,
  type ResultOk,
  toShared,
  toUnique,
  unwrapHandle,
} from '@forgeax/engine-types';
import {
  createSharedRefDoubleReleaseError,
  createSharedRefPayloadInvalidError,
  createSharedRefReleasedError,
  createUniqueRefDoubleReleaseError,
  createUniqueRefReleasedError,
  type SharedRefDoubleReleaseError,
  type SharedRefReleasedError,
  SharedRefStaleError,
  type UniqueRefDoubleReleaseError,
  type UniqueRefReleasedError,
  UniqueRefStaleError,
} from './errors';

/** Each store owns its own slots, including generation history for released handles. */
class ReferenceSlots<Entry> {
  protected readonly entries = new Map<number, Entry>();
  private readonly freeSlots: number[] = [];
  private nextSlot = 1;
  /** @internal Retirement tests seed the last generation directly. */
  // biome-ignore lint/style/useNamingConvention: internal field used by retirement tests
  private readonly _generations: number[] = [];

  protected generationAt(slot: number): number {
    return this._generations[slot] ?? 0;
  }

  protected allocateSlot(owner: string, reference: string): number {
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    if (slot > MAX_SLOT) {
      throw new RangeError(
        `${owner}: slot index ${slot} exceeds 24-bit max (${MAX_SLOT}). ` +
          `Reduce simultaneous ${reference} handles or investigate handle leaks.`,
      );
    }
    return pack(slot, this.generationAt(slot));
  }

  protected retireSlot(slot: number, generation: number): number {
    const next = generation + 1;
    this._generations[slot] = next;
    if (!isRetiredSlot(next)) this.freeSlots.push(slot);
    return next;
  }

  /** @internal Diagnostic count of live slots. */
  _liveCount(): number {
    return this.entries.size;
  }
}

interface UniqueRefEntry {
  readonly resolution: ResultOk<unknown>;
  readonly onRelease: ((payload: unknown) => void) | undefined;
}

/** World-owned singleton payload store. A handle includes slot and generation.
 * Freed slots are reused with a new generation; exhausted generations retire the slot.
 * Each release drops the payload and runs its deleter once. */
export class UniqueRefStore extends ReferenceSlots<UniqueRefEntry> {
  /** Allocate a payload and optional deleter under a unique target tag. */
  alloc<Target extends string, T = unknown>(
    target: Target,
    payload: T,
    onRelease?: (payload: T) => void,
  ): Handle<Target, 'unique'> {
    void target; // target is a phantom - tag flows only at the type level via Handle<Target,_>.
    const raw = this.allocateSlot('UniqueRefStore', 'unique');
    this.entries.set(raw, {
      resolution: Object.freeze(ok(payload)),
      onRelease: onRelease as ((payload: unknown) => void) | undefined,
    });
    return toUnique(raw);
  }

  /** Resolve a live handle, distinguishing released and stale generations. Sentinel zero is empty. */
  resolve<Target extends string, T = unknown>(
    handle: Handle<Target, 'unique'>,
  ): Result<T, UniqueRefReleasedError | UniqueRefStaleError> {
    const raw = unwrapHandle(handle);
    // Gen comparison (M4): extract slot + handle gen, compare against
    // store's current gen. Runs BEFORE payload lookup.
    const slot = handleSlot(handle);
    const handleGen = handleGeneration(handle);
    const storeGen = this.generationAt(slot);
    if (handleGen !== storeGen) {
      return err(new UniqueRefStaleError(slot, handleGen, storeGen));
    }
    const entry = this.entries.get(raw);
    const payload = entry?.resolution.value;
    if (entry === undefined || payload === undefined) {
      // Slot 0 (sentinel) and any handle whose payload was already removed
      // both surface as released. The phantom Target is unavailable at
      // runtime - the error carries '<unknown>' to keep the structured
      // shape consistent.
      return err(createUniqueRefReleasedError(raw, '<unknown>'));
    }
    return entry.resolution as ResultOk<T>;
  }

  /** Release one live handle, invoke its deleter once, and reuse or retire the slot. */
  release<Target extends string>(
    handle: Handle<Target, 'unique'>,
  ): Result<void, UniqueRefDoubleReleaseError | UniqueRefStaleError> {
    const raw = unwrapHandle(handle);
    // Gen comparison runs FIRST (q12: all operations compare gen first).
    const slot = handleSlot(handle);
    const handleGen = handleGeneration(handle);
    const storeGen = this.generationAt(slot);
    if (handleGen !== storeGen) {
      // AC-03: stale release MUST NOT drop payload / fire callback / touch freeSlots.
      return err(new UniqueRefStaleError(slot, handleGen, storeGen));
    }
    const entry = this.entries.get(raw);
    const payload = entry?.resolution.value;
    if (entry === undefined || payload === undefined) {
      return err(createUniqueRefDoubleReleaseError(raw, '<unknown>'));
    }
    // Retire the complete entry and generation before user cleanup can
    // re-enter or throw. A recycled slot must never expose its old callback.
    const cb = entry?.onRelease;
    this.entries.delete(raw);
    this.retireSlot(slot, storeGen);
    if (cb !== undefined) {
      cb(payload);
    }
    return ok(undefined);
  }
}

interface SharedRefReleaseEvidence {
  readonly payload: unknown;
  readonly refcount: 0;
  readonly generation: number;
  readonly evidence: 'released';
}

/** One shared payload and its current owner count. */
type SharedRefEntry = { refcount: number } & (
  | { readonly payload: unknown; readonly target: undefined }
  | { readonly payload: object; readonly target: string }
);

export class SharedRefStore extends ReferenceSlots<SharedRefEntry> {
  private readonly internedByTarget = new Map<string, WeakMap<object, number>>();
  /** Allocate a shared payload with one caller-owned reference. */
  alloc<Target extends string, T = unknown>(target: Target, payload: T): Handle<Target, 'shared'> {
    return this.allocate(target, { payload, refcount: 1, target: undefined });
  }

  private allocate<Target extends string>(
    target: Target,
    entry: SharedRefEntry,
  ): Handle<Target, 'shared'> {
    if (entry.payload === null || entry.payload === undefined) {
      throw createSharedRefPayloadInvalidError(
        target,
        entry.payload === null ? 'null' : 'undefined',
      );
    }
    const raw = this.allocateSlot('SharedRefStore', 'shared');
    this.entries.set(raw, entry);
    return toShared(raw);
  }

  /** Return the producer-owned handle for this object and target. Repeated calls do not retain.
   * This cache is a lookup index; normal reference counts determine payload lifetime. */
  intern<Target extends string, T extends object>(
    target: Target,
    payload: T,
  ): Handle<Target, 'shared'> {
    let byPayload = this.internedByTarget.get(target);
    if (byPayload === undefined) {
      byPayload = new WeakMap<object, number>();
      this.internedByTarget.set(target, byPayload);
    }

    const existingRaw = byPayload.get(payload);
    if (existingRaw !== undefined) {
      return toShared(existingRaw);
    }

    const handle = this.allocate(target, { payload, refcount: 1, target });
    byPayload.set(payload, unwrapHandle(handle));
    return handle;
  }

  /** Acquire one caller-owned grant, sharing the existing object/target identity. */
  acquire<Target extends string, T extends object>(
    target: Target,
    payload: T,
  ): Handle<Target, 'shared'> {
    const raw = this.internedByTarget.get(target)?.get(payload);
    if (raw === undefined) return this.intern(target, payload);
    // Release evicts the identity before retiring the live entry.
    (this.entries.get(raw) as SharedRefEntry).refcount += 1;
    return toShared(raw);
  }

  /** Resolve a live shared handle, distinguishing released and stale generations. */
  resolve<Target extends string, T = unknown>(
    handle: Handle<Target, 'shared'>,
  ): Result<T, SharedRefReleasedError | SharedRefStaleError> {
    const raw = unwrapHandle(handle);
    const entry = this.entries.get(raw);
    if (entry === undefined) {
      return err(this.staleError(handle) ?? createSharedRefReleasedError(raw, '<unknown>'));
    }
    return ok(entry.payload as T);
  }

  /** Live keys already include their generation. Look up slot history to classify misses. */
  private staleError(handle: Handle<string, 'shared'>): SharedRefStaleError | undefined {
    const slot = handleSlot(handle);
    const generation = handleGeneration(handle);
    const current = this.generationAt(slot);
    return generation === current ? undefined : new SharedRefStaleError(slot, generation, current);
  }

  /**
   * Increment the refcount of a live shared handle. Returns
   * `err(shared-ref-released)` when the handle is not live - retain MUST
   * NOT resurrect a released slot (charter P3 explicit failure; would
   * defeat the rc=0 -> drop invariant); `err(builtin-slot-not-owned)` for a
   * builtin slot.
   */
  retain<Target extends string>(
    handle: Handle<Target, 'shared'>,
  ): Result<void, SharedRefReleasedError | SharedRefStaleError> {
    const raw = unwrapHandle(handle);
    const entry = this.entries.get(raw);
    if (entry === undefined) {
      return err(this.staleError(handle) ?? createSharedRefReleasedError(raw, '<unknown>'));
    }
    entry.refcount += 1;
    return ok(undefined);
  }

  /** Drop one reference. At zero, return the payload as release evidence and reuse or retire the slot.
   * The payload owner handles disposal; the store invokes no cleanup callback. */
  release<Target extends string>(
    handle: Handle<Target, 'shared'>,
  ): Result<
    SharedRefReleaseEvidence | undefined,
    SharedRefDoubleReleaseError | SharedRefStaleError
  > {
    const raw = unwrapHandle(handle);
    const entry = this.entries.get(raw);
    if (entry === undefined) {
      return err(this.staleError(handle) ?? createSharedRefDoubleReleaseError(raw, '<unknown>', 0));
    }
    if (entry.refcount > 1) {
      entry.refcount -= 1;
      return ok(undefined);
    }
    // rc === 1 -> drop. Capture the payload for release evidence before
    // clearing the live slot; nullish payloads never enter the store.
    if (entry.target !== undefined) {
      const byPayload = this.internedByTarget.get(entry.target);
      if (byPayload?.get(entry.payload) === raw) byPayload.delete(entry.payload);
    }
    this.entries.delete(raw);
    const generation = this.retireSlot(handleSlot(handle), handleGeneration(handle));
    const evidence = Object.freeze({
      payload: entry.payload,
      refcount: 0 as const,
      generation,
      evidence: 'released' as const,
    });
    return ok(evidence);
  }

  /**
   * Return the current refcount for `handle`. Returns 0 for a released
   * (or never-allocated) slot. Primarily a debug + tests entry point;
   * production code rarely reads rc directly (the rc=0 -> drop invariant
   * is the surface AI users consume via release / the per-handle deleter).
   */
  refcount<Target extends string>(handle: Handle<Target, 'shared'>): number {
    const raw = unwrapHandle(handle);
    return this.entries.get(raw)?.refcount ?? 0;
  }
}
