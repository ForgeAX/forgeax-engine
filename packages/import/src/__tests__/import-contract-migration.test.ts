import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Asset, AssetRelation, ImportedAsset, ImportResult } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createImportProduct } from '../import-product.js';
import { type RunImportMeta, runImport } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';

const GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const DEPENDENCY_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';
const MESH = {
  kind: 'mesh',
  vertices: new Float32Array(),
  indices: new Uint16Array(),
  attributes: {},
} as unknown as Asset;

const relation: AssetRelation = {
  from: { type: 'asset', id: GUID },
  to: { type: 'asset', id: DEPENDENCY_GUID },
  type: 'references',
  provenance: { provider: 'fixture-producer', version: '2.0.0' },
};

function registry(): ImporterRegistry {
  const registry = new ImporterRegistry();
  registry.register({
    key: 'fixture',
    import: async (): Promise<ImportResult> => ({
      ok: true,
      value: {
        assets: [
          {
            guid: GUID,
            kind: 'mesh',
            payload: MESH,
            refs: [{ guid: DEPENDENCY_GUID }],
            artifacts: {},
          } satisfies ImportedAsset,
        ],
        sourceDependencies: [],
      },
    }),
  });
  return registry;
}

function readFs() {
  return {
    readSource: async () => ({ ok: true as const, value: new Uint8Array([1]) }),
  };
}

function multiMeta(
  overrides: readonly (Partial<RunImportMeta['subAssets'][number]> | undefined)[] = [],
): RunImportMeta {
  const entries = [
    { guid: GUID, sourceKey: 'scene/main', sourceIndex: 0, kind: 'mesh' },
    { guid: DEPENDENCY_GUID, sourceKey: 'scene/detail', sourceIndex: 1, kind: 'mesh' },
  ];
  return {
    importer: 'fixture',
    source: 'models/fixture.glb',
    subAssets: entries.map((entry, index) => ({ ...entry, ...(overrides[index] ?? {}) })),
  };
}

function meta(facts: Record<string, unknown> = {}): RunImportMeta {
  return {
    importer: 'fixture',
    source: 'models/fixture.glb',
    ...facts,
    subAssets: [
      {
        guid: GUID,
        sourceKey: 'scene/main',
        sourceIndex: 0,
        kind: 'mesh',
        relations: [relation],
      },
    ],
  } as unknown as RunImportMeta;
}

describe('import runner producer fact propagation', () => {
  it('rejects sourceIndex-only declarations before reading source or invoking importer', async () => {
    let reads = 0;
    const keyedMeta = multiMeta();
    const sourceIndexOnlyMeta: RunImportMeta = {
      ...keyedMeta,
      subAssets: keyedMeta.subAssets.map(
        ({ sourceKey: _sourceKey, ...declaration }) => declaration,
      ),
    };
    const result = await runImport(sourceIndexOnlyMeta, registry(), {
      readSource: async () => {
        reads += 1;
        return { ok: true as const, value: new Uint8Array([1]) };
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('source-validation-failed');
      expect(result.error.detail).toMatchObject({
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'source-key-required' }),
        ]),
      });
    }
    expect(reads).toBe(0);
  });

  it('rejects duplicate, empty, and malformed sourceKey before Meta publication', async () => {
    for (const override of [
      { sourceKey: 'scene/main' },
      { sourceKey: '   ' },
      { sourceKey: 7 as unknown as string },
    ]) {
      const result = await runImport(multiMeta([undefined, override]), registry(), readFs());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('source-validation-failed');
    }
  });

  it('preserves complete producer facts on the DDC row matched by GUID', async () => {
    const facts = {
      packageId: 'package/fixture',
      provenance: { provider: 'fixture-producer', version: '2.0.0', source: 'fixture.glb' },
      revision: { digest: 'sha256:fixture', observedAt: 42, rootId: 'root-fixture' },
      diagnostics: [
        {
          code: 'fixture-warning',
          severity: 'warning',
          hint: 'reimport the fixture when its source changes',
        },
      ],
    };
    const result = await runImport(meta(facts), registry(), readFs());

    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(result.value.pack).toMatchObject(facts);
    expect(result.value.pack.assets).toEqual([
      expect.objectContaining({
        guid: GUID,
        sourceKey: 'scene/main',
        sourceIndex: 0,
        relations: [relation],
      }),
    ]);
    expect(result.value.cookProducts).toEqual([
      expect.objectContaining({
        guid: GUID,
        payload: MESH,
        refs: [DEPENDENCY_GUID],
        artifacts: {},
        receipt: expect.objectContaining({
          guid: GUID,
          origin: 'sourceMeta',
          status: 'succeeded',
        }),
      }),
    ]);
  });

  it('keeps optional producer facts absent when the declaration has no evidence', async () => {
    const result = await runImport(meta(), registry(), readFs());

    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(result.value.pack).not.toHaveProperty('packageId');
    expect(result.value.pack).not.toHaveProperty('provenance');
    expect(result.value.pack).not.toHaveProperty('revision');
    expect(result.value.pack).not.toHaveProperty('diagnostics');
    expect(result.value.pack.assets[0]).toMatchObject({
      guid: GUID,
      sourceKey: 'scene/main',
      sourceIndex: 0,
      relations: [relation],
    });
  });

  it('removes package-global artifact and kind-specific bin contracts from the runner', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'import-runner.ts'), 'utf8');
    expect(source).not.toContain('RunImportOk.bins');
    expect(source).not.toContain('readonly bins');
    expect(source).not.toContain("a.kind === 'texture'");
    expect(source).not.toContain("a.kind === 'mesh'");
  });
});

describe('engine-import terminal product contract', () => {
  it('projects refs, artifacts, receipts, diagnostics, and source identity together', () => {
    const result = createImportProduct({
      assets: [
        {
          guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
          kind: 'texture',
          payload: { kind: 'texture', width: 1, height: 1 },
          refs: [],
          artifacts: {},
        },
      ],
      sourceDependencies: ['hero.png'],
      refs: [],
      artifacts: {},
      receipts: [],
      diagnostics: [],
      sourceRevision: 'sha256:hero',
      sourceKey: 'hero/albedo',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceRevision).toBe('sha256:hero');
    expect(result.value.sourceKey).toBe('hero/albedo');
    expect(result.value).toHaveProperty('refs');
    expect(result.value).toHaveProperty('artifacts');
    expect(result.value).toHaveProperty('receipts');
    expect(result.value).toHaveProperty('diagnostics');
  });
});
