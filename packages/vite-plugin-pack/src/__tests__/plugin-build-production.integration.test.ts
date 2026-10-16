import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const GUID = '00000000-0000-4000-8000-000000000003';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const fixtureImporter: Importer = {
  key: 'fixture',
  import: async () => ({
    ok: true,
    value: {
      assets: [
        {
          guid: GUID,
          kind: 'fixture-mesh',
          payload: { kind: 'fixture-mesh', vertexCount: 3 },
          refs: [],
          artifacts: {
            body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([4, 5, 6]) },
          },
        },
      ],
      sourceDependencies: ['fixture.scene'],
    },
  }),
};

describe('production Pack bundle contract', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('writes each complete publication once in a bound production catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scoped-catalog-build-'));
    roots.push(root);
    const assets = resolve(root, 'assets');
    await mkdir(assets);
    const count = 16;
    await writeFile(
      resolve(assets, 'samplers.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '019a0000-0000-7000-8000-000000000083',
        assets: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `sampler/${index}`,
            { kind: 'sampler', payload: { kind: 'sampler', magFilter: 'linear' }, refs: [] },
          ]),
        ),
      }),
    );
    const binding = createStandaloneRuntimeAssetBinding('scoped-catalog');
    const plugin = pluginPack({ roots: [assets], runtimeBinding: binding });
    const emitted: Array<{ fileName?: string; source?: string | Uint8Array }> = [];
    try {
      await plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName(referenceId) {
          return referenceId;
        },
      });
      const serialized = String(
        emitted.find((asset) => asset.fileName === 'pack-index.json')?.source,
      );
      const catalog = JSON.parse(serialized);
      const rows = decodeCatalogWire(catalog).unwrap();
      expect(rows).toHaveLength(count);
      expect(rows[0]?.publication?.outputs).toHaveLength(count);
      expect(serialized.match(/"schemaVersion":"asset-publication\/1"/g)).toHaveLength(1);
      // The full sibling roster is present once, instead of count squared outputs.
      expect(serialized.match(/"outputs":\[/g)).toHaveLength(1);
      expect(rows[0]?.publication).toBe(rows[count - 1]?.publication);
      expect(catalog).toMatchObject({
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: binding.scopeId,
        generation: binding.generation,
        authority: 'authoritative',
        diagnostics: [],
      });
    } finally {
      await plugin.closeBundle();
    }
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])(
    'validates direct plugin references after dynamic outputs exist: present=%s bound=%s',
    async (present, bound) => {
      const project = await mkdtemp(join(tmpdir(), 'forgeax-plugin-reference-build-'));
      roots.push(project);
      const assets = resolve(project, 'assets');
      await mkdir(assets);
      await writeFile(
        resolve(project, 'forge.json'),
        JSON.stringify({
          schemaVersion: '3.0.0',
          id: 'plugin-reference',
          name: 'Plugin reference',
          roots: {},
        }),
      );
      const namespace = '019a0000-0000-7000-8000-000000000081';
      const packageId = PackageId.parse(namespace);
      if (!packageId.ok) throw packageId.error;
      const samplerGuid = AssetGuid.format(AssetGuid.derive(packageId.value, 'sampler/main'));
      await writeFile(
        resolve(assets, 'generated.pack.ts'),
        `
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
export default definePack({
  schemaVersion: '2.0.0', packageId: definePackageId('${namespace}'),
  build: () => ok({ '${present ? 'sampler/main' : 'sampler/other'}': { kind: 'sampler', magFilter: 'linear' } }),
});
`,
      );
      await writeFile(resolve(assets, 'game.ts'), 'export default { apply() {} };');
      await writeFile(
        resolve(assets, 'game.pack.json'),
        JSON.stringify({
          schemaVersion: '3.0.0',
          packageId: '019a0000-0000-7000-8000-000000000082',
          assets: {
            'plugin/root': {
              kind: 'plugin',
              payload: {
                module: { specifier: './game.ts' },
                config: { sampler: { $asset: samplerGuid } },
              },
            },
          },
        }),
      );
      const previousCwd = process.cwd();
      process.chdir(project);
      const plugin = pluginPack({
        roots: [assets],
        ...(bound
          ? { runtimeBinding: createStandaloneRuntimeAssetBinding('plugin-reference') }
          : {}),
      });
      try {
        const emitted: Array<{ fileName?: string; source?: string | Uint8Array }> = [];
        const production = plugin.generateBundle.call({
          emitFile(asset) {
            emitted.push(asset);
            return asset.fileName ?? asset.name ?? 'asset';
          },
          getFileName(referenceId) {
            return referenceId;
          },
        });
        if (!present) {
          await expect(production).rejects.toMatchObject({ code: 'pack-output-reference-missing' });
          expect(emitted.some((asset) => asset.fileName === 'pack-index.json')).toBe(false);
          return;
        }
        await production;
        const catalog = JSON.parse(
          String(emitted.find((asset) => asset.fileName === 'pack-index.json')?.source),
        );
        if (bound) {
          expect(catalog).toMatchObject({
            schemaVersion: 'runtime-catalog-snapshot-v1',
            scopeId: 'plugin-reference',
            generation: 1,
            authority: 'authoritative',
            diagnostics: [],
          });
        }
        const entries = decodeCatalogWire(catalog).unwrap();
        expect(entries).toHaveLength(2);
        expect(entries.find((entry: { kind: string }) => entry.kind === 'plugin')?.refs).toEqual([
          samplerGuid,
        ]);
      } finally {
        await plugin.closeBundle();
        process.chdir(previousCwd);
      }
    },
    60_000,
  );

  it('emits the source-package product through the hashed production sink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-build-'));
    roots.push(root);
    const assets = resolve(root, 'assets');
    await mkdir(assets);
    await writeFile(resolve(assets, 'fixture.scene'), 'fixture');
    await writeFile(
      resolve(assets, 'fixture.scene.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'fixture.scene',
        importSettings: {},
        subAssets: [
          { guid: GUID, sourceIndex: 0, sourceKey: 'fixture/main', kind: 'fixture-mesh' },
        ],
      }),
    );
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const emitted: Array<{ fileName?: string; name?: string; source?: string | Uint8Array }> = [];
      const plugin = pluginPack({ roots: [assets], importers: [fixtureImporter] });
      plugin.configResolved?.({ base: '/preview/' } as Parameters<
        NonNullable<typeof plugin.configResolved>
      >[0]);
      await plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName(referenceId) {
          return `assets/${referenceId}-hash`;
        },
      });
      const catalog = decodeCatalogWire(
        JSON.parse(String(emitted.find((asset) => asset.fileName === 'pack-index.json')?.source)),
      ).unwrap();
      const row = catalog.find((entry) => entry.guid.toLowerCase() === GUID);
      expect(row?.packageUrl).toMatch(/^\/preview\/assets\/.*-hash$/);
      expect(row?.publication?.outputs).toEqual([
        expect.objectContaining({
          guid: GUID,
          sourceKey: 'fixture/main',
          kind: 'fixture-mesh',
        }),
      ]);
      expect(emitted.find((asset) => asset.fileName === `assets/${GUID}-body.bin`)?.source).toEqual(
        new Uint8Array([4, 5, 6]),
      );
      expect(
        emitted.some((asset) => asset.source?.toString().includes('createDevImportTransport')),
      ).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('retains the missing importer module in a failed production build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-missing-module-'));
    roots.push(root);
    const assets = resolve(root, 'assets');
    await mkdir(assets);
    await writeFile(resolve(assets, 'fixture.scene'), 'fixture');
    await writeFile(
      resolve(assets, 'fixture.scene.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'fixture.scene',
        importSettings: {},
        subAssets: [
          { guid: GUID, sourceIndex: 0, sourceKey: 'fixture/main', kind: 'fixture-mesh' },
        ],
      }),
    );
    const missingModule = resolve(root, 'pkg/missing-importer.mjs');
    const importer: Importer = {
      key: 'fixture',
      async import() {
        await import(/* @vite-ignore */ pathToFileURL(missingModule).href);
        throw new Error('missing module unexpectedly loaded');
      },
    };
    const plugin = pluginPack({ roots: [assets], importers: [importer] });
    const emitted: unknown[] = [];
    await expect(
      plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return 'unexpected';
        },
        getFileName(referenceId) {
          return referenceId;
        },
      }),
    ).rejects.toMatchObject({
      code: 'import-internal-error',
      expected: expect.stringContaining('fixture'),
      hint: expect.any(String),
      detail: { loadError: expect.stringContaining(pathToFileURL(missingModule).href) },
      message: expect.stringContaining('import-internal-error'),
    });
    expect(emitted).toEqual([]);
  });

  it('resolves a logical Catalog Pack path back through a symlinked build root', async () => {
    const project = await mkdtemp(join(tmpdir(), 'forgeax-pack-logical-build-'));
    roots.push(project);
    const physicalAssets = resolve(project, 'game', 'assets');
    const farmAssets = resolve(project, 'host-games', 'sample', 'assets');
    await mkdir(physicalAssets, { recursive: true });
    await mkdir(dirname(farmAssets), { recursive: true });
    await symlink(physicalAssets, farmAssets);
    const packSource = JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: GUID,
          kind: 'fixture-scene',
          payload: { kind: 'fixture-scene' },
          refs: [],
        },
      ],
    });
    await writeFile(resolve(physicalAssets, 'scene.pack.json'), packSource);
    const sourceRevision = `sha256:${createHash('sha256').update(packSource).digest('hex')}`;

    const previousCwd = process.cwd();
    process.chdir(project);
    try {
      const emitted: Array<{
        fileName?: string;
        name?: string;
        source?: string | Uint8Array;
      }> = [];
      const plugin = pluginPack({
        roots: [farmAssets],
        sourceIdentityFor: (sourcePath) =>
          basename(sourcePath) === 'scene.pack.json' ? 'assets/scene.pack.json' : sourcePath,
      });
      plugin.configResolved?.({ base: '/preview/' } as Parameters<
        NonNullable<typeof plugin.configResolved>
      >[0]);
      await plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName(referenceId) {
          return `assets/${referenceId}-hash`;
        },
      });

      const catalog = decodeCatalogWire(
        JSON.parse(String(emitted.find((asset) => asset.fileName === 'pack-index.json')?.source)),
      ).unwrap();
      expect(catalog).toContainEqual(
        expect.objectContaining({
          guid: GUID,
          sourcePath: 'assets/scene.pack.json',
          publication: expect.objectContaining({
            sourcePath: 'assets/scene.pack.json',
            sourceRevision,
          }),
        }),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('keeps the build owner on the semantic producer and outside runtime transport', async () => {
    const source = await readFile(resolve(ROOT, 'src', 'build', 'plugin-build.ts'), 'utf8');
    const ownerSource = await readFile(
      resolve(ROOT, '..', 'import', 'src', 'build-production.ts'),
      'utf8',
    );
    expect(source).toContain('produceBuildAssets');
    expect(ownerSource).toContain('produceSourcePackage');
    expect(source).not.toMatch(/createDevImportTransport|@forgeax\/engine-runtime/);
  });

  it('emits ScriptablePack roots and v3 instances as independent production packages', async () => {
    const project = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-build-'));
    roots.push(project);
    const assets = resolve(project, 'assets');
    await mkdir(assets);
    const rootPackageId = '019a0000-0000-7000-8000-000000000011';
    const instancePackageId = '019a0000-0000-7000-8000-000000000012';
    await writeFile(
      resolve(assets, 'filter.pack.ts'),
      `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${rootPackageId}'),
  parameters: [{ name: 'filter', type: 'enum', values: ['linear', 'nearest'], default: 'linear' }],
  build({ values }) {
    return ok({ 'sampler/main': { kind: 'sampler', magFilter: values.filter } });
  },
});
`,
    );
    await writeFile(
      resolve(assets, 'nearest.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: instancePackageId,
        parent: rootPackageId,
        values: { filter: 'nearest' },
      }),
    );

    const previousCwd = process.cwd();
    process.chdir(project);
    try {
      const emitted: Array<{
        fileName?: string;
        name?: string;
        source?: string | Uint8Array;
      }> = [];
      const plugin = pluginPack({ roots: [assets] });
      plugin.configResolved?.({ base: '/preview/' } as Parameters<
        NonNullable<typeof plugin.configResolved>
      >[0]);
      await plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName(referenceId) {
          return `assets/${referenceId}-hash`;
        },
      });
      const catalog = decodeCatalogWire(
        JSON.parse(String(emitted.find((asset) => asset.fileName === 'pack-index.json')?.source)),
      ).unwrap();
      expect(catalog).toHaveLength(2);
      expect(catalog.map((entry) => entry.packageId).sort()).toEqual(
        [rootPackageId, instancePackageId].sort(),
      );
      expect(catalog.every((entry) => entry.sourceKey === 'sampler/main')).toBe(true);
      const packages = emitted
        .filter((asset) => (asset.fileName ?? asset.name)?.endsWith('.pack.json'))
        .map(
          (asset) =>
            JSON.parse(
              typeof asset.source === 'string'
                ? asset.source
                : new TextDecoder().decode(asset.source),
            ) as {
              assets: Array<{ payload: { magFilter: string } }>;
            },
        );
      expect(packages.map((pack) => pack.assets[0]?.payload.magFilter).sort()).toEqual([
        'linear',
        'nearest',
      ]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('cooks direct producer-backed outputs before emitting the production Pack', async () => {
    const project = await mkdtemp(join(tmpdir(), 'forgeax-direct-pack-build-'));
    roots.push(project);
    const assets = resolve(project, 'assets');
    await mkdir(assets);
    const packageId = '019a0000-0000-7000-8000-000000000013';
    const parsedPackageId = PackageId.parse(packageId);
    if (!parsedPackageId.ok) throw parsedPackageId.error;
    const particleGuid = AssetGuid.format(AssetGuid.derive(parsedPackageId.value, 'vfx/main'));
    const samplerGuid = AssetGuid.format(AssetGuid.derive(parsedPackageId.value, 'sampler/main'));
    await writeFile(
      resolve(assets, 'direct.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: {
          'sampler/main': {
            kind: 'sampler',
            payload: {
              magFilter: 'linear',
              minFilter: 'linear',
              mipmapFilter: 'nearest',
              addressModeU: 'repeat',
              addressModeV: 'repeat',
              addressModeW: 'repeat',
            },
            refs: [],
          },
          'vfx/main': {
            kind: 'particle-effect',
            payload: {
              schemaVersion: 3,
              emitters: [{ id: 'main', program: { module: 'main.vfx.wgsl' }, renderers: [] }],
            },
            refs: [samplerGuid],
          },
        },
      }),
    );
    const cooker: NativeCooker = {
      key: 'particle-effect',
      cook: ({ guid }) => ({
        guid,
        payload: {
          kind: 'particle-effect',
          schemaVersion: 3,
          programFingerprint: 'sha256:direct-cooked',
          emitters: [],
          program: {
            format: 'forgeax-vfx-program-4',
            fingerprint: 'sha256:direct-cooked',
            emitters: [],
          },
        },
        refs: [samplerGuid],
        artifacts: {
          program: {
            mediaType: 'application/json',
            bytes: new TextEncoder().encode('{"program":"direct-cooked"}'),
          },
        },
        inputFingerprint: 'sha256:direct-cooked',
      }),
    };

    const previousCwd = process.cwd();
    process.chdir(project);
    try {
      const emitted: Array<{ fileName?: string; name?: string; source?: string | Uint8Array }> = [];
      const plugin = pluginPack({ roots: [assets], cookers: [cooker] });
      plugin.configResolved?.({ base: '/preview/' } as Parameters<
        NonNullable<typeof plugin.configResolved>
      >[0]);
      await plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName(referenceId) {
          return `assets/${referenceId}-hash`;
        },
      });
      const catalog = decodeCatalogWire(
        JSON.parse(String(emitted.find((asset) => asset.fileName === 'pack-index.json')?.source)),
      ).unwrap();
      const particle = catalog.find((entry) => entry.guid === particleGuid);
      expect(particle).toMatchObject({
        guid: particleGuid,
        kind: 'particle-effect',
        packageId,
        sourceKey: 'vfx/main',
        execution: 'cooked',
        refs: [samplerGuid],
      });
      const packageAsset = emitted.find((asset) =>
        asset.fileName?.endsWith(`${packageId}.pack.json`),
      );
      expect(packageAsset).toBeDefined();
      if (packageAsset === undefined) throw new Error('expected the direct Pack output');
      const pack = JSON.parse(
        typeof packageAsset.source === 'string'
          ? packageAsset.source
          : new TextDecoder().decode(packageAsset.source),
      ) as {
        assets: Array<{
          guid: string;
          payload: { programFingerprint?: string };
          artifacts: Record<string, { path: string }>;
        }>;
      };
      expect(pack.assets).toContainEqual(
        expect.objectContaining({
          guid: particleGuid,
          payload: expect.objectContaining({ programFingerprint: 'sha256:direct-cooked' }),
          artifacts: expect.objectContaining({ program: expect.anything() }),
        }),
      );
      expect(
        emitted.some((asset) =>
          String(asset.fileName ?? asset.name).includes(`${particleGuid}/program.bin`),
        ),
      ).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
