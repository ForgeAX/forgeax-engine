import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportProduct } from '@forgeax/engine-import';
import { DdcEntryStore, DdcGenerationSession, ddcOutputDigest } from '@forgeax/engine-ddc';
import { finalizePackageProduct, scanInventory } from '@forgeax/engine-pack/build';
import { catalogDeltaDigest, validateCatalogDelta } from '@forgeax/engine-types';

const guid = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const key = 'a'.repeat(64);
const root = await mkdtemp(join(tmpdir(), 'forgeax-owner-chain-smoke-'));

try {
  await writeFile(
    join(root, 'owner.pack.json'),
    JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid,
          kind: 'texture',
          sourceKey: 'owner/texture',
          sourceIndex: 0,
          payload: {},
          refs: [],
          artifacts: {},
        },
      ],
    }),
  );
  const inventory = await scanInventory([root]);
  if (!inventory.ok || inventory.value.inventory.length !== 1) throw new Error('inventory failed');
  const sourceRevision = inventory.value.inventory[0].sourceRevision;
  const imported = createImportProduct({
    assets: [{ guid, kind: 'texture', payload: { kind: 'texture' }, refs: [], artifacts: {} }],
    sourceDependencies: ['owner.pack.json'],
    refs: [],
    artifacts: {},
    receipts: [],
    diagnostics: [],
    sourceRevision,
    sourceKey: 'owner/texture',
  });
  if (!imported.ok) throw new Error('import product failed');
  const finalized = await finalizePackageProduct(
    {
      ...imported.value,
      receipts: [
        {
          guid,
          origin: 'sourceMeta',
          status: 'succeeded',
          inputFingerprint: sourceRevision,
        },
      ],
    },
    { base: '/assets', packagePath: 'owner.pack.json', artifactPath: () => 'owner.bin' },
  );
  if (!finalized.ok) throw new Error('package finalization failed');
  const entry = {
    key,
    guid,
    payload: finalized.value.pack.assets[0].payload,
    refs: [],
    artifacts: {},
    receipt: {
      guid,
      key,
      producer: 'owner-chain',
      inputFingerprint: sourceRevision,
      outputDigest: '',
    },
  };
  const stored = { ...entry, receipt: { ...entry.receipt, outputDigest: ddcOutputDigest(entry) } };
  await new DdcEntryStore(root).write(stored);
  const session = new DdcGenerationSession(root, { generation: 1 });
  const candidate = await session.beginCandidate(guid, key);
  const committed = await session.commitCandidate(candidate, key);
  const catalog = validateCatalogDelta({
    added: [{ guid, packageUrl: finalized.value.packageUrl, kind: 'texture', sourcePath: 'owner.pack' }],
    changed: [],
    removed: [],
  });
  if (!catalog.ok || committed.result !== 'current') throw new Error('owner chain rejected');
  console.log(JSON.stringify({ digest: catalogDeltaDigest(catalog.value), result: committed.result }));
  await session.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
