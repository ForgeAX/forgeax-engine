import { fieldTypeToMetaKey, type ManagedArrayElementType, TYPE_METADATA } from './component';
import type { FieldView } from './storage/column';

/** Freeze the detached POD produced by World.inspect(). */
export function detachWorldInspection<T extends object>(snapshot: T): Readonly<T> {
  return freezeInspection(snapshot);
}

function freezeInspection<T>(value: T): Readonly<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value as Readonly<T>;
  }
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && (typeof child === 'object' || typeof child === 'function')) {
      freezeInspection(child);
    }
  }
  return Object.freeze(value) as Readonly<T>;
}

/**
 * Element-byte-width for a managed-array element type, read off the global
 * TYPE_METADATA table (single SSOT). `entity` stores as `u32` (4 bytes); every
 * scalar maps to its own key. `fieldTypeToMetaKey` always resolves a key for a
 * ManagedArrayElementType, and every such row carries a concrete `byteSize`.
 */
export function elementByteSize(elementType: ManagedArrayElementType): number {
  const key = fieldTypeToMetaKey(elementType);
  // biome-ignore lint/style/noNonNullAssertion: every ManagedArrayElementType resolves to a row with a concrete byteSize
  return TYPE_METADATA[key!]!.byteSize;
}

export function reinterpretSlotBytes(
  bytes: Uint8Array,
  elementType: ManagedArrayElementType,
  elementCount: number,
): ReturnType<typeof reinterpretBufferRegion> {
  return reinterpretBufferRegion(bytes.buffer, bytes.byteOffset, elementType, elementCount);
}

export function reinterpretBufferRegion(
  buffer: ArrayBufferLike,
  byteOffset: number,
  elementType: ManagedArrayElementType,
  elementCount: number,
): FieldView {
  const key = fieldTypeToMetaKey(elementType);
  // biome-ignore lint/style/noNonNullAssertion: admitted array element types resolve to a metadata row
  const Ctor = TYPE_METADATA[key!]!.viewCtor;
  return new Ctor(buffer, byteOffset, elementCount);
}

// Fixed codec state, independent of World capacity: the largest scalar is f64.
// Only synchronous scalar operations use these finite native conversion windows.
// Public array borrows still construct their own transient views.
const scalarBytes = new Uint8Array(8);
const scalarViews = new Map<(typeof TYPE_METADATA)[string]['viewCtor'], FieldView>();
for (const metadata of Object.values(TYPE_METADATA)) {
  const Ctor = metadata.viewCtor;
  if (!scalarViews.has(Ctor)) scalarViews.set(Ctor, new Ctor(scalarBytes.buffer, 0, 1));
}

function scalarScratchEligible(bytes: Uint8Array, index: number, width: number): boolean {
  return (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteLength > 0 &&
    bytes.byteOffset % width === 0 &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    (index + 1) * width <= bytes.byteLength
  );
}

/** Write through the metadata owner's exact native numeric conversion. */
export function writeArrayElementAt(
  bytes: Uint8Array,
  idx: number,
  elementType: ManagedArrayElementType,
  value: number,
): void {
  const key = fieldTypeToMetaKey(elementType);
  // biome-ignore lint/style/noNonNullAssertion: admitted array element types resolve to metadata
  const metadata = TYPE_METADATA[key!]!;
  const width = metadata.byteSize;
  const window = scalarScratchEligible(bytes, idx, width)
    ? scalarViews.get(metadata.viewCtor)
    : undefined;
  if (window === undefined) {
    // Shared/cross-realm memory and exceptional indices/alignment retain the
    // original native typed access, including no-tear shared integer stores.
    reinterpretSlotBytes(bytes, elementType, Math.floor(bytes.byteLength / width))[idx] = value;
    return;
  }
  window[0] = value;
  const offset = idx * width;
  for (let lane = 0; lane < width; lane++) bytes[offset + lane] = scalarBytes[lane] ?? 0;
}

/** Read a number without an escaping row window; preserve native exceptional paths. */
export function readArrayElementAt(
  bytes: Uint8Array,
  idx: number,
  elementType: ManagedArrayElementType,
): number {
  const key = fieldTypeToMetaKey(elementType);
  // biome-ignore lint/style/noNonNullAssertion: admitted array element types resolve to metadata
  const metadata = TYPE_METADATA[key!]!;
  const width = metadata.byteSize;
  const window = scalarScratchEligible(bytes, idx, width)
    ? scalarViews.get(metadata.viewCtor)
    : undefined;
  if (window === undefined)
    return reinterpretSlotBytes(bytes, elementType, Math.floor(bytes.byteLength / width))[idx] ?? 0;
  const offset = idx * width;
  for (let lane = 0; lane < width; lane++) scalarBytes[lane] = bytes[offset + lane] ?? 0;
  return window[0] ?? 0;
}
