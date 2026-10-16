// Host-side image views over replay readbacks: a texture subresource or a
// storage-buffer region (probe irradiance, card atlases, SDF slices) decodes to
// one float RGBA image, from which atlas tiles, statistics and PNG previews
// derive. Values stay raw until `toRgba8`, so HDR and integer ids survive.

import { err, ok, type Result } from '@forgeax/engine-types';
import pako from 'pako';
import { createRhiDebugError, type RhiDebugError } from './errors';
import type { ReplayReadbackResult } from './replay/readback';
import { rawTexelReader } from './texel-decode';

/** Raw decoded RGBA texels, row-major from the top-left texel. */
export interface FloatImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/**
 * How texels sit in a byte range. Textures default to their own format and
 * extent; buffers must name all three. `bytesPerRow` defaults to tight rows.
 */
export interface ImageLayout {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly offset?: number;
  readonly bytesPerRow?: number;
}

/**
 * One tile of a row-major atlas, e.g. one octahedral probe. `border` texels
 * are cropped from every side; `columns` defaults to how many tiles fit a row.
 */
export interface AtlasTile {
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly index: number;
  readonly border?: number;
  readonly columns?: number;
}

export interface ImageStats {
  readonly min: readonly [number, number, number, number];
  readonly max: readonly [number, number, number, number];
  readonly mean: readonly [number, number, number, number];
  /** Texels with at least one NaN or infinite channel; excluded from min/max/mean. */
  readonly nonFinite: number;
}

/**
 * Display mapping: `exposure` scales RGB (default 1), then `range` remaps
 * linearly to 0..1 (default [0, 1]; 'auto' spans the finite exposed RGB
 * min..max), then `tonemap` 'reinhard' compresses HDR or 'clamp' (default)
 * saturates. Alpha is clamped without exposure.
 */
export interface DisplayOptions {
  readonly exposure?: number;
  readonly range?: readonly [number, number] | 'auto';
  readonly tonemap?: 'clamp' | 'reinhard';
}

/**
 * The camera that wrote a depth plane. Perspective depth maps to view-space
 * distance (`far` may be Infinity); orthographic depth, as in directional
 * shadow maps, is already linear and maps to near..far.
 */
export interface DepthProjection {
  readonly near: number;
  readonly far: number;
  readonly reverseZ?: boolean;
  readonly orthographic?: boolean;
}

const MAX_TEXELS = 16 * 1024 * 1024;

