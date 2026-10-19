// @forgeax/engine-rhi-null/src/bookkeeping - method-A handle ledger for the
// headless no-op backend.
//
// RhiNull issues legal opaque-handle brands (each RHI brand is a compile-time
// `unique symbol` with no runtime field, so any plain object cast via
// `as unknown as Buffer` satisfies the type contract; research Finding A6). To
// let M3 command-stream assertions read back create/destroy pairing, draw /
// dispatch counts and binding assembly, RhiNull threads each issued handle
// through a per-device Bookkeeper that records a numeric id + kind + destroyed
// flag + the issuing device id.
//
// Error contract (plan-strategy D-1): handle-chain inconsistencies reuse the
// existing closed RhiErrorCode union with ZERO new members:
//   - a handle observed on a device other than its issuer -> 'rhi-not-available'
//   - a destroy / use observed on an already-destroyed handle ->
//     'destroy-after-destroy'
// Every RhiError carries the required code / expected / hint triple
// (charter proposition 3 structured failure).
//
// Related: requirements AC-09 (foreign handle returns structured err, no silent
// pass); plan-strategy §2 D-1; research Finding A3 (RhiErrorCode 20 members,
// 'rhi-not-available' at errors.ts:113, 'destroy-after-destroy' at errors.ts:127)
// + Finding A6 (brand construction); charter P3.

import type { Result, RhiError as RhiErrorType } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';

/**
 * One ledger row for an issued opaque-handle brand.
 *
 * - `id` — per-device monotonic numeric id assigned at register time; the value
 *   M3 assertions read back to pair create / destroy and count draws.
 * - `kind` — the handle category (`'Buffer'` / `'Texture'` / `'BindGroupLayout'`
 *   etc.); free-form so every create* entry can tag what it minted.
 * - `destroyed` — flipped to `true` by the first destroy; a second destroy
 *   fail-fasts via `'destroy-after-destroy'`.
 * - `sourceDeviceId` — the id of the device that issued the handle; cross-device
 *   use fail-fasts via `'rhi-not-available'`.
 */
interface HandleRecord {
  readonly id: number;
  readonly kind: string;
  destroyed: boolean;
  readonly sourceDeviceId: number;
  readonly references: readonly unknown[];
  onSubmitted?: ((completion: Promise<undefined>) => void) | undefined;
}

/**
 * The brand attachment RhiNull stamps onto every issued handle object so the
 * ledger can be recovered from the handle alone (handle-chain validation reads
 * `handle[BOOKKEEPING_KEY]` rather than holding a side Map keyed on identity,
 * which would leak across device instances).
 *
 * Lives behind a module-private symbol so it never collides with a real RHI
 * brand symbol and never appears in the public `.d.ts` surface.
 */
export const BOOKKEEPING_KEY = Symbol('forgeax-rhi-null-bookkeeping');

/** A handle object as RhiNull mints it: a plain object carrying its ledger row
 *  under the private bookkeeping symbol, cast to the relevant brand at the
 *  create* call site. */
interface BookkeptHandle {
  readonly [BOOKKEEPING_KEY]: HandleRecord;
}

/**
 * Per-device handle ledger. One Bookkeeper instance lives on each
 * RhiNullDevice; it assigns the device id at construction and mints monotonic
 * handle ids thereafter.
 */
export class Bookkeeper {
  readonly deviceId: number;
  private nextHandleId = 0;
  private readonly records = new Map<number, BookkeptHandle>();

  constructor(deviceId: number) {
    this.deviceId = deviceId;
  }

  /**
   * Register a freshly-minted handle of the given kind, returning a plain
   * object that carries its ledger row. The caller casts the return value to
   * the concrete brand (`as unknown as Buffer` etc.).
   */
  register(kind: string, references: readonly unknown[] = []): BookkeptHandle {
    const id = this.nextHandleId++;
    const handle = {} as BookkeptHandle;
    const record: HandleRecord = {
      id,
      kind,
      destroyed: false,
      sourceDeviceId: this.deviceId,
      references: Object.freeze([...references]),
    };
    this.records.set(id, handle);
    Object.defineProperty(handle, BOOKKEEPING_KEY, { value: record, enumerable: true });
    return handle;
  }

