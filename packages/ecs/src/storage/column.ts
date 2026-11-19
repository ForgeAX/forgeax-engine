import type { ArrayFieldPlan, FieldPlan } from '../component';
import type { WorldRead } from '../world-read';
import { ARRAY_FIELD_ARITY, type ArrayStore } from './array-store';
// @forgeax/engine-ecs — per-field independent buffer column storage (D-01).
//
// Each component field gets its own ArrayBuffer/SharedArrayBuffer + TypedArray view.
// This enables independent per-column transfer() expansion and
// supports dynamic column add/remove during archetype migration.
//
// Variable `array<T>` fields take one arity-3 u32 column holding
// the whole location `[block, byteOffset, count]` in the World's ArrayStore
// (`storage/array-store.ts`); capacity follows from the block. `array<T,N>`
// (fixed-capacity) fields take a single inline stride-N column (arity = N)
// with the elements contiguous per row. Byte arrays use the same u8 element layout.

import { SCALAR_LAYOUTS, type ScalarFieldType, type TypedArrayFor } from '../component';
// ManagedColumnReader — read-only view onto a managed-vocab column
// (feat-20260614 M4 / D-4 / AC-08 / AC-09 / AC-10)

/**
 * Read-only column access for strings, references and managed arrays.
 *
 * The column carries u32 handles (`UniqueRefStore` ids, or the arity-3
 * `[block, byteOffset, count]` array locations); direct index assignment
 * would corrupt the backing store. The reader exposes `.length` +
 * `.get(i): number` so consumers can walk the raw words, then route through the public dispatch (`world.set`,
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
// Column: one field's storage

/** TypedArray view types used by columns. */
export type FieldView = TypedArrayFor<ScalarFieldType>;

/** Element-indexed numeric views; field admission checks the declared element constructor. */
export function isNumericArray(value: unknown): value is FieldView | Uint8ClampedArray {
  return (
    ArrayBuffer.isView(value) &&
    !(value instanceof DataView) &&
    !(value instanceof BigInt64Array) &&
    !(value instanceof BigUint64Array)
  );
}

function isSharedBuffer(buffer: ArrayBufferLike): buffer is SharedArrayBuffer {
  return typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
}

/** A single column: one field's ArrayBuffer + TypedArray view. */
const COLUMN_WINDOW = Symbol('ecs.column-window');
interface ColumnWindow {
  readonly source: FieldView;
  readonly start: number;
  readonly end: number;
  readonly managed: string | undefined;
  readonly value: FieldView | ManagedColumnReader<string>;
}

export interface Column {
  [COLUMN_WINDOW]?: ColumnWindow | undefined;
  view: FieldView;
  /**
   * The component's immutable compiled layout, shared by every physical column
   * for this field. It owns the native storage kind and elements per row.
   *
   * For inline columns, the TypedArray view returned by `col.view.subarray()`
   * aliases the column buffer directly. The view is transient: `growColumn`
   * detaches the old `ArrayBuffer` via `transfer()`, so callers must re-fetch
   * the view after any structural change. See `packages/ecs/README.md`
   * Transient view contract section.
   */
  readonly layout: FieldPlan;
}

/**
 * One latest physical window at the column owner. The carrier of a Query span
 * stays fresh/mutable; only equal borrowed typed views or frozen readers share.
 */
export function columnWindow(
  column: Column,
  start: number,
  end: number,
  managed: string | undefined,
  cache: boolean,
): FieldView | ManagedColumnReader<string> {
  const source = column.view;
  if (start === 0 && end === source.length && managed === undefined) return source;
  const previous = cache ? column[COLUMN_WINDOW] : undefined;
  if (
    previous?.source === source &&
    previous.start === start &&
    previous.end === end &&
    previous.managed === managed
  )
    return previous.value;
  const view = start === 0 && end === source.length ? source : source.subarray(start, end);
  const value =
    managed === undefined
      ? view
      : Object.freeze({
          length: view.length,
          get(index: number): number {
            return view[index] ?? 0;
          },
          __managed: managed,
        });
  if (cache) column[COLUMN_WINDOW] = { source, start, end, managed, value };
  return value;
}

/**
 * Create a column for a single field with given capacity.
 *
 * @param layout - component-owned field layout
 * @param capacity - number of rows
 */
