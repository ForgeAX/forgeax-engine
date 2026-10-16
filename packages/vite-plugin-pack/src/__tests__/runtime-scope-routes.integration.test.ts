import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import {
  type CatalogDelta,
  createStandaloneRuntimeAssetBinding,
  type PackIndexEntry,
  RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
} from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DevSession } from '../dev/dev-session.js';
import type { DispatcherResponse } from '../dev/dispatcher.js';
import type { PluginServerState } from '../dev/plugin-server.js';
import { createTransportRouteHandler } from '../dev/transport-routes.js';
import {
  createPluginPackInternal,
  createPluginPackInternal as pluginPack,
} from '../plugin-pack.js';

const GUID = '01900000-0000-7000-8000-aaaaaaaaaaaa';
const IMAGE_GUID = '01900000-0000-7000-8000-bbbbbbbbbbbb';
const UI_GUID = '01900000-0000-7000-8000-cccccccccccc';
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function projectDdcForTest(root: string) {
  return {
    buildCacheRoot: join(root, '.forgeax', 'ddc', 'build-cache'),
    projectDdcRoot: join(root, '.forgeax', 'ddc', 'v2'),
  } as const;
}

describe('runtime-scoped pack routes', () => {
  let root: string | undefined;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await close?.();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('waits for startup when a bound scope is still transitioning before lazy import', async () => {
    let releaseStartup!: () => void;
    const startupReady = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const binding = createStandaloneRuntimeAssetBinding('startup-race');
    const entry = {
      guid: GUID,
      packageUrl: `/__forgeax-ddc/${GUID}.pack.json`,
      sourcePath: 'fixture.pack.json',
    } as PackIndexEntry;
    const state = {
      catalogProjection: { declarations: new Map(), entries: [entry] },
      importedGuids: new Set<string>(),
      metaPackBodies: new Map(),
      devArtifactBodies: new Map(),
    } as unknown as PluginServerState;
    let sessionStatus: 'starting' | 'serving' | 'failed' = 'starting';
    let runtimeStatus: 'transitioning' | 'ready' = 'transitioning';
    let materializeCalls = 0;
    const session = {
      state: () =>
        sessionStatus === 'starting'
          ? { status: 'starting' as const }
          : sessionStatus === 'serving'
            ? {
                status: 'serving' as const,
                snapshot: {
                  generation: 1,
                  catalog: [],
                  authority: 'authoritative' as const,
                  diagnostics: [],
                },
              }
            : {
                status: 'failed' as const,
                error: {
                  code: 'scan-failed',
                  expected: 'an accepted ForgeaX pack snapshot',
                  hint: 'repair the producer and retry',
                  detail: { stage: 'scan', subject: 'fixture' },
                },
              },
      runtimeScope: () => ({ ...binding, status: runtimeStatus }),
    } as unknown as DevSession;
    const handler = createTransportRouteHandler({
      startupReady,
      state,
      callbacks: {
        materializeAsset: async () => {
          materializeCalls += 1;
          return [entry];
        },
        rebuildAsset: async () => [entry],
        ensureMetaPackBody: async () => undefined,
      },
      devSession: session,
      scopedPackageUrl: (_scope, packageUrl) => packageUrl,
      scopedCatalogBody: () => JSON.stringify({ entries: [entry] }),
    });
    const response: DispatcherResponse & { body: string } = {
      statusCode: 0,
      body: '',
      setHeader() {},
      end(chunk) {
        this.body = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      },
    };
    const pending = handler(
      { url: `${binding.importUrlBase}/${GUID}`, method: 'POST' },
      response,
      () => {},
    );
    await Promise.resolve();
    expect(response.statusCode).toBe(0);
    expect(materializeCalls).toBe(0);

    sessionStatus = 'serving';
    runtimeStatus = 'ready';
    releaseStartup();
    await pending;
    expect(response.statusCode).toBe(200);
    expect(materializeCalls).toBe(1);

    let failedMaterializeCalls = 0;
    sessionStatus = 'failed';
    const failedHandler = createTransportRouteHandler({
      startupReady: Promise.resolve(),
      state,
      callbacks: {
        materializeAsset: async () => {
          failedMaterializeCalls += 1;
          return [entry];
        },
        rebuildAsset: async () => [entry],
        ensureMetaPackBody: async () => undefined,
      },
      devSession: session,
      scopedPackageUrl: (_scope, packageUrl) => packageUrl,
      scopedCatalogBody: () => JSON.stringify({ entries: [entry] }),
    });
    const failedResponse: DispatcherResponse = {
      statusCode: 0,
      setHeader() {},
      end() {},
    };
    await failedHandler(
      { url: `${binding.importUrlBase}/${GUID}`, method: 'POST' },
      failedResponse,
      () => {},
    );
    expect(failedResponse.statusCode).toBe(500);
    expect(failedMaterializeCalls).toBe(0);
  });

  it('rejects asset identity routes before any runtime scope is bound', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-unbound-'));
    const plugin = pluginPack({ roots: [root] });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });
    expect(plugin.runtimeBinding()).toBeUndefined();

    expect((await request(middlewares, '/__pack/index')).statusCode).toBe(404);
    expect((await request(middlewares, '/pack-index.json')).statusCode).toBe(404);
    expect((await request(middlewares, `/__import/${GUID}`, 'POST')).statusCode).toBe(404);
    expect((await request(middlewares, `/__forgeax-ddc/${GUID}.pack.json`)).statusCode).toBe(404);
    expect((await request(middlewares, '/__pack/scopes/active/1/catalog.json')).statusCode).toBe(
      404,
    );
  });

  it('binds one game, ignores a malformed sibling, and disables global routes', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-'));
    const active = join(root, 'active');
    const brokenSibling = join(root, 'broken-sibling');
    await mkdir(active, { recursive: true });
    await mkdir(brokenSibling, { recursive: true });
    await writeFile(
      join(active, 'effect.pack.json'),
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
    await writeFile(join(brokenSibling, 'broken.pack.json'), '{not-json');

    const plugin = pluginPack({ roots: [active, brokenSibling] });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    const bound = await plugin.rebind(
      {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'active',
        scopeId: 'active',
        generation: 7,
        status: 'unbound',
        catalogUrl: '/__pack/scopes/active/7/catalog.json',
        importUrlBase: '/__pack/scopes/active/7/import',
        packageUrlBase: '/__pack/scopes/active/7/asset',
      },
      [active],
    );
    expect(bound.status).toBe('ready');
    expect(bound.authority).toBe('authoritative');
    expect(plugin.runtimeBinding()).toMatchObject({
      scopeId: 'active',
      generation: 7,
      status: 'ready',
    });

    const stringify = vi.spyOn(JSON, 'stringify');
    const catalog = await request(middlewares, '/__pack/scopes/active/7/catalog.json');
    const repeated = await Promise.all([
      request(middlewares, '/__pack/scopes/active/7/catalog.json'),
      request(middlewares, '/__pack/scopes/active/7/catalog.json'),
    ]);
    expect(repeated.map((response) => response.body)).toEqual([catalog.body, catalog.body]);
    expect(
      stringify.mock.calls.filter(
        ([value]) => value?.schemaVersion === RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
      ),
    ).toHaveLength(1);
    expect(catalog.statusCode).toBe(200);
    expect(catalog.headers['cache-control']).toBe('no-store');
    const snapshot = JSON.parse(catalog.body) as {
      authority: string;
      entries: Array<{ guid: string; packageUrl: string }>;
    };
    expect(snapshot.authority).toBe('authoritative');
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({ guid: GUID });
    expect(snapshot.entries[0]?.packageUrl).toBe(
      `/__pack/scopes/active/7/asset/__forgeax-ddc/${GUID}.pack.json`,
    );

    const packageResponse = await request(middlewares, snapshot.entries[0]?.packageUrl ?? '');
    expect(packageResponse.statusCode).toBe(200);
    expect(JSON.parse(packageResponse.body).assets[0].guid).toBe(GUID);

    expect((await request(middlewares, '/__pack/index')).statusCode).toBe(404);
    expect((await request(middlewares, '/pack-index.json')).statusCode).toBe(404);
    expect((await request(middlewares, `/__import/${GUID}`, 'POST')).statusCode).toBe(404);
    expect((await request(middlewares, `/__forgeax-ddc/${GUID}.pack.json`)).statusCode).toBe(404);
    expect((await request(middlewares, '/__pack/scopes/active/6/catalog.json')).statusCode).toBe(
      410,
    );
    expect((await request(middlewares, '/__pack/scopes/other/7/catalog.json')).statusCode).toBe(
      404,
    );

    await plugin.rebind(
      {
        ...bound,
        generation: 8,
        catalogUrl: '/__pack/scopes/active/8/catalog.json',
        importUrlBase: '/__pack/scopes/active/8/import',
        packageUrlBase: '/__pack/scopes/active/8/asset',
      },
      [active],
    );
    expect((await request(middlewares, '/__pack/scopes/active/7/catalog.json')).statusCode).toBe(
      410,
    );
    const next = await request(middlewares, '/__pack/scopes/active/8/catalog.json');
    expect(JSON.parse(next.body)).toMatchObject({
      generation: 8,
      entries: [{ packageUrl: `/__pack/scopes/active/8/asset/__forgeax-ddc/${GUID}.pack.json` }],
    });
    expect((await request(middlewares, '/__pack/scopes/active/8/catalog.json')).body).toBe(
      next.body,
    );
    expect(
      stringify.mock.calls.filter(
        ([value]) => value?.schemaVersion === RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
      ),
    ).toHaveLength(2);
  });

  it('does not duplicate the Vite host base in scoped package URLs', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-base-'));
    const active = join(root, 'active');
    await mkdir(active, { recursive: true });
    await writeFile(
      join(active, 'effect.pack.json'),
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

    const plugin = createPluginPackInternal({ roots: [active] }, { transportBase: '/preview/' });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    await plugin.rebind(
      {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'active',
        scopeId: 'active',
        generation: 7,
        status: 'unbound',
        catalogUrl: '/preview/__pack/scopes/active/7/catalog.json',
        importUrlBase: '/preview/__pack/scopes/active/7/import',
        packageUrlBase: '/preview/__pack/scopes/active/7/asset',
      },
      [active],
    );

    const catalog = await request(middlewares, '/__pack/scopes/active/7/catalog.json');
    expect(catalog.statusCode).toBe(200);
    const snapshot = JSON.parse(catalog.body) as {
      entries: Array<{ guid: string; packageUrl: string }>;
    };
    expect(snapshot.entries[0]?.packageUrl).toBe(
      `/preview/__pack/scopes/active/7/asset/__forgeax-ddc/${GUID}.pack.json`,
    );
    expect(snapshot.entries[0]?.packageUrl).not.toContain('/asset/preview/');

    const baseCatalog = await request(middlewares, '/preview/__pack/scopes/active/7/catalog.json');
    expect(baseCatalog.statusCode).toBe(200);
    expect(JSON.parse(baseCatalog.body).authority).toBe('authoritative');
  });

  it.each([
    '',
    '/preview',
  ])('keeps snapshot and HMR rows identical after lazy import (base=%s)', async (base) => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-image-'));
    const active = join(root, 'active');
    await mkdir(active, { recursive: true });
    await writeFile(join(active, 'pixel.png'), ONE_PIXEL_PNG);
    await writeFile(
      join(active, 'pixel.png.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'image',
        source: 'pixel.png',
        importSettings: { colorSpace: 'srgb', mipmap: false },
        subAssets: [{ guid: IMAGE_GUID, sourceIndex: 0, kind: 'texture' }],
      }),
    );

    await writeFile(join(active, 'second.png'), ONE_PIXEL_PNG);
    const secondMeta = JSON.parse(await readFile(join(active, 'pixel.png.meta.json'), 'utf8'));
    await writeFile(
      join(active, 'second.png.meta.json'),
      JSON.stringify({
        ...secondMeta,
        source: 'second.png',
        subAssets: [{ guid: UI_GUID, sourceIndex: 0, kind: 'texture' }],
      }),
    );

    const plugin = createPluginPackInternal(
      {
        roots: [active],
        producerReadiness: 'on-demand',
        importers: [imageImporter],
        ddc: projectDdcForTest(root),
      },
      { transportBase: base },
    );
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    const deltas: CatalogDelta[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: {
        send: (message) => {
          if (message.event === 'forgeax:catalog-delta') deltas.push(message.data as CatalogDelta);
        },
      },
    });

    const bound = await plugin.rebind(
      {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'active',
        scopeId: 'active',
        generation: 9,
        status: 'unbound',
        catalogUrl: `${base}/__pack/scopes/active/9/catalog.json`,
        importUrlBase: `${base}/__pack/scopes/active/9/import`,
        packageUrlBase: `${base}/__pack/scopes/active/9/asset`,
      },
      [active],
    );
    expect(bound.status).toBe('ready');

    const stringify = vi.spyOn(JSON, 'stringify');
    const catalogSerializations = () =>
      stringify.mock.calls.filter(
        ([value]) => value?.schemaVersion === RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
      ).length;
    const beforeImport = await request(middlewares, '/__pack/scopes/active/9/catalog.json');
    expect(beforeImport.statusCode).toBe(200);
    expect(catalogSerializations()).toBe(1);

    const imported = await request(
      middlewares,
      `/__pack/scopes/active/9/import/${IMAGE_GUID}`,
      'POST',
    );
    expect(imported.statusCode).toBe(200);
    const importedRows = JSON.parse(imported.body) as Array<{
      guid: string;
      publication?: { schemaVersion?: string; generation?: number };
    }>;
    expect(importedRows[0]?.publication).toMatchObject({
      schemaVersion: 'asset-publication/1',
    });
    expect(importedRows[0]?.publication?.generation).toBeGreaterThan(0);

    const afterImport = await request(middlewares, '/__pack/scopes/active/9/catalog.json');
    expect(afterImport.body).not.toBe(beforeImport.body);
    const repeated = await request(middlewares, '/__pack/scopes/active/9/catalog.json');
    expect(repeated.body).toBe(afterImport.body);
    expect(catalogSerializations()).toBe(2);

    const secondImport = await request(
      middlewares,
      `/__pack/scopes/active/9/import/${UI_GUID}`,
      'POST',
    );
    expect(secondImport.statusCode).toBe(200);
    const afterSecondImport = await request(middlewares, '/__pack/scopes/active/9/catalog.json');
    expect(afterSecondImport.body).not.toBe(afterImport.body);
    expect(JSON.parse(afterSecondImport.body).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ guid: UI_GUID, publication: expect.any(Object) }),
      ]),
    );
    expect((await request(middlewares, '/__pack/scopes/active/9/catalog.json')).body).toBe(
      afterSecondImport.body,
    );
    expect(catalogSerializations()).toBe(3);

    const metaPath = join(active, 'pixel.png.meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    const deltasBeforeEdit = deltas.length;
    await writeFile(
      metaPath,
      JSON.stringify({ ...meta, importSettings: { colorSpace: 'linear', mipmap: false } }),
    );
    await expect
      .poll(() =>
        deltas
          .slice(deltasBeforeEdit)
          .flatMap((delta) => delta.changed)
          .some((row) => row.guid === IMAGE_GUID),
      )
      .toBe(true);

    const catalog = await request(middlewares, '/__pack/scopes/active/9/catalog.json');
    expect(catalogSerializations()).toBe(4);
    const snapshot = JSON.parse(catalog.body) as {
      entries: Array<{
        guid: string;
        publication?: { schemaVersion?: string; generation?: number };
      }>;
    };
    const entry = snapshot.entries.find((candidate) => candidate.guid === IMAGE_GUID);
    expect(entry?.publication).toMatchObject({ schemaVersion: 'asset-publication/1' });
    expect(entry?.publication?.generation).toBeGreaterThan(0);
    const changed = deltas
      .flatMap((delta) => delta.changed)
      .reverse()
      .find((row) => row.guid === IMAGE_GUID);
    expect(changed).toEqual(entry);
    expect((await request(middlewares, changed?.packageUrl ?? '')).statusCode).toBe(200);
    expect((await request(middlewares, `/__forgeax-ddc/${IMAGE_GUID}.pack.json`)).statusCode).toBe(
      404,
    );

    const authoredPath = join(active, 'added.pack.json');
    await writeFile(
      authoredPath,
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: GUID,
            kind: 'test-effect',
            execution: 'direct',
            payload: {},
            refs: [],
            artifacts: {},
          },
        ],
      }),
    );
    await expect
      .poll(() => deltas.flatMap((delta) => delta.added).find((row) => row.guid === GUID))
      .toBeDefined();
    const added = deltas
      .flatMap((delta) => delta.added)
      .reverse()
      .find((row) => row.guid === GUID);
    const nextCatalog = JSON.parse((await request(middlewares, bound.catalogUrl)).body) as {
      entries: PackIndexEntry[];
    };
    expect(added).toEqual(nextCatalog.entries.find((row) => row.guid === GUID));
    expect((await request(middlewares, added?.packageUrl ?? '')).statusCode).toBe(200);
    await rm(authoredPath);
    await expect.poll(() => deltas.flatMap((delta) => delta.removed)).toContain(GUID);
    expect(deltas.every((delta) => delta.scopeId === 'active' && delta.generation === 9)).toBe(
      true,
    );
  });

  it('retains a lazy-imported UI row across package and catalog reads', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-ui-'));
    const active = join(root, 'active');
    await mkdir(active, { recursive: true });
    await writeFile(join(active, 'hud.ui.html'), '<section data-ui-part="root">HUD</section>\n');
    await writeFile(join(active, 'hud.ui.css'), ':host { display: block; }\n');
    await writeFile(
      join(active, 'hud.ui.html.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'ui',
        source: 'hud.ui.html',
        importSettings: {},
        subAssets: [{ guid: UI_GUID, sourceIndex: 0, kind: 'ui' }],
      }),
    );

    const plugin = pluginPack({
      roots: [active],
      producerReadiness: 'on-demand',
      importers: [createUiImporter()],
      ddc: projectDdcForTest(root),
    });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    await plugin.rebind(
      {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'active',
        scopeId: 'active',
        generation: 11,
        status: 'unbound',
        catalogUrl: '/__pack/scopes/active/11/catalog.json',
        importUrlBase: '/__pack/scopes/active/11/import',
        packageUrlBase: '/__pack/scopes/active/11/asset',
      },
      [active],
    );

    const initial = await request(middlewares, '/__pack/scopes/active/11/catalog.json');
    const initialSnapshot = JSON.parse(initial.body) as {
      entries: Array<{ guid: string; packageUrl: string }>;
    };
    const initialEntry = initialSnapshot.entries.find((entry) => entry.guid === UI_GUID);
    expect(initialEntry).toBeDefined();

    const packageResponse = await request(middlewares, initialEntry?.packageUrl ?? '');
    expect(packageResponse.statusCode).toBe(200);
    expect(JSON.parse(packageResponse.body).assets[0].guid).toBe(UI_GUID);

    const afterPackage = await request(middlewares, '/__pack/scopes/active/11/catalog.json');
    const afterPackageSnapshot = JSON.parse(afterPackage.body) as {
      entries: Array<{ guid: string }>;
    };
    expect(afterPackageSnapshot.entries.some((entry) => entry.guid === UI_GUID)).toBe(true);

    const imported = await request(
      middlewares,
      `/__pack/scopes/active/11/import/${UI_GUID}`,
      'POST',
    );
    expect(imported.statusCode).toBe(200);
    const afterImport = await request(middlewares, '/__pack/scopes/active/11/catalog.json');
    const afterImportSnapshot = JSON.parse(afterImport.body) as {
      entries: Array<{ guid: string }>;
    };
    expect(afterImportSnapshot.entries.some((entry) => entry.guid === UI_GUID)).toBe(true);
  });

  it('exposes degraded catalog evidence but fails closed for lazy import', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-degraded-'));
    const active = join(root, 'active');
    const validRoot = join(active, 'valid');
    const brokenRoot = join(active, 'broken');
    await mkdir(validRoot, { recursive: true });
    await mkdir(brokenRoot, { recursive: true });
    // Keep one valid root beside a broken root: one inventory failure is
    // fail-closed, so an initial session has no accepted Catalog generation.
    await writeFile(
      join(validRoot, 'valid.pack.json'),
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
    await writeFile(join(brokenRoot, 'broken.pack.json'), '{not-json');

    const plugin = pluginPack({ roots: [active] });
    close = () => plugin.closeBundle();
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    const bound = await plugin.rebind(
      {
        schemaVersion: 'runtime-asset-binding-v1',
        gameId: 'active',
        scopeId: 'active',
        generation: 8,
        status: 'unbound',
        catalogUrl: '/__pack/scopes/active/8/catalog.json',
        importUrlBase: '/__pack/scopes/active/8/import',
        packageUrlBase: '/__pack/scopes/active/8/asset',
      },
      [validRoot, brokenRoot],
    );
    expect(bound.status).toBe('degraded');
    expect(bound.authority).toBe('degraded');
    expect(bound.diagnostics?.length).toBeGreaterThan(0);

    const catalog = await request(middlewares, '/__pack/scopes/active/8/catalog.json');
    expect(catalog.statusCode).toBe(500);

    const imported = await request(middlewares, `/__pack/scopes/active/8/import/${GUID}`, 'POST');
    expect(imported.statusCode).toBe(500);
  });
});

interface MockResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  end(chunk: string | Uint8Array): void;
}

type Middleware = (
  req: { url?: string; method?: string },
  res: MockResponse,
  next: () => void,
) => unknown;

async function request(
  middlewares: readonly Middleware[],
  url: string,
  method = 'GET',
): Promise<MockResponse> {
  const response: MockResponse = {
    statusCode: 200,
    body: '',
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    },
  };
  let index = 0;
  const next = async (): Promise<void> => {
    const middleware = middlewares[index++];
    if (middleware !== undefined) await middleware({ url, method }, response, () => void next());
  };
  await next();
  return response;
}
