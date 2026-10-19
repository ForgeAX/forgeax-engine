import type { TextureAsset } from '@forgeax/engine-types';
import { fnv1a32 } from '@forgeax/engine-types';
import { compareSkinGeometryBytes } from './skin-geometry-bytes';

const MAX_BYTES = 1_048_576;
const MAX_ENTRIES = 4;
const entries = new Map<TextureAsset, { readonly bytes: Uint8Array; readonly digest: string }>();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const offsetOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const lengthOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const iterator = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.iterator)?.value;

function ordinaryBytes(data: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  // Reject Proxy/lookalike iterables without invoking their prototype traps.
  if (!ArrayBuffer.isView(data)) return undefined;
  try {
    // Custom iterators retain the original hash loop and its observable reads.
    if (
      Object.getPrototypeOf(data) !== Uint8Array.prototype ||
      Object.getOwnPropertyDescriptor(data, Symbol.iterator) !== undefined ||
      Object.getOwnPropertyDescriptor(Uint8Array.prototype, Symbol.iterator) !== undefined ||
      Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.iterator)?.value !== iterator
    )
      return undefined;
    const buffer = bufferOf?.call(data);
    const byteLength = lengthOf?.call(data) as number;
    if (!(buffer instanceof ArrayBuffer) || byteLength < 4096 || byteLength > MAX_BYTES)
      return undefined;
    return new Uint8Array(buffer, offsetOf?.call(data) as number, byteLength);
  } catch {
    // Typed-array lookalikes do not acquire a cache or new iteration semantics.
    return undefined;
  }
}

function equal(first: Uint8Array<ArrayBuffer>, second: Uint8Array): boolean {
  if (first.byteLength !== second.byteLength) return false;
  const compared = compareSkinGeometryBytes(
    first.buffer,
    first.byteOffset,
    second.buffer as ArrayBuffer,
    second.byteOffset,
    first.byteLength,
  );
  if (compared !== undefined) return compared;
  for (let index = 0; index < first.byteLength; index++)
    if (first[index] !== second[index]) return false;
  return true;
}

/** Exact live-byte FNV-1a identity; at most four bounded owned comparisons. */
export function textureDigest(texture: TextureAsset): string {
  const data = texture.data;
  const bytes = ordinaryBytes(data);
  const previous = bytes === undefined ? undefined : entries.get(texture);
  if (bytes !== undefined && previous !== undefined && equal(bytes, previous.bytes))
    return previous.digest;
  const hash = fnv1a32(data);
  const digest = `fnv1a:${hash.toString(16).padStart(8, '0')}`;
  if (bytes !== undefined) {
    if (!entries.has(texture) && entries.size === MAX_ENTRIES)
      entries.delete(entries.keys().next().value as TextureAsset);
    entries.set(texture, { bytes: new Uint8Array(bytes), digest });
  } else entries.delete(texture);
  return digest;
}
