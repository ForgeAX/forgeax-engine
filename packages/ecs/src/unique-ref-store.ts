// @forgeax/engine-ecs - UniqueRefStore.
//
// Per-slot singleton store for ECS-managed asset handles. Schema vocab
// `ref<T>` fields derive `Handle<T, 'unique'>` whose lifecycle is owned by
// the ECS - World hooks `despawn` / `removeComponent` / `set` into
// `UniqueRefStore.release` so dropping a holder entity reliably releases the
// referenced asset slot. AssetRegistry handles (`handle<T>` schema vocab) take
// the orthogonal `'shared'` mode and never enter this store.
//
// §contract — handles carry a generation; stale-by-reuse is detected
//   The handle u32 packs `(generation << 24) | slot` via the shared codec in
//   `@forgeax/engine-types` (the same SSOT codec ECS `EntityHandle` uses). The
//   slot occupies the low 24 bits (capped at MAX_SLOT == ENTITY_MAX_INDEX);
//   the generation occupies the high 8 bits. `alloc` welds the slot's current
//   generation into the returned handle; `resolve` / `release` compare the
//   handle's generation against the store's `_generations[slot]` BEFORE any
//   payload work, so a handle whose slot was released and re-allocated is
//   caught deterministically and returns `UniqueRefStaleError` ('unique-ref-
//   stale') — it no longer silently resolves to the next payload.
//
//   Generation advances on release and retires the slot when gen would exceed
//   MAX_GEN (255) — gen 255 is still usable; the bump to 256 triggers retire —
//   rather than wrapping, so a re-used slot can never collide with an old
//   handle's generation (mirrors EntityHandle via the isRetiredSlot SSOT).
//
//   AC-06 (unique-ref-double-release) remains payload-presence detected
//   (`entries.has(raw)`) for a handle whose generation still matches; the
//   generation check catches the orthogonal stale-by-reuse case first.
//
// One live entry owns payload and optional cleanup. The entry is deleted
// before invoking cleanup; generation history survives retired entries.
// Free slots form a LIFO stack; fresh slots begin at 1.
//
// 24 bits = 16_777_215 simultaneous live managed handles - the same ceiling
// as Entity, so an ECS that hit the entity ceiling cannot grow past the
// managed-ref ceiling either. Ceiling-exhaust handling is a future concern;
// the store deliberately panics on overflow to fail fast rather than
// silently wrap.
//
// Release path (D-1 codes):
//   - resolve(h):  err(UniqueRefReleasedError)        if payload absent.
//   - release(h):  err(UniqueRefDoubleReleaseError)   on second release.
//
// Object.is identity invariant (AC-04 prelude):
//   resolve(h) returns the SAME payload object on every call until release
//   - the store does not clone, wrap, or proxy the payload. M4 carry-over
//   reuses this invariant: archetype migrate moves the row index, not the
//   payload reference, so wrapper identity survives migration.

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
  toUnique,
  unwrapHandle,
} from '@forgeax/engine-types';
import { UniqueRefDoubleReleaseError, UniqueRefReleasedError, UniqueRefStaleError } from './errors';

// MAX_SLOT is now imported from @forgeax/engine-types (codec SSOT, D-1).
// The local constant is removed to avoid drift (AC-15).

interface UniqueRefEntry {
  payload: unknown;
  readonly onRelease: ((payload: unknown) => void) | undefined;
}

