// @perf-budget-skip: intentional real Vite server integration gate.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcEntryStore, ddcOutputDigest } from '@forgeax/engine-ddc';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import {
  createStandaloneRuntimeAssetBinding,
  err,
  type Importer,
  ok,
  validateCatalogDelta,
} from '@forgeax/engine-types';
import { createUiLoader, type UiAsset } from '@forgeax/engine-ui';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssetRegistry,
  createCatalogHotSubscription,
  createCatalogSource,
  defineAssetKind,
} from '../../../assets-runtime/src/index.js';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const GUID = '01900000-0000-7000-8000-aaaaaaaaaaaa';

describe('DevSession through a real Vite server', () => {
  let root: string | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('admits a requested UI through the real on-demand producer without cooking unused declarations', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-ui-demand-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const unused = '01900000-0000-7000-8000-bbbbbbbbbbbb';
    for (const [name, guid] of [
      ['guide', GUID],
      ['unused', unused],
    ] as const) {
      await writeFile(join(assets, `${name}.ui.html`), `<div>${name}</div>`);
      await writeFile(join(assets, `${name}.ui.css`), 'div { color: white; }');
      await writeFile(
        join(assets, `${name}.ui.html.meta.json`),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'ui',
          source: `${name}.ui.html`,
          importSettings: {},
          subAssets: [{ guid, sourceKey: `ui/${name}`, sourceIndex: 0, kind: 'ui' }],
        }),
      );
    }
    const uiImporter = createUiImporter();
    const imported = vi.fn(uiImporter.import);
    const binding = createStandaloneRuntimeAssetBinding('runtime-ui-demand');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      producerReadiness: 'on-demand',
      importers: [{ ...uiImporter, import: imported }],
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc', 'v2') },
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const base = server.resolvedUrls?.local[0];
    if (!base) throw new Error('Vite did not expose its local URL');
    const catalogUrl = new URL(binding.catalogUrl, base).href;
    const before = decodeCatalogWire(await (await fetch(catalogUrl)).json()).unwrap();
    expect(before).toHaveLength(2);
    expect(imported).not.toHaveBeenCalled();
    let hotDelta: (data: unknown) => void = () => {};
    let publishedDigest: string | undefined;
    let observedPublication = () => {};
    const publicationHot = new Promise<void>((resolve) => {
      observedPublication = resolve;
    });
    const send = vi.fn((message: { type?: string; event?: string; data?: unknown }) => {
      if (
        typeof message === 'object' &&
        message.type === 'custom' &&
        message.event === 'forgeax:catalog-delta'
      ) {
        const delta = validateCatalogDelta(message.data);
        if (delta.ok) {
          const row = [...delta.value.added, ...delta.value.changed].find(
            (row) => row.guid === GUID,
          );
          if (publishedDigest !== undefined && row?.publication?.digest === publishedDigest)
            observedPublication();
        }
        hotDelta(message.data);
      }
    });
    plugin.configureServer({ middlewares: { use() {} }, ws: { send } });
    const transport = createDevImportTransport({
      ...binding,
      importUrlBase: new URL(binding.importUrlBase, base).href,
    });
    const source = createCatalogSource({
      url: catalogUrl,
      expectedScope: binding,
      subscribe: createCatalogHotSubscription({
        on(_event, listener) {
          hotDelta = listener;
        },
        off() {
          hotDelta = () => {};
        },
      }),
      importTransport: {
        async fetchPack(guid, scope) {
          const result = await transport.fetchPack(guid, scope);
          if (result.ok) {
            publishedDigest = result.entries?.find((row) => row.guid === GUID)?.publication?.digest;
            // Hold the actual POST response until the producer's watcher emits
            // its retained publication, exercising a hot update before get settles.
            await writeFile(join(assets, 'guide.ui.html'), '<div>updated</div>');
            await publicationHot;
          }
          return result;
        },
      },
    });
    const registry = new AssetRegistry({ catalog: source });
    const kind = defineAssetKind<UiAsset, 'ui'>('ui');
    registry.installDecoder(kind, {
      async decode({ envelope }) {
        const loaded = createUiLoader().load(envelope.payload);
        return loaded.ok
          ? ok(loaded.value)
          : err({
              code: 'asset-package-invalid',
              expected: 'a valid UI payload',
              hint: 'repair the UI producer',
              detail: { guid: GUID, reason: loaded.error.code },
            });
      },
    });
    try {
      const loaded = await registry.load(GUID, kind);
      expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
      const reference = loaded.unwrap();
      expect(registry.read(reference).unwrap()).toMatchObject({
        guid: GUID,
        html: '<div>guide</div>',
      });
      expect(imported).toHaveBeenCalledTimes(1);
      const after = decodeCatalogWire(await (await fetch(catalogUrl)).json()).unwrap();
      expect(after.find((row) => row.guid === GUID)).toMatchObject({
        lifecycle: 'current',
        publication: { generation: expect.any(Number) },
      });
      expect(after.find((row) => row.guid === unused)).toMatchObject({
        lifecycle: 'missing',
      });
      expect(registry.inspectSource()?.ready).toEqual([GUID]);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'custom', event: 'forgeax:catalog-delta' }),
      );
      const refreshed = await registry.load(GUID, kind);
      expect(refreshed.ok, JSON.stringify(refreshed)).toBe(true);
      expect(refreshed.unwrap()).toBe(reference);
      expect(registry.read(refreshed.unwrap()).unwrap()).toMatchObject({
        guid: GUID,
        html: '<div>guide</div>',
      });
    } finally {
      registry.dispose();
    }
  }, 20_000);

  it('preserves explicitly disabled Vite watching', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-vite-no-watch-'));
    const plugin = pluginPack({
      roots: [],
      ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc', 'v2') },
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0, watch: null },
    });
    await server.listen();
    expect(server.config.server.watch).toBeNull();
    expect(server.watcher.getWatched()).toEqual({});
  });

  it('publishes derived DDC entries without watching them and preserves author and user watch policies', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-vite-watch-'));
    const projectDdcRoot = join(root, '.forgeax', 'ddc', 'v2');
    const authored = `${projectDdcRoot}-author`;
    await mkdir(authored, { recursive: true });
    const source = join(authored, 'source.ts');
    await writeFile(source, 'export const value = 1;');
    const key = 'a'.repeat(64);
    const value = {
      key,
      guid: GUID,
      payload: { kind: 'test-blob' },
      refs: [],
      artifacts: {
        payload: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2]) },
      },
      receipt: {
        key,
        guid: GUID,
        producer: 'watch-fixture',
        inputFingerprint: 'one',
        outputDigest: '',
      },
    };
    const entry = { ...value, receipt: { ...value.receipt, outputDigest: ddcOutputDigest(value) } };
    const store = new DdcEntryStore(projectDdcRoot);
    const userRegex = /\.user-ignored$/;
    const userFunction = (path: string) => path.endsWith('.custom-ignored');
    const plugin = pluginPack({ roots: [], ddc: { projectDdcRoot } });
    let watcherReady = Promise.resolve();
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'watch-ready-fixture',
          enforce: 'pre',
          configureServer(server) {
            watcherReady = new Promise<void>((resolve) => server.watcher.once('ready', resolve));
          },
        },
        plugin,
      ],
      server: {
        host: '127.0.0.1',
        port: 0,
        // Exercise native file/directory handles that can block DDC publication,
        // rather than macOS's directory-stream provider or stat polling.
        watch: { useFsEvents: false, usePolling: false, ignored: [userRegex, userFunction] },
      },
    });
    await server.listen();
    await watcherReady;

    const staged = await store.stage(entry);
    // Cooking stages output after the server starts. Let the real filesystem
    // watcher consume those directory events before attempting publication.
    await new Promise((resolve) => setTimeout(resolve, 500));

    await expect(store.publish(staged)).resolves.toEqual({ result: 'published', key });
    await expect(store.read(key)).resolves.toEqual(entry);
    expect(server.watcher.getWatched()[join(staged.path, 'artifacts')]).toBeUndefined();
    expect(server.config.server.watch?.ignored).toEqual(
      expect.arrayContaining([userRegex, userFunction]),
    );
    const changed = vi.fn();
    server.watcher.on('change', changed);
    await writeFile(source, 'export const value = 2;');
    await expect.poll(() => changed.mock.calls.some(([path]) => path === source)).toBe(true);
  }, 15_000);

  it('repairs startup, imports the same derived GUID, and preserves sibling packages', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-startup-repair-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const source = join(assets, 'effect.pack.json');
    await writeFile(source, '{broken');
    await writeFile(
      join(assets, 'sibling.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-bbbbbbbbbbbb',
        assets: { 'effect/sibling': { kind: 'test-effect', payload: { value: 2 }, refs: [] } },
      }),
    );
    const binding = createStandaloneRuntimeAssetBinding('startup-repair');
    const plugin = pluginPack({ roots: [assets], runtimeBinding: binding });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const catalogUrl = new URL(binding.catalogUrl, server.resolvedUrls?.local[0]).href;
    expect((await fetch(catalogUrl)).status).toBe(500);
    await writeFile(source, '{still broken');
    expect((await fetch(catalogUrl)).status).toBe(500);
    await writeFile(
      source,
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: GUID,
        assets: { 'effect/main': { kind: 'test-effect', payload: { value: 1 }, refs: [] } },
      }),
    );
    await expect.poll(async () => (await fetch(catalogUrl)).status, { timeout: 5000 }).toBe(200);
    const catalog = decodeCatalogWire(await (await fetch(catalogUrl)).json()).unwrap();
    expect(catalog).toHaveLength(2);
    const packageId = PackageId.parse(GUID);
    if (!packageId.ok) throw packageId.error;
    const expectedGuid = AssetGuid.format(AssetGuid.derive(packageId.value, 'effect/main'));
    const target = catalog.find((entry) => entry.guid === expectedGuid);
    expect(target).toBeDefined();
    if (target === undefined) throw new Error('expected the current Catalog row');
    const importUrl = new URL(`${binding.importUrlBase}/${target.guid}`, catalogUrl);
    const imported = await fetch(importUrl, { method: 'POST' });
    expect(imported.status).toBe(200);
    const rows = await imported.json();
    const body = await fetch(new URL(rows[0].packageUrl, catalogUrl));
    expect(body.status).toBe(200);
    expect((await body.json()).assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ guid: target.guid, payload: { kind: 'test-effect', value: 1 } }),
      ]),
    );
    const rebuilt = await fetch(importUrl, {
      method: 'POST',
      headers: { 'x-forgeax-import-mode': 'rebuild' },
    });
    expect(rebuilt.status).toBe(200);
    const after = decodeCatalogWire(await (await fetch(catalogUrl)).json()).unwrap();
    expect(after.map((entry) => entry.guid).sort()).toEqual(
      catalog.map((entry) => entry.guid).sort(),
    );
    expect(plugin.runtimeBinding()).toMatchObject({ status: 'ready', diagnostics: [] });
  }, 20_000);

  it('retains both lazy publications after concurrent HTTP imports', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-concurrent-import-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const guids = [GUID, '01900000-0000-7000-8000-bbbbbbbbbbbb'];
    for (const [index, guid] of guids.entries()) {
      await writeFile(join(assets, `${index}.blob`), String(index));
      await writeFile(
        join(assets, `${index}.blob.meta.json`),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'test-blob',
          source: `${index}.blob`,
          importSettings: {},
          subAssets: [{ guid, sourceIndex: 0, kind: 'test-blob' }],
        }),
      );
    }
    const importer: Importer = {
      key: 'test-blob',
      async import(ctx) {
        const source = await ctx.readSource();
        if (!source.ok) throw new Error('unreadable source');
        const index = new TextDecoder().decode(source.value);
        const guid = guids[Number(index)];
        if (guid === undefined) throw new Error('unknown fixture source');
        return {
          ok: true,
          value: {
            assets: [
              {
                guid,
                kind: 'test-blob',
                payload: { index } as never,
                refs: [],
                artifacts: {
                  blob: { bytes: source.value, mediaType: 'application/octet-stream' },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('concurrent-import');
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: binding,
      importers: [importer],
      producerReadiness: 'on-demand',
      ddc: { projectDdcRoot: join(root, 'ddc') },
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const catalogUrl = new URL(binding.catalogUrl, server.resolvedUrls?.local[0]).href;
    expect((await fetch(catalogUrl)).status).toBe(200);
    const responses = await Promise.all(
      guids.map((guid) =>
        fetch(new URL(`${binding.importUrlBase}/${guid}`, catalogUrl), { method: 'POST' }),
      ),
    );
    for (const response of responses) expect(response.status).toBe(200);
    const catalog = decodeCatalogWire(await (await fetch(catalogUrl)).json()).unwrap();
    expect(catalog).toHaveLength(2);
    expect(catalog.every((row) => row.lifecycle === 'current')).toBe(true);
    for (const row of catalog) {
      const response = await fetch(new URL(row.packageUrl, catalogUrl));
      expect(response.status).toBe(200);
      const body = await response.json();
      const asset = body.assets[0];
      expect(asset.guid).toBe(row.guid);
      const artifact = await fetch(new URL(asset.artifacts.blob.path, response.url));
      expect(artifact.status).toBe(200);
      expect(await artifact.text()).toBe(asset.payload.index);
    }
  }, 20_000);

  it('keeps invalid producer configuration failed after a source change', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-invalid-readiness-'));
    const source = join(root, 'effect.pack.json');
    const pack = JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: GUID,
      assets: { 'effect/main': { kind: 'test-effect', payload: {}, refs: [] } },
    });
    await writeFile(source, pack);
    const binding = createStandaloneRuntimeAssetBinding('invalid-readiness');
    const plugin = pluginPack({
      roots: [root],
      runtimeBinding: binding,
      producerReadiness: 'invalid' as never,
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const url = new URL(binding.catalogUrl, server.resolvedUrls?.local[0]);
    expect((await fetch(url)).status).toBe(500);
    await writeFile(source, `${pack}\n`);
    const retried = await fetch(url);
    expect(retried.status).toBe(500);
    expect(JSON.stringify(await retried.json())).toContain('producer-readiness-invalid');
  });

  it('serves one accepted scope, preserves it across failed rebind, and closes with 410', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-dev-session-vite-'));
    await mkdir(join(root, 'assets'));
    await writeFile(
      join(root, 'assets', 'effect.pack.json'),
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: GUID,
            kind: 'test-effect',
            execution: 'direct',
            payload: { schemaVersion: 1 },
            refs: [],
            artifacts: {},
          },
        ],
      }),
    );
    const binding = createStandaloneRuntimeAssetBinding('vite-session');
    const plugin = pluginPack({
      roots: [join(root, 'assets')],
      runtimeBinding: binding,
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
    const catalogUrl = new URL(binding.catalogUrl, baseUrl).href;
    const catalog = await fetch(catalogUrl);
    expect(catalog.status).toBe(200);
    expect(decodeCatalogWire(await catalog.json()).unwrap()).toHaveLength(1);

    await mkdir(join(root, 'broken-assets'));
    await writeFile(join(root, 'broken-assets', 'broken.pack.json'), '{broken');
    const failed = await plugin.rebind({ ...binding, generation: binding.generation + 1 }, [
      join(root, 'broken-assets'),
    ]);
    expect(failed.status).toBe('degraded');
    const retained = await fetch(catalogUrl);
    expect(retained.status).toBe(200);

    await plugin.closeBundle();
    const closed = await fetch(catalogUrl);
    expect(closed.status).toBe(410);
  }, 20_000);

  it.each([
    'json',
    'module',
  ] as const)('reloads every consumer after verified %s recovery without dropping the failed page', async (mode) => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-watcher-recovery-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const source = join(assets, 'effect.pack.json');
    const valid = JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: GUID,
          kind: 'test-effect',
          execution: 'direct',
          payload: { schemaVersion: 1 },
          refs: [],
          artifacts: {},
        },
      ],
    });
    await writeFile(source, valid);
    const binding = createStandaloneRuntimeAssetBinding('watcher-recovery');
    const plugin = pluginPack({ roots: [assets], runtimeBinding: binding, refresh: () => {} });
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [plugin],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const catalogUrl = new URL(binding.catalogUrl, server.resolvedUrls?.local[0]).href;
    const acceptedCatalog = await (await fetch(catalogUrl)).json();
    const acceptedEntries = decodeCatalogWire(acceptedCatalog).unwrap();
    expect(acceptedEntries).toHaveLength(1);
    const acceptedEntry = acceptedEntries[0];
    if (acceptedEntry === undefined) throw new Error('expected the accepted Catalog row');
    const packageUrl = new URL(acceptedEntry.packageUrl, catalogUrl);
    const acceptedBody = await (await fetch(packageUrl)).text();
    const send = vi.spyOn(server.ws, 'send');
    const second = vi.fn();
    plugin.configureServer({ middlewares: { use() {} }, ws: { send: second } });
    const brokenModule = join(assets, 'broken.pack.ts');
    if (mode === 'module')
      await writeFile(brokenModule, "throw new Error('module-repair-marker');");
    else await writeFile(source, '{broken');
    await expect.poll(() => plugin.runtimeBinding()?.status, { timeout: 5000 }).toBe('degraded');
    expect(
      send.mock.calls.some(
        ([message]) =>
          typeof (message as unknown) === 'object' &&
          (message as unknown as { type?: string }).type === 'full-reload',
      ),
    ).toBe(false);
    const degradedCatalog = await (await fetch(catalogUrl)).json();
    expect(degradedCatalog.authority).toBe('degraded');
    expect(degradedCatalog.entries).toEqual(acceptedCatalog.entries);
    expect(degradedCatalog.diagnostics).not.toEqual([]);
    const retainedPackage = await fetch(packageUrl);
    expect(retainedPackage.status).toBe(200);
    expect(await retainedPackage.text()).toBe(acceptedBody);
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'custom',
        data: expect.objectContaining({
          authority: 'degraded',
          added: [],
          changed: [],
          removed: [],
        }),
      }),
    );
    expect(JSON.stringify(plugin.runtimeBinding()?.diagnostics)).toContain(
      mode === 'module' ? 'module-repair-marker' : 'effect.pack.json',
    );
    if (mode === 'module') await rm(brokenModule);
    await writeFile(source, valid);
    await expect.poll(() => plugin.runtimeBinding()?.status, { timeout: 5000 }).toBe('ready');
    expect(plugin.runtimeBinding()?.diagnostics).toEqual([]);
    expect((await fetch(catalogUrl)).status).toBe(200);
    await expect
      .poll(() => second.mock.calls.some(([message]) => message.type === 'full-reload'))
      .toBe(true);
    expect(send).toHaveBeenCalledWith({ type: 'full-reload' });
  }, 15000);

  it('reopens the same plugin after Vite closes a sequential server', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-dev-session-vite-reopen-'));
    await mkdir(join(root, 'assets'));
    const binding = createStandaloneRuntimeAssetBinding('vite-session-reopen');
    const plugin = pluginPack({
      roots: [join(root, 'assets')],
      runtimeBinding: binding,
    });
    let first: Awaited<ReturnType<typeof createServer>> | undefined;
    let second: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      first = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin],
        server: { host: '127.0.0.1', port: 0 },
      });
      await first.listen();
      const firstUrl = first.resolvedUrls?.local[0];
      if (firstUrl === undefined) throw new Error('first Vite server did not expose a local URL');
      expect((await fetch(new URL(binding.catalogUrl, firstUrl))).status).toBe(200);
      await first.close();
      first = undefined;

      second = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [plugin],
        server: { host: '127.0.0.1', port: 0 },
      });
      await second.listen();
      const secondUrl = second.resolvedUrls?.local[0];
      if (secondUrl === undefined) throw new Error('second Vite server did not expose a local URL');
      expect((await fetch(new URL(binding.catalogUrl, secondUrl))).status).toBe(200);
    } finally {
      await second?.close();
      await first?.close();
    }
  }, 20_000);
});
