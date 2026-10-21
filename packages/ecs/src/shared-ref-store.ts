// Reference-counted, generation-checked storage for non-asset shared ECS values.
// Assets use the injected AssetReferenceOwner and never enter this store.
// Slot 0 is reserved for an empty component field; every other slot is owned.

import type { Handle } from '@forgeax/engine-types';
import {
  err,
  handleGeneration,
  handleSlot,
  isRetiredSlot,
  MAX_SLOT,
  ok,
  pack,
  type Result,
  toShared,
  unwrapHandle,
} from '@forgeax/engine-types';
import {
  SharedRefDoubleReleaseError,
  SharedRefPayloadInvalidError,
  SharedRefReleasedError,
  SharedRefStaleError,
} from './errors.js';

interface SharedRefReleaseEvidence {
  readonly payload: unknown;
  readonly refcount: 0;
  readonly generation: number;
  readonly evidence: 'released';
}

// MAX_SLOT is now imported from @forgeax/engine-types (codec SSOT, D-1).
// The local constant is removed to avoid drift (AC-15).

/**
 * Reference-counted store for ECS-aware `Handle<T, 'shared'>` lifecycles.
 *
 * The producer calls `alloc` once and owns the
 * "alloc-grant" rc=1; consumers (ECS schema fields, external systems) call
 * `retain` on each new holder and `release` when the holder drops. When rc
 * transitions 1 -> 0 the store publishes one structured release-evidence
 * record; it does not invoke a user callback or own payload disposal.
 *
 * Public API:
 *   - alloc(target, payload)        -> Handle<T, 'shared'> (rc=1)
 *   - intern(target, payload)        -> stable producer handle per target + object identity
 *   - resolve(handle)             -> Result<T, SharedRefReleasedError | SharedRefStaleError>
 *   - retain(handle)              -> Result<void, SharedRefReleasedError | SharedRefStaleError>
 *   - release(handle)             -> Result<release evidence | undefined, ...>
 *   - refcount(handle)            -> number (0 == released; debug + tests)
 *   - _liveCount()                -> live slot count (debug + inspector)
 */
type SharedRefEntry = { refcount: number } & (
  | { readonly payload: unknown; readonly target: undefined }
  | { readonly payload: object; readonly target: string }
);

export class SharedRefStore {
  private readonly entries = new Map<number, SharedRefEntry>();
  private readonly freeSlots: number[] = [];
  private readonly internedByTarget = new Map<string, WeakMap<object, number>>();
  private nextSlot = 1;
  /** Latest published mutation epoch per live handle; not an event journal. */

  /**
   * Generation table indexed by slot (D-6). Each entry tracks the current
   * generation for the slot — written to during alloc (welded into the
   * returned handle via pack) and incremented on release (M4).
   *
   * @internal
   */
  // biome-ignore lint/style/useNamingConvention: internal field — @internal JSDoc suppresses lint:internal gate
  private readonly _generations: number[] = [];

  /**
   * Allocate a fresh shared handle for `payload`, branded against `target`.
   * Refcount starts at 1 (the alloc-grant). Nullish payloads are rejected
   * before a slot or free-list is touched.
   *
   * The returned handle carries a generation tag welded via codec.pack
   * (D-8, OOS-2): first allocation gen=0 (AC-06), reused slot gen = the
   * current generation from _generations[slot]. The toShared brand cast
   * happens internally — external callers no longer construct Handle<...>
   * directly.
   *
   */
  alloc<Target extends string, T = unknown>(target: Target, payload: T): Handle<Target, 'shared'> {
    return this.allocate(target, { payload, refcount: 1, target: undefined });
  }

  private allocate<Target extends string>(
    target: Target,
    entry: SharedRefEntry,
  ): Handle<Target, 'shared'> {
    if (entry.payload === null || entry.payload === undefined) {
      throw new SharedRefPayloadInvalidError(target, entry.payload === null ? 'null' : 'undefined');
    }
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    if (slot > MAX_SLOT) {
      throw new RangeError(
        `SharedRefStore: slot index ${slot} exceeds 24-bit max (${MAX_SLOT}). ` +
          'Reduce simultaneous shared handles or investigate handle leaks.',
      );
    }
    const gen = this._generations[slot] ?? 0;
    const raw = pack(slot, gen);
    this.entries.set(raw, entry);
    return toShared(raw);
  }

  /**
   * Return the idempotent producer handle for one object payload in this
   * store. Identity includes `target`, so the same object branded for two
   * asset kinds does not alias.
   *
   * A cache hit deliberately does not retain: this is one producer grant,
   * discovered repeatedly by an asset catalogue. Actual holders retain and
   * release through the ECS write barrier. Callers needing independent
   * grants or a per-handle deleter must use {@link alloc}.
   */
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
    if (existingRaw !== undefined && this.entries.has(existingRaw)) {
      return toShared(existingRaw);
    }

