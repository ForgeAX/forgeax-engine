import { encodeKtx2Native, type Ktx2NativeEncodeOptions } from '@forgeax/engine-codec/encode';
import {
  type AssetDecoderInput,
  type ImportContext,
  ImportError,
  ok,
  type TextureAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { imageImporter } from '../image-importer.js';
import { prepareRuntimeTexture, textureContribution } from '../runtime/asset-decoders';

const BC5_BLOCK = new Uint8Array([200, 100, 0x02, 0, 0, 0, 0, 0, 10, 20, 0x3e, 0, 0, 0, 0, 0]);
const RG8_LEVELS = [Uint8Array.from({ length: 16 }, (_, i) => i), Uint8Array.from([1, 2, 3, 4])];

async function encode(options: Ktx2NativeEncodeOptions): Promise<Uint8Array> {
  const encoded = await encodeKtx2Native(options);
  if (!encoded.ok) throw new Error(encoded.error.code);
  return encoded.value;
}

async function rg8(supercompression: 'none' | 'zstd' = 'none'): Promise<Uint8Array> {
  return encode({
    format: 'rg8unorm',
    width: 4,
    height: 2,
    levels: RG8_LEVELS,
    supercompression,
  });
}

function bc5(): Promise<Uint8Array> {
  return encode({ format: 'bc5-rg-unorm', width: 4, height: 4, levels: [BC5_BLOCK] });
}

function srgb(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[new DataView(copy.buffer).getUint32(48, true) + 14] = 2;
  return copy;
}

function decode(bytes: Uint8Array, kind: 'texture' = 'texture', colorSpace = 'linear') {
  const input: AssetDecoderInput<TextureAsset> = {
    envelope: {
      guid: 'normal-fixture',
      kind,
      payload: { kind, colorSpace } as TextureAsset,
      refs: [],
      artifacts: {
        body: {
          path: 'normal.ktx2',
          mediaType: 'image/ktx2',
          contentEncoding: 'identity',
          byteLength: bytes.byteLength,
          integrity: { algorithm: 'sha256', digest: `sha256:${'0'.repeat(64)}` },
        },
      },
    },
    artifacts: { read: async () => ok(bytes) },
    signal: new AbortController().signal,
  };
  return textureContribution.decoder.decode(input);
}

function context(bytes: Uint8Array, colorSpace: 'linear' | 'srgb' = 'linear'): ImportContext {
  return {
    source: 'normal.ktx2',
    readSource: async () => ({ ok: true as const, value: bytes }),
    readSibling: async () => ({
      ok: false as const,
      error: new ImportError({
        code: 'source-read-failed',
        expected: 'no sibling source',
        hint: 'test source has no sibling',
        detail: { source: 'normal.ktx2', reason: 'no sibling' },
      }),
    }),
    decodeImage: async () => {
      throw new Error('precompressed source must not call decodeImage');
    },
    subAssets: [{ guid: 'g', sourceIndex: 0, sourceKey: 'main', kind: 'texture' as const }],
    importSettings: { colorSpace },
    sourceOverrides: { main: { colorSpace } },
  } as unknown as ImportContext;
}

describe('non-Basis RG8 / BC5 KTX2 image admission', () => {
  it.each([
    'none',
    'zstd',
  ] as const)('unwraps an RG8 (%s) KTX2 into a native texture', async (scheme) => {
    const texture = (await decode(await rg8(scheme))).unwrap();
    expect(texture).toMatchObject({
      format: 'rg8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 4, height: 2 } },
      mips: { kind: 'packed', levelCount: 2 },
    });
    expect(texture.encoding).toBeUndefined();
    expect([...texture.data]).toEqual(RG8_LEVELS.flatMap((level) => [...level]));
  });

  it('retains a BC5 KTX2 as an encoded source for per-device derivation', async () => {
    const bytes = await bc5();
    const texture = (await decode(bytes)).unwrap();
    expect(texture).toMatchObject({
      format: 'bc5-rg-unorm',
      colorSpace: 'linear',
      encoding: 'ktx2',
      mips: { kind: 'none' },
    });
    expect(texture.data).toBe(bytes);
    expect(prepareRuntimeTexture(texture).ok).toBe(true);
    expect(prepareRuntimeTexture({ ...texture, colorSpace: 'srgb' }).ok).toBe(false);
    expect(prepareRuntimeTexture({ ...texture, data: await rg8() }).ok).toBe(false);
  });

  it('rejects an sRGB two-channel payload with the structured codec cause', async () => {
    expect(await decode(srgb(await rg8()), 'texture', 'srgb')).toMatchObject({
      ok: false,
      error: {
        code: 'asset-decode-failed',
        detail: {
          cause: {
            code: 'ktx2-native-unsupported',
            detail: { reason: 'srgb-transfer', vkFormat: 16 },
          },
        },
      },
    });
  });

  it('imports RG8 and BC5 KTX2 sources without a Basis codec descriptor', async () => {
    for (const [bytes, format] of [
      [await rg8(), 'rg8unorm'],
      [await bc5(), 'bc5-rg-unorm'],
    ] as const) {
      const result = await imageImporter.import(context(bytes));
      if (!result.ok) throw result.error;
      const asset = result.value.assets[0];
      expect(asset?.payload).toMatchObject({ format, colorSpace: 'linear' });
      expect(asset?.artifacts?.body).toMatchObject({ mediaType: 'image/ktx2' });
      expect(asset?.artifacts?.body).not.toHaveProperty('assetCodec');
    }
  });

  it.each([
    [
      'sRGB DFD',
      async () => srgb(await rg8()),
      'linear',
      'image-conversion-inspect-ktx2-native-unsupported',
    ],
    ['sRGB Meta', async () => rg8(), 'srgb', 'image-conversion-inspect-ktx2-color-space-conflict'],
  ] as const)('rejects %s for a two-channel source at import', async (_name, build, colorSpace, code) => {
    const result = await imageImporter.import(context(await build(), colorSpace));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatchObject({ diagnostics: [{ code }] });
  });
});