export function createColumn(layout: FieldPlan, capacity: number, shared = false): Column {
  const meta = SCALAR_LAYOUTS[layout.storage];
  if (!meta) throw new Error(`Missing scalar layout for field type ${layout.storage}`);
  const bytesPerElement = meta.byteSize;
  const buffer = shared
    ? new SharedArrayBuffer(bytesPerElement * capacity * layout.arity)
    : new ArrayBuffer(bytesPerElement * capacity * layout.arity);
  const Ctor = meta.viewCtor;
  const view = new Ctor(buffer);
  return { view, layout };
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
  const meta = SCALAR_LAYOUTS[col.layout.storage];
  if (!meta) throw new Error(`Missing scalar layout for field type ${col.layout.storage}`);
  const bytesPerElement = meta.byteSize;
  const newByteLength = bytesPerElement * newCapacity * col.layout.arity;
  const Ctor = meta.viewCtor;
  const previous = col.view.buffer;

  let buffer: ArrayBuffer | SharedArrayBuffer;
  if (isSharedBuffer(previous)) {
    buffer = new SharedArrayBuffer(newByteLength);
    new Uint8Array(buffer).set(new Uint8Array(previous));
  } else if (HAS_TRANSFER) {
    // Zero-copy path: transfer() resizes the underlying buffer in-place
    // and detaches the source. The old column's buffer becomes detached,
    // but we return a new Column object so callers never touch the old one.
    buffer = (previous as unknown as { transfer(newByteLength: number): ArrayBuffer }).transfer(
      newByteLength,
    );
  } /* istanbul ignore next -- fallback for runtimes without ES2024 transfer() */ else {
    // Fallback path: allocate new buffer + byte-level copy.
    buffer = new ArrayBuffer(newByteLength);
    new Uint8Array(buffer).set(new Uint8Array(previous));
  }

  const view = new Ctor(buffer);
  return { ...col, view, [COLUMN_WINDOW]: undefined };
}
/** Read the live length without creating a row window. */
export function columnArrayLength(column: Column, row: number): number | undefined {
  const plan = column.layout;
  if (plan.kind === 'fixed-array') return plan.arity;
  if (plan.kind === 'array') return column.view[row * ARRAY_FIELD_ARITY + 2] ?? 0;
  return undefined;
}

export function columnArrayElement(
  store: ArrayStore,
  column: Column,
  row: number,
  index: number,
): number | undefined {
  const plan = column.layout;
  if (plan.kind === 'fixed-array')
    return index < plan.arity ? column.view[row * plan.arity + index] : undefined;
  if (plan.kind !== 'array') return undefined;
  const base = row * ARRAY_FIELD_ARITY;
  if (index >= (column.view[base + 2] as number)) return undefined;
  const source = store.view(column.view[base] as number, plan.element.viewCtor);
  return source[(column.view[base + 1] as number) / plan.element.byteSize + index];
}

/** Borrow one physical row window until the column or cell is reused. */
export function borrowColumnArray(
  store: ArrayStore,
  column: Column,
  row: number,
  plan: ArrayFieldPlan,
): FieldView {
  const Ctor = plan.element.viewCtor;
  if (plan.kind === 'fixed-array') {
    return new Ctor(
      column.view.buffer,
      column.view.byteOffset + row * plan.arity * plan.element.byteSize,
      plan.arity,
    );
  }
  const base = row * ARRAY_FIELD_ARITY;
  return new Ctor(
    store.buffer(column.view[base] as number),
    column.view[base + 1] as number,
    column.view[base + 2] as number,
  );
}

export function copyColumnArray(
  store: ArrayStore,
  column: Column,
  row: number,
  target: Parameters<WorldRead['copyArray']>[3],
): number | undefined {
  const plan = column.layout;
  let source: FieldView;
  let start: number;
  let count: number;
  if (plan.kind === 'array') {
    const base = row * ARRAY_FIELD_ARITY;
    const location = column.view;
    count = location[base + 2] as number;
    if (target.length < count) return undefined;
    source = store.view(location[base] as number, plan.element.viewCtor);
    start = (location[base + 1] as number) / plan.element.byteSize;
  } else if (plan.kind === 'fixed-array') {
    count = plan.arity;
    if (target.length < count) return undefined;
    source = column.view;
    start = row * count;
  } else {
    return undefined;
  }
  if (target.buffer === source.buffer) {
    // Native set handles a target that aliases the same backing.
    target.set(source.subarray(start, start + count));
  } else {
    for (let index = 0; index < count; index++) target[index] = source[start + index] as number;
  }
  return count;
}
