// @forgeax/engine-ecs - SharedRefStore.
//
// Reference-counted store for AssetRegistry-style shared handles. Schema vocab
// `shared<T>` fields derive `Handle<T, 'shared'>` whose lifecycle is tracked
// by retain/release on the holder side - allocators (typically the asset
// registry) call `alloc` once and let consumers retain/release as the asset
// flows through ECS components and external systems. When rc transitions
// 1 -> 0 the store publishes release evidence. External owners dispose their
// payloads from their own lifecycle effects; ECS does not invoke callbacks.
//
// Companion to UniqueRefStore (1-holder-direct-release semantics). The two
// stores share storage shape and code patterns; only the lifecycle differs:
//
//   UniqueRefStore: alloc -> store; release -> drop. No retain.
//   SharedRefStore: alloc -> rc=1; retain -> rc++; release -> rc--; rc=0 -> drop.
//
// §contract - shared handles are refcounted AND carry a generation
//   The handle u32 packs `(generation << 24) | slot` via the shared codec in
//   `@forgeax/engine-types` (same SSOT codec as UniqueRefStore and ECS
//   EntityHandle). `alloc` welds the slot's current generation; resolve /
//   retain / release compare the handle generation against
//   `_generations[slot]` BEFORE any refcount/payload work, so a handle whose
//   slot was released and re-allocated returns `SharedRefStaleError`
//   ('shared-ref-stale') instead of silently resolving the next payload.
//   Generation advances on the rc=0 drop and retires the slot when gen would
//   exceed MAX_GEN (gen 255 is still usable; retire at would-be 256, no wrap).
//   AI users keep the rule "don't cache a handle
//   past release" - the AssetRegistry mediates most shared handle lifecycles,
//   but a stale handle now fails structurally rather than silently.
//
// §tier boundary (feat-20260614 M6 D-15)
//   This store manages ONLY user-tier slots (`slot >= BUILTIN_BASE`). Builtin
//   asset payloads in the builtin range are process-static and live in their
//   authoring package; they
//   are never reference-counted. `nextSlot` starts at `BUILTIN_BASE` so minted
//   handles never collide with builtin slots, and alloc/retain/release/resolve
//   fail-fast with `BuiltinSlotNotOwnedError` when handed a builtin slot.
//
// One live entry owns payload, refcount and optional intern identity. The
// reverse object index is weak; generation history survives entry retirement.
// Free slots form a LIFO stack; fresh slots begin at BUILTIN_BASE.
//
// 24 bits = 16_777_215 simultaneous live shared handles - same ceiling as
// UniqueRefStore + Entity, so the three managed-handle resources fail-fast
// at the same bound.
//
// Release path (D-1 codes):
//   - resolve(h): err(SharedRefReleasedError)        if payload absent.
//   - retain(h):  err(SharedRefReleasedError)        if payload absent.
//   - release(h): err(SharedRefDoubleReleaseError, rc=0) on rc=0 input.
//   - any(builtin slot): err(BuiltinSlotNotOwnedError) (D-15).
//
// Identity invariant (mirrors UniqueRefStore): resolve(h) returns the SAME
// payload object on every call until the final release. Archetype migration
// preserves this trivially - the column carries the u32 handle, never the
// payload reference.

import type { Handle } from '@forgeax/engine-types';
import {
  BUILTIN_BASE,
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
  BuiltinSlotNotOwnedError,
  SharedRefDoubleReleaseError,
  SharedRefPayloadInvalidError,
  SharedRefReleasedError,
  SharedRefStaleError,
} from './errors.js';

export interface SharedRefReleaseEvidence {
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
 * The producer (typically AssetRegistry) calls `alloc` once and owns the
 * "alloc-grant" rc=1; consumers (ECS schema fields, external systems) call
 * `retain` on each new holder and `release` when the holder drops. When rc
 * transitions 1 -> 0 the store publishes one structured release-evidence
 * record; it does not invoke a user callback or own payload disposal.
 *
 * D-15: manages ONLY user-tier slots (`slot >= BUILTIN_BASE`). Builtin slots
 * (`< BUILTIN_BASE`) fail-fast with `BuiltinSlotNotOwnedError`.
 *
 * Public API:
 *   - alloc(target, payload)        -> Handle<T, 'shared'> (rc=1)
 *   - intern(target, payload)        -> stable producer handle per target + object identity
 *   - resolve(handle)             -> Result<T, SharedRefReleasedError | SharedRefStaleError | BuiltinSlotNotOwnedError>
 *   - retain(handle)              -> Result<void, SharedRefReleasedError | SharedRefStaleError | BuiltinSlotNotOwnedError>
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
  private nextSlot = BUILTIN_BASE;
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
   * Minted slots are user-tier (`>= BUILTIN_BASE`); builtin slots are never
   * produced here (D-15).
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
  ): Result<T, SharedRefReleasedError | SharedRefStaleError | BuiltinSlotNotOwnedError> {
    const raw = unwrapHandle(handle);
    if (raw < BUILTIN_BASE) return err(new BuiltinSlotNotOwnedError(raw));
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
  ): Result<void, SharedRefReleasedError | SharedRefStaleError | BuiltinSlotNotOwnedError> {
    const raw = unwrapHandle(handle);
    if (raw < BUILTIN_BASE) return err(new BuiltinSlotNotOwnedError(raw));
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
    SharedRefDoubleReleaseError | SharedRefStaleError | BuiltinSlotNotOwnedError
  > {
    const raw = unwrapHandle(handle);
    if (raw < BUILTIN_BASE) return err(new BuiltinSlotNotOwnedError(raw));
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
