import { encodeKtx2Native } from '@forgeax/engine-codec/encode';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { textureAssetOutputProducer } from '../scriptable-pack-output-producers.js';

const BC5_BLOCK = new Uint8Array([200, 100, 0x02, 0, 0, 0, 0, 0, 10, 20, 0x3e, 0, 0, 0, 0, 0]);

async function bc5Texture(patch: Partial<TextureAsset> = {}): Promise<TextureAsset> {
  const encoded = await encodeKtx2Native({
    format: 'bc5-rg-unorm',
    width: 4,
    height: 4,
    levels: [BC5_BLOCK],
  });
  if (!encoded.ok) throw new Error(encoded.error.code);
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'bc5-rg-unorm',
    colorSpace: 'linear',
    data: encoded.value,
    encoding: 'ktx2',
    mips: { kind: 'none' },
    ...patch,
  } as TextureAsset;
}

const produce = (asset: TextureAsset) =>
  textureAssetOutputProducer.produce({
    guid: '019ffa97-3000-7000-8000-000000000010',
    sourceKey: 'texture/normal',
    asset,
  });

describe('ScriptablePack BC5 KTX2 texture output', () => {
  it('stores the KTX2 container as the image/ktx2 body without a Basis codec', async () => {
    const asset = await bc5Texture();
    const result = await produce(asset);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.artifacts.body).toMatchObject({ mediaType: 'image/ktx2' });
    expect(result.value.artifacts.body).not.toHaveProperty('assetCodec');
    expect([...(result.value.artifacts.body?.bytes ?? [])]).toEqual([...asset.data]);
  });

  it.each([
    [
      'declared extent differs',
      { shape: { viewDimension: '2d', extent: { width: 8, height: 4 } } },
    ],
    ['sRGB metadata', { colorSpace: 'srgb' }],
    ['format is not BC5', { format: 'rgba8unorm' }],
  ] as const)('rejects a KTX2 texture when %s', async (_name, patch) => {
    const result = await produce(await bc5Texture(patch as Partial<TextureAsset>));
    expect(result.ok).toBe(false);
  });

  it('rejects an sRGB-transfer container through the shared codec admission', async () => {
    const asset = await bc5Texture();
    const data = asset.data.slice();
    data[new DataView(data.buffer).getUint32(48, true) + 14] = 2;
    expect((await produce({ ...asset, data })).ok).toBe(false);
  });
});
