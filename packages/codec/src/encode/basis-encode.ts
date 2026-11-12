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
import { parseKtx2 } from '../ktx2.js';
import type { TranscodeChannels, TranscodeModel } from '../transcode.js';
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
  /** Generate a mip chain in the encoder (box filter, no renormalization). */
  readonly mipGen: boolean;
  /**
   * Pre-generated levels 1..n after `pixels` (level 0), each `max(1, size >> k)` on
   * both axes in the same pixel layout. UASTC only: every level is encoded on its
   * own and the block payloads are assembled into one KTX2 chain, so offline
   * filtering (normal renormalization, variance-aware roughness) reaches the GPU
   * unchanged. Exclusive with `mipGen`.
   */
  readonly levels?: readonly Uint8Array[];
  /**
   * Source channels (default 'rgba'). 'rg' encodes R and G of `pixels` (a normal
   * map's XY) as UASTC luminance-alpha, `RRRG` in the DFD, the lanes Basis reads
   * for BC5 and EAC RG11; 'r' encodes R as `RRR` for BC4 and EAC R11. Transcoding
   * derives the target arm from this DFD id. UASTC-LDR only.
   */
  readonly channels?: TranscodeChannels;
  /** UASTC-LDR rate-distortion lambda ([0.001, 10]; lower keeps more quality). Absent: no RDO. */
  readonly uastcRdo?: number;
  /**
   * UASTC-LDR pack level 0 (fastest, default) to 4 (very slow). Offline deliveries of
   * normal and packed maps use a higher level; the import default keeps the fast tier.
   */
  readonly uastcLevel?: 0 | 1 | 2 | 3 | 4;
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
  const { mode, width, height, levels = [], channels = 'rgba' } = options;
  const fail = (reason: string) => codecError('ktx2-encode-failed', { mode, reason });
  if (width <= 0 || height <= 0) return fail(`invalid dimensions ${width}x${height}`);
  if (channels !== 'rgba' && mode !== 'uastc-ldr')
    return fail(`channels '${channels}' needs uastc-ldr`);
  if (levels.length > 0) {
    if (mode === 'etc1s') return fail('pre-generated levels need a UASTC mode');
    if (options.mipGen) return fail('levels and mipGen are exclusive');
    if (levels.length >= Math.floor(Math.log2(Math.max(width, height))) + 1)
      return fail(
        `at most ${Math.floor(Math.log2(Math.max(width, height)))} levels follow ${width}x${height}`,
      );
  }
  const texel = mode === 'uastc-hdr' ? 8 : 4;
  const encoded: Uint8Array[] = [];
  for (const [k, level] of [pixels, ...levels].entries()) {
    const w = Math.max(1, width >> k);
    const h = Math.max(1, height >> k);
    if (level.byteLength !== w * h * texel)
      return fail(
        `level ${k} holds ${w}x${h} texels of ${texel} bytes (${level.byteLength} bytes given)`,
      );
    const one = encodeLevel(mod, level, { ...options, width: w, height: h });
    if (!one.ok) return one;
    encoded.push(one.value);
  }
  const chain = encoded.length === 1 ? (encoded[0] as Uint8Array) : assembleLevels(encoded);
  if (typeof chain === 'string') return fail(chain);
  return channels === 'rgba' ? { ok: true, value: chain } : markChannels(chain, channels, fail);
}

const KTX2_HEADER_BYTES = 80;
const LEVEL_ENTRY_BYTES = 24;
/** UASTC DFD channel ids (KTX 2.0 section 3.10.2) and the source swizzle into them. */
const UASTC_CHANNELS = {
  rg: { id: 5, swizzle: [0, 0, 0, 1] },
  r: { id: 4, swizzle: [0, 0, 0, 3] },
} as const;

/** Rewrite the single UASTC DFD sample's channel id (bits 24-27 of its first word). */
function markChannels(
  bytes: Uint8Array,
  channels: 'rg' | 'r',
  fail: (reason: string) => CodecResult<Uint8Array>,
): CodecResult<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dfd = view.getUint32(48, true);
  // totalSize word, 24-byte descriptor header, then sample 0.
  const sample = dfd + 4 + 24;
  if (view.getUint32(dfd + 4 + 8, true) % 256 !== 166 || sample + 16 > bytes.byteLength)
    return fail('the encoder wrote no UASTC DFD sample');
  const word = view.getUint32(sample, true);
  view.setUint32(sample, ((word & ~(0xf << 24)) | (UASTC_CHANNELS[channels].id << 24)) >>> 0, true);
  return { ok: true, value: bytes };
}

