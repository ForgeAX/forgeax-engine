import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Yields so bounded capture cancellation can run during large seeds in any host. */
export async function digestBytesAsync(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (globalThis.crypto?.subtle !== undefined) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${bytesToHex(new Uint8Array(hash))}`;
  }
  const hash = sha256.create();
  const chunkBytes = 1024 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    if (offset > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    hash.update(bytes.subarray(offset, offset + chunkBytes));
  }
  return `sha256:${bytesToHex(hash.digest())}`;
}
