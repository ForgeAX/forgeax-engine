// texel-decode.ts -- CPU decode of each uncompressed color format to RGBA8 for preview.
//
// The recorder promotes COPY_SRC onto every createTexture, so the replayer's
// copyTextureToBuffer reads back each uncompressed color texture's raw bytes
// faithfully (no format change -- replay fidelity intact). This module turns
// those raw bytes into displayable RGBA8 entirely on the host:
//
//   raw bytes --formatInfo--> per-channel values --[display map]--> RGBA8
//
// Display map (RenderDoc's default initial state, confirmed with the user):
//   float/ufloat -> clamp(v, 0, 1) * 255     (HDR highlights >1 saturate to white)
//   unorm        -> v * 255                   (already 0..1)
//   snorm        -> clamp(v, 0, 1) * 255      (negatives clip to black)
//   uint/sint    -> clamp(v, 0, 255)          (small integer ids stay visible)
//
// Channels -> RGBA: 1ch grayscale (R=G=B), 2ch (R,G,B=0), 3ch (RGB,A=255), 4ch.
//
// Related: plan "all-format color preview"; reuses formatInfo (rhi-debug texel-layout).

import { bytesPerTexel, type FormatInfo, formatInfo } from './texel-layout';

/** Decode a single IEEE half-float (16-bit) bit pattern to a JS number. */
export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  const s = sign === 0 ? 1 : -1;
  if (exp === 0) {
    // Subnormal (or zero): 2^-14 * (frac / 1024).
    return s * 2 ** -14 * (frac / 1024);
  }
  if (exp === 0x1f) {
    // Inf / NaN.
    return frac === 0 ? s * Number.POSITIVE_INFINITY : Number.NaN;
  }
  // Normal: 2^(exp-15) * (1 + frac/1024).
  return s * 2 ** (exp - 15) * (1 + frac / 1024);
}

/**
 * Decode an unsigned-int bit pattern of an 11- or 10-bit unsigned float
 * (rg11b10ufloat layout: no sign bit). 11-bit = 5 exp + 6 mantissa; 10-bit =
 * 5 exp + 5 mantissa. Bias 15, matching the f16 exponent.
 */
