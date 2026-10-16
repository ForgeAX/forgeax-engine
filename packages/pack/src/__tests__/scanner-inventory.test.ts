import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventoryDigest } from '../inventory/sync.js';
import { scanInventory } from '../scanner.js';

describe('AssetInventory', () => {
  const guid = '00000000-0000-0000-0000-000000000002';
  let root: string | undefined;
  let sourcePath: string | undefined;
  let result: Awaited<ReturnType<typeof scanInventory>> | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-scanner-inventory-'));
    sourcePath = join(root, 'generated.pack.ts');
    await writeFile(
      sourcePath,
      [
        'const packageId = new Uint8Array(16);',
        'packageId[15] = 1;',
        'export default {',
        "schemaVersion: '2.0.0', packageId,",
        "build: () => ({ ok: true, value: { mesh: { kind: 'mesh' } } }),",
        '};',
      ].join('\n'),
    );
    result = await scanInventory([root]);
  });

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  const getFixture = () => {
    if (result === undefined || sourcePath === undefined) {
      throw new Error('scanner fixture was not initialized');
    }
    if (!result.ok) throw new Error('scanner fixture failed');
    return { inventory: result.value, sourcePath };
  };

  it('projects the ScriptablePack declaration and owner outputs', () => {
    const { inventory, sourcePath } = getFixture();
    const declaration = inventory.declarations.get(sourcePath);
    expect(declaration).toMatchObject({
      format: 'pack.ts',
      sourcePath,
      value: {
        schemaVersion: '2.0.0',
        kind: 'scriptable-pack-source',
        packageId: '00000000-0000-0000-0000-000000000001',
        source: sourcePath,
      },
    });
  });

  it('projects source closure evidence', async () => {
    const { inventory, sourcePath } = getFixture();
    const declaration = inventory.declarations.get(sourcePath);
    expect(
      declaration?.format === 'pack.ts'
        ? declaration.sourceClosure.map((entry) => entry.path)
        : undefined,
    ).toEqual([await realpath(sourcePath)]);
  });

  it('indexes the ScriptablePack declaration without a second metadata registry', () => {
    const { inventory, sourcePath } = getFixture();
    const declaration = inventory.declarations.get(sourcePath);
    expect(inventory.inventory).toEqual([]);
    expect(declaration?.format === 'pack.ts' ? declaration.definition : undefined).toMatchObject({
      packageId: expect.any(Uint8Array),
      schemaVersion: '2.0.0',
    });
  });

  it('keeps semantic identity stable when the source path is renamed', () => {
    const before = inventoryDigest({
      declarations: [{ guid, sourceKey: 'hero/body', kind: 'mesh', payload: {}, refs: [] }],
    });
    const after = inventoryDigest({
      declarations: [{ guid, sourceKey: 'hero/body', kind: 'mesh', payload: {}, refs: [] }],
    });

    expect(after).toBe(before);
    expect(after).not.toContain('generated.pack.ts');
  });
});
