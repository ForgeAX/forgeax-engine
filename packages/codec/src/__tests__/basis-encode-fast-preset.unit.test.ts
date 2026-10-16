// basis-encode-fast-preset.unit.test.ts -- R-9 fast-preset gate for the w17
// basisEncode wrapper.
//
// M5/w38 flipped the sidecar compressionMode default to 'auto', routing every
// existing texture through Basis encode. The single-threaded encoder's default
// effort tiers pushed the model-loading demo build past 10 minutes. R-9 remedy
// (option 2) drops each arm to its lowest effort tier inside basisEncode:
//   etc1s     -> setETC1SCompressionLevel(0)  (perf lever, quality unchanged)
//   uastc-ldr -> setPackUASTCFlags(cPackUASTCLevelFastest)
//   uastc-hdr -> setUASTCHDRQualityLevel(0)
//
// This gate guards the two load-bearing invariants the speedup must NOT break:
//   (a) the fast-preset output is still a valid Basis KTX2 -- parseKtx2 accepts
//       it and transcodeKtx2 produces a nonempty BC7 mip (functional).
//   (b) AC-02 / R-11 determinism survives the effort change -- encoding the same
//       pixels twice through basisEncode is byte-identical.
//
// This exercises the w17 basisEncode WRAPPER (not the raw encoder like w15), so
// it locks the preset wiring the wrapper adds. pkg/ is a gitignored emcc build
// artifact (AC-12); the WASM cases skip when it is not built (contributor
// without emsdk) and run in CI's build-artifacts job.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseKtx2, transcodeKtx2 } from '@forgeax/engine-codec';
import { basisEncode } from '@forgeax/engine-codec/encode';
import { beforeAll, describe, expect, it } from 'vitest';
import { _setBasisEncoderImporter } from '../encode/basis-encode.js';

const ENCODER_GLUE = new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url);
const TRANSCODER_GLUE = new URL('../../pkg/basis_transcoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(TRANSCODER_GLUE));

/** A deterministic WxH tight-packed RGBA image. */
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

/** A deterministic WxH rgba16float image (HDR arm source bytes). */
function makeHdrF16(w: number, h: number): Uint8Array {
  const out = new Uint16Array(w * h * 4);
  const toF16 = (value: number): number => {
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
  };
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = toF16((i % 8) / 8);
    out[i * 4 + 1] = toF16((i % 4) / 4);
    out[i * 4 + 2] = toF16(0.5);
    out[i * 4 + 3] = toF16(1);
  }
  return new Uint8Array(out.buffer);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe.skipIf(!pkgBuilt)('basisEncode fast preset (R-9 / w17)', () => {
  beforeAll(() => {
    // Use the real WASM importer (default). Reset the singleton so this file's
    // first encode drives a clean init regardless of test-file ordering.
    _setBasisEncoderImporter();
  });

  it('etc1s fast preset round-trips through parseKtx2 + transcodeKtx2', async () => {
    const r = await basisEncode(makeRgba(16, 16), {
      mode: 'etc1s',
      width: 16,
      height: 16,
      srgb: true,
      perceptual: true,
      uastcSupercompression: false,
      mipGen: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = await parseKtx2(r.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const transcoded = await transcodeKtx2(parsed.value, 'bc7-rgba-unorm');
    expect(transcoded.ok).toBe(true);
    if (!transcoded.ok) return;
    expect(transcoded.value.mips[0]?.data.length).toBeGreaterThan(0);
  });

  it('uastc-ldr fast preset round-trips through parseKtx2 + transcodeKtx2', async () => {
    const r = await basisEncode(makeRgba(16, 16), {
      mode: 'uastc-ldr',
      width: 16,
      height: 16,
      srgb: true,
      perceptual: true,
      uastcSupercompression: true,
      mipGen: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = await parseKtx2(r.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const transcoded = await transcodeKtx2(parsed.value, 'bc7-rgba-unorm');
    expect(transcoded.ok).toBe(true);
    if (!transcoded.ok) return;
    expect(transcoded.value.mips[0]?.data.length).toBeGreaterThan(0);
  });

  it('uastc-hdr fast preset round-trips through parseKtx2 + transcodeKtx2', async () => {
    const r = await basisEncode(makeHdrF16(16, 16), {
      mode: 'uastc-hdr',
      width: 16,
      height: 16,
      srgb: false,
      perceptual: false,
      uastcSupercompression: false,
      mipGen: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = await parseKtx2(r.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const transcoded = await transcodeKtx2(parsed.value, 'bc6h-rgb-ufloat');
    expect(transcoded.ok).toBe(true);
    if (!transcoded.ok) return;
    expect(transcoded.value.mips[0]?.data.length).toBeGreaterThan(0);
  });

  it('AC-02: double encode with fast preset is byte-equal (etc1s)', async () => {
    const img = makeRgba(16, 16);
    const opts = {
      mode: 'etc1s',
      width: 16,
      height: 16,
      srgb: true,
      perceptual: true,
      uastcSupercompression: false,
      mipGen: false,
    } as const;
    const a = await basisEncode(img, opts);
    const b = await basisEncode(img, opts);
    expect(a.ok && b.ok).toBe(true);
    if (!(a.ok && b.ok)) return;
    expect(bytesEqual(a.value, b.value)).toBe(true);
  });

  it('AC-02: double encode with fast preset is byte-equal (uastc-ldr)', async () => {
    const img = makeRgba(16, 16);
    const opts = {
      mode: 'uastc-ldr',
      width: 16,
      height: 16,
      srgb: true,
      perceptual: true,
      uastcSupercompression: true,
      mipGen: false,
    } as const;
    const a = await basisEncode(img, opts);
    const b = await basisEncode(img, opts);
    expect(a.ok && b.ok).toBe(true);
    if (!(a.ok && b.ok)) return;
    expect(bytesEqual(a.value, b.value)).toBe(true);
  });

  it('AC-02: double encode with fast preset is byte-equal (uastc-hdr)', async () => {
    const img = makeHdrF16(16, 16);
    const opts = {
      mode: 'uastc-hdr',
      width: 16,
      height: 16,
      srgb: false,
      perceptual: false,
      uastcSupercompression: false,
      mipGen: false,
    } as const;
    const a = await basisEncode(img, opts);
    const b = await basisEncode(img, opts);
    expect(a.ok && b.ok).toBe(true);
    if (!(a.ok && b.ok)) return;
    expect(bytesEqual(a.value, b.value)).toBe(true);
  });
});
