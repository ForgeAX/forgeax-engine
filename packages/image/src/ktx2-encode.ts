// ktx2-encode.ts -- the image-side offline texture encode arm (M3 w18, D-5).
//
// This module is the image-semantic layer of the Basis encode path: it maps the
// sidecar `compressionMode` control-plane value + the source's colorSpace / HDR
// signal into a delivery encoding (D-12 'auto' derivation), maps that to the
// encoder parameters, and drives the low-level `basisEncode` binding that lives
// in `@forgeax/engine-codec/encode` (the WASM + enum plumbing stays in codec;
// the image semantics stay here -- D-5 "arm in image, binary in codec/encode").
//
// It is a NODE-ONLY build-time module (consumed by imageImporter, itself a
// node-only sub-export). It never touches GPU (isolation path b) and is never
// bundled into the runtime (isolation path a/d: runtime does not import
// @forgeax/engine-image nor @forgeax/engine-codec/encode).
//
// M3 sequencing constraint (plan R-9): the 'auto' derivation is implemented and
// tested here, but the sidecar DEFAULT stays 'none'. The default flip to 'auto'
// is M5 (w38); doing it here would make every existing texture encode to Basis
// ahead of loader support and redden the whole fixture fleet.

import { parseKtx2 } from '@forgeax/engine-codec';
import type { BasisEncodeMode } from '@forgeax/engine-codec/encode';
import { basisEncode } from '@forgeax/engine-codec/encode';

/** The sidecar control-plane value (ImageMetadata.compressionMode). */
export type CompressionMode = 'auto' | 'etc1s' | 'uastc' | 'none';

/** The resolved delivery encoding after 'auto' derivation. `'none'` = no encode. */
export type ResolvedEncodeMode = 'etc1s' | 'uastc' | 'uastc-hdr' | 'none';

/** Source signals that drive 'auto' derivation (D-12) and encoder params. */
export interface EncodeSourceInfo {
  /** Color transfer of the source (from the sidecar importSettings). */
  readonly colorSpace: 'srgb' | 'linear';
  /** Whether the source is an HDR image (.hdr -> rgba16float). */
  readonly isHdr: boolean;
  /**
   * Bake the full mip chain into the KTX2 (sidecar `mipmap`). Block-compressed
   * formats cannot be mip-generated on the GPU, so the chain is offline-only.
   */
  readonly mipmap: boolean;
}

/**
 * Resolve the sidecar `compressionMode` into a concrete delivery encoding.
 *
 * D-12 'auto' derivation (zero new required inputs, derived from existing
 * sidecar signals):
 *   - HDR source            -> 'uastc-hdr'  (BC6H target downstream)
 *   - colorSpace 'srgb'     -> 'etc1s'      (albedo / UI color)
 *   - colorSpace 'linear'   -> 'uastc'      (normals / ORM / data)
 *
 * Explicit modes pass through, except an explicit 'uastc' on an HDR source
 * resolves to 'uastc-hdr' (there is no LDR UASTC path for HDR pixels). 'none'
 * and 'etc1s' pass through verbatim.
 */
export function resolveEncodeMode(
  mode: CompressionMode,
  source: Pick<EncodeSourceInfo, 'colorSpace' | 'isHdr'>,
): ResolvedEncodeMode {
  switch (mode) {
    case 'none':
      return 'none';
    case 'etc1s':
      return 'etc1s';
    case 'uastc':
      return source.isHdr ? 'uastc-hdr' : 'uastc';
    case 'auto':
      if (source.isHdr) return 'uastc-hdr';
      return source.colorSpace === 'srgb' ? 'etc1s' : 'uastc';
  }
}

/** Encoder parameters for a resolved delivery encoding. */
export interface BasisEncodeParams {
  /** The codec-side delivery encoding. */
  readonly mode: BasisEncodeMode;
  /** Write the sRGB transfer function (LDR color only). */
  readonly srgb: boolean;
  /** ETC1S perceptual (sRGB) metric. */
  readonly perceptual: boolean;
  /** Wrap the UASTC-LDR payload in KTX2 zstd supercompression. */
  readonly uastcSupercompression: boolean;
  /** Encoder-side mip generation: the offline chain for a mipmapped source. */
  readonly mipGen: boolean;
}

/**
 * Map the sidecar mode + source into encoder parameters. Returns `null` for the
 * 'none' path -- the caller keeps the uncompressed `.bin` path and never calls
 * the encoder.
 */
