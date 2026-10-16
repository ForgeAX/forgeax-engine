import type { ImportContext, ImportedAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { BakeAtlas, MsdfGenerator } from '../cli-font.js';
import { fontImporter } from '../font-importer.js';

const ATLAS_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const FONT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';

const atlas: BakeAtlas = {
  texture: { width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]) },
  glyphs: [],
  metrics: { lineHeight: 16, ascender: 12 },
  textureSize: [1, 1],
  fieldRange: 4,
};

function context(): ImportContext {
  const generatorFactory = async (): Promise<MsdfGenerator> => ({
    generateAtlas: async () => atlas,
    dispose: async () => undefined,
  });
  return {
    source: 'fonts/test.ttf',
    readSource: async () => ({ ok: true as const, value: new Uint8Array([0, 1, 0, 0]) }),
    readSibling: async () => ({ ok: true as const, value: new Uint8Array() }),
    decodeImage: async () => {
      throw new Error('font import does not use runtime image decoding');
    },
    subAssets: [
      { guid: ATLAS_GUID, sourceIndex: 0, kind: 'texture' },
      { guid: FONT_GUID, sourceIndex: 0, kind: 'font' },
    ],
    importSettings: { generatorFactory },
  };
}

describe('font asset-local artifacts', () => {
  it('keeps atlas bytes local and keeps font refs as GUID edges', async () => {
    const result = await fontImporter.import(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assets = result.value.assets as readonly ImportedAsset[];
    const atlasAsset = assets.find((asset: ImportedAsset) => asset.guid === ATLAS_GUID);
    expect(atlasAsset).toBeDefined();
    if (atlasAsset === undefined) return;
    const fontAsset = assets.find((asset: ImportedAsset) => asset.guid === FONT_GUID);
    const body = atlasAsset.artifacts.atlas;
    expect(body).toBeDefined();
    if (body === undefined) return;
    expect(body.mediaType).toBe('application/octet-stream');
    expect(body).not.toHaveProperty('assetCodec');
    expect(body.bytes).toBeInstanceOf(Uint8Array);
    expect(body.bytes).toEqual(atlas.texture.data);
    expect(body).not.toHaveProperty('path');
    expect(body).not.toHaveProperty('integrity');
    expect(fontAsset?.refs.map((ref) => ref.guid)).toEqual([ATLAS_GUID]);
  });
});