/**
 * Per-slot singleton store for ECS-managed `Handle<T, 'unique'>` lifecycles.
 * World hooks the three release paths (despawn, removeComponent, set) into
 * `release(handle)`; `resolve(handle)` is the read path AI users reach
 * indirectly through `world.get(e, C)` for `ref<T>` schema fields.
 *
 * §contract — handles carry a generation; stale-by-reuse is detected: the
 * handle u32 packs `(gen << 24) | slot` via the shared codec; `resolve` /
 * `release` compare the handle generation against `_generations[slot]` and
 * return `UniqueRefStaleError` ('unique-ref-stale') when a released slot has
 * been re-allocated, instead of silently resolving to the next payload.
 * README §"Managed handles carry a generation" is the canonical AI-user-
 * facing statement.
 *
 * Identity invariant (AC-04 prelude): the payload returned by `resolve` is
 * the same object reference on every call until `release`. Carry-over (M4)
 * relies on this - archetype migrate moves the row index, not the payload.
 *
 * Storage is type-erased (`unknown`): the store routes lifecycle without ever
 * inspecting payload fields. Per-call payload typing flows through method
 * generics: `alloc<T>` accepts a `T` payload + matching `onRelease(T)`, and
 * `resolve<T>` returns `Result<T, ...>`. Both narrow at the call boundary
 * (the single read site is World.get's ref path); making the class generic
 * on `T` was decoration with no internal use, so the parameter was dropped
 * (architecture-principles.md §1 SSOT).
 */
export class UniqueRefStore {
  private readonly entries = new Map<number, UniqueRefEntry>();
  private readonly freeSlots: number[] = [];
  private nextSlot = 1;

  /**
   * Generation table indexed by slot (D-6). Each entry tracks the current
   * generation for the slot — written to during alloc (welded into the
   * returned handle via pack) and incremented on release (M4).
   *
   * Slot 0 is the sentinel and always has gen=0 — it is never allocated
   * and never incremented (R6).
   *
   * @internal
   */
  // biome-ignore lint/style/useNamingConvention: internal field — @internal JSDoc suppresses lint:internal gate
  private readonly _generations: number[] = [];

  /**
   * Allocate a fresh managed handle for `payload`, branded against `target`.
   *
   * Slot 0 is reserved as the "null/unset" sentinel - schema-vocab `ref<T>`
   * fields default to this sentinel before the first write, and World's
   * release loop uses it to short-circuit (`shouldRelease(0) === false`).
   *
   * The returned handle carries a generation tag welded via codec.pack
   * (D-8, OOS-2): first allocation gen=0 (AC-06), reused slot gen = the
   * current generation from _generations[slot]. The toUnique brand cast
   * happens internally — external callers no longer construct Handle<...>
   * directly.
   *
   * @returns a `Handle<T, 'unique'>` u32. The branded number is safe to
   *   widen to `number` for GPU upload (charter consistent abstraction).
   */
  alloc<Target extends string, T = unknown>(
    target: Target,
    payload: T,
    onRelease?: (payload: T) => void,
  ): Handle<Target, 'unique'> {
    void target; // target is a phantom - tag flows only at the type level via Handle<Target,_>.
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    if (slot > MAX_SLOT) {
      throw new RangeError(
        `UniqueRefStore: slot index ${slot} exceeds 24-bit max (${MAX_SLOT}). ` +
          'Reduce simultaneous managed handles or investigate handle leaks.',
      );
    }
    const gen = this._generations[slot] ?? 0;
    const raw = pack(slot, gen);
    this.entries.set(raw, {
      payload,
      onRelease: onRelease as ((payload: unknown) => void) | undefined,
    });
    return toUnique(raw);
  }

  /**
   * Look up `payload` by handle. Returns `err(unique-ref-released)` when
   * the handle's slot has no live payload (release happened in between, and
   * no re-alloc has filled the slot). Resolves the same payload object on
   * every call - identity-stable until release.
   *
   * §contract: a stale handle whose slot has been released and re-allocated
   * returns `err(unique-ref-stale)` — the generation welded into the handle
   * no longer matches `_generations[slot]`. The gen check runs before the
   * payload lookup, so stale-by-reuse is caught deterministically — see
   * README §"Managed handles carry a generation".
   *
   * `T` flows from the caller's `Handle<T, 'unique'>` type; the store erases
   * payload types at the storage layer and the call boundary re-narrows.
   */
  resolve<Target extends string, T = unknown>(
    handle: Handle<Target, 'unique'>,
  ): Result<T, UniqueRefReleasedError | UniqueRefStaleError> {
    const raw = unwrapHandle(handle);
    // Gen comparison (M4): extract slot + handle gen, compare against
    // store's current gen. Runs BEFORE payload lookup.
    const slot = handleSlot(handle);
    const handleGen = handleGeneration(handle);
    const storeGen = this._generations[slot] ?? 0;
    if (handleGen !== storeGen) {
      return err(new UniqueRefStaleError(slot, handleGen, storeGen));
    }
    const entry = this.entries.get(raw);
    const payload = entry?.payload;
    if (payload === undefined) {
      // Slot 0 (sentinel) and any handle whose payload was already removed
      // both surface as released. The phantom Target is unavailable at
      // runtime - the error carries '<unknown>' to keep the structured
      // shape consistent.
      return err(new UniqueRefReleasedError(raw, '<unknown>'));
    }
    return ok(payload as T);
  }