function smallUFloatToFloat(bits: number, mantissaBits: number): number {
  const expBits = 5;
  const exp = (bits >> mantissaBits) & ((1 << expBits) - 1);
  const mantMax = 1 << mantissaBits;
  const frac = bits & (mantMax - 1);
  if (exp === 0) return 2 ** -14 * (frac / mantMax);
  if (exp === 0x1f) return frac === 0 ? Number.POSITIVE_INFINITY : Number.NaN;
  return 2 ** (exp - 15) * (1 + frac / mantMax);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Map one decoded channel value to a 0..255 display byte by channel type. */
function toByte(v: number, channelType: FormatInfo['channelType']): number {
  // uint/sint: small integer ids stay visible (clamp 0..255, no normalize).
  if (channelType === 'uint' || channelType === 'sint') {
    return Math.round(v < 0 ? 0 : v > 255 ? 255 : v);
  }
  // float/ufloat clamp HDR to [0,1]; unorm already 0..1; snorm clips negatives.
  return Math.round(clamp01(v) * 255);
}

/**
 * Read the `channels` raw channel values of one texel at byte offset `off`.
 * Plain formats read each channel at a uniform per-channel byte width; packed
 * formats unpack the single 32-bit word by bit-field. Values are returned in the
 * format's native channel order (BGRA swizzle handled by the caller).
 */
function readTexel(
  view: DataView,
  off: number,
  info: FormatInfo,
  channelBytes: number,
): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 1];

  if (info.packed === 'rgb10a2unorm') {
    const word = view.getUint32(off, true);
    out[0] = (word & 0x3ff) / 1023;
    out[1] = ((word >> 10) & 0x3ff) / 1023;
    out[2] = ((word >> 20) & 0x3ff) / 1023;
    out[3] = ((word >> 30) & 0x3) / 3;
    return out;
  }
  if (info.packed === 'rgb9e5ufloat') {
    const word = view.getUint32(off, true);
    const scale = 2 ** ((word >>> 27) - 15 - 9);
    out[0] = (word & 0x1ff) * scale;
    out[1] = ((word >>> 9) & 0x1ff) * scale;
    out[2] = ((word >>> 18) & 0x1ff) * scale;
    return out;
  }
  if (info.packed === 'rg11b10ufloat') {
    const word = view.getUint32(off, true);
    out[0] = smallUFloatToFloat(word & 0x7ff, 6);
    out[1] = smallUFloatToFloat((word >> 11) & 0x7ff, 6);
    out[2] = smallUFloatToFloat((word >> 22) & 0x3ff, 5);
    out[3] = 1;
    return out;
  }

  for (let c = 0; c < info.channels; c++) {
    const co = off + c * channelBytes;
    let v: number;
    switch (info.channelType) {
      case 'float':
        v = channelBytes === 2 ? halfToFloat(view.getUint16(co, true)) : view.getFloat32(co, true);
        break;
      case 'unorm':
        v =
          channelBytes === 1
            ? view.getUint8(co) / 255
            : channelBytes === 2
              ? view.getUint16(co, true) / 65535
              : view.getUint32(co, true) / 4294967295;
        break;
      case 'snorm': {
        const raw =
          channelBytes === 1
            ? view.getInt8(co)
            : channelBytes === 2
              ? view.getInt16(co, true)
              : view.getInt32(co, true);
        const denom = channelBytes === 1 ? 127 : channelBytes === 2 ? 32767 : 2147483647;
        v = Math.max(-1, raw / denom);
        break;
      }
      case 'uint':
        v =
          channelBytes === 1
            ? view.getUint8(co)
            : channelBytes === 2
              ? view.getUint16(co, true)
              : view.getUint32(co, true);
        break;
      case 'sint':
        v =
          channelBytes === 1
            ? view.getInt8(co)
            : channelBytes === 2
              ? view.getInt16(co, true)
              : view.getInt32(co, true);
        break;
      default:
        v = 0;
    }
    out[c] = v;
  }
  return out;
}

/**
 * Decode tight raw GPU bytes of a supported color or depth/stencil plane into
 * RGBA8 the canvas can paint via putImageData. Returns null when the format has
 * no {@link formatInfo} entry or the requested aspect is invalid.
 *
 * @param bytes - Tight readback bytes (no row padding), length = w*h*bytesPerTexel.
 * @param format - The texture's real format string.
 * @param width - Texture width in pixels.
 * @param height - Texture height in pixels.
 * @param aspect - Explicit plane selected by readback for depth/stencil formats.
 */
export function decodeToRgba8(
  bytes: Uint8Array,
  format: string,
  width: number,
  height: number,
  aspect: 'all' | 'depth-only' | 'stencil-only' = 'all',
): Uint8ClampedArray<ArrayBuffer> | null {
  if (format.startsWith('depth')) {
    return decodeDepthToRgba8(bytes, format, width, height, aspect);
  }
  const info = formatInfo(format);
  const texBytes = bytesPerTexel(format as never);
  if (!info || texBytes === undefined) return null;

  // Per-channel byte width for plain formats (packed formats ignore this).
  const channelBytes = info.packed ? texBytes : texBytes / info.channels;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Explicit ArrayBuffer backing (not ArrayBufferLike) so ImageData accepts it.
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));

  for (let i = 0; i < width * height; i++) {
    const [c0, c1, c2, c3] = readTexel(view, i * texBytes, info, channelBytes);
    const di = i * 4;
    if (info.channels === 1) {
      const g = toByte(c0, info.channelType);
      out[di] = g;
      out[di + 1] = g;
      out[di + 2] = g;
      out[di + 3] = 255;
    } else if (info.channels === 2) {
      out[di] = toByte(c0, info.channelType);
      out[di + 1] = toByte(c1, info.channelType);
      out[di + 2] = 0;
      out[di + 3] = 255;
    } else {
      // 3 or 4 channels. BGRA stores blue-first -> swizzle B<->R.
      const r = info.bgra ? c2 : c0;
      const b = info.bgra ? c0 : c2;
      out[di] = toByte(r, info.channelType);
      out[di + 1] = toByte(c1, info.channelType);
      out[di + 2] = toByte(b, info.channelType);
      out[di + 3] = info.channels === 4 ? toByte(c3, info.channelType) : 255;
    }
  }
  return out;
}

