import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogImporterPolicyFor } from '@forgeax/engine-import';
import { buildCatalogProjection } from '@forgeax/engine-pack/build';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';

const scratch = temporaryDirectories();
const GOOD_GUID = '018e7a4d-1234-7abc-8def-000000000010';
const BAD_GUID = '018e7a4d-1234-7abc-8def-000000000011';

const meta = (importer: string, kind: string, guid = GOOD_GUID) => ({
  schemaVersion: '1.0.0',
  kind: 'external-asset-package',
  importer,
  source: 'asset.bin',
  importSettings: {},
  subAssets: [{ guid, sourceIndex: 0, kind, sourceKey: 'output/main' }],
});

const pack = (guid: string) => ({
  schemaVersion: '3.0.0',
  packageId: guid,
  assets: { blob: { kind: 'host/blob', payload: {}, refs: [] } },
});

async function makeRoot(name: string): Promise<string> {
  const root = await scratch.make(`forgeax-catalog-failure-${name}-`);
  return root;
}

async function writeMeta(root: string, value: unknown, name = 'asset.bin.meta.json') {
  await writeFile(join(root, 'asset.bin'), Buffer.from('fixture'));
  await writeFile(join(root, name), JSON.stringify(value));
}

afterEach(scratch.clear);

describe('catalog failure result', () => {
  it('allows a registered importer to produce an engine-owned asset schema', async () => {
    const root = await makeRoot('native-output');
    await writeMeta(root, meta('host-provider', 'texture'));
    const result = await buildCatalogProjection([root], {
      importerPolicy: catalogImporterPolicyFor(new Set(['host-provider'])),
    });
    expect(result.authority).toBe('authoritative');
    expect(result.diagnostics).toEqual([]);
    expect(result.entries).toMatchObject([
      { guid: GOOD_GUID, kind: 'texture', lifecycle: 'missing' },
    ]);
  });

  it('returns a structured conflict for an unregistered provider', async () => {
    const root = await makeRoot('unregistered');
    await writeMeta(root, meta('missing-provider', 'host/blob'));

    const result = await buildCatalogProjection([root], {
      importerPolicy: catalogImporterPolicyFor(),
    });

    expect(result.authority).toBe('degraded');
    expect(result.entries).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'catalog-raw-source-unsupported',
      expected: expect.any(String),
      actual: 'missing-provider',
      hint: expect.any(String),
    });
  });

  it('keeps browser-safe recovery fields after JSON roundtrip', async () => {
    const root = await makeRoot('json-roundtrip');
    await writeMeta(root, meta('missing-provider', 'host/blob'));
    const result = await buildCatalogProjection([root], {
      importerPolicy: catalogImporterPolicyFor(),
    });
    const diagnostic = result.diagnostics[0];
    const response = JSON.parse(JSON.stringify(diagnostic));

    expect(response).toMatchObject({
      code: 'catalog-raw-source-unsupported',
      expected: expect.any(String),
      hint: expect.any(String),
      actual: 'missing-provider',
    });
    expect(response.message).toContain('missing-provider');
  });

  it('rejects shader source rows instead of silently skipping them', async () => {
    const root = await makeRoot('shader-source');
    await writeMeta(root, meta('shader', 'shader'));

    const result = await buildCatalogProjection([root], {
      importerPolicy: catalogImporterPolicyFor(),
    });

    expect(result.authority).toBe('degraded');
    expect(result.entries).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'catalog-raw-source-unsupported',
      expected: expect.stringContaining('cooked'),
      actual: 'shader',
      hint: expect.any(String),
    });
  });

  it('marks schema or scan failure as degraded with an affected root', async () => {
    const root = await makeRoot('schema-failure');
    await writeMeta(root, { ...meta('gltf', 'mesh'), importSettings: 'invalid' });

    const result = await buildCatalogProjection([root], {
      importerPolicy: catalogImporterPolicyFor(),
    });

    expect(result.authority).toBe('degraded');
    expect(result.diagnostics).toMatchObject([
      {
        code: 'catalog-scan-failed',
        path: '<scan>',
        subjects: [root],
        expected: expect.any(String),
        actual: expect.any(String),
        hint: expect.any(String),
      },
    ]);
  });

  it('does not rescan or publish a partial Catalog after one inventory failure', async () => {
    const goodRoot = await makeRoot('partial-good');
    const badRoot = await makeRoot('partial-bad');
    await writeFile(join(goodRoot, 'good.pack.json'), JSON.stringify(pack(GOOD_GUID)));
    await writeFile(join(badRoot, 'first.pack.json'), JSON.stringify(pack(BAD_GUID)));
    await writeFile(join(badRoot, 'second.pack.json'), JSON.stringify(pack(BAD_GUID)));

    const result = await buildCatalogProjection([goodRoot, badRoot], {
      importerPolicy: catalogImporterPolicyFor(),
    });

    expect(result.authority).toBe('degraded');
    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'catalog-scan-failed',
        path: '<scan>',
        subjects: [goodRoot, badRoot],
      },
    ]);
  });

  it('keeps a prior LKG navigation URL visible without relabeling the failed row current', () => {
    const row = {
      guid: GOOD_GUID,
      kind: 'scene',
      sourcePath: 'generated.pack.ts',
      packageUrl: '/__forgeax-ddc/new.runtime-pack.json',
      subject: 'imported-output',
      execution: 'cooked',
      lifecycle: 'failed',
      projection: {
        subject: 'imported-output',
        execution: 'cooked',
        lifecycle: 'failed',
        operations: [],
        lastKnownGood: { packageUrl: '/__forgeax-ddc/old.runtime-pack.json' },
      },
    } as unknown as PackIndexEntry;

    const projected = {
      entries: [row],
      authority: 'degraded' as const,
      diagnostics: [
        {
          code: 'catalog-scriptable-pack-invalid' as const,
          path: 'generated.pack.ts',
          message: 'source generation failed',
        },
      ],
    };

    expect(projected.authority).toBe('degraded');
    expect(projected.entries[0]).toMatchObject({
      lifecycle: 'failed',
      packageUrl: '/__forgeax-ddc/new.runtime-pack.json',
      projection: {
        lifecycle: 'failed',
        lastKnownGood: { packageUrl: '/__forgeax-ddc/old.runtime-pack.json' },
      },
    });
  });
});