  /**
   * Release `handle` - drop the payload and push the slot onto the free list.
   * Releasing the same handle twice surfaces `unique-ref-double-release`
   * (D-1) so World's release loop can route the second release to Layer 3
   * ErrorHandler without aborting the despawn chain. Detection is by
   * payload-presence, not generation (§contract — managed handles are
   * operational, not persistent).
   *
   * Releasing the slot-0 sentinel is a no-op - World's release loop calls
   * `shouldRelease` first to filter sentinels.
   */
  release<Target extends string>(
    handle: Handle<Target, 'unique'>,
  ): Result<void, UniqueRefDoubleReleaseError | UniqueRefStaleError> {
    const raw = unwrapHandle(handle);
    // Gen comparison runs FIRST (q12: all operations compare gen first).
    const slot = handleSlot(handle);
    const handleGen = handleGeneration(handle);
    const storeGen = this._generations[slot] ?? 0;
    if (handleGen !== storeGen) {
      // AC-03: stale release MUST NOT drop payload / fire callback / touch freeSlots.
      return err(new UniqueRefStaleError(slot, handleGen, storeGen));
    }
    const entry = this.entries.get(raw);
    const payload = entry?.payload;
    if (payload === undefined) {
      return err(new UniqueRefDoubleReleaseError(raw, '<unknown>'));
    }
    // Retire the complete entry and generation before user cleanup can
    // re-enter or throw. A recycled slot must never expose its old callback.
    const cb = entry?.onRelease;
    this.entries.delete(raw);
    // Gen increment + retire (AC-07): bump gen; once it would exceed MAX_GEN
    // (gen 255 is still usable; the bump to 256 triggers retire) the slot is
    // permanently retired — NOT pushed to freeSlots.
    this._generations[slot] = storeGen + 1;
    if (!isRetiredSlot(this._generations[slot])) {
      this.freeSlots.push(slot);
    }
    // else: slot retired (gen exceeded MAX_GEN) — never returns to freeSlots.
    if (cb !== undefined) {
      cb(payload);
    }
    return ok(undefined);
  }

  /** @internal Replace the payload of a live slot without changing its handle. */
  _setPayload<Target extends string, T>(handle: Handle<Target, 'unique'>, payload: T): void {
    const raw = unwrapHandle(handle);
    const entry = this.entries.get(raw);
    if (entry === undefined) {
      throw new Error(`UniqueRefStore: cannot replace released payload ${raw}.`);
    }
    entry.payload = payload;
  }

  /**
   * `true` if `handle` references a live slot - used by World's release loop
   * to decide whether to call `release` (skips sentinel + already-released).
   *
   * The release loop differentiates "expected sentinel" (no error) from
   * "leaked already-released handle" (`unique-ref-double-release`) at the
   * caller layer; this helper handles only the no-op short-circuit.
   */
  isLive<Target extends string>(handle: Handle<Target, 'unique'>): boolean {
    const raw = unwrapHandle(handle);
    if (raw === 0) return false;
    return this.entries.has(raw);
  }

  /** @internal Diagnostic count of live slots. Exposed for tests + inspector. */
  _liveCount(): number {
    return this.entries.size;
  }
}
