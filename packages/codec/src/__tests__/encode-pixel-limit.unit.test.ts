import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseKtx2 } from '@forgeax/engine-codec';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BasisEncoderModule, BasisModuleFactory } from '../wasm/basis-types.js';

// @perf-budget-skip: intentional large-source WASM encoder boundary gate.
/**
 * Encoder source-pixel ceiling gate (CI-red fix, human decision).
 *
 * The wasm32 Basis encoder caps total source texels at
 * BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS. The vendored default was 4 Mpx (higher
 * limit 12 Mpx), below a 4096x4096 = 16.78 Mpx game texture, so encode() returned
 * 0 bytes -> ktx2-encode-failed. build-wasm.mjs now raises both non-wasm64 limits
 * to 16 Mpx (1024*1024*16) at build time. This test proves the raised WASM really
 * encodes a 4096x4096 source: ETC1S encode returns a non-empty KTX2 that parseKtx2
 * accepts.
 *
 * pkg/ is a gitignored emcc build artifact (AC-12); the case skips when it is not
 * built (contributor without emsdk) and runs in the CI build-artifacts job.
 */

const ENCODER_GLUE = new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url);
const TRANSCODER_GLUE = new URL('../../pkg/basis_transcoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(TRANSCODER_GLUE));

/** KTX2 BasisLZ supercompression scheme (ETC1S rides scheme=1). */
const SCHEME_BASISLZ = 1;

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

/** A deterministic WxH RGBA image (opaque, cheap to build for large sizes). */
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

function encodeEtc1s(mod: BasisEncoderModule, img: Uint8Array, w: number, h: number): number {
  const e = new mod.BasisEncoder();
  try {
    e.controlThreading(false, 0);
    e.setSliceSourceImage(0, img, w, h, 0);
    e.setCreateKTX2File(true);
    e.setFormatMode(mod.basis_tex_format.cETC1S.value);
    e.setQualityLevel(128);
    e.setETC1SCompressionLevel(0);
    e.setPerceptual(true);
    e.setMipGen(false);
    // A 4096x4096 ETC1S KTX2 stays well under 32 MiB; give it headroom.
    const out = new Uint8Array(1 << 25);
    const n = e.encode(out);
    if (n <= 0) return 0;
    return n;
  } finally {
    e.delete();
  }
}

describe.skipIf(!pkgBuilt)('encoder source-pixel ceiling raised to 4096^2', () => {
  let mod: BasisEncoderModule;

  beforeAll(async () => {
    mod = await loadEncoder();
  });

  it('encodes a 4096x4096 (16.78 Mpx) source to a non-empty ETC1S KTX2', async () => {
    const w = 4096;
    const h = 4096;
    const img = makeRgba(w, h);
    const out = new Uint8Array(1 << 25);
    const e = new mod.BasisEncoder();
    let n = 0;
    try {
      e.controlThreading(false, 0);
      e.setSliceSourceImage(0, img, w, h, 0);
      e.setCreateKTX2File(true);
      e.setFormatMode(mod.basis_tex_format.cETC1S.value);
      e.setQualityLevel(128);
      e.setETC1SCompressionLevel(0);
      e.setPerceptual(true);
      e.setMipGen(false);
      n = e.encode(out);
    } finally {
      e.delete();
    }
    // The whole point: this returns 0 with the un-patched 4/12 Mpx limit.
    expect(n).toBeGreaterThan(0);
    const parsed = await parseKtx2(out.slice(0, n));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.header.supercompressionScheme).toBe(SCHEME_BASISLZ);
    expect(parsed.value.header.pixelWidth).toBe(w);
    expect(parsed.value.header.pixelHeight).toBe(h);
  }, 120_000);

  it('a small source still encodes (sanity: raised limit did not break the low path)', () => {
    expect(encodeEtc1s(mod, makeRgba(16, 16), 16, 16)).toBeGreaterThan(0);
  });
});
