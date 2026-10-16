/// <reference types="@webgpu/types" />
// @forgeax/engine-rhi-debug/texel-layout -- SSOT for how a texture's GPU
// bytes are laid out, shared by the snapshot readback (recorder) and the seed
// write-back (replayer) so both agree on byte layout without duplicating it in
// the tape (architecture-principles #1 SSOT / #2 Derive: format + size +
// mipLevelCount already live in the createTexture event; layout is derived, not
// re-stored in the initialData event).
//
// Why this exists: the original frame-header snapshot hardcoded bytesPerRow =
// width*4, depthOrArrayLayers = 1, mipLevel = 0 -- correct only for a single-mip
// single-layer 4-byte texture (rgba8). IBL resources break all three: the
// irradiance/prefilter cubemaps are rgba16float (8 B/texel), 6 array layers, and
// the prefilter map has a 5-mip roughness chain. Snapshotting them with the old
// assumptions either skipped them (-> replay renders unlit/black) or would have
// seeded corrupt bytes. This module computes the real per-subresource layout so a
// full snapshot + faithful seed round-trips each color format with a known texel
// block footprint, including block-compressed formats.

import {
  isCompressedFormat,
  type TextureFormatBlock,
  textureFormatBlock,
} from '@forgeax/engine-types';

/**
 * Bytes per texel for uncompressed color formats and depth32float. Block-compressed formats use
 * {@link textureBlockLayout} because their bytes are addressed by blocks.
 */
export function bytesPerTexel(format: GPUTextureFormat | undefined): number | undefined {
  if (format === undefined) return undefined;
  return TEXEL_BYTES[format];
}

// Uncompressed color formats and the copyable depth32float plane. Keyed to the W3C WebGPU GPUTextureFormat
// names. Other depth/stencil and block-compressed formats are absent.
const TEXEL_BYTES: Partial<Record<GPUTextureFormat, number>> = {
  // 8-bit channels
  r8unorm: 1,
  r8snorm: 1,
  r8uint: 1,
  r8sint: 1,
  rg8unorm: 2,
  rg8snorm: 2,
  rg8uint: 2,
  rg8sint: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  rgba8snorm: 4,
  rgba8uint: 4,
  rgba8sint: 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  // 16-bit channels
  r16uint: 2,
  r16sint: 2,
  r16float: 2,
  rg16uint: 4,
  rg16sint: 4,
  rg16float: 4,
  rgba16uint: 8,
  rgba16sint: 8,
  rgba16float: 8,
  // 32-bit channels
  r32uint: 4,
  r32sint: 4,
  r32float: 4,
  depth32float: 4,
  rg32uint: 8,
  rg32sint: 8,
  rg32float: 8,
  rgba32uint: 16,
  rgba32sint: 16,
  rgba32float: 16,
  // packed
  rgb10a2unorm: 4,
  rg11b10ufloat: 4,
  rgb9e5ufloat: 4,
};

/** Return the WebGPU texel-block footprint for each supported color format. */
export function textureBlockLayout(
  format: GPUTextureFormat | undefined,
): TextureFormatBlock | undefined {
  if (format === undefined) return undefined;
  if (isCompressedFormat(format)) return textureFormatBlock(format);
  const bytesPerBlock = TEXEL_BYTES[format];
  return bytesPerBlock === undefined ? undefined : { blockWidth: 1, blockHeight: 1, bytesPerBlock };
}

// ============================================================================
// formatInfo -- per-channel semantics for CPU-side decode (viewer preview)
// ============================================================================

/** How a channel's bits are interpreted (drives the host-side decode-to-RGBA8). */
export type ChannelType = 'unorm' | 'snorm' | 'uint' | 'sint' | 'float' | 'ufloat';

/**
 * Per-channel layout of an uncompressed color format, enough to decode its raw
 * GPU bytes into displayable RGBA8 on the host (no GPU). Sits beside
 * {@link bytesPerTexel} (which stays the SSOT for total texel size); the
 * per-channel byte width is derived as `bytesPerTexel / channels` for plain
 * formats, so no byte count is re-stored here. `packed` formats pack all
 * channels into a single 4-byte word (channels read by bit-field, not by a
 * uniform per-channel width).
 */
export interface FormatInfo {
  readonly channels: 1 | 2 | 3 | 4;
  readonly channelType: ChannelType;
  /** Channels stored blue-first in memory (swizzle B<->R when decoding). */
  readonly bgra?: boolean;
  /** Bit-packed layout (channels share one 32-bit word) needing special unpack. */
  readonly packed?: 'rgb10a2unorm' | 'rg11b10ufloat' | 'rgb9e5ufloat';
}

