import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { openFrontlinePublication } from '../frontline-workload.mjs';
import { hash } from '../workload.mjs';

const entry = {
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'mesh',
  sourcePath: 'fixture.mesh.ts',
  sourceKey: 'mesh/fixture',
  packageUrl: '/fixture.pack.json',
};
const catalog = {
  schemaVersion: 'runtime-catalog-snapshot-v1',
  scopeId: 'frontline-publication-test',
  generation: 1,
  authority: 'authoritative',
  entries: {
    schemaVersion: 'pack-index-tables/1',
    entries: [entry],
    publications: [],
    projections: [],
  },
  diagnostics: [],
};

for (const encoding of ['identity', 'zstd']) {
  test(`Frontline reads a normal ${encoding} catalog through the runtime owner`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontline-publication-'));
    try {
      const plain = Buffer.from(JSON.stringify(catalog));
      const encoded = encoding === 'zstd' ? await compressZstd(plain) : { ok: true, value: plain };
      assert(encoded.ok);
      const bytes = encoded.value;
      await writeFile(join(root, 'pack-index.json'), bytes);
      const publication = await openFrontlinePublication(new AssetRegistry(), root);
      assert.equal(publication.rows.length, 1);
      assert.equal(publication.rows[0].guid, entry.guid);
      assert.equal(publication.rows[0].sourceKey, entry.sourceKey);
      assert.deepEqual(publication.catalogBytes, Buffer.from(bytes));
      assert.deepEqual(publication.loaded.get('pack-index.json'), { bytes: bytes.length, sha256: hash(bytes) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('Frontline rejects invalid publication table references instead of accepting raw rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frontline-publication-invalid-'));
  try {
    await writeFile(join(root, 'pack-index.json'), JSON.stringify({
      ...catalog,
      entries: { ...catalog.entries, entries: [{ ...entry, publicationIndex: 0 }] },
    }));
    await assert.rejects(openFrontlinePublication(new AssetRegistry(), root), /asset-parse-failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
