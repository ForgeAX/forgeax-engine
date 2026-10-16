import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  BasisEncoderModule,
  BasisModuleFactory,
  BasisTranscoderModule,
} from '../wasm/basis-types.js';

/**
 * M1 closing red-green gate: the two self-built basis WASM modules (transcoder +
 * encoder) init in node, and the encoder produces a KTX2 container whose first
 * bytes are the KTX2 identifier magic. This validates the whole M1 WASM
 * self-build base end to end without touching M2/M3 code.
 *
 * pkg/ is a gitignored emcc build artifact (zero-binary, AC-12). When it has
 * not been built (contributor without emsdk), skip rather than false-fail --
 * CI builds it in the build-artifacts job (w6) so the gate runs there.
 */
const TRANSCODER_GLUE = new URL('../../pkg/basis_transcoder.mjs', import.meta.url);
const ENCODER_GLUE = new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url);

const pkgBuilt =
  existsSync(fileURLToPath(TRANSCODER_GLUE)) && existsSync(fileURLToPath(ENCODER_GLUE));

/** KTX2 2.0 identifier: «KTX 20»\r\n\x1A\n (spec section 1). */
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

async function loadTranscoder(): Promise<BasisTranscoderModule> {
  const factory = (
    (await import(/* @vite-ignore */ TRANSCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisTranscoderModule>;
    }
  ).default;
  const mod = await factory({
    locateFile: () => new URL('../../pkg/basis_transcoder.wasm', import.meta.url).href,
  });
  mod.initializeBasis();
  return mod;
}

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

/** A deterministic 8x8 RGBA test image. */
function makeRgba8x8(): Uint8Array {
  const w = 8;
  const h = 8;
  const img = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    img[i * 4] = (i * 7) & 255;
    img[i * 4 + 1] = (i * 13) & 255;
    img[i * 4 + 2] = (i * 29) & 255;
    img[i * 4 + 3] = 255;
  }
  return img;
}

describe.skipIf(!pkgBuilt)('basis WASM init smoke (M1)', () => {
  it('transcoder initializes when dynamic Function construction is unavailable', () => {
    // The SDK producer uses this same real-artifact gate before packaging.
    expect(() =>
      execFileSync(process.execPath, [
        fileURLToPath(new URL('../../scripts/verify-transcoder.mjs', import.meta.url)),
      ]),
    ).not.toThrow();
  });

  it('transcoder module inits with KTX2File + format enum', async () => {
    const tc = await loadTranscoder();
    expect(tc).not.toBeNull();
    expect(typeof tc.KTX2File).toBe('function');
    expect(typeof tc.transcoder_texture_format.cTFBC7_RGBA.value).toBe('number');
  });

  it('encoder module inits with BasisEncoder + format enum', async () => {
    const enc = await loadEncoder();
    expect(enc).not.toBeNull();
    expect(typeof enc.BasisEncoder).toBe('function');
    expect(typeof enc.basis_tex_format.cUASTC_LDR_4x4.value).toBe('number');
  });

  it('encoder produces a KTX2 container with the identifier magic', async () => {
    const enc = await loadEncoder();
    const encoder = new enc.BasisEncoder();
    const img = makeRgba8x8();
    encoder.setSliceSourceImage(0, img, 8, 8, 0);
    encoder.setCreateKTX2File(true);
    encoder.setKTX2UASTCSupercompression(true);
    encoder.setFormatMode(enc.basis_tex_format.cUASTC_LDR_4x4.value);
    encoder.setPerceptual(true);
    encoder.setMipGen(false);
    const out = new Uint8Array(1 << 20);
    const n = encoder.encode(out);
    encoder.delete();

    expect(n).toBeGreaterThan(KTX2_IDENTIFIER.length);
    const head = Array.from(out.slice(0, KTX2_IDENTIFIER.length));
    expect(head).toEqual(KTX2_IDENTIFIER);
  });
});
