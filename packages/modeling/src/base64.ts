/** Base64 of FXEM snapshots in JSON transports (cook sources, transfer normals). */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes per encoded chunk: a multiple of 3, and 4/3 of it stays under the argument limit of String.fromCharCode. */
const BASE64_CHUNK = 3 * 8192;
const PAD = '='.charCodeAt(0);

/**
 * Encodes in chunks joined once: appending one character at a time builds a rope of one
 * V8 cons-string node per character, about 32 bytes each, so a 10 MB snapshot would hold
 * hundreds of MB until the string is flattened (the Pack Worker heap is 256 MB).
 */
export function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const codes = new Array<number>((BASE64_CHUNK / 3) * 4);
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    const end = Math.min(bytes.length, start + BASE64_CHUNK);
    let c = 0;
    for (let i = start; i < end; i += 3) {
      const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      codes[c++] = ALPHABET.charCodeAt((n >> 18) & 63);
      codes[c++] = ALPHABET.charCodeAt((n >> 12) & 63);
      codes[c++] = i + 1 < bytes.length ? ALPHABET.charCodeAt((n >> 6) & 63) : PAD;
      codes[c++] = i + 2 < bytes.length ? ALPHABET.charCodeAt(n & 63) : PAD;
    }
    chunks.push(String.fromCharCode(...codes.slice(0, c)));
  }
  return chunks.join('');
}

export function fromBase64(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0) return undefined;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const ch = text[i + k] as string;
      const v = ch === '=' ? 0 : ALPHABET.indexOf(ch);
      if (v < 0) return undefined;
      n = (n << 6) | v;
    }
    for (const shift of [16, 8, 0]) if (o < out.length) out[o++] = (n >> shift) & 255;
  }
  return out;
}