function decodeDepthToRgba8(
  bytes: Uint8Array,
  format: string,
  width: number,
  height: number,
  aspect: 'all' | 'depth-only' | 'stencil-only',
): Uint8ClampedArray<ArrayBuffer> | null {
  const combined = format.endsWith('-stencil8');
  if (combined && aspect === 'all') return null;
  if (!combined && aspect === 'stencil-only') return null;
  const stencil = aspect === 'stencil-only';
  const bytesPerValue = stencil ? 1 : 4;
  const texelCount = width * height;
  if (bytes.byteLength < texelCount * bytesPerValue) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8ClampedArray(new ArrayBuffer(texelCount * 4));
  for (let index = 0; index < texelCount; index++) {
    const value = stencil
      ? view.getUint8(index)
      : Math.round(clamp01(view.getFloat32(index * 4, true)) * 255);
    const target = index * 4;
    out[target] = value;
    out[target + 1] = value;
    out[target + 2] = value;
    out[target + 3] = 255;
  }
  return out;
}

/**
 * Decode a single texel from tight raw GPU bytes into raw float RGBA values
 * without the display clamp (D-4: raw byte bypass for HDR fidelity).
 *
 * Unlike `decodeToRgba8` which clamps float/ufloat to [0,1] for display, this
 * returns the decoded per-channel values as-is: float formats keep true values
 * (2.5 stays 2.5, negative stays negative), unorm/snorm stay in their native
 * ranges, uint/sint stay as integers cast to number.
 *
 * Channels: 1ch grayscale (R=G=B, A=1), 2ch (RG, B=0, A=1), 3/4ch (RGBA or
 * BGRA→swizzled). Returns null when the format has no {@link formatInfo} entry.
 *
 * @param bytes - Tight readback bytes, length = width*height*bytesPerTexel.
 * @param format - The texture's real format string.
 * @param width - Texture width in pixels.
 * @param height - Texture height in pixels.
 * @param texelX - 0-based column of the target texel.
 * @param texelY - 0-based row of the target texel.
 */
export function decodeTexelRaw(
  bytes: Uint8Array,
  format: string,
  width: number,
  height: number,
  texelX: number,
  texelY: number,
): [number, number, number, number] | null {
  if (texelX < 0 || texelX >= width || texelY < 0 || texelY >= height) return null;
  const reader = rawTexelReader(format);
  if (reader === undefined) return null;
  const byteOffset = (texelY * width + texelX) * reader.bytesPerTexel;
  if (byteOffset + reader.bytesPerTexel > bytes.byteLength) return null;
  return reader.read(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), byteOffset);
}

/**
 * A per-texel raw RGBA reader for one format (same channel mapping as
 * {@link decodeTexelRaw}), resolved once so whole-image decodes skip the
 * per-texel format lookup. Returns undefined for formats without a host decode.
 */
export function rawTexelReader(format: string):
  | {
      readonly bytesPerTexel: number;
      read(view: DataView, byteOffset: number): [number, number, number, number];
    }
  | undefined {
  const info = formatInfo(format);
  const texBytes = bytesPerTexel(format as never);
  if (!info || texBytes === undefined) return undefined;
  const channelBytes = info.packed ? texBytes : texBytes / info.channels;
  return {
    bytesPerTexel: texBytes,
    read(view, byteOffset) {
      const c = readTexel(view, byteOffset, info, channelBytes);
      if (info.channels === 1) return [c[0], c[0], c[0], 1];
      if (info.channels === 2) return [c[0], c[1], 0, 1];
      const r = info.bgra ? c[2] : c[0];
      const b = info.bgra ? c[0] : c[2];
      return [r, c[1], b, info.channels === 4 ? c[3] : 1];
    },
  };
}
