import { sha1 } from '@noble/hashes/legacy.js';

/** Internal UUIDv5 kernel; each caller owns its namespace and name validation. */
export function uuidV5(namespace: Uint8Array, name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespace.byteLength + nameBytes.byteLength);
  input.set(namespace, 0);
  input.set(nameBytes, namespace.byteLength);
  const result = sha1(input).slice(0, 16);
  // RFC 4122: UUID version 5, RFC variant.
  result[6] = ((result[6] ?? 0) & 0x0f) | 0x50;
  result[8] = ((result[8] ?? 0) & 0x3f) | 0x80;
  return result;
}
