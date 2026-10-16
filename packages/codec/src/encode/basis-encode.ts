/**
 * Low-level basis encoder binding (build-time, D-5): raw pixels -> Basis KTX2.
 *
 * `basisEncode` wraps the self-built encoder WASM (scripts/build-wasm.mjs ->
 * pkg/encode/basis_encoder.{mjs,wasm}) with a Result-returning function over the
 * three delivery encodings this Loop produces (ETC1S / UASTC-LDR-4x4 /
 * UASTC-HDR-4x4). It is the codec-side counterpart of `compressZstd`: it lives
 * in the `@forgeax/engine-codec/encode` subpath (isolation path d guards runtime
 * from statically importing it), and it carries the WASM + enum plumbing so the
 * image-side arm (`encodeTextureToKtx2`, w18) can stay pure image semantics.
 *
 * Determinism (AC-02 / R-11): pthreads are disabled at build time and the
 * per-encode threading is turned off here (`controlThreading(false, 0)`), so the
 * same pixels + same options encode byte-identically. KTX2 carries no timestamp.
 *
 * Lazy-init (D-10, mirrors basis-transcoder): the encoder WASM module is
 * dynamic-imported on the first encode and cached; subsequent encodes reuse the
 * instance. The module .mjs is a MODULARIZE factory, node-legal here (build-time
 * only, never bundled into the browser runtime by the isolation gate).
 */

import type { CodecResult } from '../errors.js';
import { codecError } from '../errors.js';
import type { TranscodeModel } from '../transcode.js';
import type { BasisEncoder, BasisEncoderModule, BasisModuleFactory } from '../wasm/basis-types.js';

/** Which delivery encoding to produce. Mirrors the transcode source models (D-3). */
export type BasisEncodeMode = TranscodeModel;

// --- Fast-preset encode-effort constants (R-9) -------------------------------
// The 'auto' default (M5 w38) sends every existing texture through Basis encode,
// and the single-threaded encoder's default effort levels made the model-loading
// demo build run 10+ minutes. These three constants drop each arm to its lowest
// effort tier. Determinism (AC-02 / R-11) is unaffected -- effort tiers change
// the search budget, not the output nondeterminism (double-encode stays
// byte-identical; verified). Values anchor to the vendored encoder enums so a
// pin bump that renames a tier surfaces here.

/**
 * ETC1S perf-vs-size effort level (`m_etc1s_compression_level`, range [0,6],
 * vendored default 2 -- basisu_frontend.h). This lever is orthogonal to visual
 * quality: quality is fixed by `setQualityLevel` below; a lower compression
 * level only trades a marginally larger file for a much faster encode.
 */
const ETC1S_COMPRESSION_LEVEL_FASTEST = 0;

/**
 * UASTC-LDR pack level (`cPackUASTCLevelFastest`, the low nibble of
 * `m_pack_uastc_ldr_4x4_flags`, vendored default `cPackUASTCLevelDefault` = 2 --
 * basisu_uastc_enc.h). Unlike the ETC1S lever this DOES lower reconstruction
 * quality (~43.5 dB vs ~47.5 dB avg), so R-9's per-fixture escape hatch
 * (`compressionMode:'none'`) / D-12 upgrade path exists for any smoke that can
 * not converge in epsilon at this tier.
 */
const PACK_UASTC_LDR_LEVEL_FASTEST = 0;

/**
 * UASTC-HDR quality level (`m_uastc_hdr_4x4_options` level, range [0,4],
 * vendored default 1 -- basisu_uastc_hdr_4x4_enc.h). Level 0 is the fastest
 * search tier; block-format bytes are unchanged in size, only encode time drops.
 */
const UASTC_HDR_QUALITY_LEVEL_FASTEST = 0;

/** Encode options -- pixel layout + delivery encoding + transfer / mip flags. */
export interface BasisEncodeOptions {
  readonly mode: BasisEncodeMode;
  readonly width: number;
  readonly height: number;
  /** Write the sRGB transfer function into the KTX2 + DFD (LDR color only). */
  readonly srgb: boolean;
  /** ETC1S perceptual (sRGB) error metric vs linear PSNR. Ignored for UASTC. */
  readonly perceptual: boolean;
  /** Wrap the UASTC-LDR payload in KTX2 zstd supercompression. Ignored otherwise. */
  readonly uastcSupercompression: boolean;
  /** Generate a mip chain in the encoder. M3 keeps this false (offline mips are w18/M5). */
  readonly mipGen: boolean;
}

/** How the encoder WASM module is loaded. Overridable in tests. @internal */
type EncoderImporter = () => Promise<BasisEncoderModule>;

const ENCODER_GLUE = new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url);
const ENCODER_WASM = new URL('../../pkg/encode/basis_encoder.wasm', import.meta.url);

