// basis-catalog-dispatch.integration.test.ts -- feat-20260707 M6 fix regression.
//
// End-to-end witness for the catalog round-trip bug: the pack-index ROW must
// carry the resolved `compression: 'basis-*'` discriminant so the runtime
// `loadTextureAsset` dispatches its transcode arm. Before the fix, the build /
// dev texture arms stamped the row with the STRATEGY_TABLE 'none' default (the
// resolved basis-* lived only in `metadata.compression`), so loadTextureAsset
// missed the transcode arm and the scheme=1 (BasisLZ / ETC1S) KTX2 fell through
// to `ktx2LevelsToRGBA`, which rejects it with `ktx2-unsupported-scheme`.
//
// This test uses the REAL encoder + REAL transcoder WASM (no mocks) so it
// exercises the exact scheme=1 payload the pipeline ships:
//   (bug witness) row compression='none'         -> scheme=1 reject (load fails)
//   (fix)         row compression='basis-etc1s'  -> transcode arm succeeds
//
// pkg/ (encoder + transcoder glue) is a gitignored emcc artefact (AC-12); CI's
// build-artifacts job builds it. Skip when absent (contributor without emsdk).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
// NOTE: @forgeax/engine-codec/encode is the build-time encoder subpath. The
// image-pipeline isolation gate (path d) forbids a STATIC import of it from
// packages/runtime/src (encode is build-time only). This test needs the real
// encoder to mint a Basis KTX2 fixture, so it uses a DYNAMIC import inside the
// pkg-gated beforeAll — build-time-only, never reached in shipped runtime code.
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { TranscodeCaps } from '@forgeax/engine-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BasisEncoderModule, BasisModuleFactory } from '../../../codec/src/wasm/basis-types';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
const TRANSCODER_GLUE = new URL('../../../codec/pkg/basis_transcoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(TRANSCODER_GLUE));

const GUID_TEX = 'c0000000-0000-4000-a000-0000626173a1';
const PACK_INDEX_URL = '/basis-catalog-dispatch-pack-index.json';
const PACK_URL = `/ddc/${GUID_TEX}.pack.json`;
const W = 16;
const H = 16;
const CAPABILITY_CELLS = [
  [{ bc: false, etc2: false, astc: false }, 'rgba'],
  [{ bc: false, etc2: false, astc: true }, 'astc'],
  [{ bc: true, etc2: false, astc: false }, 'bc'],
  [{ bc: false, etc2: true, astc: false }, 'etc'],
  [{ bc: true, etc2: true, astc: true }, 'all'],
] as const;
const NO_CAPS = CAPABILITY_CELLS[0][0];

let basisKtx2: Uint8Array;
let uastcLdrKtx2: Uint8Array;
let uastcHdrKtx2: Uint8Array;
let rawBasis: Uint8Array;
let originalFetch: typeof globalThis.fetch;

type TextureFixture = {
  readonly bytes: Uint8Array;
  readonly extension: 'ktx2' | 'basis';
  readonly mediaType: 'image/ktx2' | 'image/basis';
  readonly container: 'ktx2' | 'basis';
  readonly profile: 'etc1s' | 'uastc-ldr' | 'uastc-hdr';
  readonly colorSpace: 'srgb' | 'linear';
};

function parseGuid(g: string): AssetGuid {
  const parsed = AssetGuid.parse(g);
  if (!parsed.ok) throw new Error(`bad guid ${g}`);
  return parsed.value;
}

// Build a deterministic RGBA gradient and encode it to a real ETC1S Basis KTX2
// (scheme=1). The exact payload the vite-plugin-pack image arm ships for a
// compressionMode:'auto' sRGB texture.
beforeAll(async () => {
  if (!pkgBuilt) return;
  const { basisEncode } = await import('@forgeax/engine-codec/encode');
  const pixels = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      pixels[i] = (x * 16) & 0xff;
      pixels[i + 1] = (y * 16) & 0xff;
      pixels[i + 2] = 128;
      pixels[i + 3] = 255;
    }
  }
  async function encode(mode: 'etc1s' | 'uastc-ldr' | 'uastc-hdr', source: Uint8Array) {
    const enc = await basisEncode(source, {
      mode,
      width: W,
      height: H,
      srgb: mode !== 'uastc-hdr',
      perceptual: mode !== 'uastc-hdr',
      uastcSupercompression: mode === 'uastc-ldr',
      mipGen: false,
    });
    if (!enc.ok) throw new Error(`basisEncode failed: ${enc.error.code}`);
    return enc.value;
  }
  basisKtx2 = await encode('etc1s', pixels);
  uastcLdrKtx2 = await encode('uastc-ldr', pixels);
  uastcHdrKtx2 = await encode('uastc-hdr', new Uint8Array(W * H * 8));

  const factory = (
    (await import(/* @vite-ignore */ ENCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisEncoderModule>;
    }
  ).default;
  const mod = await factory({
    locateFile: () => new URL('../../../codec/pkg/encode/basis_encoder.wasm', import.meta.url).href,
  });
  mod.initializeBasis();
  const encoder = new mod.BasisEncoder();
  try {
    encoder.setSliceSourceImage(0, pixels, W, H, 0);
    encoder.setCreateKTX2File(false);
    encoder.setFormatMode(mod.basis_tex_format.cUASTC_LDR_4x4.value);
    encoder.setPerceptual(false);
    encoder.setMipGen(false);
    const bytes = new Uint8Array(1 << 20);
    const length = encoder.encode(bytes);
    if (length <= 0) throw new Error('raw Basis encode failed');
    rawBasis = bytes.slice(0, length);
  } finally {
    encoder.delete();
  }
});

