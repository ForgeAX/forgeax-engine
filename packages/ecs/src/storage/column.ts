// @forgeax/engine-ecs — per-field independent buffer column storage (D-01).
//
// Each component field gets its own ArrayBuffer/SharedArrayBuffer + TypedArray view.
// This enables independent per-column transfer() expansion and
// supports dynamic column add/remove during archetype migration.
//
// `array<T>` (variable-capacity) fields take TWO columns in archetype layout
// (D-3): the primary u32 column carries the BufferPool slot id; a sidecar
// column carries the live element count, named `<fieldName>:count` and
// keyed by `arrayCountColumnName(fieldName)`. `array<T,N>` (fixed-capacity)
// fields (feat-20260602) take a SINGLE inline stride-N column (arity = N) --
// no BufferPool slot id, no sidecar count column. The elements live
// contiguously per row. `buffer<N>` likewise takes a single stride-N u8
// column. Variable `buffer` still uses a u32 BufferPool slot id column.
// Capacity is never stored as an independent column: for variable-capacity
// fields it is derived from `BufferPool.view(slotId).byteLength /
// elementBytes`; for fixed-capacity fields the schema-declared N is the
// capacity.

import { type ScalarFieldType, TYPE_METADATA } from '../component';

// ────────────────────────────────────────────────────────────────────────────
// ManagedColumnReader — read-only view onto a managed-vocab column
// (feat-20260614 M4 / D-4 / AC-08 / AC-09 / AC-10)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read-only access shape for the 4 managed-vocab column keywords --
 * `'string'` / `` `ref<T>` `` / variable `'buffer'` / variable `` `array<T>` ``.
 *
 * The column carries u32 slot ids (`UniqueRefStore` / `BufferPool`); direct
 * index assignment would corrupt the slot table. The reader exposes
 * `.length` + `.get(i): number` so consumers can walk row indices and
 * retrieve slot ids, then route through the public dispatch (`world.set`,
 * `world.push`, `world.allocUniqueRef`, etc.) for any mutation.
 *
 * Phantom brand `__managed` (D-7 / requirements-decisions q2): the
 * double-underscore + semantic-word pattern matches `Handle.__handle`. The
 * brand is a structural-typing safety net; the class name already
 * disambiguates against `Uint32Array` / `Uint8Array` / fixed inline views.
 *
 * Intentionally minimal -- no iterator, no `toArray`, no `slice`. Adding
 * those invites a "cache the slot ids, mutate later" anti-pattern that
 * silently desyncs from the live column on the next archetype migration
 * (charter P4 / plan-strategy §8.4).
 */
export interface ManagedColumnReader<T extends string> {
  readonly length: number;
  get(i: number): number;
  readonly __managed: T;
}

/**
 * Sidecar column name for the live `count` of an `array<T>` (variable-
 * capacity) field. Format `<fieldName>:count` keeps the suffix outside the
 * legal user-facing schema name space (the colon is forbidden in user
 * field names by convention) so the archetype Map can carry both columns
 * under one `Map<fieldName, Column>` keyed namespace without collision
 * (D-3 double-column allocation in M1 / w7).
 */
export function arrayCountColumnName(fieldName: string): string {
  return `${fieldName}:count`;
}

// ────────────────────────────────────────────────────────────────────────────
// Column: one field's storage
// ────────────────────────────────────────────────────────────────────────────

/** TypedArray view types used by columns. */
export type FieldView =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array;

type FieldViewConstructor = new (buffer: ArrayBufferLike) => FieldView;

function createFieldView(
  Ctor: NonNullable<(typeof TYPE_METADATA)[string]['viewCtor']>,
  buffer: ArrayBufferLike,
): FieldView {
  return new (Ctor as FieldViewConstructor)(buffer);
}

function isSharedBuffer(buffer: ArrayBufferLike): buffer is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
}

/** A single column: one field's ArrayBuffer + TypedArray view. */
export interface Column {
  buffer: ArrayBuffer | SharedArrayBuffer;
  view: FieldView;
  capacity: number;
  fieldType: ScalarFieldType;
  /**
   * Number of elements per row (stride). Scalar and variable-capacity columns
   * default to 1 (one u32 slot id or one scalar value per row). Fixed-capacity
   * `array<T,N>` / `buffer<N>` inline columns (feat-20260602) have arity = N.
   *
   * For inline columns, the TypedArray view returned by `col.view.subarray()`
   * aliases the column buffer directly. The view is transient: `growColumn`
   * detaches the old `ArrayBuffer` via `transfer()`, so callers must re-fetch
   * the view after any structural change. See `packages/ecs/README.md`
   * Transient view contract section.
   */
  arity: number;
}

