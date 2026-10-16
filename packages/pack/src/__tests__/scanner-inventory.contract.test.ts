import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetGuid } from '../guid.js';
import { scan, scanInventory } from '../scanner.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

function guid(value: string): Uint8Array {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe('engine-pack scanner inventory contract', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps healthy sources in an explicit partial scan and reports each malformed sibling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-partial-inventory-'));
    roots.push(root);
    const healthy = join(root, 'healthy.pack.json');
    const broken = join(root, 'broken.pack.json');
    await writeFile(
      healthy,
      JSON.stringify({ schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] }),
    );
    await writeFile(broken, '{ invalid JSON');
    expect((await scanInventory([root])).ok).toBe(false);
    const diagnostics: { path: string; code: string }[] = [];
    const result = await scanInventory([root], {
      onSourceFailure: (path, error) => diagnostics.push({ path, code: error.code }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.paths).toEqual([healthy]);
    expect([...result.value.declarations.keys()]).toEqual([healthy]);
    expect(diagnostics).toEqual([{ path: broken, code: 'pack-malformed-pack' }]);
  });

  it('returns one inventory declaration with source identity before finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-inventory-'));
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
            payload: { kind: 'texture', width: 1, height: 1 },
            refs: [],
            sourceKey: 'hero/albedo',
            sourceIndex: 0,
          },
        ],
      }),
    );

    const result = await scanInventory([root]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inventory).toHaveLength(1);
    expect(result.value.inventory[0]).toMatchObject({
      guid: GUID,
      sourceKey: 'hero/albedo',
      sourceIndex: 0,
    });
  });

  it('returns the parsed Meta, Pack, and ScriptablePack declarations from one scan pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-declarations-'));
    roots.push(root);

    const metaPath = join(root, 'hero.meta.json');
    const packPath = join(root, 'environment.pack.json');
    const scriptablePath = join(root, 'effects.pack.ts');
    const meta = {
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'hero.png',
      importSettings: {},
      subAssets: [
        { guid: '019e3969-1d48-7c3b-ac24-6d68f4570660', sourceIndex: 0, kind: 'texture' },
      ],
    } as const;
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: '019e3969-1d48-7c3b-ac24-6d68f4570661',
          kind: 'texture',
          payload: { kind: 'texture', width: 1, height: 1 },
          refs: [],
        },
      ],
    } as const;
    await writeFile(join(root, 'hero.png'), 'source');
    await writeFile(metaPath, JSON.stringify(meta));
    await writeFile(packPath, JSON.stringify(pack));
    await writeFile(scriptablePath, '// scanner fixture');

    const scriptablePackageId = guid('019e3969-1d48-7c3b-ac24-6d68f4570662');
    const result = await scanInventory([root], {
      scriptablePack: {
        executor: {
          load: async () => ({
            default: {
              schemaVersion: '2.0.0',
              packageId: scriptablePackageId,
              build: () => ({ ok: true, value: { effect: { kind: 'scene', entities: {} } } }),
            },
          }),
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.declarations.size).toBe(3);
    expect(result.value.declarations.get(metaPath)).toMatchObject({
      format: 'meta.json',
      sourcePath: metaPath,
      value: meta,
    });
    expect(result.value.declarations.get(packPath)).toMatchObject({
      format: 'pack.json',
      sourcePath: packPath,
      value: pack,
    });
    const scriptableDeclaration = result.value.declarations.get(scriptablePath);
    expect(scriptableDeclaration).toMatchObject({
      format: 'pack.ts',
      sourcePath: scriptablePath,
      value: {
        packageId: '019e3969-1d48-7c3b-ac24-6d68f4570662',
      },
    });
    expect(
      scriptableDeclaration?.format === 'pack.ts' ? scriptableDeclaration.value : undefined,
    ).not.toHaveProperty('subAssets');
  });

  it('releases the ScriptablePack loader for the path-only scan contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-scan-release-'));
    roots.push(root);
    const scriptablePath = join(root, 'effects.pack.ts');
    await writeFile(scriptablePath, '// scanner fixture');

    const packageId = guid('019e3969-1d48-7c3b-ac24-6d68f4570664');
    let disposals = 0;
    const result = await scan([root], {
      scriptablePack: {
        executor: {
          load: async () => ({
            default: {
              schemaVersion: '2.0.0',
              packageId,
              build: () => ({ ok: true, value: { effect: { kind: 'scene', entities: {} } } }),
            },
          }),
          dispose: async () => {
            disposals += 1;
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(disposals).toBe(1);
  });

  it('characterizes the public scanner inventory vocabulary', () => {
    expect(typeof scan).toBe('function');
    expect(typeof scanInventory).toBe('function');
  });
});
