import type { ImportContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { audioImporter } from '../audio-importer.js';

describe('audio asset-local artifacts', () => {
  it('emits a source artifact body for the declared audio GUID', async () => {
    const context: ImportContext = {
      source: 'audio/intro.ogg',
      readSource: async () => ({ ok: true as const, value: new Uint8Array([1, 2, 3]) }),
      readSibling: async () => ({ ok: true as const, value: new Uint8Array() }),
      decodeImage: async () => {
        throw new Error('audio import must not use image decoding');
      },
      subAssets: [{ guid: 'audio-guid', sourceIndex: 0, kind: 'audio' }],
      importSettings: {},
    };

    const result = await audioImporter.import(context);
    expect(result).toMatchObject({ ok: true });
    if (!('ok' in (result as object)) || !(result as { ok: boolean }).ok) return;
    const asset = (result as { value: { assets: readonly Record<string, unknown>[] } }).value
      .assets[0];
    expect(asset?.payload).toMatchObject({ kind: 'audio', mediaType: 'audio/ogg' });
    expect(asset?.payload).not.toHaveProperty('bytes');
    const body = (asset?.artifacts as Record<string, Record<string, unknown>>).source;
    expect(body).toBeDefined();
    if (body === undefined) return;
    expect(body.mediaType).toBe('audio/ogg');
    expect(body.assetCodec).toEqual({ name: 'browser-audio', version: '1' });
    expect(body.bytes).toBeInstanceOf(Uint8Array);
    expect(body).not.toHaveProperty('path');
    expect(body).not.toHaveProperty('integrity');
  });
});
