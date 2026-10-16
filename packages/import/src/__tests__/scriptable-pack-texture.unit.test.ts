import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetGuid as AssetGuidType, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { textureAssetOutputProducer } from '../scriptable-pack-output-producers.js';

const GUID = '019ffa97-3000-7000-8000-000000000201';
const SOURCE_KEY = 'density/volume';

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function texture(shape: TextureAsset['shape'], data: Uint8Array): TextureAsset {
  return {
    kind: 'texture',
    shape,
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data,
  };
}

describe('ScriptablePack texture output producer', () => {
  it.each([
    {
      label: 'array',
      shape: { viewDimension: '2d-array' as const, extent: { width: 8, height: 4, layers: 3 } },
      bytes: 8 * 4 * 3,
    },
    {
      label: 'volume',
      shape: { viewDimension: '3d' as const, extent: { width: 4, height: 4, depth: 4 } },
      bytes: 4 * 4 * 4,
    },
  ])('matches source producer facts for a $label logical asset', async ({ shape, bytes }) => {
    const payload = texture(shape, new Uint8Array(bytes).fill(23));
    const result = await textureAssetOutputProducer.produce({
      guid: GUID,
      sourceKey: SOURCE_KEY,
      asset: payload,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload).toEqual(payload);
    expect(result.value.artifacts.body).toMatchObject({
      mediaType: 'application/x-forgeax-r8',
      assetCodec: { name: 'r8unorm', version: '1' },
    });
    expect(result.value.artifacts.body?.bytes).toEqual(payload.data);
    expect(result.value.refs).toEqual([]);
  });

  it('keeps one publication GUID and rejects slice or layer identity fabrication', async () => {
    const payload = texture(
      { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
      new Uint8Array(8),
    );
    const result = await textureAssetOutputProducer.produce({
      guid: AssetGuid.format(guid(GUID)),
      sourceKey: SOURCE_KEY,
      asset: payload,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value.payload as TextureAsset).shape).toEqual(payload.shape);
    expect(result.value.artifacts.body?.bytes.byteLength).toBe(8);
    expect(result.value.refs).toEqual([]);
    expect(result.value).not.toHaveProperty('sliceGuids');
    expect(result.value).not.toHaveProperty('layerGuids');
  });

  it('fails fast when the payload data is not a canonical byte stream', async () => {
    const payload = texture(
      { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
      new Uint8Array(7),
    );
    const result = await textureAssetOutputProducer.produce({
      guid: GUID,
      sourceKey: SOURCE_KEY,
      asset: payload,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('import-internal-error');
      expect(result.error.detail).toMatchObject({
        reason: expect.stringContaining('texture data is not canonical'),
      });
    }
  });
});
