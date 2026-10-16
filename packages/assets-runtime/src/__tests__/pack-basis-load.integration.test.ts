import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LoadContext, LoaderAsyncResult, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  BasisEncoderModule,
  BasisModuleFactory,
} from '../../../codec/src/wasm/basis-types.js';
import type { CodecContextFailure } from '../loaders/pack-artifact.js';
import { PACK_ARTIFACT_LOADERS, textureLoader } from '../loaders/pack-artifact.js';

const TRANSCODER_GLUE = new URL('../../../codec/pkg/basis_transcoder.mjs', import.meta.url);
const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
const pkgBuilt =
  existsSync(fileURLToPath(TRANSCODER_GLUE)) && existsSync(fileURLToPath(ENCODER_GLUE));

async function loadEncoder(): Promise<BasisEncoderModule> {
  const factory = (
    (await import(/* @vite-ignore */ ENCODER_GLUE.href)) as {
      default: BasisModuleFactory<BasisEncoderModule>;
    }
  ).default;
  const mod = await factory({
    locateFile: () => new URL('../../../codec/pkg/encode/basis_encoder.wasm', import.meta.url).href,
  });
  mod.initializeBasis();
  return mod;
}

async function makeBasis(ktx2 = false, mips = false): Promise<Uint8Array> {
  const mod = await loadEncoder();
  const encoder = new mod.BasisEncoder();
  try {
    encoder.setSliceSourceImage(0, new Uint8Array(4 * 4 * 4).fill(127), 4, 4, 0);
    encoder.setCreateKTX2File(ktx2);
    encoder.setFormatMode(mod.basis_tex_format.cUASTC_LDR_4x4.value);
    encoder.setPerceptual(false);
    encoder.setKTX2AndBasisSRGBTransferFunc(false);
    encoder.setMipGen(mips);
    const bytes = new Uint8Array(1 << 20);
    const length = encoder.encode(bytes);
    if (length <= 0) throw new Error('raw Basis encode failed');
    return bytes.slice(0, length);
  } finally {
    encoder.delete();
  }
}

const context: LoadContext = {
  fetchBinary: async () => ({ ok: false as const, error: new Error('not used') }),
  resolveRef: async () => ({ ok: false as const, error: new Error('not used') }),
  transcodeCaps: { bc: false, etc2: false, astc: false },
  device: undefined,
};

describe.skipIf(!pkgBuilt)('Pack runtime raw Basis loader', () => {
  it('keeps context failure code and detail correlated as a closed union', () => {
    type ExpectedContextFailure =
      | {
          readonly code: 'basis-profile-unsupported';
          readonly detail: { readonly profile: string };
        }
      | {
          readonly code: 'ktx2-color-space-mismatch';
          readonly detail: {
            readonly authoredColorSpace: 'srgb' | 'linear';
            readonly dfdColorSpace: 'srgb' | 'linear' | 'unknown';
          };
        };

    expectTypeOf<CodecContextFailure>().toEqualTypeOf<ExpectedContextFailure>();
  });

  it('transcodes a raw Basis artifact using its explicit container identity', async () => {
    const bytes = await makeBasis();
    const loadPack = textureLoader.loadPack;
    if (loadPack === undefined) throw new Error('textureLoader.loadPack must be registered');

    const result = (await loadPack(
      {
        guid: '019f0000-0000-7000-8000-000000000304',
        kind: 'texture',
        payload: {
          shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
          colorSpace: 'linear',
          mips: { kind: 'none' },
        },
        refs: [],
        artifacts: {
          body: {
            bytes,
            descriptor: {
              path: 'texture.basis',
              mediaType: 'image/basis',
              assetCodec: { name: 'basis', container: 'basis', profile: 'uastc-ldr' },
            },
          },
        },
      },
      context,
    )) as
      | { readonly ok: true; readonly value: TextureAsset }
      | { readonly ok: false; readonly error: unknown };

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'packed', levelCount: 1 },
    });
    expect(result.value.data.byteLength).toBeGreaterThan(0);
  });

  it.each([
    'basis',
    'ktx2',
  ] as const)('publishes the complete %s mip chain in order', async (container) => {
    const bytes = await makeBasis(container === 'ktx2', true);
    const loadPack = textureLoader.loadPack;
    if (loadPack === undefined) throw new Error('textureLoader.loadPack must be registered');
    const result = (await loadPack(
      {
        guid: '019f0000-0000-7000-8000-000000000306',
        kind: 'texture',
        payload: { colorSpace: 'linear' },
        refs: [],
        artifacts: {
          body: {
            bytes,
            descriptor: {
              path: `texture.${container}`,
              mediaType: `image/${container}`,
              assetCodec: { name: 'basis', container, profile: 'uastc-ldr' },
            },
          },
        },
      },
      context,
    )) as LoaderAsyncResult<TextureAsset>;
    if (!result.ok) throw result.error;
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      mips: { kind: 'packed', levelCount: 3 },
    });
    // 4x4, 2x2 and 1x1 RGBA mips, largest first, with the same authored color.
    const texture = result.value as TextureAsset;
    expect(texture.data.byteLength).toBe((16 + 4 + 1) * 4);
    const pixels = new Uint8Array(
      texture.data.buffer,
      texture.data.byteOffset,
      texture.data.byteLength,
    );
    for (const offset of [0, 64, 80])
      expect(Array.from(pixels.slice(offset, offset + 3))).toEqual([127, 127, 127]);
  });

  it('preserves codec context for a malformed KTX2 Pack artifact', async () => {
    const loadPack = textureLoader.loadPack;
    if (loadPack === undefined) throw new Error('textureLoader.loadPack must be registered');

    const result = (await loadPack(
      {
        guid: '019f0000-0000-7000-8000-000000000305',
        kind: 'texture',
        payload: {
          shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
          colorSpace: 'srgb',
          mips: { kind: 'none' },
        },
        refs: [],
        artifacts: {
          body: {
            bytes: new Uint8Array([0, 1, 2, 3]),
            descriptor: {
              path: 'texture.ktx2',
              mediaType: 'image/ktx2',
              assetCodec: { name: 'basis', container: 'ktx2', profile: 'uastc-ldr' },
            },
          },
        },
      },
      context,
    )) as
      | { readonly ok: true; readonly value: TextureAsset }
      | {
          readonly ok: false;
          readonly error: {
            readonly code: string;
            readonly hint: string;
            readonly detail?: unknown;
          };
        };

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('asset-parse-failed');
    expect(result.error.hint).toContain('KTX2');
    expect(result.error.detail).toMatchObject({
      sourcePath: '019f0000-0000-7000-8000-000000000305',
      container: 'ktx2',
      profile: 'uastc-ldr',
      codecCode: 'ktx2-parse-failed',
      capabilities: { bc: false, etc2: false, astc: false },
    });
    expect(result.error.detail).toHaveProperty('codecDetail.reason');
  });
});

describe('Pack artifact loader matrix', () => {
  it('registers every artifact-backed ordinary asset kind', () => {
    expect(PACK_ARTIFACT_LOADERS.map((loader) => loader.kind).sort()).toEqual(
      ['equirect', 'font', 'render-pipeline', 'texture', 'tileset'].sort(),
    );
  });
});
