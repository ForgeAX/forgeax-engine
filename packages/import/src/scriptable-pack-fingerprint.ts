import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Binary leaves are content-addressed. Tree hashing never concatenates geometry buffers. */
function encodeFingerprint(
  value: unknown,
  binary: (value: ArrayBufferView | ArrayBuffer) => string,
): string {
  const visit = (item: unknown): string => {
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return binary(item);
    if (Array.isArray(item)) return `[${item.map(visit).join(',')}]`;
    if (item !== null && typeof item === 'object') {
      const object = item as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit(object[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(item) ?? 'null';
  };
  return `scriptable-pack-fingerprint/3:${visit(value)}`;
}
function bytes(value: ArrayBufferView | ArrayBuffer): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (!(value.buffer instanceof ArrayBuffer))
    throw new TypeError('shared mutable fingerprint input');
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
function leaf(value: ArrayBufferView | ArrayBuffer, digest: string): string {
  return `\0${value instanceof ArrayBuffer ? 'ArrayBuffer' : value.constructor.name}:${value.byteLength}:${digest}\0`;
}

export function scriptablePackFingerprint(value: unknown): string {
  const encoded = encodeFingerprint(value, (array) =>
    leaf(array, bytesToHex(sha256(bytes(array)))),
  );
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(encoded)))}`;
}

/** One immutable candidate scope may reuse binary-leaf hashes; never cache caller-owned input. */
export function createScriptablePackFingerprinter(): (value: unknown) => Promise<string> {
  const buffers = new WeakMap<ArrayBuffer, Map<string, Promise<string>>>();
  const digest = async (value: Uint8Array<ArrayBuffer>): Promise<string> =>
    globalThis.crypto?.subtle
      ? bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
      : bytesToHex(sha256(value));
  return async (value) => {
    const leaves: Promise<string>[] = [];
    // Capture metadata and start every binary read before the first await.
    const encoded = encodeFingerprint(value, (array) => {
      const view = bytes(array);
      let offsets = buffers.get(view.buffer);
      if (!offsets) {
        offsets = new Map();
        buffers.set(view.buffer, offsets);
      }
      const key = `${view.byteOffset}:${view.byteLength}`;
      let pending = offsets.get(key);
      if (!pending) {
        pending = digest(view);
        offsets.set(key, pending);
      }
      const prefix = leaf(array, '');
      const id = leaves.length;
      leaves.push(pending.then((hash) => `${prefix.slice(0, -1)}${hash}\0`));
      return `\0leaf:${id}\0`;
    });
    const hashes = await Promise.all(leaves);
    const materialized = encoded.replace(/\0leaf:(\d+)\0/g, (_match, index: string) => {
      const leaf = hashes[Number(index)];
      if (leaf === undefined) throw new TypeError('missing binary fingerprint');
      return leaf;
    });
    return `sha256:${await digest(new TextEncoder().encode(materialized))}`;
  };
}

/** Unowned callers always get a fresh scope, so subsequent mutation changes the digest. */
export function scriptablePackFingerprintAsync(value: unknown): Promise<string> {
  return createScriptablePackFingerprinter()(value);
}
