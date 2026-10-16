import type { ImportContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { imageImporter } from '../image-importer.js';
import { makePng } from './make-fixture.js';

const GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';

function context(): ImportContext {
  return {
    source: 'textures/panel.png',
    readSource: async () => ({ ok: true as const, value: makePng(1, 1, [10, 20, 30, 255]) }),
    readSibling: async () => ({ ok: true as const, value: new Uint8Array() }),
    decodeImage: async () => {
      throw new Error('runtime decodeImage must not be used by static image import');
    },
    subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'texture' }],
    importSettings: { colorSpace: 'srgb', mipmap: 'none' },
  };
}

describe('image asset-local artifacts', () => {
  it('emits a local body with media type, codec, and bytes but no publish facts', async () => {
    const result = await imageImporter.import(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const asset = result.value.assets[0] as unknown as Record<string, unknown>;
    const artifacts = asset.artifacts as Record<string, Record<string, unknown>>;
    const body = artifacts.body;
    expect(body).toBeDefined();
    if (body === undefined) return;
    expect(body.mediaType).toBe('application/x-forgeax-rgba8');
    expect(body.assetCodec).toEqual({ name: 'rgba8', version: '1' });
    expect(body.bytes).toBeInstanceOf(Uint8Array);
    expect(body).not.toHaveProperty('path');
    expect(body).not.toHaveProperty('integrity');
  });
});