// Keyed to the same uncompressed color formats as TEXEL_BYTES. Depth/stencil and
// block-compressed formats are absent (return undefined -> caller falls back).
const FORMAT_INFO: Partial<Record<GPUTextureFormat, FormatInfo>> = {
  // 8-bit channels
  r8unorm: { channels: 1, channelType: 'unorm' },
  r8snorm: { channels: 1, channelType: 'snorm' },
  r8uint: { channels: 1, channelType: 'uint' },
  r8sint: { channels: 1, channelType: 'sint' },
  rg8unorm: { channels: 2, channelType: 'unorm' },
  rg8snorm: { channels: 2, channelType: 'snorm' },
  rg8uint: { channels: 2, channelType: 'uint' },
  rg8sint: { channels: 2, channelType: 'sint' },
  rgba8unorm: { channels: 4, channelType: 'unorm' },
  'rgba8unorm-srgb': { channels: 4, channelType: 'unorm' },
  rgba8snorm: { channels: 4, channelType: 'snorm' },
  rgba8uint: { channels: 4, channelType: 'uint' },
  rgba8sint: { channels: 4, channelType: 'sint' },
  bgra8unorm: { channels: 4, channelType: 'unorm', bgra: true },
  'bgra8unorm-srgb': { channels: 4, channelType: 'unorm', bgra: true },
  // 16-bit channels
  r16uint: { channels: 1, channelType: 'uint' },
  r16sint: { channels: 1, channelType: 'sint' },
  r16float: { channels: 1, channelType: 'float' },
  rg16uint: { channels: 2, channelType: 'uint' },
  rg16sint: { channels: 2, channelType: 'sint' },
  rg16float: { channels: 2, channelType: 'float' },
  rgba16uint: { channels: 4, channelType: 'uint' },
  rgba16sint: { channels: 4, channelType: 'sint' },
  rgba16float: { channels: 4, channelType: 'float' },
  // 32-bit channels
  r32uint: { channels: 1, channelType: 'uint' },
  r32sint: { channels: 1, channelType: 'sint' },
  r32float: { channels: 1, channelType: 'float' },
  rg32uint: { channels: 2, channelType: 'uint' },
  rg32sint: { channels: 2, channelType: 'sint' },
  rg32float: { channels: 2, channelType: 'float' },
  rgba32uint: { channels: 4, channelType: 'uint' },
  rgba32sint: { channels: 4, channelType: 'sint' },
  rgba32float: { channels: 4, channelType: 'float' },
  // packed (channels share one 32-bit word; decoded by bit-field)
  rgb10a2unorm: { channels: 4, channelType: 'unorm', packed: 'rgb10a2unorm' },
  rg11b10ufloat: { channels: 3, channelType: 'ufloat', packed: 'rg11b10ufloat' },
  rgb9e5ufloat: { channels: 3, channelType: 'ufloat', packed: 'rgb9e5ufloat' },
};

/**
 * Per-channel layout of an uncompressed color format for host-side decode.
 * Returns `undefined` for depth/stencil, block-compressed, or unknown formats
 * (the viewer's preview path treats `undefined` as "not directly previewable").
 */
export function formatInfo(format: GPUTextureFormat | string | undefined): FormatInfo | undefined {
  if (format === undefined) return undefined;
  return FORMAT_INFO[format as GPUTextureFormat];
}

/** One mip level of one array layer: its extent + where its tight bytes live in the blob. */
export interface SubresourceSlice {
  readonly layer: number;
  readonly mip: number;
  readonly width: number;
  readonly height: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

/** Full subresource layout of a texture snapshot blob. */
export interface TextureLayout {
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly bytesPerBlock: number;
  readonly layerCount: number;
  readonly mipLevelCount: number;
  readonly slices: readonly SubresourceSlice[];
  /** Total tight byte length across every subresource (the blob size). */
  readonly totalBytes: number;
}

export interface TextureExtent {
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
}

/** Project a serialized GPU texture extent onto the dimensions used by snapshots. */
export function projectTextureExtent(size: unknown): TextureExtent {
  if (typeof size === 'number') return { width: size, height: 1, layerCount: 1 };
  if (Array.isArray(size)) {
    const width = typeof size[0] === 'number' ? size[0] : 1;
    const height = typeof size[1] === 'number' ? size[1] : width;
    const layerCount = typeof size[2] === 'number' ? size[2] : 1;
    return { width, height, layerCount };
  }
  if (size !== null && typeof size === 'object') {
    const record = size as {
      readonly width?: unknown;
      readonly height?: unknown;
      readonly depthOrArrayLayers?: unknown;
    };
    const width = typeof record.width === 'number' ? record.width : 1;
    const height = typeof record.height === 'number' ? record.height : width;
    const layerCount =
      typeof record.depthOrArrayLayers === 'number' ? record.depthOrArrayLayers : 1;
    return { width, height, layerCount };
  }
  return { width: 1, height: 1, layerCount: 1 };
}

/**
 * Compute the canonical tight byte layout for a texture snapshot: every array
 * layer, every mip level, packed in layer-major then mip-minor order with no row
 * padding (tight bytesPerRow = blockCountX * bytesPerBlock). Mip dimensions halve
 * per level (floor, min 1), matching the WebGPU mip size rule.
 *
 * Returns `undefined` when the format has no known block footprint. The
 * recorder reads each slice into this exact offset; the replayer reads each
 * slice back out and writeTexture's it to (layer, mip).
 */
export function computeTextureLayout(
  format: GPUTextureFormat | undefined,
  width: number,
  height: number,
  layerCount: number,
  mipLevelCount: number,
): TextureLayout | undefined {
  const block = textureBlockLayout(format);
  if (block === undefined) return undefined;

  const layers = Math.max(1, layerCount);
  const mips = Math.max(1, mipLevelCount);
  const slices: SubresourceSlice[] = [];
  let offset = 0;
  for (let layer = 0; layer < layers; layer++) {
    for (let mip = 0; mip < mips; mip++) {
      const mw = Math.max(1, width >> mip);
      const mh = Math.max(1, height >> mip);
      const blockCountX = Math.ceil(mw / block.blockWidth);
      const blockCountY = Math.ceil(mh / block.blockHeight);
      const byteLength = blockCountX * blockCountY * block.bytesPerBlock;
      slices.push({ layer, mip, width: mw, height: mh, byteOffset: offset, byteLength });
      offset += byteLength;
    }
  }
  return {
    blockWidth: block.blockWidth,
    blockHeight: block.blockHeight,
    bytesPerBlock: block.bytesPerBlock,
    layerCount: layers,
    mipLevelCount: mips,
    slices,
    totalBytes: offset,
  };
}
