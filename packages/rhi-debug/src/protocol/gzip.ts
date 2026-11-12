import pako from 'pako';

export function gzip(bytes: Uint8Array): Uint8Array {
  return pako.gzip(bytes);
}

export function ungzip(bytes: Uint8Array): Uint8Array {
  return pako.ungzip(bytes);
}
