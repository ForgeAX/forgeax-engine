import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  _setBasisTranscoderImporter,
  initBasisTranscoder,
  transcodeBasis,
  transcodeKtx2,
} from '../basis-transcoder.js';
import { parseKtx2 } from '../ktx2.js';
import { selectTranscodeTarget } from '../transcode.js';
import type { BasisEncoderModule, BasisModuleFactory } from '../wasm/basis-types.js';

/**
 * basis-transcoder glue unit tests (w14).
 *
 * Validates:
 *   1. Lazy-init singleton (D-10): first initBasisTranscoder() loads the WASM
 *      module once; a second call returns the cache without re-importing.
 *   2. transcodeKtx2() on a real UASTC KTX2 (encoder-produced) returns non-empty
 *      per-mip block bytes for a BC7 target.
 *   3. Module imports cleanly in node (this file runs under the node vitest
 *      project); the same dynamic-import .mjs path is browser-legal (M5/e2e).
 *
 * pkg/ is a gitignored emcc build artifact (AC-12). When it is not built
 * (contributor without emsdk) the WASM-dependent cases skip; CI builds it in the
 * build-artifacts job so the gate runs there. The importer-observation case uses an
 * injected fake importer, so it runs regardless of pkg/ presence.
 */

const TRANSCODER_GLUE = new URL('../../pkg/basis_transcoder.mjs', import.meta.url);
const ENCODER_GLUE = new URL('../../pkg/encode/basis_encoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(TRANSCODER_GLUE)) && existsSync(fileURLToPath(ENCODER_GLUE));

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

/** Encode a WxH RGBA image into a UASTC KTX2 container (Basis payload). */
async function encodeUastcKtx2(w: number, h: number, ktx2 = true): Promise<Uint8Array> {
  const enc = await loadEncoder();
  const encoder = new enc.BasisEncoder();
  encoder.setSliceSourceImage(0, makeRgba(w, h), w, h, 0);
  encoder.setCreateKTX2File(ktx2);
  encoder.setKTX2UASTCSupercompression(true);
  encoder.setFormatMode(enc.basis_tex_format.cUASTC_LDR_4x4.value);
  encoder.setPerceptual(true);
  encoder.setMipGen(false);
  const out = new Uint8Array(1 << 20);
  const n = encoder.encode(out);
  encoder.delete();
  if (n <= 0) throw new Error('encode failed for test setup');
  return out.slice(0, n);
}

afterEach(() => {
  _setBasisTranscoderImporter();
});

describe('initBasisTranscoder — lazy-init singleton (D-10, w14)', () => {
  it('importer not invoked until first init call', () => {
    const importer = vi.fn(() => Promise.resolve({} as never));
    _setBasisTranscoderImporter(importer);
    expect(importer).not.toHaveBeenCalled();
  });

  it('loads exactly once and returns the cache on the second call', async () => {
    let calls = 0;
    const fake = { transcoder_texture_format: {}, KTX2File: null } as never;
    _setBasisTranscoderImporter(() => {
      calls++;
      return Promise.resolve(fake);
    });

    const a = await initBasisTranscoder();
    const b = await initBasisTranscoder();
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it('clears the cached failure so the next call retries', async () => {
    let calls = 0;
    _setBasisTranscoderImporter(() => {
      calls++;
      return Promise.reject(new Error('boom'));
    });
    await expect(initBasisTranscoder()).rejects.toThrow();
    await expect(initBasisTranscoder()).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe.skipIf(!pkgBuilt)('transcodeKtx2 — real UASTC -> BC7 (w14)', () => {
  let uastcKtx2: Uint8Array;

  beforeAll(async () => {
    uastcKtx2 = await encodeUastcKtx2(16, 16);
  });

  it('transcodes every mip level into non-empty BC7 block bytes', async () => {
    _setBasisTranscoderImporter();
    const parsed = await parseKtx2(uastcKtx2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.code}`);

    const result = await transcodeKtx2(parsed.value, 'bc7-rgba-unorm');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`transcode failed: ${result.error.code}`);

    expect(result.value.format).toBe('bc7-rgba-unorm');
    expect(result.value.width).toBe(16);
    expect(result.value.height).toBe(16);
    expect(result.value.mips.length).toBeGreaterThanOrEqual(1);
    const base = result.value.mips[0];
    expect(base).toBeDefined();
    if (!base) throw new Error('no base mip');
    // 16x16 BC7 = 4x4 blocks * 16 bytes = 256 bytes.
    expect(base.data.length).toBe(256);
    expect(base.data.byteLength).toBeGreaterThan(0);
  });

  it('the real WASM importer loads once across two transcodes', async () => {
    _setBasisTranscoderImporter();
    const parsed = await parseKtx2(uastcKtx2);
    if (!parsed.ok) throw new Error('parse failed');
    const firstModule = await initBasisTranscoder();
    await transcodeKtx2(parsed.value, 'bc7-rgba-unorm');
    await transcodeKtx2(parsed.value, 'bc7-rgba-unorm');
    expect(await initBasisTranscoder()).toBe(firstModule);
  });
});

describe.skipIf(!pkgBuilt)('selected targets carry their declared pixel or block bytes', () => {
  for (const container of ['ktx2', 'basis'] as const) {
    describe(container, () => {
      let transcode: (format: GPUTextureFormat) => ReturnType<typeof transcodeBasis>;
      beforeAll(async () => {
        const bytes = await encodeUastcKtx2(16, 16, container === 'ktx2');
        const parsed = container === 'ktx2' ? parseKtx2(bytes) : undefined;
        if (parsed !== undefined && !parsed.ok) throw new Error(parsed.error.code);
        transcode = (format) =>
          parsed?.ok ? transcodeKtx2(parsed.value, format) : transcodeBasis(bytes, format);
      });
      it.each(['r8unorm', 'rg8unorm'] as const)('%s returns packed channels', async (format) => {
        const reference = await transcode('rgba8unorm');
        const result = await transcode(format);
        if (!reference.ok || !result.ok) throw new Error('transcode failed');
        const rgba = reference.value.mips[0]?.data;
        const actual = result.value.mips[0]?.data;
        if (rgba === undefined || actual === undefined) throw new Error('missing base mip');
        const channels = format === 'r8unorm' ? 1 : 2;
        expect(actual.length).toBe(16 * 16 * channels);
        expect([...actual]).toEqual([...rgba].filter((_, index) => index % 4 < channels));
      });
      it('transcodes every LDR capability and channel selection', async () => {
        const targets = new Set<GPUTextureFormat>();
        for (let mask = 0; mask < 8; mask++) {
          for (const model of ['etc1s', 'uastc-ldr'] as const) {
            for (const channels of ['rgba', 'rg', 'r'] as const) {
              for (const srgb of [false, true]) {
                targets.add(
                  selectTranscodeTarget(
                    { model, channels, srgb },
                    {
                      bc: (mask & 1) !== 0,
                      etc2: (mask & 2) !== 0,
                      astc: (mask & 4) !== 0,
                    },
                  ),
                );
              }
            }
          }
        }
        for (const target of targets) {
          const result = await transcode(target);
          expect(result.ok, target).toBe(true);
          if (!result.ok) continue;
          expect(result.value.format).toBe(target);
          expect(result.value.mips[0]?.data.byteLength, target).toBeGreaterThan(0);
        }
      });
    });
  }
});
