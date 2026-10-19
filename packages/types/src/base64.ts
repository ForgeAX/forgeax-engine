/** Encode the selected byte view as canonical RFC 4648 Base64, without DOM dependencies. */
export function encodeBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const buffer = (
    globalThis as typeof globalThis & {
      Buffer?: {
        from(
          bytes: ArrayBufferLike,
          offset: number,
          length: number,
        ): {
          toString(encoding: 'base64'): string;
        };
      };
    }
  ).Buffer;
  if (buffer)
    return buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks: string[] = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const word =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    chunk +=
      alphabet.charAt((word >>> 18) & 63) +
      alphabet.charAt((word >>> 12) & 63) +
      (index + 1 < bytes.length ? alphabet.charAt((word >>> 6) & 63) : '=') +
      (index + 2 < bytes.length ? alphabet.charAt(word & 63) : '=');
    if (chunk.length >= 8192) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  chunks.push(chunk);
  return chunks.join('');
}