  /**
   * Mark a handle destroyed. Fail-fasts on a second destroy
   * ('destroy-after-destroy') or on a handle issued by a different device
   * ('rhi-not-available'); otherwise flips the destroyed flag and returns ok.
   */
  destroy(handle: unknown): Result<void, RhiErrorType> {
    const ownership = this.validateOwnership(handle);
    if (!ownership.ok) return ownership;
    const destroyedCheck = isHandleDestroyed(handle);
    if (!destroyedCheck.ok) return destroyedCheck;
    ownership.value.destroyed = true;
    return ok(undefined);
  }

  /**
   * Report whether a handle has already been destroyed (true once destroy()
   * has flipped its flag). Used by command-stream methods that must not
   * consume a stale handle.
   */
  isDestroyed(handle: unknown): boolean {
    return readRecord(handle)?.destroyed === true;
  }

  /**
   * Validate that a handle was issued by THIS device. Returns the ledger row on
   * success so callers can mutate it (e.g. flip destroyed); returns
   * 'rhi-not-available' for a foreign handle (AC-09 — no silent pass).
   */
  validateOwnership(handle: unknown): Result<HandleRecord, RhiErrorType> {
    const record = readRecord(handle);
    if (
      record === undefined ||
      record.sourceDeviceId !== this.deviceId ||
      this.records.get(record.id) !== handle
    ) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'handle was issued by this RhiNull device',
          hint: 'do not pass a handle created on a different RhiNull device into this device; create resources on the device they are used with',
        }),
      );
    }
    return ok(record);
  }

  /** Validate a real, live member of this ledger, optionally narrowing its kind. */
  validateLive(handle: unknown, kind?: string): Result<HandleRecord, RhiErrorType> {
    const owned = this.validateOwnership(handle);
    if (!owned.ok) return owned;
    if (kind !== undefined && owned.value.kind !== kind) {
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: `a live ${kind} issued by this device`,
          hint: `received ${owned.value.kind}; use the corresponding device creation method`,
        }),
      );
    }
    const live = isHandleDestroyed(handle);
    return live.ok ? owned : live;
  }

  /** Follow the existing resource rows, including TextureView -> Texture parents. */
  dependencies(handles: readonly unknown[]): Result<readonly HandleRecord[], RhiErrorType> {
    const members = new Set<HandleRecord>();
    const visit = (handle: unknown): Result<void, RhiErrorType> => {
      const live = this.validateLive(handle);
      if (!live.ok) return live;
      if (members.has(live.value)) return ok(undefined);
      members.add(live.value);
      for (const reference of live.value.references) {
        const valid = visit(reference);
        if (!valid.ok) return valid;
      }
      return ok(undefined);
    };
    for (const handle of handles) {
      const valid = visit(handle);
      if (!valid.ok) return valid;
    }
    return ok([...members]);
  }

  /**
   * Return all ledger rows as a readonly array. M3 unit tests (w17) read this
   * to assert create/destroy pairing, BGL/PSO shape counts, and resource
   * lifecycle coverage (AC-05/06/07). Returns a snapshot of the current Map
   * so callers can iterate without a stale reference after further mutations.
   */
  allRecords(): readonly HandleRecord[] {
    return [...this.records.values()].map((handle) => handle[BOOKKEEPING_KEY]);
  }

  /** Report the total number of records in the ledger. */
  recordCount(): number {
    return this.records.size;
  }
}

/** Recover the ledger row from a handle object, or undefined if the object
 *  carries no RhiNull bookkeeping (foreign / non-RhiNull handle). */
export function readRecord(handle: unknown): HandleRecord | undefined {
  if (handle === null || typeof handle !== 'object') return undefined;
  const tagged = handle as Partial<BookkeptHandle>;
  return tagged[BOOKKEEPING_KEY];
}

/**
 * Validation function: has this handle already been destroyed? Returns ok(void)
 * for a live handle; returns 'destroy-after-destroy' for a handle whose ledger
 * row is flagged destroyed (charter P3 fail-fast over silent idempotency).
 */
export function isHandleDestroyed(handle: unknown): Result<void, RhiErrorType> {
  if (readRecord(handle)?.destroyed === true) {
    return err(
      new RhiError({
        code: 'destroy-after-destroy',
        expected: 'GPU buffer/texture handle has not been destroyed yet',
        hint: 'object already destroyed; track lifecycle in caller or check isDestroyed before re-destroy',
      }),
    );
  }
  return ok(undefined);
}
