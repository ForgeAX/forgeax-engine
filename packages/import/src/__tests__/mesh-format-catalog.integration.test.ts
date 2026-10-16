import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalogResult } from '../index.js';

describe('engine-owned mesh format Catalog admission', () => {
  it.each([
    'obj',
    'stl',
    'svg',
  ])('publishes reserved mesh outputs from the standard %s producer', async (importer) => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-mesh-catalog-'));
    try {
      const source = `mesh.${importer}`;
      const guid = '018e7a4d-1234-7abc-8def-000000000010';
      await writeFile(join(root, source), 'source fixture');
      await writeFile(
        join(root, `${source}.meta.json`),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'external-asset-package',
          importer,
          source,
          importSettings: {},
          subAssets: [{ guid, kind: 'mesh', sourceIndex: 0, sourceKey: 'mesh:Example' }],
        }),
      );
      const result = await buildCatalogResult([root], '/', new Set([importer]));
      expect(result.authority).toBe('authoritative');
      expect(result.diagnostics).toEqual([]);
      expect(result.entries).toMatchObject([{ guid, kind: 'mesh', sourceKey: 'mesh:Example' }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