function wireFetch(
  includeCodec: boolean,
  fixture: TextureFixture = {
    bytes: basisKtx2,
    extension: 'ktx2',
    mediaType: 'image/ktx2',
    container: 'ktx2',
    profile: 'etc1s',
    colorSpace: 'srgb',
  },
): void {
  globalThis.fetch = ((input: string) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url === PACK_INDEX_URL) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              guid: GUID_TEX,
              packageUrl: PACK_URL,
              kind: 'texture',
            },
          ]),
      });
    }
    if (url === PACK_URL) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: GUID_TEX,
                kind: 'texture',
                payload: {
                  shape: { viewDimension: '2d', extent: { width: W, height: H } },
                  format: fixture.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba16float',
                  colorSpace: fixture.colorSpace,
                  mips: { kind: 'none' },
                },
                refs: [],
                artifacts: {
                  body: {
                    path: `${GUID_TEX}.${fixture.extension}`,
                    mediaType: fixture.mediaType,
                    ...(includeCodec
                      ? {
                          assetCodec: {
                            name: 'basis',
                            container: fixture.container,
                            profile: fixture.profile,
                          },
                        }
                      : {}),
                  },
                },
              },
            ],
          }),
      });
    }
    // Serve the real Basis KTX2 bytes for the artifact URL.
    return Promise.resolve({
      ok: true,
      arrayBuffer: () =>
        Promise.resolve(
          fixture.bytes.buffer.slice(
            fixture.bytes.byteOffset,
            fixture.bytes.byteOffset + fixture.bytes.byteLength,
          ),
        ),
    });
  }) as unknown as typeof globalThis.fetch;
}

async function loadWith(
  includeCodec: boolean,
  fixture?: TextureFixture,
  caps: TranscodeCaps = NO_CAPS,
) {
  wireFetch(includeCodec, fixture);
  const reg = new AssetRegistry(makeMockShaderRegistry());
  reg.configurePackIndex(PACK_INDEX_URL);
  reg.setTranscodeCaps(caps);
  return reg.loadByGuid(parseGuid(GUID_TEX));
}

describe.skipIf(!pkgBuilt)('Basis catalog dispatch round-trip (M6 fix)', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('loads a Basis texture when the artifact has no optional codec hint', async () => {
    // Catalog v2 carries package navigation only. The optional codec hint is
    // owned by the artifact descriptor, so a valid KTX2 artifact remains
    // loadable when that hint is absent from the package row.
    const result = await loadWith(false);
    expect(result.ok).toBe(true);
  });

  it('artifact codec=basis-etc1s takes the transcode arm and loads', async () => {
    const result = await loadWith(true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`load failed: ${result.error.code}`);
    const tex = result.value as {
      kind: string;
      shape: { viewDimension: string; extent: { width: number; height: number } };
      format: string;
    };
    expect(tex.kind).toBe('texture');
    expect(tex.shape).toEqual({ viewDimension: '2d', extent: { width: W, height: H } });
    // NO_CAPS -> the transcode arm degrades to the uncompressed sRGB fallback
    // (section 8 P3), never a scheme=1 reject.
    expect(tex.format).toBe('rgba8unorm-srgb');
  });

  it('loads every real KTX2/Basis profile through Catalog and loadByGuid', async () => {
    const fixtures: readonly TextureFixture[] = [
      {
        bytes: basisKtx2,
        extension: 'ktx2',
        mediaType: 'image/ktx2',
        container: 'ktx2',
        profile: 'etc1s',
        colorSpace: 'srgb',
      },
      {
        bytes: uastcLdrKtx2,
        extension: 'ktx2',
        mediaType: 'image/ktx2',
        container: 'ktx2',
        profile: 'uastc-ldr',
        colorSpace: 'srgb',
      },
      {
        bytes: uastcHdrKtx2,
        extension: 'ktx2',
        mediaType: 'image/ktx2',
        container: 'ktx2',
        profile: 'uastc-hdr',
        colorSpace: 'linear',
      },
      {
        bytes: rawBasis,
        extension: 'basis',
        mediaType: 'image/basis',
        container: 'basis',
        profile: 'uastc-ldr',
        colorSpace: 'srgb',
      },
    ];

    for (const fixture of fixtures) {
      for (const [caps, arm] of CAPABILITY_CELLS) {
        const result = await loadWith(true, fixture, caps);
        expect(result.ok, `${fixture.container}:${fixture.profile}:${arm}`).toBe(true);
        if (!result.ok) continue;
        const texture = result.value as {
          kind: string;
          shape: { viewDimension: string; extent: { width: number; height: number } };
          format: string;
          data: Uint8Array;
          colorSpace: string;
        };
        expect(texture.kind).toBe('texture');
        expect(texture.shape).toEqual({ viewDimension: '2d', extent: { width: W, height: H } });
        expect(texture.data.byteLength).toBeGreaterThan(0);
        expect(texture.colorSpace).toBe(fixture.colorSpace);
        const expected =
          fixture.profile === 'uastc-hdr'
            ? caps.bc
              ? 'bc6h-rgb-ufloat'
              : 'rgba16float'
            : caps.bc
              ? `bc7-rgba-unorm${fixture.colorSpace === 'srgb' ? '-srgb' : ''}`
              : caps.astc
                ? `astc-4x4-unorm${fixture.colorSpace === 'srgb' ? '-srgb' : ''}`
                : caps.etc2
                  ? `etc2-rgba8unorm${fixture.colorSpace === 'srgb' ? '-srgb' : ''}`
                  : `rgba8unorm${fixture.colorSpace === 'srgb' ? '-srgb' : ''}`;
        expect(texture.format, `${fixture.container}:${fixture.profile}:${arm}`).toBe(expected);
      }
    }
  });
});
