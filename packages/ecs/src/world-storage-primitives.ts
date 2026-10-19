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

/** Write a numeric value through the declared array element's native conversion. */
export function writeArrayElementAt(
  bytes: Uint8Array,
  idx: number,
  elementType: ManagedArrayElementType,
  value: number,
): void {
  const count = Math.floor(bytes.byteLength / elementByteSize(elementType));
  reinterpretSlotBytes(bytes, elementType, count)[idx] = value;
}

/** Read an array element, returning the existing zero sentinel outside the slot. */
export function readArrayElementAt(
  bytes: Uint8Array,
  idx: number,
  elementType: ManagedArrayElementType,
): number {
  const count = Math.floor(bytes.byteLength / elementByteSize(elementType));
  return reinterpretSlotBytes(bytes, elementType, count)[idx] ?? 0;
}
