import {
  ImporterRegistry,
  type ImportRunnerFs,
  produceSourcePackage,
} from '@forgeax/engine-import';
import type { ImportedAsset, Importer } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const GUID_A = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const GUID_B = '019e3969-1d48-7c3b-ac24-6d68f4570660';

function asset(guid: string): ImportedAsset {
  return {
    guid,
    kind: 'texture',
    payload: { kind: 'texture', width: 1, height: 1 },
    refs: [],
    artifacts: {
      body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
    },
  } as unknown as ImportedAsset;
}

function fixture(produced: readonly ImportedAsset[]) {
  const importer: Importer = {
    key: 'image',
    import: async () => ({ ok: true, value: { assets: produced, sourceDependencies: [] } }),
  };
  const registry = new ImporterRegistry();
  registry.register(importer);
  const fs: ImportRunnerFs = {
    readSource: async () => ({ ok: true, value: new Uint8Array([7, 8, 9]) }),
  };
  return {
    registry,
    fs,
    meta: {
      importer: 'image',
      source: 'fixture.png',
      subAssets: [
        { guid: GUID_A, sourceIndex: 0, kind: 'texture', sourceKey: 'image/main' },
        { guid: GUID_B, sourceIndex: 1, kind: 'texture', sourceKey: 'image/preview' },
      ],
    },
  };
}

describe('source package producer', () => {
  it('returns one complete package for every declared sibling', async () => {
    const input = fixture([asset(GUID_A), asset(GUID_B)]);

    const result = await produceSourcePackage(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.declaredGuids).toEqual([GUID_A, GUID_B]);
    expect(result.value.product.assets.map((item) => item.guid)).toEqual([GUID_A, GUID_B]);
    expect(result.value.anchorGuid).toBe(GUID_A);
  });

  it.each([
    ['missing', [asset(GUID_A)]],
    ['extra', [asset(GUID_A), asset(GUID_B), asset('019e3969-1d48-7c3b-ac24-6d68f4570661')]],
    ['wrong', [asset('019e3969-1d48-7c3b-ac24-6d68f4570661'), asset(GUID_B)]],
    ['duplicate', [asset(GUID_A), asset(GUID_A)]],
  ])('rejects a %s GUID closure mismatch without a partial package', async (_label, produced) => {
    const result = await produceSourcePackage(fixture(produced));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('source-package-guid-closure-mismatch');
    if (result.error.code !== 'source-package-guid-closure-mismatch') return;
    expect(result.error.detail.declaredGuids).toEqual([GUID_A, GUID_B]);
    expect(result.error.detail.producedGuids).toEqual(
      expect.arrayContaining([...new Set(produced.map((item) => item.guid))]),
    );
    expect(result.error.detail.stage).toBe('closure');
  });
});
