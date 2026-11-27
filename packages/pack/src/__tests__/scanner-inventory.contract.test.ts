import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import { AssetGuid } from '../guid.js';
import { scan, scanInventory } from '../scanner.js';
import { directPackFixture } from './support/direct-pack-fixture.js';

const GUID = 'ca7501e7-f752-5f69-87b4-7b41063a509b';

function guid(value: string): Uint8Array {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe('engine-pack scanner inventory contract', () => {
  const scratch = temporaryDirectories();

  afterEach(scratch.clear);

  it('keeps healthy sources in an explicit partial scan and reports each malformed sibling', async () => {
    const root = await scratch.make('forgeax-pack-partial-inventory-');
    const healthy = join(root, 'healthy.pack.json');
    const broken = join(root, 'broken.pack.json');
    const legacy = join(root, 'legacy.pack.json');
    await writeFile(
      healthy,
      JSON.stringify(directPackFixture('019e3800-0000-7000-8000-73742e747331', {})),
    );
    await writeFile(broken, '{ invalid JSON');
    await writeFile(
      legacy,
      JSON.stringify({ schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] }),
    );
    expect((await scanInventory([root])).ok).toBe(false);
    const diagnostics: { path: string; code: string }[] = [];
    const result = await scanInventory([root], {
      onSourceFailure: (path, error) => diagnostics.push({ path, code: error.code }),
    });
    if (!result.ok) throw result.error;
    expect(result.value.paths).toEqual([healthy]);
    expect([...result.value.declarations.keys()]).toEqual([healthy]);
    expect(diagnostics).toEqual([
      { path: broken, code: 'pack-malformed-pack' },
      { path: legacy, code: 'pack-malformed-pack' },
    ]);
  });

  it('returns the parsed Meta, Pack, and ScriptablePack declarations from one scan pass', async () => {
    const root = await scratch.make('forgeax-pack-declarations-');

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
      schemaVersion: '3.0.0',
      packageId: '019e3969-1d48-7c3b-ac24-6d68f457065f',
      assets: {
        'hero/albedo': {
          kind: 'texture',
          payload: { kind: 'texture', width: 1, height: 1 },
          refs: [],
        },
      },
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

    if (!result.ok) throw result.error;
    expect(result.value.inventory.find(({ sourcePath }) => sourcePath === packPath)).toMatchObject({
      guid: GUID,
      sourcePath: packPath,
      sourceKey: 'hero/albedo',
      sourceIndex: 0,
    });
    expect(result.value.declarations.size).toBe(3);
    expect(result.value.declarations.get(metaPath)).toMatchObject({
      format: 'meta.json',
      sourcePath: metaPath,
      value: meta,
    });
    expect(result.value.declarations.get(packPath)).toMatchObject({
      format: 'pack.json',
      sourcePath: packPath,
      value: { ...pack, format: 'direct', packageId: guid(pack.packageId) },
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
    const root = await scratch.make('forgeax-pack-scan-release-');
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

    if (!result.ok) throw result.error;
    expect(disposals).toBe(1);
  });
});
