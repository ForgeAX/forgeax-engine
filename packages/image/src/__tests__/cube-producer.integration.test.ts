import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  finalizeImportProducts,
  projectImportProductForBuild,
  textureAssetOutputProducer,
} from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';
import { produceCubeTexture } from '../lut/cube-producer.js';

const GUID = '019ffa97-3000-7000-8000-000000000901';
const SOURCE_KEY = 'color-grading/neutral';

function cubeSource(size = 16): string {
  const rows = Array.from({ length: size ** 3 }, () => '0 0.5 1');
  return [
    'TITLE "ForgeaX neutral LUT"',
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0 0 0',
    'DOMAIN_MAX 1 1 1',
    ...rows,
    '',
  ].join('\n');
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('cube texture producer identity', () => {
  it('keeps ordinary texture shape, bytes, and Pack artifact identity closed', async () => {
    const produced = produceCubeTexture(
      { guid: GUID, source: 'assets/neutral.cube', sourceKey: SOURCE_KEY },
      cubeSource(),
    );
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;

    const asset = produced.value;
    expect(asset).toMatchObject({ guid: GUID, kind: 'texture' });
    expect(asset.payload.kind).toBe('texture');
    expect(asset.payload.shape).toEqual({
      viewDimension: '3d',
      extent: { width: 16, height: 16, depth: 16 },
    });
    expect(asset.payload.format).toBe('rgba16float');
    expect(asset.payload.colorSpace).toBe('linear');
    expect(asset.payload.mips).toEqual({ kind: 'none' });

    const standard = await textureAssetOutputProducer.produce({
      guid: GUID,
      sourceKey: SOURCE_KEY,
      asset: asset.payload,
    });
    expect(standard.ok).toBe(true);
    if (!standard.ok) return;
    const producedBody = asset.artifacts.body;
    const standardBody = standard.value.artifacts.body;
    expect(producedBody).toBeDefined();
    expect(standardBody).toBeDefined();
    if (producedBody === undefined || standardBody === undefined) return;
    expect(standardBody.mediaType).toBe(producedBody.mediaType);
    expect(standardBody.assetCodec).toEqual(producedBody.assetCodec);
    expect(Buffer.from(standardBody.bytes).equals(Buffer.from(producedBody.bytes))).toBe(true);

    const pack = projectImportProductForBuild({
      assets: [{ ...asset, artifacts: standard.value.artifacts }],
    });
    expect(pack.assets).toHaveLength(1);
    expect(pack.assets[0]).toMatchObject({ guid: GUID, kind: 'texture' });
    expect(pack.assets[0]?.payload.kind).toBe('texture');
    expect(pack.assets[0]?.payload.shape).toEqual({
      viewDimension: '3d',
      extent: { width: 16, height: 16, depth: 16 },
    });
    expect(pack.assets[0]?.payload.format).toBe('rgba16float');
    const products = await finalizeImportProducts(
      {
        assets: [{ ...asset, artifacts: standard.value.artifacts }],
        sourceDependencies: ['assets/neutral.cube'],
      },
      'sha256:source-neutral',
    );
    expect(products[0]).toMatchObject({
      guid: GUID,
      digest: expect.stringMatching(/^sha256:/),
      receipt: { guid: GUID, inputFingerprint: 'sha256:source-neutral', status: 'succeeded' },
    });
    expect(products[0]?.artifacts.body?.integrity).toEqual({
      algorithm: 'sha256',
      digest: digest(asset.artifacts.body?.bytes ?? new Uint8Array()),
    });
  });
});
