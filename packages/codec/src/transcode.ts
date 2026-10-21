/**
 * Transcode target selection (D-4 priority chain, browser+node dual-safe).
 *
 * `selectTranscodeTarget` is a pure function: given the source Basis encoding
 * descriptor (DFD-derived) and the device's compression capabilities, it returns
 * the `GPUTextureFormat` to transcode into. It performs zero I/O and imports no
 * node-only or DOM API -- an AI user can call it in node to predict, offline,
 * which format a given caps combination will hit.
 *
 * Priority chains (requirements §range table + D-4 Mesa guard):
 *   RGBA : ASTC-4x4 -> BC7 -> ETC2-rgba8 -> RGBA8
 *   RG   : BC5 -> EAC-rg11 -> RG8
 *   R    : BC4 -> EAC-r11 -> R8
 *   HDR  : BC6H -> rgba16float
 *
 * D-4 "BC present => prefer BC": when `bc` is available alongside `astc`/`etc2`,
 * every LDR arm selects the BC target first. Rationale: bc coexisting with
 * astc/etc2 means either Apple Silicon (dual hardware; BC7 is lossless-equal at
 * 8bpp) or a desktop driver software-decoding ETC2/ASTC (the Mesa/ANV trap to
 * avoid). Preferring BC is correct in both cases, so the rule needs no source
 * discrimination. Because `bc` is tested first in each arm, this fall-through is
 * inherent -- no extra branch.
 *
 * Fallback is a format, never an error: with no compression cap the LDR arms
 * return `rgba8unorm[-srgb]` and the HDR arm returns `rgba16float`. Degradation
 * is silent but observable (the returned format reflects reality). ASTC-HDR and
 * PVRTC are out of scope (OOS-5 / not exposed by WebGPU core).
 */

import type { TranscodeCaps } from '@forgeax/engine-types';
import type { TranscoderTextureFormatEnum } from './wasm/basis-types.js';

interface TranscodeTargetSpec {
  readonly basis: keyof TranscoderTextureFormatEnum;
  /** RGBA32 decode is compacted by the codec before its bytes leave this owner. */
  readonly channels?: 1 | 2;
}

/** @internal Supported GPU targets and their complete Basis byte projection. */
export const TRANSCODE_TARGETS = {
  'bc7-rgba-unorm': { basis: 'cTFBC7_RGBA' },
  'bc7-rgba-unorm-srgb': { basis: 'cTFBC7_RGBA' },
  'bc5-rg-unorm': { basis: 'cTFBC5_RG' },
  'bc4-r-unorm': { basis: 'cTFBC4_R' },
  'bc6h-rgb-ufloat': { basis: 'cTFBC6H' },
  'etc2-rgba8unorm': { basis: 'cTFETC2_RGBA' },
  'etc2-rgba8unorm-srgb': { basis: 'cTFETC2_RGBA' },
  'eac-r11unorm': { basis: 'cTFETC2_EAC_R11' },
  'eac-rg11unorm': { basis: 'cTFETC2_EAC_RG11' },
  'astc-4x4-unorm': { basis: 'cTFASTC_4x4_RGBA' },
  'astc-4x4-unorm-srgb': { basis: 'cTFASTC_4x4_RGBA' },
  rgba16float: { basis: 'cTFRGBA_HALF' },
  rgba8unorm: { basis: 'cTFRGBA32' },
  'rgba8unorm-srgb': { basis: 'cTFRGBA32' },
  rg8unorm: { basis: 'cTFRGBA32', channels: 2 },
  r8unorm: { basis: 'cTFRGBA32', channels: 1 },
} as const satisfies Partial<Record<GPUTextureFormat, TranscodeTargetSpec>>;

export type TranscodeTargetFormat = keyof typeof TRANSCODE_TARGETS;

/** @internal Broad caller formats are admitted through the same closed target inventory. */
export const transcodeTargetSpecs: Readonly<
  Partial<Record<GPUTextureFormat, TranscodeTargetSpec>>
> = TRANSCODE_TARGETS;

/** The DFD-derived source encoding of the Basis payload (D-3 delivery encodings). */
export type TranscodeModel = 'etc1s' | 'uastc-ldr' | 'uastc-hdr';

/** Which channels the source carries, deciding the LDR arm (data vs color). */
export type TranscodeChannels = 'rgba' | 'rg' | 'r';

/** Source descriptor for target selection; all fields DFD-derived upstream. */
export interface TranscodeSource {
  readonly model: TranscodeModel;
  /** sRGB transfer function (from the DFD). Only varies the RGBA color arm. */
  readonly srgb: boolean;
  readonly channels: TranscodeChannels;
}

export type { TranscodeCaps } from '@forgeax/engine-types';

function selectRgba(srgb: boolean, caps: TranscodeCaps): TranscodeTargetFormat {
  // D-4: BC wins whenever present (before ASTC), guarding the Mesa/ANV trap.
  if (caps.bc) return srgb ? 'bc7-rgba-unorm-srgb' : 'bc7-rgba-unorm';
  if (caps.astc) return srgb ? 'astc-4x4-unorm-srgb' : 'astc-4x4-unorm';
  if (caps.etc2) return srgb ? 'etc2-rgba8unorm-srgb' : 'etc2-rgba8unorm';
  return srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
}

function selectRg(caps: TranscodeCaps): TranscodeTargetFormat {
  // Data channels have no sRGB variant. ASTC is not in the RG chain.
  if (caps.bc) return 'bc5-rg-unorm';
  if (caps.etc2) return 'eac-rg11unorm';
  return 'rg8unorm';
}

function selectR(caps: TranscodeCaps): TranscodeTargetFormat {
  if (caps.bc) return 'bc4-r-unorm';
  if (caps.etc2) return 'eac-r11unorm';
  return 'r8unorm';
}

function selectHdr(caps: TranscodeCaps): TranscodeTargetFormat {
  // ASTC-HDR is OOS; only BC6H, else uncompressed half-float.
  if (caps.bc) return 'bc6h-rgb-ufloat';
  return 'rgba16float';
}

/**
 * Select the transcode target `GPUTextureFormat` for a Basis source under the
 * given device caps. Pure, browser+node dual-safe, never returns an error --
 * a missing cap degrades to an uncompressed format, not a failure.
 */
export function selectTranscodeTarget(
  source: TranscodeSource,
  caps: TranscodeCaps,
): TranscodeTargetFormat {
  if (source.model === 'uastc-hdr') return selectHdr(caps);
  switch (source.channels) {
    case 'rgba':
      return selectRgba(source.srgb, caps);
    case 'rg':
      return selectRg(caps);
    case 'r':
      return selectR(caps);
  }
}
