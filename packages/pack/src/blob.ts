/** In-process bytes stay binary; JSON transport uses base64. */
export type PackBlob = Uint8Array<ArrayBuffer> | string | readonly number[];

// Node/Bun expose the native byte codec globally. Keep its optional capability
// structural so no Node module or polyfill enters the browser graph.
const hostBuffer = () =>
  (
    globalThis as typeof globalThis & {
      Buffer?: {
        from(
          bytes: ArrayBufferLike,
          offset: number,
          length: number,
        ): { toString(encoding: 'base64'): string };
        from(encoded: string, encoding: 'base64'): Uint8Array;
      };
    }
  ).Buffer;

export function encodePackBlob(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const buffer = hostBuffer();
  if (buffer)
    return buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

/** Validate without allocating a decoded buffer or enumerating properties per byte. */
export function validatePackBlob(value: unknown): asserts value is PackBlob {
  if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) return;
  if (typeof value === 'string') {
    const body = value.replace(/={1,2}$/, '');
    if (value.length % 4 || /[^A-Za-z0-9+/]/.test(body))
      throw new TypeError('expected canonical base64 bytes');
    // Unused bits must be zero, so each byte sequence has only one spelling.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const tail = alphabet.indexOf(body.at(-1) ?? 'A');
    if (
      (value.endsWith('==') && tail & 15) ||
      (value.endsWith('=') && !value.endsWith('==') && tail & 3)
    )
      throw new TypeError('expected canonical base64 padding');
    return;
  }
  if (!Array.isArray(value)) throw new TypeError('expected Pack binary content');
  for (let i = 0; i < value.length; i++) {
    const byte: unknown = value[i];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)
      throw new TypeError('expected byte values');
  }
}

export function decodePackBlob(value: PackBlob): Uint8Array<ArrayBuffer> {
  validatePackBlob(value);
  if (typeof value !== 'string') return new Uint8Array(value);
  const native = (
    Uint8Array as typeof Uint8Array & { fromBase64?: (value: string) => Uint8Array<ArrayBuffer> }
  ).fromBase64;
  if (native) return native(value);
  const buffer = hostBuffer();
  if (buffer) return new Uint8Array(buffer.from(value, 'base64'));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
