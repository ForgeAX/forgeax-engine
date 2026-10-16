import { deriveTextureLayout, isCompressedFormat, type TextureAsset } from '@forgeax/engine-types';
import {
  COOKIE_MIP_LEVEL_COUNT,
  COOKIE_SLICE_MIP_CHAIN_BYTES,
  COOKIE_SLICE_SIZE,
} from './resources';

/**
 * The fixed GPU representation consumed by the extended-lighting Cookie
 * array. The matrix is deliberately keyed by Cookie slice rather than by
 * light: it carries only the source texture aspect correction. The shader
 * still owns the light-local basis, roll, and outer-cone projection, so one
 * Cookie can be shared by Spots with different directions or cone angles.
 */
/**
 * How a light-texture slice is filled. `mip-chain` is the CPU-prepared linear
 * RGBA8 chain (level 0 at 256x256 first, down to 1x1); `gpu-resample` names a
 * block-compressed source the renderer decodes and resamples on the GPU into
 * the same chain, since block formats have no CPU decoder.
 */
export type LightTextureSource =
  | { readonly kind: 'mip-chain'; readonly data: Uint8Array }
  | { readonly kind: 'gpu-resample'; readonly asset: TextureAsset };

export interface CookieProjection {
  readonly source: LightTextureSource;
  readonly matrix: Float32Array;
  readonly aspect: number;
}

const COOKIE_PROJECTION_CACHE = new WeakMap<TextureAsset, CookieProjection | null>();

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function halfToFloat(bits: number): number {
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * One source texel encoding: bytes per texel, the colour space its format
 * requires, and a reader that writes linear RGBA for texel `index`.
 */
interface SourceDecoder {
  readonly bytesPerTexel: number;
  readonly colorSpace: TextureAsset['colorSpace'];
  read(bytes: Uint8Array, view: DataView, index: number, out: Float32Array, at: number): void;
}

function unorm8Decoder(srgb: boolean, bgra: boolean): SourceDecoder {
  const toLinear = (value: number) => (srgb ? srgbToLinear(value / 255) : value / 255);
  return {
    bytesPerTexel: 4,
    colorSpace: srgb ? 'srgb' : 'linear',
    read(bytes, _view, index, out, at) {
      const base = index * 4;
      out[at] = toLinear(bytes[base + (bgra ? 2 : 0)] ?? 0);
      out[at + 1] = toLinear(bytes[base + 1] ?? 0);
      out[at + 2] = toLinear(bytes[base + (bgra ? 0 : 2)] ?? 0);
      out[at + 3] = (bytes[base + 3] ?? 0) / 255;
    },
  };
}

function floatDecoder(bytesPerChannel: 2 | 4): SourceDecoder {
  return {
    bytesPerTexel: bytesPerChannel * 4,
    colorSpace: 'linear',
    read(_bytes, view, index, out, at) {
      for (let channel = 0; channel < 4; channel += 1) {
        const offset = (index * 4 + channel) * bytesPerChannel;
        const value =
          bytesPerChannel === 2
            ? halfToFloat(view.getUint16(offset, true))
            : view.getFloat32(offset, true);
        // The slice is RGBA8: HDR sources keep their shape below 1 and clip
        // above it, so `intensity` stays the light's absolute scale.
        out[at + channel] = Number.isFinite(value) ? clamp01(value) : 0;
      }
    },
  };
}

const R8_DECODER: SourceDecoder = {
  bytesPerTexel: 1,
  colorSpace: 'linear',
  read(bytes, _view, index, out, at) {
    const value = (bytes[index] ?? 0) / 255;
    out[at] = value;
    out[at + 1] = value;
    out[at + 2] = value;
    out[at + 3] = 1;
  },
};

function sourceDecoder(format: GPUTextureFormat): SourceDecoder | undefined {
  switch (format) {
    case 'rgba8unorm':
      return unorm8Decoder(false, false);
    case 'rgba8unorm-srgb':
      return unorm8Decoder(true, false);
    case 'bgra8unorm':
      return unorm8Decoder(false, true);
    case 'bgra8unorm-srgb':
      return unorm8Decoder(true, true);
    case 'r8unorm':
      return R8_DECODER;
    case 'rgba16float':
      return floatDecoder(2);
    case 'rgba32float':
      return floatDecoder(4);
    default:
      return undefined;
  }
}

/** Decode mip level 0 (the first bytes of a packed chain) to linear RGBA. */
function decodeSource(asset: TextureAsset, decoder: SourceDecoder): Float32Array {
  const { width, height } = asset.shape.extent;
  const linear = new Float32Array(width * height * 4);
  const view = new DataView(asset.data.buffer, asset.data.byteOffset, asset.data.byteLength);
  for (let index = 0; index < width * height; index += 1) {
    decoder.read(asset.data, view, index, linear, index * 4);
  }
  return linear;
}

/**
 * Resample one axis of an RGBA float image to COOKIE_SLICE_SIZE. Upsampling
 * keeps the corner-aligned bilinear lookup; downsampling integrates the
 * covered source span so large RectAreaLight images do not alias into the
 * fixed slice.
 */
function resampleAxis(
  source: Float32Array,
  sourceLength: number,
  lineCount: number,
  horizontal: boolean,
): Float32Array {
  const target = new Float32Array(COOKIE_SLICE_SIZE * lineCount * 4);
  const read = (line: number, index: number, channel: number): number =>
    source[(horizontal ? line * sourceLength + index : index * lineCount + line) * 4 + channel] ??
    0;
  const write = (line: number, index: number, channel: number, value: number): void => {
    target[
      (horizontal ? line * COOKIE_SLICE_SIZE + index : index * lineCount + line) * 4 + channel
    ] = value;
  };
  const scale = sourceLength / COOKIE_SLICE_SIZE;
  for (let line = 0; line < lineCount; line += 1) {
    for (let index = 0; index < COOKIE_SLICE_SIZE; index += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        if (scale < 1) {
          const position = clamp01((index + 0.5) / COOKIE_SLICE_SIZE) * (sourceLength - 1);
          const i0 = Math.floor(position);
          const i1 = Math.min(sourceLength - 1, i0 + 1);
          const t = position - i0;
          write(
            line,
            index,
            channel,
            read(line, i0, channel) * (1 - t) + read(line, i1, channel) * t,
          );
          continue;
        }
        const begin = index * scale;
        const end = begin + scale;
        let sum = 0;
        for (let texel = Math.floor(begin); texel < Math.ceil(end); texel += 1) {
          const coverage = Math.min(end, texel + 1) - Math.max(begin, texel);
          sum += read(line, texel, channel) * coverage;
        }
        write(line, index, channel, sum / scale);
      }
    }
  }
  return target;
}

