import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { build, createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetRegistry } from '../../../assets-runtime/src/asset-registry.js';
import { createCatalogSource } from '../../../assets-runtime/src/catalog-source.js';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const ROOT_PACKAGE_ID = '019a0000-0000-7000-8000-000000000001';
const INSTANCE_PACKAGE_ID = '019a0000-0000-7000-8000-000000000002';

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  if (!accept(value)) throw new Error('timed out waiting for ScriptablePack rebuild');
  return value;
}

describe('ScriptablePack and Pack development publication', () => {
  let root: string | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('shares one Meta production for concurrent sibling imports and recooks a watched revision', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-meta-sibling-vite-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const sourcePath = join(assets, 'siblings.fixture');
    await writeFile(sourcePath, 'first');
    const guids = [
      '019a0000-0000-7000-8000-000000000021',
      '019a0000-0000-7000-8000-000000000022',
    ] as const;
    await writeFile(
      `${sourcePath}.meta.json`,
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'sibling-fixture',
        source: 'siblings.fixture',
        importSettings: {},
        subAssets: guids.map((guid, sourceIndex) => ({
          guid,
          sourceIndex,
          sourceKey: `mesh/${sourceIndex}`,
          kind: 'fixture-mesh',
        })),
      }),
    );
    let enterImport!: () => void;
    const importEntered = new Promise<void>((resolve) => {
      enterImport = resolve;
    });
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let observeSiblingRequest!: () => void;
    const siblingRequest = new Promise<void>((resolve) => {
      observeSiblingRequest = resolve;
    });
    let imports = 0;
    const importer: Importer = {
      key: 'sibling-fixture',
      async import(context) {
        imports += 1;
        if (imports === 1) {
          enterImport();
          await importGate;
        }
        const source = await context.readSource();
        if (!source.ok) throw source.error;
        return {
          ok: true,
          value: {
            assets: guids.map((guid) => ({
              guid,
              kind: 'fixture-mesh',
              payload: { kind: 'fixture-mesh', revision: new TextDecoder().decode(source.value) },
              refs: [],
              artifacts: { body: { mediaType: 'application/octet-stream', bytes: source.value } },
            })),
            sourceDependencies: [],
          },
        };
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('meta-sibling-vite');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      producerReadiness: 'on-demand',
      importers: [importer],
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'observe-sibling-http-request',
          configureServer(target) {
            target.middlewares.use((request, _response, next) => {
              next();
              if (
                request.method === 'POST' &&
                request.url === `${binding.importUrlBase}/${guids[1]}`
              )
                observeSiblingRequest();
            });
          },
        },
        plugin,
      ],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const base = server.resolvedUrls?.local[0];
    if (!base) throw new Error('Vite did not expose its local URL');
    const readCatalog = async () => {
      const response = await fetch(new URL(binding.catalogUrl, base));
      expect(response.status).toBe(200);
      return response.json();
    };
    const post = (guid: string) =>
      fetch(new URL(`${binding.importUrlBase}/${guid}`, base), { method: 'POST' });
    expect((await readCatalog()).entries).toHaveLength(2);
    const first = post(guids[0]);
    await importEntered;
    const second = post(guids[1]);
    try {
      await siblingRequest;
      // The first producer is still held while the real second HTTP request
      // and an independent Catalog read cross the live Vite transport.
      expect(
        (await readCatalog()).entries.every(
          (row: { lifecycle: string }) => row.lifecycle === 'missing',
        ),
      ).toBe(true);
    } finally {
      releaseImport();
    }
    for (const [index, response] of (await Promise.all([first, second])).entries()) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ guid: guids[index] })]),
      );
    }
    const assertClosure = async (revision: string) => {
      const catalog = await readCatalog();
      expect(catalog.entries.map((row: { guid: string }) => row.guid).sort()).toEqual(
        [...guids].sort(),
      );
      for (const row of catalog.entries) {
        expect(row.lifecycle).toBe('current');
        const response = await fetch(new URL(row.packageUrl, base));
        expect(response.status).toBe(200);
        const pack = await response.json();
        expect(pack.assets.map((asset: { guid: string }) => asset.guid).sort()).toEqual(
          [...guids].sort(),
        );
        for (const asset of pack.assets) {
          expect(asset.payload.revision).toBe(revision);
          const body = await fetch(
            new URL(asset.artifacts.body.path, new URL(row.packageUrl, base)),
          );
          expect(body.status).toBe(200);
          expect(await body.text()).toBe(revision);
        }
      }
    };
    await assertClosure('first');
    expect(imports).toBe(1);
    const beforeWatch = imports;
    await writeFile(sourcePath, 'second');
    await waitFor(
      async () => {
        const response = await post(guids[0]);
        expect(response.status).toBe(200);
        await response.json();
        return imports;
      },
      (count) => count > beforeWatch,
    );
    await assertClosure('second');
    expect(imports).toBe(beforeWatch + 1);
  }, 30_000);

  it('retains authored plugin publications after on-demand Meta import for a fresh Registry', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-plugin-demand-reload-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(root, 'package.json'), '{"name":"plugin-demand-reload","type":"module"}');
    await writeFile(
      join(assets, 'root.pack.ts'),
      `
      import { definePack, definePackageId } from '@forgeax/engine-pack/source';
      import { ok } from '@forgeax/engine-types';
      export const root = { apply() {} };
      export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${ROOT_PACKAGE_ID}'),
        build() { return ok({ 'plugin/engine': { kind: 'plugin', module: { specifier: './root.pack.ts', export: 'root' } } }); } });
    `,
    );
    const uiGuid = '01900000-0000-7000-8000-aaaaaaaaaaaa';
    await writeFile(join(assets, 'guide.ui.html'), '<div>guide</div>');
    await writeFile(join(assets, 'guide.ui.css'), 'div { color: white; }');
    await writeFile(
      join(assets, 'guide.ui.html.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'ui',
        source: 'guide.ui.html',
        importSettings: {},
        subAssets: [{ guid: uiGuid, sourceKey: 'ui/guide', sourceIndex: 0, kind: 'ui' }],
      }),
    );
    const binding = createStandaloneRuntimeAssetBinding('plugin-demand-reload');
    const plugin = pluginPack({
      roots: [assets],
      producerReadiness: 'on-demand',
      importers: [createUiImporter()],
      runtimeBinding: binding,
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
      watch: false,
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await plugin.ready();
    await server.listen();
    const base = server.resolvedUrls?.local[0];
    if (!base) throw new Error('Vite did not expose its local URL');
    const catalogUrl = new URL(binding.catalogUrl, base).href;
    const definition = (await plugin.readPluginDefinitions())[0]?.definition;
    if (!definition) throw new Error('authored plugin not published');
    const catalog = async () => {
      const result = await createCatalogSource({
        url: catalogUrl,
        expectedScope: binding,
      }).enumerate();
      if (!result.ok) throw result.error;
      return result.value;
    };
    const beforeImport = await catalog();
    expect(beforeImport.find((row) => row.guid === definition.guid)?.publication).toBeDefined();
    const read = async () => {
      const registry = new AssetRegistry({} as never);
      registry.configureRuntimeBinding({ ...binding, catalogUrl });
      registry.setCatalogSource(createCatalogSource({ url: catalogUrl, expectedScope: binding }));
      try {
        return await registry.readPluginDefinition(definition.guid);
      } finally {
        registry.clearCatalogSource();
      }
    };
    expect((await read()).ok).toBe(true);
    const imported = await fetch(new URL(`${binding.importUrlBase}/${uiGuid}`, base), {
      method: 'POST',
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ guid: uiGuid, publication: expect.any(Object) }),
      ]),
    );
    const reopened = await read();
    expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
    if (reopened.ok) expect(reopened.value.evidence).toEqual(definition.evidence);
    const afterImport = await catalog();
    expect(afterImport.find((row) => row.guid === definition.guid)).toEqual(
      beforeImport.find((row) => row.guid === definition.guid),
    );
    expect(afterImport.find((row) => row.guid === uiGuid)?.publication).toBeDefined();

    const pluginSource = join(assets, 'root.pack.ts');
    await rm(pluginSource);
    expect(await plugin.rebuildCatalogInPlace([pluginSource])).toBe(true);
    expect((await catalog()).some((row) => row.guid === definition.guid)).toBe(false);
    expect(await read()).toMatchObject({ ok: false, error: { code: 'asset-not-found' } });
  }, 30_000);

  it.each([
    'serve',
    'build',
  ] as const)('reads byte-emitted plugin Pack definitions through actual Vite %s', async (mode) => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-mixed-plugin-vite-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(root, 'package.json'), '{"name":"mixed-plugin","type":"module"}');
    await writeFile(join(assets, 'plugin.ts'), 'export default { apply() {} };');
    await writeFile(
      join(assets, 'plugin.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: ROOT_PACKAGE_ID,
        assets: {
          root: {
            kind: 'plugin',
            payload: { module: { specifier: './plugin.ts' }, config: { speed: 3 } },
          },
        },
      }),
    );
    await writeFile(
      join(assets, 'sampler.pack.ts'),
      `
      import { definePack, definePackageId } from '@forgeax/engine-pack/source';
      import { ok } from '@forgeax/engine-types';
      export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${INSTANCE_PACKAGE_ID}'),
        build() { return ok({ sampler: { kind: 'sampler', magFilter: 'linear' } }); } });
    `,
    );
    const binding = createStandaloneRuntimeAssetBinding('mixed-plugin');
    const plugin = pluginPack({
      roots: [assets],
      watch: false,
      runtimeBinding: binding,
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
    });
    let definitions: Awaited<ReturnType<typeof plugin.readPluginDefinitions>>;
    if (mode === 'serve') {
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin],
        server: { host: '127.0.0.1', port: 0 },
      });
      await plugin.ready();
      const accepted = plugin.catalogSnapshot().find((row) => row.kind === 'plugin');
      expect(accepted?.publication).toBeDefined();
      await server.listen();
      expect(plugin.catalogSnapshot().find((row) => row.kind === 'plugin')).toEqual(accepted);
      definitions = await plugin.readPluginDefinitions();
    } else {
      await writeFile(join(root, 'entry.js'), 'export const ready = true;');
      definitions = [];
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          plugin,
          {
            name: 'verify-plugin-inventory',
            async generateBundle() {
              definitions = await plugin.readPluginDefinitions();
            },
          },
        ],
        build: { write: false, rollupOptions: { input: join(root, 'entry.js') } },
      });
    }
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.definition.asset.config).toEqual({ speed: 3 });
  });

  it('publishes a root and a v3 instance through the dynamic Catalog path', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-vite-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(
      join(assets, 'filter.pack.ts'),
      `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${ROOT_PACKAGE_ID}'),
  parameters: [{ name: 'filter', type: 'enum', values: ['linear', 'nearest'], default: 'linear' }],
  build({ values }) {
    return ok({
      'sampler/main': { kind: 'sampler', magFilter: values.filter },
    });
  },
});
`,
    );
    await writeFile(
      join(assets, 'nearest.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: INSTANCE_PACKAGE_ID,
        parent: ROOT_PACKAGE_ID,
        values: { filter: 'nearest' },
      }),
    );

    const binding = createStandaloneRuntimeAssetBinding('scriptable-pack-vite');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();

    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined) throw new Error('Vite did not expose a local URL');
    const catalogResponse = await fetch(new URL(binding.catalogUrl, baseUrl));
    const catalogBody = await catalogResponse.text();
    expect(catalogResponse.status, catalogBody).toBe(200);
    const catalog = JSON.parse(catalogBody) as {
      entries: Array<{ packageId?: string; packageUrl: string; sourceKey?: string }>;
    };
    expect(catalog.entries).toHaveLength(2);
    const rootEntry = catalog.entries.find((entry) => entry.packageId === ROOT_PACKAGE_ID);
    const instanceEntry = catalog.entries.find((entry) => entry.packageId === INSTANCE_PACKAGE_ID);
    expect(rootEntry).toBeDefined();
    expect(instanceEntry).toBeDefined();
    if (rootEntry === undefined || instanceEntry === undefined) {
      throw new Error('expected root and instance Catalog rows');
    }
    expect(rootEntry.sourceKey).toBe('sampler/main');
    expect(instanceEntry.sourceKey).toBe('sampler/main');
    expect(instanceEntry.packageUrl).not.toBe(rootEntry.packageUrl);

    const rootPackage = await fetch(new URL(rootEntry.packageUrl, baseUrl));
    const instancePackage = await fetch(new URL(instanceEntry.packageUrl, baseUrl));
    expect(rootPackage.status).toBe(200);
    const instanceBody = await instancePackage.text();
    expect(instancePackage.status, instanceBody).toBe(200);
    expect((await rootPackage.json()).assets[0].payload.magFilter).toBe('linear');
    expect(JSON.parse(instanceBody).assets[0].payload.magFilter).toBe('nearest');

    await writeFile(
      join(assets, 'nearest.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: INSTANCE_PACKAGE_ID,
        parent: ROOT_PACKAGE_ID,
        values: { filter: 'linear' },
      }),
    );
    const refreshed = await waitFor(
      async () => {
        const response = await fetch(new URL(binding.catalogUrl, baseUrl));
        return (await response.json()) as typeof catalog;
      },
      (next) =>
        next.entries.find((entry) => entry.packageId === INSTANCE_PACKAGE_ID)?.packageUrl !==
        instanceEntry.packageUrl,
    );
    const refreshedEntry = refreshed.entries.find(
      (entry) => entry.packageId === INSTANCE_PACKAGE_ID,
    );
    if (refreshedEntry === undefined) throw new Error('expected the refreshed instance row');
    const refreshedPackage = await fetch(new URL(refreshedEntry.packageUrl, baseUrl));
    expect(refreshedPackage.status).toBe(200);
    expect((await refreshedPackage.json()).assets[0].payload.magFilter).toBe('linear');
  }, 60_000);

  it('publishes a direct producer-backed Pack through the dev cooked transport', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-direct-pack-vite-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const packageId = '019a0000-0000-7000-8000-000000000014';
    const parsedPackageId = PackageId.parse(packageId);
    if (!parsedPackageId.ok) throw parsedPackageId.error;
    const guid = AssetGuid.format(AssetGuid.derive(parsedPackageId.value, 'vfx/main'));
    await writeFile(
      join(assets, 'direct.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: {
          'vfx/main': {
            kind: 'particle-effect',
            payload: {
              schemaVersion: 3,
              emitters: [{ id: 'main', program: { module: 'main.vfx.wgsl' }, renderers: [] }],
            },
            refs: [],
          },
        },
      }),
    );
    const cooker: NativeCooker = {
      key: 'particle-effect',
      cook: ({ guid: inputGuid }) => ({
        guid: inputGuid,
        payload: {
          kind: 'particle-effect',
          schemaVersion: 3,
          programFingerprint: 'sha256:dev-cooked',
          emitters: [],
          program: {
            format: 'forgeax-vfx-program-4',
            fingerprint: 'sha256:dev-cooked',
            emitters: [],
          },
        },
        refs: [],
        artifacts: {
          program: {
            mediaType: 'application/json',
            bytes: new TextEncoder().encode('{"program":"dev-cooked"}'),
          },
        },
        inputFingerprint: 'sha256:dev-cooked',
      }),
    };

    const binding = createStandaloneRuntimeAssetBinding('direct-pack-vite');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      cookers: [cooker],
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();

    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined) throw new Error('Vite did not expose a local URL');
    const catalogResponse = await fetch(new URL(binding.catalogUrl, baseUrl));
    const catalogBody = await catalogResponse.text();
    expect(catalogResponse.status, catalogBody).toBe(200);
    const catalog = (await JSON.parse(catalogBody)) as {
      entries: Array<{
        guid: string;
        kind: string;
        packageUrl: string;
        execution?: string;
      }>;
    };
    const entry = catalog.entries.find((candidate) => candidate.guid === guid);
    expect(entry).toMatchObject({ guid, kind: 'particle-effect', execution: 'cooked' });
    if (entry === undefined) throw new Error('expected the direct cooked Catalog row');
    const packageResponse = await fetch(new URL(entry.packageUrl, baseUrl));
    const packageBody = await packageResponse.text();
    expect(packageResponse.status, packageBody).toBe(200);
    const pack = JSON.parse(packageBody) as {
      assets: Array<{
        guid: string;
        payload: { programFingerprint?: string };
        artifacts: Record<string, { path: string }>;
      }>;
    };
    const asset = pack.assets.find((candidate) => candidate.guid === guid);
    expect(asset).toMatchObject({
      payload: { programFingerprint: 'sha256:dev-cooked' },
      artifacts: { program: { path: expect.any(String) } },
    });
    if (asset === undefined) throw new Error('expected the direct cooked Pack asset');
    const artifactPath = asset.artifacts.program?.path;
    if (artifactPath === undefined) throw new Error('expected the direct cooked artifact');
    const artifactResponse = await fetch(new URL(artifactPath, new URL(entry.packageUrl, baseUrl)));
    const artifactBody = await artifactResponse.text();
    expect(artifactResponse.status, artifactBody).toBe(200);
    expect(artifactBody).toBe('{"program":"dev-cooked"}');
  }, 60_000);

  it('accepts direct Pack refs to a separately declared Meta asset', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-direct-pack-meta-ref-vite-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const packageId = '019a0000-0000-7000-8000-000000000015';
    const parsedPackageId = PackageId.parse(packageId);
    if (!parsedPackageId.ok) throw parsedPackageId.error;
    const sceneGuid = AssetGuid.format(AssetGuid.derive(parsedPackageId.value, 'scene/main'));
    const externalGuid = '019a0000-0000-7000-8000-000000000016';
    const imageImporter: Importer = {
      key: 'image',
      import: async () => ({
        ok: true,
        value: {
          assets: [
            {
              guid: externalGuid,
              kind: 'equirect',
              payload: {
                kind: 'equirect',
                width: 1,
                height: 1,
                format: 'rgba16float',
                data: new Uint8Array(8),
                colorSpace: 'linear',
              },
              refs: [],
              artifacts: {},
            },
          ],
          sourceDependencies: [],
        },
      }),
    };
    await writeFile(join(assets, 'sky.hdr'), 'fixture');
    await writeFile(
      join(assets, 'sky.hdr.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'image',
        source: 'sky.hdr',
        importSettings: {},
        subAssets: [{ guid: externalGuid, sourceIndex: 0, kind: 'equirect' }],
      }),
    );
    await writeFile(
      join(assets, 'scene.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: {
          'scene/main': {
            kind: 'scene',
            payload: { kind: 'scene', entities: {} },
            refs: [externalGuid],
          },
        },
      }),
    );

    const binding = createStandaloneRuntimeAssetBinding('direct-pack-meta-ref-vite');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      importers: [imageImporter],
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc') },
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();

    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined) throw new Error('Vite did not expose a local URL');
    const catalogResponse = await fetch(new URL(binding.catalogUrl, baseUrl));
    const catalogBody = await catalogResponse.text();
    expect(catalogResponse.status, catalogBody).toBe(200);
    const catalog = JSON.parse(catalogBody) as {
      entries: Array<{ guid: string; packageUrl: string; refs?: readonly string[] }>;
    };
    const scene = catalog.entries.find((entry) => entry.guid === sceneGuid);
    const external = catalog.entries.find((entry) => entry.guid === externalGuid);
    expect(scene).toMatchObject({ guid: sceneGuid, refs: [externalGuid] });
    expect(external).toMatchObject({ guid: externalGuid });
    if (scene === undefined) throw new Error('expected the direct scene Catalog row');
    const packageResponse = await fetch(new URL(scene.packageUrl, baseUrl));
    const packageBody = await packageResponse.text();
    expect(packageResponse.status, packageBody).toBe(200);
    expect(JSON.parse(packageBody).assets[0].refs).toEqual([externalGuid]);
  }, 60_000);
});
