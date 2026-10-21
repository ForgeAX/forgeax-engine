// Real portable Basis sources survive the publication / JSON / Catalog boundary.
// Device-specific transcode selection is covered at the GPU residency owner.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { equirectContribution, textureContribution } from '@forgeax/engine-image';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BasisEncoderModule, BasisModuleFactory } from '../../../codec/src/wasm/basis-types';

const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
const TRANSCODER_GLUE = new URL('../../../codec/pkg/basis_transcoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(ENCODER_GLUE)) && existsSync(fileURLToPath(TRANSCODER_GLUE));
const GUID_TEX = 'c0000000-0000-4000-a000-0000626173a1';
const PACK_URL = 'https://basis.invalid/source.pack.json';
const W = 16;
const H = 16;
let basisKtx2: Uint8Array;
let uastcLdrKtx2: Uint8Array;
let uastcHdrKtx2: Uint8Array;
let rawBasis: Uint8Array;

type TextureFixture = {
  readonly bytes: Uint8Array;
  readonly container: 'ktx2' | 'basis';
  readonly profile: 'etc1s' | 'uastc-ldr' | 'uastc-hdr';
  readonly colorSpace: 'srgb' | 'linear';
};

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

function registry(
  fixture: TextureFixture,
  includeCodec = true,
  kind: 'texture' | 'equirect' = 'texture',
) {
  const sourcePath = 'texture.pack';
  const format =
    fixture.profile === 'uastc-hdr'
      ? 'rgba16float'
      : fixture.colorSpace === 'srgb'
        ? 'rgba8unorm-srgb'
        : 'rgba8unorm';
  const produced = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: 'fixture',
    packageUrl: PACK_URL,
    pack: {
      assets: [
        {
          guid: GUID_TEX,
          kind,
          refs: [],
          payload: {
            kind,
            ...(kind === 'texture'
              ? { shape: { viewDimension: '2d', extent: { width: W, height: H } } }
              : { width: W, height: H }),
            format,
            colorSpace: fixture.colorSpace,
            mips: { kind: 'none' },
          },
          artifacts: {
            body: {
              path: `texture.${fixture.container}`,
              mediaType: `image/${fixture.container}`,
              byteLength: fixture.bytes.byteLength,
              contentEncoding: 'identity',
              integrity: {
                algorithm: 'sha256',
                digest: `sha256:${createHash('sha256').update(fixture.bytes).digest('hex')}`,
              },
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
    },
  });
  const assets = new AssetRegistry({
    catalog: createCatalogSource({
      entries: [
        {
          guid: GUID_TEX,
          kind,
          sourcePath,
          packageUrl: PACK_URL,
          publication: produced.publication,
        },
      ],
      fetch: async (input) => {
        const url = String(input);
        if (url === PACK_URL) return Response.json(produced.pack);
        if (url === `https://basis.invalid/texture.${fixture.container}`)
          return new Response(fixture.bytes.slice().buffer);
        throw new Error(`unexpected asset request: ${url}`);
      },
    }),
  });
  if (kind === 'texture')
    assets.installDecoder(textureContribution.kind, textureContribution.decoder);
  else assets.installDecoder(equirectContribution.kind, equirectContribution.decoder);
  return assets;
}

function fixtures(): readonly TextureFixture[] {
  return [
    { bytes: basisKtx2, container: 'ktx2', profile: 'etc1s', colorSpace: 'srgb' },
    { bytes: uastcLdrKtx2, container: 'ktx2', profile: 'uastc-ldr', colorSpace: 'srgb' },
    { bytes: uastcHdrKtx2, container: 'ktx2', profile: 'uastc-hdr', colorSpace: 'linear' },
    { bytes: rawBasis, container: 'basis', profile: 'uastc-ldr', colorSpace: 'srgb' },
  ];
}

describe.skipIf(!pkgBuilt)('Basis source Catalog round-trip', () => {
  it.each([
    false,
    true,
  ])('decodes HDR equirect source to renderable pixels (codec hint=%s)', async (includeCodec) => {
    const assets = registry(
      { bytes: uastcHdrKtx2, container: 'ktx2', profile: 'uastc-hdr', colorSpace: 'linear' },
      includeCodec,
      'equirect',
    );
    try {
      const handle = (await assets.load(GUID_TEX, 'equirect')).unwrap();
      const image = assets.read(handle).unwrap();
      expect(image).toMatchObject({
        kind: 'equirect',
        width: W,
        height: H,
        format: 'rgba16float',
        colorSpace: 'linear',
      });
      expect(image.data.byteLength).toBe(W * H * 8);
    } finally {
      assets.dispose();
    }
  });
  it.each([
    false,
    true,
  ])('retains every real encoded profile through Pack JSON (codec hint=%s)', async (includeCodec) => {
    for (const fixture of fixtures()) {
      const assets = registry(fixture, includeCodec);
      try {
        const result = await assets.load(GUID_TEX, 'texture');
        expect(
          result.ok,
          `${fixture.container}:${fixture.profile}:${JSON.stringify(result.ok ? undefined : result.error)}`,
        ).toBe(true);
        const texture = assets.read(result.unwrap()).unwrap();
        expect(texture.kind).toBe('texture');
        expect(texture.shape).toEqual({ viewDimension: '2d', extent: { width: W, height: H } });
        expect(texture.format).toBe(
          fixture.profile === 'uastc-hdr' ? 'rgba16float' : 'rgba8unorm-srgb',
        );
        expect(texture.encoding).toBe(fixture.container);
        expect(texture.data).toEqual(fixture.bytes);
        expect(texture.colorSpace).toBe(fixture.colorSpace);
        expect(texture.mips).toEqual({ kind: 'packed', levelCount: 1 });
      } finally {
        assets.dispose();
      }
    }
  });
});
