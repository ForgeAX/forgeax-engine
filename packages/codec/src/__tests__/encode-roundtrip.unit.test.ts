import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseKtx2, transcodeKtx2 } from '@forgeax/engine-codec';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BasisEncoderModule, BasisModuleFactory } from '../wasm/basis-types.js';

/**
 * M3 encode round-trip + determinism gate (w15).
 *
 * Exercises the whole offline-encode arm end to end against the M1 encoder WASM
 * and the M2 transcoder:
 *
 *   (a) AC-01 round-trip -- encode an RGB/RGBA test image into a Basis KTX2
 *       container (ETC1S / UASTC-LDR), parse it with parseKtx2, and transcode
 *       the levels with transcodeKtx2. parseKtx2 must NOT reject the ETC1S
 *       payload with `ktx2-unsupported-scheme` (scheme=1 gate, M2 w13).
 *   (b) AC-02 determinism -- the same input bytes encoded twice are byte-equal
 *       (fixed encoder params, no timestamp / no random dither; R-11).
 *   (c) DFD model -- ETC1S / UASTC-LDR / UASTC-HDR produce distinct DFD color
 *       models (163 / 166 / 167) empirically verified against the pinned
 *       encoder (D-2 / D-3).
 *
 * This file uses the raw M1 encoder WASM directly (like wasm-init-smoke); it
 * does not exercise the w17 basisEncode wrapper (that is w17's own AC). It does
 * NOT test compression ratio (M2 w9) or image quality (M6).
 *
 * pkg/ is a gitignored emcc build artifact (AC-12). When it is not built
 * (contributor without emsdk) the WASM cases skip; CI builds it in the
 * build-artifacts job so the gate runs there.
 */

const ENCODER_GLUE = new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url);
const TRANSCODER_GLUE = new URL('../../pkg/basis_transcoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(TRANSCODER_GLUE));

/** DFD color models the pinned basis encoder writes per delivery encoding (D-3). */
const DFD_MODEL_ETC1S = 163;
const DFD_MODEL_UASTC_LDR = 166;
const DFD_MODEL_UASTC_HDR = 167;

/** KTX2 supercompression schemes (spec section 2.9). */
const SCHEME_NONE = 0;
const SCHEME_BASISLZ = 1;
const SCHEME_ZSTD = 2;

async function loadEncoder(): Promise<BasisEncoderModule> {
  const factory = (
    (await import(/* @vite-ignore */ ENCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisEncoderModule>;
    }
  ).default;
  const mod = await factory({
    locateFile: () => new URL('../../pkg/encode/basis_encoder.wasm', import.meta.url).href,
  });
  mod.initializeBasis();
  return mod;
}

/** A deterministic WxH RGBA image. */
function makeRgba(w: number, h: number): Uint8Array {
  const img = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    img[i * 4] = (i * 7) & 255;
    img[i * 4 + 1] = (i * 13) & 255;
    img[i * 4 + 2] = (i * 29) & 255;
    img[i * 4 + 3] = 255;
  }
  return img;
}

/** A deterministic WxH RGBA half-float image (rgba16float bytes) for HDR encode. */
function makeHdrF16(w: number, h: number): Uint8Array {
  // Half-float is IEEE 754 binary16; build the pattern directly so this helper
  // stays free of a runtime math dependency (the values are small, exactly
  // representable magnitudes).
  const out = new Uint16Array(w * h * 4);
  const toF16 = (v: number): number => f32ToF16(v);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = toF16((i % 8) / 8);
    out[i * 4 + 1] = toF16((i % 4) / 4);
    out[i * 4 + 2] = toF16(0.5);
    out[i * 4 + 3] = toF16(1);
  }
  return new Uint8Array(out.buffer);
}

/** Minimal f32 -> f16 bit encoder (round-to-nearest-even not needed for exact values). */
function f32ToF16(value: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = value;
  const x = u32[0] ?? 0;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp === 0) return sign;
  const e = exp - 127 + 15;
  if (e <= 0) return sign;
  if (e >= 0x1f) return sign | 0x7c00;
  return sign | (e << 10) | (mant >> 13);
}

function encodeEtc1s(mod: BasisEncoderModule, img: Uint8Array, w: number, h: number): Uint8Array {
  const e = new mod.BasisEncoder();
  e.setSliceSourceImage(0, img, w, h, 0);
  e.setCreateKTX2File(true);
  e.setFormatMode(mod.basis_tex_format.cETC1S.value);
  e.setQualityLevel(128);
  e.setPerceptual(true);
  e.setMipGen(false);
  const out = new Uint8Array(1 << 20);
  const n = e.encode(out);
  e.delete();
  if (n <= 0) throw new Error('ETC1S encode failed');
  return out.slice(0, n);
}