const defaultImporter: EncoderImporter = async () => {
  const factory = (
    (await import(/* @vite-ignore */ ENCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisEncoderModule>;
    }
  ).default;
  const mod = await factory({ locateFile: () => ENCODER_WASM.href });
  mod.initializeBasis();
  return mod;
};

let importer: EncoderImporter = defaultImporter;

/** Lazy-init singleton (D-10): null = never attempted, cleared on failure to retry. @internal */
let _initPromise: Promise<BasisEncoderModule> | null = null;

/**
 * Lazy-init the Basis encoder WASM module (D-10 main-thread singleton).
 * First call dynamic-imports + initializes; subsequent calls return the cache.
 */
export function initBasisEncoder(): Promise<BasisEncoderModule> {
  if (_initPromise !== null) return _initPromise;
  _initPromise = importer().catch((cause: unknown) => {
    _initPromise = null;
    throw new Error('codec-init-failed', { cause });
  });
  return _initPromise;
}

/**
 * Test-only: reset the lazy singleton and optionally override the importer.
 * Call with no argument to restore the real WASM importer.
 * @internal
 */
export function _setBasisEncoderImporter(next?: EncoderImporter): void {
  importer = next ?? defaultImporter;
  _initPromise = null;
}

/** Map a delivery encoding to the encoder `basis_tex_format` enum value. */
function formatModeValue(mod: BasisEncoderModule, mode: BasisEncodeMode): number {
  const f = mod.basis_tex_format;
  switch (mode) {
    case 'etc1s':
      return f.cETC1S.value;
    case 'uastc-ldr':
      return f.cUASTC_LDR_4x4.value;
    case 'uastc-hdr':
      return f.cUASTC_HDR_4x4.value;
  }
}

/**
 * Encode raw pixels into a Basis KTX2 container.
 *
 * `pixels` is tight-packed RGBA: 8-bit `R,G,B,A` per texel for LDR modes
 * (`etc1s` / `uastc-ldr`), IEEE-754 binary16 RGBA (rgba16float bytes) for
 * `uastc-hdr`. On any encoder-side failure returns a `ktx2-encode-failed`
 * CodecError carrying the mode + a short reason.
 */
export async function basisEncode(
  pixels: Uint8Array,
  options: BasisEncodeOptions,
): Promise<CodecResult<Uint8Array>> {
  let mod: BasisEncoderModule;
  try {
    mod = await initBasisEncoder();
  } catch {
    return codecError('codec-init-failed', { stage: 'dynamic-import-basis-encoder' });
  }

  const { mode, width, height, srgb, perceptual, uastcSupercompression, mipGen } = options;
  if (width <= 0 || height <= 0) {
    return codecError('ktx2-encode-failed', {
      mode,
      reason: `invalid dimensions ${width}x${height}`,
    });
  }

  let encoder: BasisEncoder;
  try {
    encoder = new mod.BasisEncoder();
  } catch {
    return codecError('ktx2-encode-failed', {
      mode,
      reason: 'encoder constructor failed',
    });
  }
  let result: CodecResult<Uint8Array> = codecError('ktx2-encode-failed', {
    mode,
    reason: 'encoder returned 0 bytes',
  });
  try {
    // Single-threaded for deterministic, byte-identical output (AC-02 / R-11).
    encoder.controlThreading(false, 0);

    let sourceAccepted: boolean;
    if (mode === 'uastc-hdr') {
      // img_type 0 = cHITRGBAHalfFloat: the source is rgba16float bytes; no
      // LDR->HDR upconversion (already linear half-float from the image arm).
      sourceAccepted = encoder.setSliceSourceImageHDR(0, pixels, width, height, 0, false, 1.0);
    } else {
      // img_type 0 = cRGBA32: tight-packed 8-bit RGBA.
      sourceAccepted = encoder.setSliceSourceImage(0, pixels, width, height, 0);
    }

    if (!sourceAccepted) {
      result = codecError('ktx2-encode-failed', {
        mode,
        reason:
          mode === 'uastc-hdr' ? 'setSliceSourceImageHDR failed' : 'setSliceSourceImage failed',
      });
    } else {
      encoder.setCreateKTX2File(true);
      encoder.setFormatMode(formatModeValue(mod, mode));
      encoder.setMipGen(mipGen);

      if (mode === 'etc1s') {
        encoder.setQualityLevel(128);
        // Fastest perf tier (R-9): quality stays fixed by setQualityLevel above;
        // the compression level only trades a marginally larger file for a much
        // faster encode (the 'auto' default routes every texture through here).
        encoder.setETC1SCompressionLevel(ETC1S_COMPRESSION_LEVEL_FASTEST);
        encoder.setPerceptual(perceptual);
      } else if (mode === 'uastc-ldr') {
        encoder.setKTX2UASTCSupercompression(uastcSupercompression);
        // Fastest pack tier (R-9). Unlike ETC1S this lowers quality; per-fixture
        // opt-out / D-12 upgrade covers any smoke that will not converge.
        encoder.setPackUASTCFlags(PACK_UASTC_LDR_LEVEL_FASTEST);
        encoder.setPerceptual(perceptual);
      } else {
        // uastc-hdr: fastest HDR search tier (R-9); block bytes unchanged in size.
        encoder.setUASTCHDRQualityLevel(UASTC_HDR_QUALITY_LEVEL_FASTEST);
      }
      // sRGB transfer function into the KTX2 header + DFD (LDR color arm).
      encoder.setKTX2AndBasisSRGBTransferFunc(srgb);

      // encode() copies into the provided buffer and returns the byte length (0 on
      // failure). A 4 MiB scratch buffer covers a single-slice mip-0 image at the
      // sizes this offline arm handles; grow-on-overflow retries once.
      let capacity = 1 << 22;
      let out = new Uint8Array(capacity);
      let n = encoder.encode(out);
      if (n === 0) {
        capacity = 1 << 25;
        out = new Uint8Array(capacity);
        n = encoder.encode(out);
      }
      if (n === 0) {
        result = codecError('ktx2-encode-failed', { mode, reason: 'encoder returned 0 bytes' });
      } else {
        result = { ok: true, value: out.slice(0, n) };
      }
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    result = codecError('ktx2-encode-failed', { mode, reason });
  }
  try {
    encoder.delete();
  } catch {
    if (result.ok) {
      result = codecError('ktx2-encode-failed', { mode, reason: 'encoder cleanup failed' });
    }
  }
  return result;
}
