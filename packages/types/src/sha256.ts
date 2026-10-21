import { sha256 as digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Deterministic synchronous SHA-256 for runtime contract identities. */
export function sha256(input: string): string {
  return bytesToHex(digest(new TextEncoder().encode(input)));
}