export function basisEncodeParamsFor(
  mode: CompressionMode,
  source: EncodeSourceInfo,
): BasisEncodeParams | null {
  const resolved = resolveEncodeMode(mode, source);
  const srgbColor = source.colorSpace === 'srgb';
  switch (resolved) {
    case 'none':
      return null;
    case 'etc1s':
      return {
        mode: 'etc1s',
        srgb: srgbColor,
        perceptual: srgbColor,
        uastcSupercompression: false,
        mipGen: source.mipmap,
      };
    case 'uastc':
      return {
        mode: 'uastc-ldr',
        srgb: srgbColor,
        perceptual: srgbColor,
        uastcSupercompression: true,
        mipGen: source.mipmap,
      };
    case 'uastc-hdr':
      return {
        mode: 'uastc-hdr',
        srgb: false,
        perceptual: false,
        uastcSupercompression: false,
        mipGen: source.mipmap,
      };
  }
}

/** A successful encode result: KTX2 bytes + the resolved delivery encoding. */
export interface EncodedTexture {
  readonly ktx2: Uint8Array;
  readonly mode: ResolvedEncodeMode;
  /** Mip levels the KTX2 carries, read back from its header. */
  readonly levelCount: number;
}

/**
 * Maximum source pixels the wasm32 Basis encoder accepts (4096x4096 = 16.78 Mpx
 * = 1024*1024*16). This mirrors the raised `BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS`
 * ceiling patched into the encoder WASM (packages/codec/scripts/build-wasm.mjs).
 * Sources above this are rejected fast with a structured `ktx2-encode-source-too-large`
 * error rather than reaching the encoder and getting a silent 0-byte failure.
 */
export const MAX_ENCODE_SOURCE_PIXELS = 4096 * 4096;

/** Failure result carrying a short reason (encoder-side or invalid request). */
export interface EncodeFailure {
  readonly code: 'ktx2-encode-failed' | 'codec-init-failed' | 'ktx2-encode-source-too-large';
  readonly mode: ResolvedEncodeMode;
  readonly reason: string;
}

export type EncodeTextureResult =
  | { readonly ok: true; readonly value: EncodedTexture }
  | { readonly ok: false; readonly error: EncodeFailure };

/**
 * Encode source pixels into a Basis KTX2 texture per the sidecar mode.
 *
 * `pixels` is tight-packed RGBA: 8-bit RGBA for LDR sources, rgba16float bytes
 * for HDR sources. Returns `{ ok: false }` with `mode: 'none'` if the sidecar
 * mode resolves to 'none' -- the importer treats that as "no encode, keep the
 * .bin path" rather than an error (see importer callsite w18).
 */
export async function encodeTextureToKtx2(
  pixels: Uint8Array,
  width: number,
  height: number,
  mode: CompressionMode,
  source: EncodeSourceInfo,
): Promise<EncodeTextureResult> {
  const params = basisEncodeParamsFor(mode, source);
  if (params === null) {
    return {
      ok: false,
      error: {
        code: 'ktx2-encode-failed',
        mode: 'none',
        reason: 'compressionMode resolved to none',
      },
    };
  }
  const resolved = resolveEncodeMode(mode, source);
  // Fail fast above the wasm32 encoder's source-pixel ceiling (4096^2). Above
  // this the encoder returns 0 bytes silently; surface a structured, actionable
  // error instead so the importer reports "reduce resolution or set
  // compressionMode:'none'" rather than an opaque encode failure.
  if (width * height > MAX_ENCODE_SOURCE_PIXELS) {
    return {
      ok: false,
      error: {
        code: 'ktx2-encode-source-too-large',
        mode: resolved,
        reason:
          `source ${width}x${height} (${width * height} px) exceeds the ${MAX_ENCODE_SOURCE_PIXELS} px ` +
          '(4096x4096) Basis encode ceiling; reduce the texture resolution to <=4096x4096 ' +
          "or set compressionMode:'none' in the sidecar to keep it uncompressed",
      },
    };
  }
  const result = await basisEncode(pixels, {
    mode: params.mode,
    width,
    height,
    srgb: params.srgb,
    perceptual: params.perceptual,
    uastcSupercompression: params.uastcSupercompression,
    mipGen: params.mipGen,
  });
  if (!result.ok) {
    const reason =
      result.error.detail !== undefined && 'reason' in result.error.detail
        ? String((result.error.detail as { reason: unknown }).reason)
        : result.error.code;
    return {
      ok: false,
      error: {
        code:
          result.error.code === 'codec-init-failed' ? 'codec-init-failed' : 'ktx2-encode-failed',
        mode: resolved,
        reason,
      },
    };
  }
  const parsed = await parseKtx2(result.value);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: 'ktx2-encode-failed', mode: resolved, reason: parsed.error.code },
    };
  }
  return {
    ok: true,
    value: {
      ktx2: result.value,
      mode: resolved,
      levelCount: Math.max(1, parsed.value.header.levelCount),
    },
  };
}
