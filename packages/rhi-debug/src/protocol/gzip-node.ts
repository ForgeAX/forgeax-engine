import zlib from 'node:zlib';

// Buffer.slice aliases storage. Preserve the portable codec's owned Uint8Array contract.
export function gzip(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(zlib.gzipSync(bytes));
}

// The container decoder owns the one complete decompressed-byte copy.
export function ungzip(bytes: Uint8Array): Uint8Array {
  return zlib.gunzipSync(bytes);
}
