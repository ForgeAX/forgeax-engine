import { type BasisEncodeMode, basisEncode, encodeKtx2Native } from '@forgeax/engine-codec/encode';
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

async function portableTexture(
  mode: BasisEncodeMode = 'uastc-ldr',
  srgb = true,
): Promise<TextureAsset> {
  const hdr = mode === 'uastc-hdr';
  const pixels = hdr
    ? new Uint8Array(new Uint16Array(4 * 4 * 4).fill(0x3800).buffer)
    : new Uint8Array(4 * 4 * 4).fill(127);
  const encoded = await basisEncode(pixels, {
    mode,
    width: 4,
    height: 4,
    srgb,
    perceptual: srgb,
    uastcSupercompression: true,
    mipGen: !hdr,
  });
  if (!encoded.ok) throw new Error(encoded.error.code);
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: hdr ? 'rgba16float' : srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    colorSpace: srgb ? 'srgb' : 'linear',
    data: encoded.value,
    encoding: 'ktx2',
    mips: hdr ? { kind: 'none' } : { kind: 'packed', levelCount: 3 },
  };
}

it('publishes an authored portable UASTC KTX2 without relabeling its source as BC5', async () => {
  const asset = await portableTexture();
  const result = await produce(asset);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.payload).toMatchObject({ format: 'rgba8unorm-srgb', encoding: 'ktx2' });
  expect(result.value.artifacts.body).toMatchObject({
    mediaType: 'image/ktx2',
    assetCodec: { name: 'basis', container: 'ktx2', profile: 'uastc-ldr', version: '1' },
  });
  expect(result.value.artifacts.body?.bytes).toEqual(asset.data);
});

it.each([
  ['etc1s', true],
  ['uastc-ldr', false],
  ['uastc-hdr', false],
] as const)('preserves the actual %s profile and authored transfer function', async (profile, srgb) => {
  const asset = await portableTexture(profile, srgb),
    result = await produce(asset);
  expect(result.ok, JSON.stringify(result.ok ? null : result.error)).toBe(true);
  if (!result.ok) return;
  expect(result.value.payload).toEqual(asset);
  expect(result.value.artifacts.body?.assetCodec).toEqual({
    name: 'basis',
    container: 'ktx2',
    profile,
    version: '1',
  });
  expect(result.value.artifacts.body?.bytes).toEqual(asset.data);
});

it('rejects portable sources whose declared extent, mips, transfer or format differ', async () => {
  const asset = await portableTexture();
  const patches: Partial<TextureAsset>[] = [
    { shape: { viewDimension: '2d', extent: { width: 8, height: 4 } } },
    { shape: { viewDimension: '2d-array', extent: { width: 4, height: 4, layers: 2 } } },
    { mips: { kind: 'none' } },
    { mips: { kind: 'generate' } },
    { mips: { kind: 'packed', levelCount: 2 } },
    { colorSpace: 'linear' },
    { format: 'rgba8unorm' },
    { format: 'rgba16float' },
    { data: asset.data.slice(0, -1) },
  ];
  for (const patch of patches)
    expect(
      (await produce({ ...asset, ...patch })).ok,
      JSON.stringify(patch, (key, value) => (key === 'data' ? 'truncated bytes' : value)),
    ).toBe(false);
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
