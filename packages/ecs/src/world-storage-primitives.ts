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
