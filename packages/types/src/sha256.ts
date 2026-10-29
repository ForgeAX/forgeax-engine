import { sha256 as digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

interface NodeHash {
  update(input: string): NodeHash;
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

/** Deterministic synchronous SHA-256 for runtime contract identities. */
export function sha256(input: string): string {
  if (nodeCrypto !== undefined) return nodeCrypto.createHash('sha256').update(input).digest('hex');
  return bytesToHex(digest(new TextEncoder().encode(input)));
}