/**
 * One KTX2 file from single-level encodes of the same settings: the header and DFD
 * of level 0, its key/value data, and each file's level payload (UASTC blocks are
 * independent, and zstd supercompression is per level). Data runs smallest level
 * first, aligned to the 16-byte UASTC block unless supercompressed.
 */
function assembleLevels(files: readonly Uint8Array[]): Uint8Array | string {
  const parsed = files.map((file) => parseKtx2(file));
  const payloads: Uint8Array[] = [];
  const entries: { uncompressed: number }[] = [];
  for (const one of parsed) {
    if (!one.ok) return `a level did not parse: ${one.error.code}`;
    const level = one.value.levelIndex[0];
    if (one.value.levelIndex.length !== 1 || level === undefined || one.value.sgd !== null)
      return 'a level encoded to more than one UASTC level';
    payloads.push(
      one.value.rawBytes.subarray(level.byteOffset, level.byteOffset + level.byteLength),
    );
    entries.push({ uncompressed: level.uncompressedByteLength });
  }
  const base = parsed[0] as { ok: true; value: Ktx2ParsedLike };
  const { header, index, rawBytes } = base.value;
  const scheme = header.supercompressionScheme;
  if (parsed.some((p) => p.ok && p.value.header.supercompressionScheme !== scheme))
    return 'levels disagree on supercompression';
  const align = scheme === 0 ? 16 : 1;
  const dfd = rawBytes.subarray(index.dfdByteOffset, index.dfdByteOffset + index.dfdByteLength);
  const kvd = rawBytes.subarray(index.kvdByteOffset, index.kvdByteOffset + index.kvdByteLength);
  const pad = (n: number, a: number) => Math.ceil(n / a) * a;
  const dfdOffset = KTX2_HEADER_BYTES + files.length * LEVEL_ENTRY_BYTES;
  const kvdOffset = dfdOffset + dfd.byteLength;
  let cursor = pad(kvdOffset + kvd.byteLength, align);
  const offsets: number[] = new Array(files.length);
  for (let k = files.length - 1; k >= 0; k--) {
    cursor = pad(cursor, align);
    offsets[k] = cursor;
    cursor += (payloads[k] as Uint8Array).byteLength;
  }
  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  out.set(rawBytes.subarray(0, 48));
  view.setUint32(40, files.length, true);
  view.setUint32(48, dfdOffset, true);
  view.setUint32(52, dfd.byteLength, true);
  view.setUint32(56, kvd.byteLength === 0 ? 0 : kvdOffset, true);
  view.setUint32(60, kvd.byteLength, true);
  for (let k = 0; k < files.length; k++) {
    const at = KTX2_HEADER_BYTES + k * LEVEL_ENTRY_BYTES;
    view.setBigUint64(at, BigInt(offsets[k] as number), true);
    view.setBigUint64(at + 8, BigInt((payloads[k] as Uint8Array).byteLength), true);
    view.setBigUint64(at + 16, BigInt((entries[k] as { uncompressed: number }).uncompressed), true);
    out.set(payloads[k] as Uint8Array, offsets[k] as number);
  }
  out.set(dfd, dfdOffset);
  out.set(kvd, kvdOffset);
  return out;
}

type Ktx2ParsedLike = Extract<ReturnType<typeof parseKtx2>, { ok: true }>['value'];

function encodeLevel(
  mod: BasisEncoderModule,
  pixels: Uint8Array,
  options: BasisEncodeOptions,
): CodecResult<Uint8Array> {
  const { mode, width, height, srgb, perceptual, uastcSupercompression, mipGen } = options;

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
        encoder.setPackUASTCFlags(options.uastcLevel ?? PACK_UASTC_LDR_LEVEL_FASTEST);
        encoder.setPerceptual(perceptual);
        if (options.channels === 'rg' || options.channels === 'r') {
          const [r, g, b, a] = UASTC_CHANNELS[options.channels].swizzle;
          encoder.setSwizzle(r, g, b, a);
        }
        if (options.uastcRdo !== undefined) {
          encoder.setRDOUASTC(true);
          encoder.setRDOUASTCQualityScalar(options.uastcRdo);
        }
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
