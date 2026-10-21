import { type AssetDecoderInput, ok, type TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type {
  BasisEncoderModule,
  BasisModuleFactory,
} from '../../../codec/src/wasm/basis-types.js';
import { textureContribution } from '../runtime/asset-decoders';

const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
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

async function decode(
  bytes: Uint8Array,
  container: string,
  profile = 'uastc-ldr',
  colorSpace = 'linear',
  includeCodec = true,
) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  const input: AssetDecoderInput<TextureAsset> = {
    envelope: {
      guid: 'image-fixture',
      kind: 'texture',
      payload: { kind: 'texture', colorSpace } as TextureAsset,
      refs: [],
      artifacts: {
        body: {
          path: `image.${container}`,
          mediaType: `image/${container}`,
          contentEncoding: 'identity',
          byteLength: bytes.byteLength,
          integrity: {
            algorithm: 'sha256',
            digest: `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
          },
          ...(includeCodec
            ? {
                assetCodec: {
                  name: 'basis' as const,
                  container: container as 'basis' | 'ktx2',
                  profile,
                },
              }
            : {}),
        },
      },
    },
    artifacts: { read: async () => ok(bytes) },
    signal: new AbortController().signal,
  };
  return textureContribution.decoder.decode(input);
}

describe('Image owner Basis decoding', () => {
  it.each([
    'basis',
    'ktx2',
  ])('retains the complete encoded %s source and its mip metadata', async (container) => {
    const bytes = await makeBasis(container === 'ktx2', true);
    const texture = (await decode(bytes, container)).unwrap();
    expect(texture).toMatchObject({
      shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      encoding: container,
      mips: { kind: 'packed', levelCount: 3 },
    });
    expect(texture.data).toBe(bytes);
  });
  it('rejects a declared color space that disagrees with the actual KTX2 transfer function', async () => {
    const bytes = await makeBasis(true);
    expect(await decode(bytes, 'ktx2', 'uastc-ldr', 'srgb')).toMatchObject({
      ok: false,
      error: {
        code: 'asset-package-invalid',
        detail: { reason: 'ktx2-color-space-mismatch' },
      },
    });
  });
  it('rejects a codec hint that disagrees with the actual encoded profile', async () => {
    const bytes = await makeBasis(true);
    expect(await decode(bytes, 'ktx2', 'etc1s')).toMatchObject({
      ok: false,
      error: { code: 'asset-package-invalid', detail: { reason: 'basis-profile-mismatch' } },
    });
  });
  it('rejects unsupported container/profile pairs before interpreting their bytes', async () => {
    for (const [container, profile] of [
      ['other', 'uastc-ldr'],
      ['basis', ''],
      ['basis', 'uastc-hdr'],
    ] as const) {
      expect(await decode(new Uint8Array(4), container, profile)).toMatchObject({
        ok: false,
        error: {
          code: 'asset-package-invalid',
          detail: { reason: 'basis-profile-unsupported' },
        },
      });
    }
  });
  it.each([
    false,
    true,
  ])('preserves structured codec failure details (codec hint=%s)', async (includeCodec) => {
    expect(
      await decode(new Uint8Array([0, 1, 2, 3]), 'ktx2', 'uastc-ldr', 'linear', includeCodec),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'asset-decode-failed',
        detail: {
          guid: 'image-fixture',
          kind: 'texture',
          cause: {
            code: 'ktx2-parse-failed',
            expected: expect.any(String),
            hint: expect.any(String),
            detail: { reason: expect.any(String) },
          },
        },
      },
    });
  });
});