    const handle = this.allocate(target, { payload, refcount: 1, target });
    const raw = unwrapHandle(handle);
    byPayload.set(payload, raw);
    return handle;
  }

  /** Acquire one caller-owned grant, sharing the existing object/target identity. */
  acquire<Target extends string, T extends object>(
    target: Target,
    payload: T,
  ): Handle<Target, 'shared'> {
    const previous = this.internedByTarget.get(target)?.get(payload);
    const handle = this.intern(target, payload);
    if (previous === unwrapHandle(handle)) this.retain(handle).unwrap();
    return handle;
  }

  /**
   * Look up `payload` by handle. Returns `err(shared-ref-released)` when
   * the handle's slot has no live payload (rc reached 0, no re-alloc has
   * filled the slot); `err(builtin-slot-not-owned)` for a builtin slot.
   *
   * §contract - mirrors UniqueRefStore: a stale handle whose slot has been
   * released and re-allocated returns `err(shared-ref-stale)` - the handle's
   * welded generation no longer matches `_generations[slot]`. The gen check
   * runs before payload lookup, so stale-by-reuse is caught deterministically.
   */
  resolve<Target extends string, T = unknown>(
    handle: Handle<Target, 'shared'>,
  ): Result<T, SharedRefReleasedError | SharedRefStaleError> {
    const raw = unwrapHandle(handle);
    // Gen comparison (M4): extract slot + handle gen, compare against
    // store's current gen. Mismatch means slot was released and re-allocated —
    // the caller's handle is stale. This check runs BEFORE payload lookup so
    // stale-by-reuse is always caught (AC-01).
    const slot = handleSlot(handle);
    const handleGen = handleGeneration(handle);
    const storeGen = this._generations[slot] ?? 0;
    if (handleGen !== storeGen) {
      return err(new SharedRefStaleError(slot, handleGen, storeGen));
    }
    const entry = this.entries.get(raw);
    if (entry === undefined) {
      return err(new SharedRefReleasedError(raw, '<unknown>'));
    }
    return ok(entry.payload as T);
  }

  /**
   * Publish that a live payload was mutated in place. Consumers that retain
   * projections of shared payload data compare the monotonic epoch and
   * explicitly refresh instead of rescanning every payload each frame.
   */

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
    // Gen comparison runs before rc read (q12: all three operations compare gen first).
    const slot = handleSlot(handle);
    const handleGen = handleGeneration(handle);
    const storeGen = this._generations[slot] ?? 0;
    if (handleGen !== storeGen) {
      return err(new SharedRefStaleError(slot, handleGen, storeGen));
    }
    const entry = this.entries.get(raw);
    if (entry === undefined) {
      return err(new SharedRefReleasedError(raw, '<unknown>'));
    }
    entry.refcount += 1;
    return ok(undefined);
  }

  /**
   * Decrement the refcount. When rc transitions 1 -> 0, the slot is dropped
   * and one structured release-evidence record is published. The evidence
   * captures the payload, zero refcount, next generation and `released` marker
   * after the store has removed the live slot.
   *
   * Returns `err(shared-ref-double-release, rc=0)` when the handle has
   * already reached rc=0 (or was never live); `err(builtin-slot-not-owned)`
   * for a builtin slot. AI users branch on `.code` and route the
   * second-release log to Layer 3 ErrorHandler without aborting the despawn
   * chain.
   */
  release<Target extends string>(
    handle: Handle<Target, 'shared'>,
  ): Result<
    SharedRefReleaseEvidence | undefined,
    SharedRefDoubleReleaseError | SharedRefStaleError
  > {
    const raw = unwrapHandle(handle);
    // Gen comparison runs FIRST — before rc read, before any mutation (q12).
    const slot = handleSlot(handle);
    const handleGen = handleGeneration(handle);
    const storeGen = this._generations[slot] ?? 0;
    if (handleGen !== storeGen) {
      // AC-03: stale release MUST NOT touch rc / payload / freeSlots.
      return err(new SharedRefStaleError(slot, handleGen, storeGen));
    }
    const entry = this.entries.get(raw);
    if (entry === undefined) {
      return err(new SharedRefDoubleReleaseError(raw, '<unknown>', 0));
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
    // Gen increment + retire (AC-07): bump gen; once it would exceed MAX_GEN
    // (gen 255 is still usable; the bump to 256 triggers retire) the slot is
    // permanently retired — NOT pushed to freeSlots. This prevents handle
    // aliasing. Shares the isRetiredSlot SSOT predicate with EntityHandle.
    const generation = storeGen + 1;
    this._generations[slot] = generation;
    if (!isRetiredSlot(generation)) {
      this.freeSlots.push(slot);
    }
    // else: slot retired (gen exceeded MAX_GEN) - never returns to freeSlots.
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

  /** @internal Diagnostic count of live slots. Exposed for tests + inspector. */
  _liveCount(): number {
    return this.entries.size;
  }
}