function buildMipChain(level0: Float32Array): Uint8Array {
  const data = new Uint8Array(COOKIE_SLICE_MIP_CHAIN_BYTES);
  let current = level0;
  let size = COOKIE_SLICE_SIZE;
  let offset = 0;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    for (let index = 0; index < size * size * 4; index += 1) {
      data[offset + index] = Math.round(clamp01(current[index] ?? 0) * 255);
    }
    offset += size * size * 4;
    if (size === 1) break;
    const next = size >> 1;
    const reduced = new Float32Array(next * next * 4);
    for (let y = 0; y < next; y += 1) {
      for (let x = 0; x < next; x += 1) {
        for (let channel = 0; channel < 4; channel += 1) {
          const at = (sx: number, sy: number): number =>
            current[(sy * size + sx) * 4 + channel] ?? 0;
          reduced[(y * next + x) * 4 + channel] =
            (at(2 * x, 2 * y) +
              at(2 * x + 1, 2 * y) +
              at(2 * x, 2 * y + 1) +
              at(2 * x + 1, 2 * y + 1)) *
            0.25;
        }
      }
    }
    current = reduced;
    size = next;
  }
  return data;
}

/**
 * Project a 2D Cookie or RectAreaLight source texture into the renderer's
 * fixed linear 256x256 mipmapped array slice. Uncompressed RGBA8 and BGRA8 in
 * either colour space, R8 grayscale, RGBA16F and RGBA32F (clipped to [0, 1])
 * are decoded here, any size, with only level 0 of a packed chain read. GPU
 * block formats (BC/ETC2/ASTC) are handed to the renderer's GPU resample,
 * which applies the same filter. This is a producer-boundary operation cached
 * by the immutable TextureAsset object, so the frame path never decodes or
 * resamples the source repeatedly.
 */
export function prepareCookieProjection(asset: TextureAsset): CookieProjection | undefined {
  if (COOKIE_PROJECTION_CACHE.has(asset)) {
    return COOKIE_PROJECTION_CACHE.get(asset) ?? undefined;
  }
  const decoder = sourceDecoder(asset.format);
  const { width, height } = asset.shape.extent;
  const valid =
    decoder !== undefined &&
    asset.shape.viewDimension === '2d' &&
    asset.colorSpace === decoder.colorSpace &&
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    asset.data.byteLength >= width * height * decoder.bytesPerTexel;
  const compressed =
    decoder === undefined &&
    isCompressedFormat(asset.format) &&
    asset.shape.viewDimension === '2d' &&
    asset.mips.kind !== 'generate' &&
    asset.colorSpace === (asset.format.endsWith('-srgb') ? 'srgb' : 'linear') &&
    deriveTextureLayout({
      shape: asset.shape,
      format: asset.format,
      mips: asset.mips,
      actualByteLength: asset.data.byteLength,
    }).ok;
  if (!valid && !compressed) {
    COOKIE_PROJECTION_CACHE.set(asset, null);
    return undefined;
  }

  // Linear box-filtered mips are averaged from the float level 0 so each
  // level stays the true footprint mean; alpha is preserved for Cookie
  // semantics and ignored by RectAreaLight source textures.
  const source: LightTextureSource =
    decoder === undefined
      ? { kind: 'gpu-resample', asset }
      : {
          kind: 'mip-chain',
          data: buildMipChain(
            resampleAxis(
              resampleAxis(decodeSource(asset, decoder), width, height, true),
              height,
              COOKIE_SLICE_SIZE,
              false,
            ),
          ),
        };

  // Column-major mat4. The shader multiplies the unprojected local
  // (x/depth, y/depth) pair by this aspect-only matrix, then applies the
  // Spot's outer-cone tangent and the [0,1] translation. Keeping outerCone
  // out of this slice-keyed matrix allows one Cookie to be shared by lights.
  const matrix = new Float32Array(16);
  matrix[0] = asset.shape.extent.height / asset.shape.extent.width;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  const projection = {
    source,
    matrix,
    aspect: asset.shape.extent.width / asset.shape.extent.height,
  };
  COOKIE_PROJECTION_CACHE.set(asset, projection);
  return projection;
}

/** Create the deterministic identity payload used for unused Cookie slices. */
export function createCookieProjectionMatrixData(count: number): Float32Array {
  const data = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    const base = index * 16;
    data[base] = 1;
    data[base + 5] = 1;
    data[base + 10] = 1;
    data[base + 15] = 1;
  }
  return data;
}
