import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseKtx2 } from '@forgeax/engine-codec';
import { ImporterRegistry, runImport } from '@forgeax/engine-import';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { decodeImageForImport, imageImporter } from '../image-importer.js';
import { makePng } from './make-fixture.js';

const GUID = '019f0000-0000-7000-8000-000000000311';
const ENCODER_GLUE = new URL('../../../codec/pkg/encode/basis_encoder.mjs', import.meta.url);
const pkgBuilt = existsSync(fileURLToPath(ENCODER_GLUE));

async function importTexture(importSettings: Readonly<Record<string, unknown>>) {
  const registry = new ImporterRegistry();
  registry.register(imageImporter);
  const png = makePng(16, 16, [200, 40, 40, 255]);
  const result = await runImport(
    {
      importer: 'image',
      source: 'albedo.png',
      importSettings,
      subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'image:texture', kind: 'texture' }],
    },
    registry,
    { readSource: async () => ({ ok: true as const, value: png }) },
  );
  if (!result.ok || 'skipped' in result.value) throw new Error('image import failed');
  const asset = result.value.product.assets[0];
  if (asset === undefined) throw new Error('image import produced no asset');
  return asset;
}

describe('image importer offline mip chain', () => {
  it.skipIf(!pkgBuilt).each(['none', 'uastc'] as const)(
    'source and embedded images share cooked pixels and mip facts for %s',
    async (compressionMode) => {
      const settings = {
        colorSpace: 'srgb',
        mipmap: true,
        compressionMode,
        downscaleMaxDimension: 8,
      };
      const source = await importTexture(settings);
      const embedded = await decodeImageForImport(
        makePng(16, 16, [200, 40, 40, 255]),
        'image/png',
        settings,
      );
      expect(embedded.ok).toBe(true);
      if (!embedded.ok) throw new Error('embedded image import failed');
      expect(embedded.value.texture).toEqual(source.payload);
      expect(embedded.value.bytes).toEqual(source.artifacts?.body?.bytes);
      expect(embedded.value.assetCodec?.name).toBe(source.artifacts?.body?.assetCodec?.name);
      expect(embedded.value.mediaType).toBe(
        compressionMode === 'none' ? 'image/png' : 'image/ktx2',
      );
    },
    30_000,
  );

  it('retains each import boundary interpretation of the auto mip token', async () => {
    const settings = { mipmap: 'auto', compressionMode: 'none' };
    const source = await importTexture(settings);
    const embedded = await decodeImageForImport(
      makePng(16, 16, [200, 40, 40, 255]),
      'image/png',
      settings,
    );
    expect((source.payload as TextureAsset).mips).toEqual({ kind: 'generate' });
    expect(embedded.ok && embedded.value.texture.mips).toEqual({ kind: 'none' });
  });

  it.skipIf(!pkgBuilt)(
    'a compressed mipmapped PNG bakes the full chain into the KTX2 and declares it packed',
    async () => {
      const asset = await importTexture({
        colorSpace: 'srgb',
        mipmap: true,
        compressionMode: 'uastc',
      });
      const body = asset.artifacts?.body;
      expect(body?.mediaType).toBe('image/ktx2');
      const parsed = await parseKtx2(body?.bytes ?? new Uint8Array());
      expect(parsed.ok && parsed.value.header.levelCount).toBe(5);
      expect((asset.payload as TextureAsset).mips).toEqual({ kind: 'packed', levelCount: 5 });
    },
    30_000,
  );

  it.skipIf(!pkgBuilt)(
    'a compressed PNG without mipmap stays a single packed level',
    async () => {
      const asset = await importTexture({
        colorSpace: 'srgb',
        mipmap: 'none',
        compressionMode: 'etc1s',
      });
      expect((asset.payload as TextureAsset).mips).toEqual({ kind: 'packed', levelCount: 1 });
    },
    30_000,
  );

  it('an uncompressed mipmapped PNG keeps runtime generation', async () => {
    const asset = await importTexture({
      colorSpace: 'srgb',
      mipmap: true,
      compressionMode: 'none',
    });
    expect((asset.payload as TextureAsset).mips).toEqual({ kind: 'generate' });
  });
});