function encodeUastcLdr(
  mod: BasisEncoderModule,
  img: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const e = new mod.BasisEncoder();
  e.setSliceSourceImage(0, img, w, h, 0);
  e.setCreateKTX2File(true);
  e.setKTX2UASTCSupercompression(true);
  e.setFormatMode(mod.basis_tex_format.cUASTC_LDR_4x4.value);
  e.setPerceptual(true);
  e.setMipGen(false);
  const out = new Uint8Array(1 << 20);
  const n = e.encode(out);
  e.delete();
  if (n <= 0) throw new Error('UASTC-LDR encode failed');
  return out.slice(0, n);
}

function encodeUastcHdr(
  mod: BasisEncoderModule,
  img: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const e = new mod.BasisEncoder();
  // img_type 0 = cHITRGBAHalfFloat (rgba16float source).
  e.setSliceSourceImageHDR(0, img, w, h, 0, false, 1.0);
  e.setCreateKTX2File(true);
  e.setFormatMode(mod.basis_tex_format.cUASTC_HDR_4x4.value);
  e.setMipGen(false);
  const out = new Uint8Array(1 << 20);
  const n = e.encode(out);
  e.delete();
  if (n <= 0) throw new Error('UASTC-HDR encode failed');
  return out.slice(0, n);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe.skipIf(!pkgBuilt)('encode round-trip + determinism (M3 w15)', () => {
  let mod: BasisEncoderModule;

  beforeAll(async () => {
    mod = await loadEncoder();
  });

  it('AC-01: ETC1S encode -> parseKtx2 (scheme=1 accepted) -> transcode round-trip', async () => {
    const ktx2 = encodeEtc1s(mod, makeRgba(16, 16), 16, 16);
    const parsed = await parseKtx2(ktx2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // scheme=1 (BasisLZ) is opened by the M2 gate; must not be rejected.
    expect(parsed.value.header.supercompressionScheme).toBe(SCHEME_BASISLZ);
    expect(parsed.value.dfd?.colorModel).toBe(DFD_MODEL_ETC1S);

    const transcoded = await transcodeKtx2(parsed.value, 'bc7-rgba-unorm');
    expect(transcoded.ok).toBe(true);
    if (!transcoded.ok) return;
    expect(transcoded.value.format).toBe('bc7-rgba-unorm');
    expect(transcoded.value.mips.length).toBeGreaterThan(0);
    expect(transcoded.value.mips[0]?.data.length).toBeGreaterThan(0);
  });

  it('AC-01: UASTC-LDR encode -> parseKtx2 -> transcode round-trip', async () => {
    const ktx2 = encodeUastcLdr(mod, makeRgba(16, 16), 16, 16);
    const parsed = await parseKtx2(ktx2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // UASTC-LDR with supercompression rides scheme=2 (Zstandard), also accepted.
    expect(parsed.value.header.supercompressionScheme).toBe(SCHEME_ZSTD);
    expect(parsed.value.dfd?.colorModel).toBe(DFD_MODEL_UASTC_LDR);

    const transcoded = await transcodeKtx2(parsed.value, 'bc7-rgba-unorm');
    expect(transcoded.ok).toBe(true);
    if (!transcoded.ok) return;
    expect(transcoded.value.format).toBe('bc7-rgba-unorm');
    expect(transcoded.value.mips[0]?.data.length).toBeGreaterThan(0);
  });

  it('AC-02: double encode is byte-equal (ETC1S)', () => {
    const img = makeRgba(16, 16);
    const a = encodeEtc1s(mod, img, 16, 16);
    const b = encodeEtc1s(mod, img, 16, 16);
    expect(bytesEqual(a, b)).toBe(true);
  });

  it('AC-02: double encode is byte-equal (UASTC-LDR)', () => {
    const img = makeRgba(16, 16);
    const a = encodeUastcLdr(mod, img, 16, 16);
    const b = encodeUastcLdr(mod, img, 16, 16);
    expect(bytesEqual(a, b)).toBe(true);
  });

  it('DFD model differs per delivery encoding (163 / 166 / 167)', async () => {
    const etc1s = await parseKtx2(encodeEtc1s(mod, makeRgba(8, 8), 8, 8));
    const uastcLdr = await parseKtx2(encodeUastcLdr(mod, makeRgba(8, 8), 8, 8));
    const uastcHdr = await parseKtx2(encodeUastcHdr(mod, makeHdrF16(8, 8), 8, 8));
    expect(etc1s.ok && uastcLdr.ok && uastcHdr.ok).toBe(true);
    if (!(etc1s.ok && uastcLdr.ok && uastcHdr.ok)) return;
    expect(etc1s.value.dfd?.colorModel).toBe(DFD_MODEL_ETC1S);
    expect(uastcLdr.value.dfd?.colorModel).toBe(DFD_MODEL_UASTC_LDR);
    expect(uastcHdr.value.dfd?.colorModel).toBe(DFD_MODEL_UASTC_HDR);
    // The three models are pairwise distinct.
    const models = new Set([
      etc1s.value.dfd?.colorModel,
      uastcLdr.value.dfd?.colorModel,
      uastcHdr.value.dfd?.colorModel,
    ]);
    expect(models.size).toBe(3);
    // HDR container carries no supercompression by default.
    expect(uastcHdr.value.header.supercompressionScheme).toBe(SCHEME_NONE);
  });
});
