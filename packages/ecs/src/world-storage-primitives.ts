import { fieldTypeToMetaKey, type ManagedArrayElementType, TYPE_METADATA } from './component';

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
  return TYPE_METADATA[key!]!.byteSize!;
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
):
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array {
  // shared<X> template literals: column-stored as u32 handles, reinterpret
  // as Uint32Array. The brand is applied at the FieldValueType level;
  // runtime storage is plain u32 (feat-20260614 M5; replaces the retired
  // 'handle<X>' arm).
  if (elementType.startsWith('shared<')) {
    return new Uint32Array(buffer, byteOffset, elementCount);
  }
  switch (elementType) {
    case 'f32':
      return new Float32Array(buffer, byteOffset, elementCount);
    case 'f64':
      return new Float64Array(buffer, byteOffset, elementCount);
    case 'i32':
      return new Int32Array(buffer, byteOffset, elementCount);
    case 'u32':
    case 'enum':
    case 'ref':
    case 'entity':
      return new Uint32Array(buffer, byteOffset, elementCount);
    case 'i16':
      return new Int16Array(buffer, byteOffset, elementCount);
    case 'u16':
      return new Uint16Array(buffer, byteOffset, elementCount);
    case 'i8':
      return new Int8Array(buffer, byteOffset, elementCount);
    case 'u8':
    case 'bool':
      return new Uint8Array(buffer, byteOffset, elementCount);
  }
  // Exhaustiveness fallthrough: TypeScript template-literal type
  // (`shared<${string}>`) is structurally not narrowed away by the
  // `startsWith` guard above, so this branch is unreachable yet TS still
  // requires a return path.
  return new Uint32Array(buffer, byteOffset, elementCount);
}

/**
 * Reinterpret `bytes` as the typed view for `elementType` and write `value`
 * at element index `idx`. Mirrors the `array<T>` storage law (4/8/2/1-byte
 * element widths per TYPE_METADATA.byteSize) and is used by `world.push`
 * to land a new tail element into BufferPool slot bytes after a `grow`.
 */
export function writeArrayElementAt(
  bytes: Uint8Array,
  idx: number,
  elementType: ManagedArrayElementType,
  value: number,
): void {
  const buf = bytes.buffer;
  const offset = bytes.byteOffset;
  const byteLen = bytes.byteLength;
  switch (elementType) {
    case 'f32':
      new Float32Array(buf, offset, byteLen >>> 2)[idx] = value;
      return;
    case 'f64':
      new Float64Array(buf, offset, byteLen >>> 3)[idx] = value;
      return;
    case 'i32':
      new Int32Array(buf, offset, byteLen >>> 2)[idx] = value;
      return;
    case 'u32':
    case 'enum':
    case 'ref':
    case 'entity':
      new Uint32Array(buf, offset, byteLen >>> 2)[idx] = value;
      return;
    case 'i16':
      new Int16Array(buf, offset, byteLen >>> 1)[idx] = value;
      return;
    case 'u16':
      new Uint16Array(buf, offset, byteLen >>> 1)[idx] = value;
      return;
    case 'i8':
      new Int8Array(buf, offset, byteLen)[idx] = value;
      return;
    case 'u8':
    case 'bool':
      new Uint8Array(buf, offset, byteLen)[idx] = value;
      return;
  }
}

/**
 * Reinterpret `bytes` as the typed view for `elementType` and read element
 * `idx`. Mirrors `writeArrayElementAt` -- consumed by `world.pop` to materialise
 * the tail value before the count is decremented.
 */
export function readArrayElementAt(
  bytes: Uint8Array,
  idx: number,
  elementType: ManagedArrayElementType,
): number {
  const buf = bytes.buffer;
  const offset = bytes.byteOffset;
  const byteLen = bytes.byteLength;
  // shared<X> template literals: column-stored as u32 handles, read as
  // Uint32Array. (feat-20260614 M5; replaces retired 'handle<X>' arm.)
  if (elementType.startsWith('shared<')) {
    return new Uint32Array(buf, offset, byteLen >>> 2)[idx] ?? 0;
  }
  switch (elementType) {
    case 'f32':
      return new Float32Array(buf, offset, byteLen >>> 2)[idx] ?? 0;
    case 'f64':
      return new Float64Array(buf, offset, byteLen >>> 3)[idx] ?? 0;
    case 'i32':
      return new Int32Array(buf, offset, byteLen >>> 2)[idx] ?? 0;
    case 'u32':
    case 'enum':
    case 'ref':
    case 'entity':
      return new Uint32Array(buf, offset, byteLen >>> 2)[idx] ?? 0;
    case 'i16':
      return new Int16Array(buf, offset, byteLen >>> 1)[idx] ?? 0;
    case 'u16':
      return new Uint16Array(buf, offset, byteLen >>> 1)[idx] ?? 0;
    case 'i8':
      return new Int8Array(buf, offset, byteLen)[idx] ?? 0;
    case 'u8':
    case 'bool':
      return new Uint8Array(buf, offset, byteLen)[idx] ?? 0;
  }
  return 0;
}
