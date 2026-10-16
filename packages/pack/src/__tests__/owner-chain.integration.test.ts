import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finalizePackageProduct } from '../package-finalizer.js';
import { scanInventory } from '../scanner.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

describe('Pack owner chain', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('scans source identity and finalizes the terminal package product', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-owner-chain-'));
    roots.push(root);
    await writeFile(
      join(root, 'hero.pack.json'),
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: GUID,
            kind: 'texture',
            sourceKey: 'hero/albedo',
            sourceIndex: 0,
            payload: {},
            refs: [],
            artifacts: {},
          },
        ],
      }),
    );
    const inventory = await scanInventory([root]);
    expect(inventory.ok).toBe(true);
    if (!inventory.ok) return;
    const writes: string[] = [];
    const result = await finalizePackageProduct(
      {
        assets: [
          {
            guid: GUID,
            kind: 'texture',
            payload: { kind: 'texture' },
            refs: [],
            artifacts: {
              body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1]) },
            },
          },
        ],
        receipts: [
          {
            guid: GUID,
            origin: 'sourceMeta',
            status: 'succeeded',
            inputFingerprint: inventory.value.inventory[0]?.sourceRevision ?? 'missing',
          },
        ],
        diagnostics: [],
        sourceRevision: inventory.value.inventory[0]?.sourceRevision ?? 'missing',
      },
      {
        base: '/assets',
        packagePath: 'hero.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
        sink: (path) => {
          writes.push(path);
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(writes).toEqual([`${GUID}/body.bin`, 'hero.pack.json']);
  });
});