/**
 * Create a column for a single field with given capacity.
 *
 * @param fieldType - scalar storage type for the column view ctor
 * @param capacity - number of rows
 * @param arity - elements per row (stride); default 1 for scalar/variable columns
 */
export function createColumn(
  fieldType: ScalarFieldType,
  capacity: number,
  arity = 1,
  shared = false,
): Column {
  const meta = TYPE_METADATA[fieldType];
  if (!meta) throw new Error(`Missing TYPE_METADATA entry for scalar field type ${fieldType}`);
  const bytesPerElement =
    // biome-ignore lint/style/noNonNullAssertion: ScalarFieldType rows always carry a byteSize
    meta.byteSize!;
  const buffer = shared
    ? new SharedArrayBuffer(bytesPerElement * capacity * arity)
    : new ArrayBuffer(bytesPerElement * capacity * arity);
  // biome-ignore lint/style/noNonNullAssertion: ScalarFieldType rows always carry a viewCtor
  const Ctor = meta.viewCtor!;
  const view = createFieldView(Ctor, buffer);
  return { buffer, view, capacity, fieldType, arity };
}

/**
 * Module-level cache for `ArrayBuffer.prototype.transfer` support (O-1).
 * Checked once at import time; avoids per-call feature detection overhead.
 *
 * Note: `transfer()` is ES2024. We use runtime feature detection + type cast
 * so that tsconfig does not need `lib: ["es2024"]`.
 */
export const HAS_TRANSFER: boolean =
  typeof (ArrayBuffer.prototype as { transfer?: unknown }).transfer === 'function';

/**
 * Grow a column to a new capacity, preserving existing data.
 * Returns a new Column; the old column is not modified.
 *
 * When the runtime supports `ArrayBuffer.transfer()` (ES2024, Node 22+,
 * modern browsers), uses zero-copy buffer transfer. Otherwise falls back
 * to `new ArrayBuffer` + `Uint8Array.set` copy.
 *
 * Both paths produce data-equivalent results (O-1 acceptance criterion).
 */
export function growColumn(col: Column, newCapacity: number): Column {
  const meta = TYPE_METADATA[col.fieldType];
  if (!meta) throw new Error(`Missing TYPE_METADATA entry for scalar field type ${col.fieldType}`);
  const bytesPerElement =
    // biome-ignore lint/style/noNonNullAssertion: ScalarFieldType rows always carry a byteSize
    meta.byteSize!;
  const newByteLength = bytesPerElement * newCapacity * col.arity;
  // biome-ignore lint/style/noNonNullAssertion: ScalarFieldType rows always carry a viewCtor
  const Ctor = meta.viewCtor!;

  let buffer: ArrayBuffer | SharedArrayBuffer;
  if (isSharedBuffer(col.buffer)) {
    buffer = new SharedArrayBuffer(newByteLength);
    new Uint8Array(buffer).set(new Uint8Array(col.buffer));
  } else if (HAS_TRANSFER) {
    // Zero-copy path: transfer() resizes the underlying buffer in-place
    // and detaches the source. The old column's buffer becomes detached,
    // but we return a new Column object so callers never touch the old one.
    buffer = (col.buffer as unknown as { transfer(newByteLength: number): ArrayBuffer }).transfer(
      newByteLength,
    );
  } /* istanbul ignore next -- fallback for runtimes without ES2024 transfer() */ else {
    // Fallback path: allocate new buffer + byte-level copy.
    buffer = new ArrayBuffer(newByteLength);
    new Uint8Array(buffer).set(new Uint8Array(col.buffer));
  }

  const view = createFieldView(Ctor, buffer);
  return { buffer, view, capacity: newCapacity, fieldType: col.fieldType, arity: col.arity };
}

// ────────────────────────────────────────────────────────────────────────────
// Buffer-write input normalization (feat-20260621 V2 / AC-A4)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a `'buffer'` / `'buffer<N>'` write payload to a `Uint8Array` view
 * over its raw bytes. The write surface (`FieldInputType<'buffer'>`) accepts
 * any `AllowSharedBufferSource` (Float32Array / ArrayBuffer / Uint8Array / any
 * TypedArray); the column store and read side speak `Uint8Array` only. This is
 * the single ingestion point that bridges the two — a strict superset of the
 * prior Uint8Array-only behavior (an existing `Uint8Array` caller round-trips
 * through `new Uint8Array(buffer, byteOffset, byteLength)`, same bytes, same
 * length), so existing callers see zero behavior change.
 *
 * Returns `null` for non-buffer-source inputs (e.g. a forced cast feeding a
 * number) so callers keep their existing "no-op / alloc(0)" branch for raw
 * that is not a real buffer view.
 */
export function normalizeBufferWrite(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (typeof SharedArrayBuffer !== 'undefined' && raw instanceof SharedArrayBuffer) {
    return new Uint8Array(raw);
  }
  return null;
}
