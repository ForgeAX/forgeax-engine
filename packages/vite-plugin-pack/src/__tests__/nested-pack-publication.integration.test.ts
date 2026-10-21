// @perf-budget-skip: real Vite build and development publication.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createStandaloneRuntimeAssetBinding, type PackIndexEntry } from '@forgeax/engine-types';
import { build, createServer } from 'vite';
import { expect, it } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

it.each([
  'build',
  'serve',
] as const)('keeps imported and cloned same-name Packs independent during %s', async (command) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-nested-packs-')));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await writeFile(join(root, 'package.json'), '{"name":"nested-packs","type":"module"}');
    await writeFile(join(root, 'index.html'), '<html><body>Nested Packs</body></html>');
    const packs = [
      { path: 'assets/original/assets/ui.pack.ts', id: '019a0000-0000-7000-8000-000000000021' },
      { path: 'assets/cloned/assets/ui.pack.ts', id: '019a0000-0000-7000-8000-000000000022' },
    ];
    for (const pack of packs) {
      await mkdir(join(root, pack.path, '..'), { recursive: true });
      await writeFile(
        join(root, pack.path),
        `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
export const ui = { apply() { throw new Error('publication must not activate'); } };
export default definePack({ schemaVersion: '2.0.0', plugins: true, packageId: definePackageId('${pack.id}'),
  build() { return ok({ 'plugin/ui': { kind: 'plugin', module: { specifier: './ui.pack.ts', export: 'ui' } } }); }
});`,
      );
    }
    const plugin = pluginPack({
      roots: [join(root, 'assets')],
      sourceIdentityFor: (path) => relative(root, path).replaceAll('\\', '/'),
      runtimeBinding: createStandaloneRuntimeAssetBinding('nested-packs'),
      watch: false,
      ddc: { projectDdcRoot: join(root, '.forgeax/ddc') },
    });
    const config = {
      root,
      configFile: false as const,
      logLevel: 'silent' as const,
      plugins: [plugin],
    };
    let rows: readonly PackIndexEntry[];
    if (command === 'build') {
      await build(config);
      const catalog = JSON.parse(await readFile(join(root, 'dist/pack-index.json'), 'utf8'));
      expect(catalog).toMatchObject({
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: 'nested-packs',
        generation: 1,
        authority: 'authoritative',
      });
      rows = decodeCatalogWire(catalog).unwrap();
    } else {
      server = await createServer({ ...config, server: { host: '127.0.0.1', port: 0 } });
      await plugin.ready();
      await server.listen();
      rows = plugin.catalogSnapshot();
    }
    expect(rows).toHaveLength(2);
    for (const pack of packs) {
      const id = PackageId.parse(pack.id);
      if (!id.ok) throw id.error;
      expect(rows).toContainEqual(
        expect.objectContaining({
          guid: AssetGuid.format(AssetGuid.derive(id.value, 'plugin/ui')),
          packageId: pack.id,
          sourcePath: pack.path,
          publication: expect.objectContaining({ sourcePath: pack.path }),
        }),
      );
    }
    expect(new Set(rows.map((row) => row.packageUrl)).size).toBe(2);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
