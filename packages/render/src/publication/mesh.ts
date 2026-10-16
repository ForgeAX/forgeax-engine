import type { MeshAsset } from '@forgeax/engine-types';

function sameMeshByteRange(
  left: ArrayBufferLike,
  leftOffset: number,
  right: ArrayBufferLike,
  rightOffset: number,
  length: number,
): boolean {
  if (length >= 32 && leftOffset % 4 === 0 && rightOffset % 4 === 0) {
    const words = Math.floor(length / 4);
    const first = new Uint32Array(left, leftOffset, words);
    const second = new Uint32Array(right, rightOffset, words);
    for (let index = 0; index < words; index++) if (first[index] !== second[index]) return false;
    const tail = words * 4;
    if (tail === length) return true;
    leftOffset += tail;
    rightOffset += tail;
    length -= tail;
  }
  const first = new Uint8Array(left, leftOffset, length);
  const second = new Uint8Array(right, rightOffset, length);
  for (let index = 0; index < length; index++) if (first[index] !== second[index]) return false;
  return true;
}

/** Shared source buffers must become receiver-owned bytes too. */
export function copyPublishedMesh(mesh: MeshAsset): MeshAsset {
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      const View = value.constructor as new (buffer: ArrayBuffer) => ArrayBufferView;
      return new View(bytes.buffer);
    }
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (Array.isArray(value)) return value.map(copy);
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, copy(field)]));
  };
  return copy(mesh) as MeshAsset;
}

/** Native message bytes are already receiver-owned; shared or non-POD data still needs a copy. */
export function ownReceivedPublishedMesh(mesh: MeshAsset): MeshAsset {
  const visiting = new WeakSet<object>();
  const owned = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return true;
    if (ArrayBuffer.isView(value)) return value.buffer instanceof ArrayBuffer;
    if (value instanceof ArrayBuffer) return true;
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype) return false;
    if (visiting.has(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
    const keys = Object.keys(value);
    if (Object.getOwnPropertyNames(value).length !== keys.length + (array ? 1 : 0)) return false;
    visiting.add(value);
    for (const key of keys) {
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return false;
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (field === undefined || !('value' in field) || !owned(field.value)) return false;
    }
    visiting.delete(value);
    return true;
  };
  return owned(mesh) ? mesh : copyPublishedMesh(mesh);
}

/** Compare a structured-cloned Mesh POD without replacing its resource identity. */
export function samePublishedMesh(left: MeshAsset, right: MeshAsset): boolean {
  const same = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
      if (
        !ArrayBuffer.isView(a) ||
        !ArrayBuffer.isView(b) ||
        a.constructor !== b.constructor ||
        a.byteLength !== b.byteLength
      )
        return false;
      return sameMeshByteRange(a.buffer, a.byteOffset, b.buffer, b.byteOffset, a.byteLength);
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof ArrayBuffer || b instanceof ArrayBuffer) {
      if (
        !(a instanceof ArrayBuffer) ||
        !(b instanceof ArrayBuffer) ||
        a.byteLength !== b.byteLength
      )
        return false;
      return sameMeshByteRange(a, 0, b, 0, a.byteLength);
    }
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      const left = (a as Record<string, unknown>)[key];
      const right = (b as Record<string, unknown>)[key];
      // Mesh number arrays contain many equal leaves. Do not recursively call
      // the structural comparator for each vertex/index or allocate a callback.
      if (!Object.is(left, right) && !same(left, right)) return false;
    }
    return true;
  };
  return same(left, right);
}
