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
  mipDimension,
  type TextureFormatBlock,
  textureFormatBlock,
} from '@forgeax/engine-types';

/**
 * Bytes per texel for uncompressed color formats and depth32float. Block-compressed formats use
 * {@link textureBlockLayout} because their bytes are addressed by blocks.
 */
export function bytesPerTexel(format: GPUTextureFormat | undefined): number | undefined {
  if (format === undefined || isCompressedFormat(format)) return undefined;
  return textureBlockLayout(format)?.bytesPerBlock;
}

/** Return the WebGPU texel-block footprint for each supported color format. */
export function textureBlockLayout(
  format: GPUTextureFormat | undefined,
): TextureFormatBlock | undefined {
  if (format === undefined) return undefined;
  if (isCompressedFormat(format) || format === 'depth32float' || formatInfo(format) !== undefined)
    return textureFormatBlock(format);
  return undefined;
}

// ============================================================================
// formatInfo -- per-channel semantics for CPU-side decode (viewer preview)
// ============================================================================

/** How a channel's bits are interpreted (drives the host-side decode-to-RGBA8). */
export type ChannelType = 'unorm' | 'snorm' | 'uint' | 'sint' | 'float' | 'ufloat';

/**
 * Per-channel layout of an uncompressed color format, enough to decode its raw
 * GPU bytes into displayable RGBA8 on the host (no GPU). Sits beside
 * {@link bytesPerTexel} (derived from the shared Types block footprint); the
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

// Supported CPU color decoders. Depth/stencil and
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
  if (format === undefined || !Object.hasOwn(FORMAT_INFO, format)) return undefined;
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

/** Decode a recorded extent with WebGPU defaults; malformed dimensions stay unavailable. */
export function projectTextureExtent(size: unknown): TextureExtent | undefined {
  const fields =
    typeof size === 'number'
      ? [size]
      : Array.isArray(size)
        ? size
        : size !== null && typeof size === 'object'
          ? [
              (size as GPUExtent3DDict).width,
              (size as GPUExtent3DDict).height,
              (size as GPUExtent3DDict).depthOrArrayLayers,
            ]
          : [];
  const [width, height = 1, layerCount = 1] = fields;
  if (
    typeof width !== 'number' ||
    !Number.isInteger(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isInteger(height) ||
    height <= 0 ||
    typeof layerCount !== 'number' ||
    !Number.isInteger(layerCount) ||
    layerCount <= 0
  )
    return undefined;
  return { width, height, layerCount };
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
      const mw = mipDimension(width, mip);
      const mh = mipDimension(height, mip);
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
