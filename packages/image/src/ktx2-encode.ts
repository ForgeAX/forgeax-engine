import { parseKtx2 } from '@forgeax/engine-codec';
import type { BasisEncodeMode, BasisEncodeOptions } from '@forgeax/engine-codec/encode';
import { basisEncode } from '@forgeax/engine-codec/encode';
import type { ImageMetadata } from '@forgeax/engine-types';

/** The sidecar control-plane value (ImageMetadata.compressionMode). */
export type CompressionMode = NonNullable<ImageMetadata['compressionMode']>;

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

/** Image policy fills every codec option except the source dimensions. */
export type BasisEncodeParams = Omit<BasisEncodeOptions, 'width' | 'height'>;

/** Resolve sidecar controls once; null keeps the ordinary uncompressed path. */
export function basisEncodeParamsFor(
  mode: CompressionMode,
  source: EncodeSourceInfo,
): BasisEncodeParams | null {
  if (mode === 'none') return null;
  const resolved: BasisEncodeMode =
    mode === 'etc1s'
      ? 'etc1s'
      : source.isHdr
        ? 'uastc-hdr'
        : mode === 'auto' && source.colorSpace === 'srgb'
          ? 'etc1s'
          : 'uastc-ldr';
  const srgb = resolved !== 'uastc-hdr' && source.colorSpace === 'srgb';
  return {
    mode: resolved,
    srgb,
    perceptual: srgb,
    uastcSupercompression: resolved === 'uastc-ldr',
    mipGen: source.mipmap,
  };
}

/** A successful encode result: KTX2 bytes + the resolved delivery encoding. */
export interface EncodedTexture {
  readonly ktx2: Uint8Array;
  readonly mode: BasisEncodeMode;
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
  readonly mode: BasisEncodeMode;
  readonly reason: string;
}

export type EncodeTextureResult =
  | { readonly ok: true; readonly value: EncodedTexture }
  | { readonly ok: false; readonly error: EncodeFailure };

/** Encode tight RGBA8/RGBA16F pixels using the already resolved image policy. */
export async function encodeTextureToKtx2(
  pixels: Uint8Array,
  width: number,
  height: number,
  params: BasisEncodeParams,
): Promise<EncodeTextureResult> {
  // Fail fast above the wasm32 encoder's source-pixel ceiling (4096^2). Above
  // this the encoder returns 0 bytes silently; surface a structured, actionable
  // error instead so the importer reports "reduce resolution or set
  // compressionMode:'none'" rather than an opaque encode failure.
  if (width * height > MAX_ENCODE_SOURCE_PIXELS) {
    return {
      ok: false,
      error: {
        code: 'ktx2-encode-source-too-large',
        mode: params.mode,
        reason:
          `source ${width}x${height} (${width * height} px) exceeds the ${MAX_ENCODE_SOURCE_PIXELS} px ` +
          '(4096x4096) Basis encode ceiling; reduce the texture resolution to <=4096x4096 ' +
          "or set compressionMode:'none' in the sidecar to keep it uncompressed",
      },
    };
  }
  const result = await basisEncode(pixels, { ...params, width, height });
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
        mode: params.mode,
        reason,
      },
    };
  }
  const parsed = await parseKtx2(result.value);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: 'ktx2-encode-failed', mode: params.mode, reason: parsed.error.code },
    };
  }
  return {
    ok: true,
    value: {
      ktx2: result.value,
      mode: params.mode,
      levelCount: Math.max(1, parsed.value.header.levelCount),
    },
  };
}
