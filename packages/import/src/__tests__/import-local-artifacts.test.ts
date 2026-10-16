import type { ImportContext, ImportResult } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type RunImportMeta, runImport } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';

const MESH_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const TEXTURE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';

const meta: RunImportMeta = {
  importer: 'local-artifacts-fixture',
  source: 'fixture.source',
  subAssets: [
    { guid: MESH_GUID, sourceIndex: 0, sourceKey: 'fixture:mesh', kind: 'mesh' },
    { guid: TEXTURE_GUID, sourceIndex: 1, sourceKey: 'fixture:texture', kind: 'texture' },
  ],
};

function registryFor(value: unknown): ImporterRegistry {
  const registry = new ImporterRegistry();
  registry.register({
    key: meta.importer,
    import: async (_ctx: ImportContext): Promise<ImportResult> =>
      ({ ok: true, value }) as ImportResult,
  });
  return registry;
}

describe('asset-local ImportProduct contract', () => {
  it('digests the published JSON values consistently before and after typed-array transport', async () => {
    const declaration = meta.subAssets[0];
    if (declaration === undefined) throw new Error('expected a mesh declaration');
    const source = {
      kind: 'mesh',
      vertices: new Float32Array([0, 0.1, 2]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
    };
    const run = async (payload: unknown) => {
      const result = await runImport(
        { ...meta, subAssets: [declaration] },
        registryFor({
          assets: [{ guid: MESH_GUID, kind: 'mesh', payload, refs: [], artifacts: {} }],
          sourceDependencies: [],
        }),
        { readSource: async () => ({ ok: true as const, value: new Uint8Array([0]) }) },
      );
      if (!result.ok || 'skipped' in result.value) throw new Error('expected imported product');
      return result.value;
    };
    const native = await run(source);
    const published = JSON.parse(JSON.stringify(native.pack.assets[0]?.payload));
    const transported = await run(published);
    expect(transported.pack).toEqual(native.pack);
    expect(transported.cookProducts[0]?.digest).toBe(native.cookProducts[0]?.digest);
    published.vertices[1] = 0.2;
    expect((await run(published)).cookProducts[0]?.digest).not.toBe(native.cookProducts[0]?.digest);
    expect(source.vertices).toEqual(new Float32Array([0, 0.1, 2]));
  });

  it('keeps artifact ownership on each asset and preserves same keys across assets', async () => {
    const value = {
      assets: [
        {
          guid: MESH_GUID,
          kind: 'mesh',
          payload: { kind: 'mesh', vertices: [] },
          refs: [],
          artifacts: {
            body: {
              mediaType: 'application/x-forgeax-mesh',
              assetCodec: { name: 'mesh-binary', version: '4' },
              bytes: new Uint8Array([1]),
            },
          },
        },
        {
          guid: TEXTURE_GUID,
          kind: 'texture',
          payload: { kind: 'texture', width: 1, height: 1 },
          refs: [],
          artifacts: {
            body: {
              mediaType: 'image/ktx2',
              assetCodec: { name: 'basis', profile: 'uastc' },
              bytes: new Uint8Array([2]),
            },
          },
        },
      ],
      sourceDependencies: ['fixture.source'],
    };

    const result = await runImport(meta, registryFor(value), {
      readSource: async () => ({ ok: true as const, value: new Uint8Array([0]) }),
    });

    expect(result.ok).toBe(true);
    if (result.ok && 'product' in result.value) {
      expect(result.value).not.toHaveProperty('bins');
      expect(result.value.product.artifacts).toHaveProperty(`${MESH_GUID}/body`);
      expect(result.value.product.receipts).toHaveLength(2);
      expect(result.value.product.sourceRevision).toBe('source:fixture.source');
      expect(result.value.pack.assets[0]?.artifacts).toHaveProperty('body');
      expect(result.value.pack.assets[1]?.artifacts).toHaveProperty('body');
    }
  });

  it('rejects a package-global artifact list instead of accepting an ownerless body', async () => {
    const firstSubAsset = meta.subAssets[0];
    if (firstSubAsset === undefined) throw new Error('fixture must declare a sub-asset');
    const result = await runImport(
      { ...meta, subAssets: [firstSubAsset] },
      registryFor({
        assets: [
          {
            guid: MESH_GUID,
            kind: 'mesh',
            payload: { kind: 'mesh', vertices: [] },
            refs: [],
          },
        ],
        artifacts: [
          { path: 'mesh.bin', mimeType: 'application/octet-stream', bytes: new Uint8Array([1]) },
        ],
        sourceDependencies: ['fixture.source'],
      }),
      { readSource: async () => ({ ok: true as const, value: new Uint8Array([0]) }) },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('import-internal-error');
  });
});