export function decodeImage(
  bytes: Uint8Array,
  layout: ImageLayout,
): Result<FloatImage, RhiDebugError> {
  const reader = rawTexelReader(layout.format);
  if (reader === undefined)
    return failure(`format ${layout.format} has no host texel decode; use buffer records instead`);
  const { width, height } = layout;
  const offset = layout.offset ?? 0;
  const bytesPerRow = layout.bytesPerRow ?? width * reader.bytesPerTexel;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_TEXELS ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(bytesPerRow) ||
    bytesPerRow < width * reader.bytesPerTexel
  )
    return failure('expected a positive image extent of at most 16M texels and rows that fit it');
  const end = offset + (height - 1) * bytesPerRow + width * reader.bytesPerTexel;
  if (end > bytes.byteLength)
    return failure(`image needs ${end} bytes but the readback holds ${bytes.byteLength}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const texel = reader.read(view, offset + y * bytesPerRow + x * reader.bytesPerTexel);
      data.set(texel, (y * width + x) * 4);
    }
  }
  return ok({ width, height, data });
}

/** Decode a readback; textures use their recorded format and extent unless overridden. */
export function readbackImage(
  read: ReplayReadbackResult,
  layout?: Partial<ImageLayout>,
): Result<FloatImage, RhiDebugError> {
  const subresource = read.provenance.subresource;
  const stencil =
    subresource !== null && 'aspect' in subresource && subresource.aspect === 'stencil-only';
  const format = layout?.format ?? (stencil ? 'r8uint' : depthPlaneFormat(read.format));
  const width = layout?.width ?? read.width;
  const height = layout?.height ?? read.height;
  if (format === undefined || width === undefined || height === undefined)
    return failure('a buffer image needs an explicit format, width and height');
  return decodeImage(read.bytes, { ...layout, format, width, height });
}

export function extractTile(image: FloatImage, tile: AtlasTile): Result<FloatImage, RhiDebugError> {
  const border = tile.border ?? 0;
  const columns = tile.columns ?? Math.floor(image.width / tile.tileWidth);
  const width = tile.tileWidth - 2 * border;
  const height = tile.tileHeight - 2 * border;
  if (
    ![tile.tileWidth, tile.tileHeight, tile.index, border, columns].every(Number.isInteger) ||
    tile.index < 0 ||
    border < 0 ||
    columns < 1 ||
    width < 1 ||
    height < 1
  )
    return failure('expected integer tile extents larger than twice the border');
  const x0 = (tile.index % columns) * tile.tileWidth + border;
  const y0 = Math.floor(tile.index / columns) * tile.tileHeight + border;
  if (x0 + width > image.width || y0 + height > image.height)
    return failure(`tile ${tile.index} lies outside the ${image.width}x${image.height} atlas`);
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((y0 + y) * image.width + x0) * 4;
    data.set(image.data.subarray(start, start + width * 4), y * width * 4);
  }
  return ok({ width, height, data });
}

export function imageStats(image: FloatImage): ImageStats {
  const min = new Float64Array(4).fill(Infinity);
  const max = new Float64Array(4).fill(-Infinity);
  const sum = new Float64Array(4);
  let finite = 0;
  let nonFinite = 0;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const texel = data.subarray(i, i + 4);
    if (!texel.every(Number.isFinite)) {
      nonFinite++;
      continue;
    }
    finite++;
    for (let c = 0; c < 4; c++) {
      const value = texel[c] as number;
      min[c] = Math.min(min[c] as number, value);
      max[c] = Math.max(max[c] as number, value);
      sum[c] = (sum[c] as number) + value;
    }
  }
  const settle = (values: Float64Array) =>
    Array.from(values, (value) => (finite === 0 ? 0 : value)) as [number, number, number, number];
  return {
    min: settle(min),
    max: settle(max),
    mean: settle(sum.map((value) => value / Math.max(finite, 1))),
    nonFinite,
  };
}

/**
 * A depth readback as a grey image: the raw [0,1] depth, or with `projection`
 * the linear view distance, broadcast to RGB with alpha 1.
 */
export function depthImage(image: FloatImage, projection?: DepthProjection): FloatImage {
  const data = new Float32Array(image.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const depth = image.data[i] as number;
    const value = projection === undefined ? depth : linearDepth(depth, projection);
    data.fill(value, i, i + 3);
    data[i + 3] = 1;
  }
  return { width: image.width, height: image.height, data };
}

function linearDepth(depth: number, { near, far, reverseZ, orthographic }: DepthProjection) {
  const d = reverseZ === true ? 1 - depth : depth;
  if (orthographic === true) return near + d * (far - near);
  if (far === Infinity) return near / (1 - d);
  return (near * far) / (far - d * (far - near));
}

export function toRgba8(image: FloatImage, options: DisplayOptions = {}): Uint8Array {
  const exposure = options.exposure ?? 1;
  const [low, high] =
    options.range === 'auto' ? autoRange(image, exposure) : (options.range ?? [0, 1]);
  const span = high - low || 1;
  const reinhard = options.tonemap === 'reinhard';
  const out = new Uint8Array(image.width * image.height * 4);
  const { data } = image;
  for (let i = 0; i < data.length; i++) {
    const alpha = i % 4 === 3;
    let value = data[i] as number;
    if (!alpha) {
      value = ((value * exposure - low) / span) as number;
      if (reinhard && value > 0) value = value / (1 + value);
    }
    out[i] = Number.isNaN(value) ? 0 : Math.round((value < 0 ? 0 : value > 1 ? 1 : value) * 255);
  }
  return out;
}

function autoRange(image: FloatImage, exposure: number): [number, number] {
  const { min, max } = imageStats(image);
  const low = Math.min(min[0], min[1], min[2]) * exposure;
  const high = Math.max(max[0], max[1], max[2]) * exposure;
  return low <= high ? [low, high] : [0, 1];
}

/** Deterministic RGBA8 PNG (filter 0, zlib level 6); no browser canvas required. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const chunks = [
    pngChunk('IHDR', header),
    pngChunk('IDAT', pako.deflate(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array()),
  ];
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(8 + chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  out.set(signature);
  let cursor = 8;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(body.byteLength + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.byteLength);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(body, 8);
  view.setUint32(8 + body.byteLength, crc32(chunk.subarray(4, 8 + body.byteLength)));
  return chunk;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Depth readbacks are f32 planes and stencil readbacks u8 planes, whatever the texture format. */
function depthPlaneFormat(format: string | undefined): string | undefined {
  if (format === 'stencil8') return 'r8uint';
  return format?.startsWith('depth') ? 'r32float' : format;
}

function failure(cause: string): Result<never, RhiDebugError> {
  return err(createRhiDebugError('readback-failed', { stage: 'readback', cause }));
}
