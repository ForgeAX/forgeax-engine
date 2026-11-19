import { sha256 as digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

interface NodeHash {
  update(input: string | Uint8Array): NodeHash;
  digest(encoding: 'hex'): string;
}

// Match the RHI Debug codec's optional native path without a Node-only import
// in browser/Worker bundles. Older Node carriers retain the portable digest.
const nodeCrypto = (
  globalThis as {
    readonly process?: { readonly getBuiltinModule?: (id: string) => unknown };
  }
).process?.getBuiltinModule?.('node:crypto') as
  | { createHash(algorithm: 'sha256'): NodeHash }
  | undefined;

/**
 * Deterministic synchronous SHA-256 hex for runtime contract identities. Text
 * hashes its UTF-8 encoding, so `sha256(text)` equals `sha256(utf8Bytes(text))`.
 */
export function sha256(input: string | Uint8Array | Iterable<string | Uint8Array>): string {
  if (typeof input === 'string' || ArrayBuffer.isView(input)) {
    if (nodeCrypto !== undefined)
      return nodeCrypto.createHash('sha256').update(input).digest('hex');
    return bytesToHex(digest(typeof input === 'string' ? new TextEncoder().encode(input) : input));
  }
  // Canonical publication producers stream chunks rather than joining a body
  // that may exceed the JavaScript string limit. Original byte identities stay intact.
  if (nodeCrypto !== undefined) {
    const hash = nodeCrypto.createHash('sha256');
    for (const chunk of input) hash.update(chunk);
    return hash.digest('hex');
  }
  const hash = digest.create();
  const encoder = new TextEncoder();
  for (const chunk of input) hash.update(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  return bytesToHex(hash.digest());
}

/** Deterministic synchronous SHA-256 for raw runtime readback bytes. */
export function sha256Bytes(input: Uint8Array): string {
  if (nodeCrypto !== undefined) return nodeCrypto.createHash('sha256').update(input).digest('hex');
  return bytesToHex(digest(input));
}
