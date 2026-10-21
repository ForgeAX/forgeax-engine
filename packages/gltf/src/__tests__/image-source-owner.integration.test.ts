import type { ImportContext, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { gltfImporter } from '../gltf-importer';

describe('glTF image source ownership', () => {
  it('uses the same external buffer and image bytes admitted by the parser', async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 0, 0, 0, 0]);
    const reads: string[] = [];
    const decoded: Uint8Array[] = [];
    const json = {
      asset: { version: '2.0' },
      buffers: [{ uri: 'shared.bin', byteLength: png.length }],
      bufferViews: [{ buffer: 0, byteLength: png.length }],
      images: [
        { bufferView: 0, mimeType: 'image/png' },
        { uri: 'external.png', mimeType: 'image/png' },
      ],
    };
    const context: ImportContext = {
      source: 'model.gltf',
      subAssets: [0, 1].map((sourceIndex) => ({
        kind: 'texture',
        sourceIndex,
        guid: `019f0000-0000-7000-8000-00000000000${sourceIndex}`,
      })),
      importSettings: {},
      readSource: async () => ({ ok: true, value: new TextEncoder().encode(JSON.stringify(json)) }),
      readSibling: async (uri) => {
        reads.push(uri);
        // A subsequent read observes a different source revision.
        return {
          ok: true,
          value: reads.filter((path) => path === uri).length === 1 ? png : new Uint8Array(8),
        };
      },
      decodeImage: async (bytes) => {
        decoded.push(bytes);
        const texture: TextureAsset = {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'none' },
          data: new Uint8Array(4),
        };
        return { ok: true, value: { texture, bytes: texture.data } };
      },
    };
    const result = await gltfImporter.import(context);
    expect(result.ok).toBe(true);
    expect(reads).toEqual(['shared.bin', 'external.png']);
    expect(decoded).toEqual([png, png]);
  });
});
