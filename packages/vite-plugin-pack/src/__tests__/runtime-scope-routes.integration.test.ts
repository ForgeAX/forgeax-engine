import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import {
  type CatalogDelta,
  createStandaloneRuntimeAssetBinding,
  type PackIndexEntry,
  RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
  type RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testGate } from '../../../../scripts/test/test-gate.mjs';
import {
  directPackFixture,
  metaFixture,
} from '../../../pack/src/__tests__/support/direct-pack-fixture.js';
import type { DevSession } from '../dev/dev-session.js';
import type { PluginServerState } from '../dev/plugin-server.js';
import { createTransportRouteHandler } from '../dev/transport-routes.js';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';
import {
  capturePackMiddleware,
  type Middleware,
  requestText as request,
} from './middleware-fixture.js';

const GUID = 'a1521f51-67a3-52f2-9241-5373b3afb6fc';
const EFFECT_PACKAGE_ID = '01900000-0000-7000-8000-aaaaaaaaaaaa';
const IMAGE_GUID = '01900000-0000-7000-8000-bbbbbbbbbbbb';
const UI_GUID = '01900000-0000-7000-8000-cccccccccccc';
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function activeScope(generation: number, base = ''): RuntimeAssetBinding {
  const path = `${base}/__pack/scopes/active/${generation}`;
  return {
    ...createStandaloneRuntimeAssetBinding('active'),
    generation,
    status: 'unbound',
    catalogUrl: `${path}/catalog.json`,
    importUrlBase: `${path}/import`,
    packageUrlBase: `${path}/asset`,
  };
}

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

  it('shares complete publication envelopes in the scoped catalog HTTP response', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-wire-'));
    const packageId = '01900000-0000-7000-8000-000000000050';
    const namespace = PackageId.parse(packageId);
    if (!namespace.ok) throw namespace.error;
    const keys = Array.from({ length: 32 }, (_, index) => `effect/${index}`);
    const assets = Object.fromEntries(
      keys.map((key, index) => [
        key,
        { kind: 'test-effect', payload: { marker: index }, refs: [] },
      ]),
    );
    await writeFile(
      join(root, 'shared.pack.json'),
      JSON.stringify({ schemaVersion: '3.0.0', packageId, assets }),
    );
    const plugin = pluginPack({ roots: [root] });
    close = () => plugin.closeBundle();
    const middlewares = capturePackMiddleware(plugin);
    const binding = createStandaloneRuntimeAssetBinding('scoped-wire');
    await plugin.rebind(binding, [root]);
    const stringify = vi.spyOn(JSON, 'stringify');
    const response = await request(middlewares, binding.catalogUrl);
    const publicationEncodes = stringify.mock.calls.filter(
      ([value]) => value?.schemaVersion === 'asset-publication/1',
    ).length;
    expect(publicationEncodes).toBe(1);
    expect(response.statusCode).toBe(200);
    const wire = JSON.parse(response.body);
    expect(wire).toMatchObject({
      schemaVersion: RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
      scopeId: binding.scopeId,
      generation: binding.generation,
      authority: 'authoritative',
      entries: { schemaVersion: 'pack-index-tables/1' },
    });
    const rows = decodeCatalogWire(wire).unwrap();
    expect(rows.map((row) => row.guid).sort()).toEqual(
      keys.map((key) => AssetGuid.format(AssetGuid.derive(namespace.value, key))).sort(),
    );
    expect(wire.entries.publications).toHaveLength(1);
    const publication = rows[0]?.publication;
    expect(publication?.outputs).toHaveLength(keys.length);
    expect(publication?.receipt.outputSetDigest).toBe(publication?.outputSetDigest);
    expect(rows.every((row) => row.publication === publication)).toBe(true);
    expect(rows.every((row) => row.packageUrl.startsWith(binding.packageUrlBase))).toBe(true);
    expect(response.body.match(/"schemaVersion":"asset-publication\/1"/g)).toHaveLength(1);
    expect(response.body.length).toBeLessThan(JSON.stringify({ ...wire, entries: rows }).length);
    expect((await request(middlewares, binding.catalogUrl)).body).toBe(response.body);
  });

  it('waits for startup when a bound scope is still transitioning before lazy import', async () => {
    const { promise: startupReady, resolve: releaseStartup } = testGate();
    const binding = createStandaloneRuntimeAssetBinding('startup-race');
    const entry = {
      guid: GUID,
      packageUrl: `/__forgeax-ddc/${GUID}.runtime-pack.json`,
      sourcePath: 'fixture.pack.json',
    } as PackIndexEntry;
    const state = {
      catalogProjection: { declarations: new Map(), entries: [entry] },
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
                  expected: 'an accepted ForgeAX pack snapshot',
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
      scopedCatalogEntry: (_scope, entry) => entry,
      scopedCatalogBody: () => JSON.stringify({ entries: [entry] }),
    });
    const route = `${binding.importUrlBase}/${GUID}`;
    let finished = false;
    const pending = request([handler], route, 'POST').finally(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(materializeCalls).toBe(0);

    sessionStatus = 'serving';
    runtimeStatus = 'ready';
    releaseStartup();
    expect((await pending).statusCode).toBe(200);
    expect(materializeCalls).toBe(1);

    sessionStatus = 'failed';
    expect((await request([handler], route, 'POST')).statusCode).toBe(500);
    expect(materializeCalls).toBe(1);
  });

  it('rejects asset identity routes before any runtime scope is bound', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-unbound-'));
    const plugin = pluginPack({ roots: [root] });
    close = () => plugin.closeBundle();
    const middlewares = capturePackMiddleware(plugin);
    expect(plugin.runtimeBinding()).toBeUndefined();
    for (const path of [
      '/__pack/index',
      '/pack-index.json',
      `/__forgeax-ddc/${GUID}.runtime-pack.json`,
      '/__pack/scopes/active/1/catalog.json',
    ])
      expect((await request(middlewares, path)).statusCode).toBe(404);
    expect((await request(middlewares, `/__import/${GUID}`, 'POST')).statusCode).toBe(404);
  });

  it.each([
    '',
    '/preview',
  ])('binds one game and returns exactly scoped URLs with host base %s', async (base) => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-scope-'));
    const active = join(root, 'active');
    const broken = join(root, 'broken-sibling');
    await Promise.all([mkdir(active), mkdir(broken)]);
    await writeFile(
      join(active, 'effect.pack.json'),
      JSON.stringify(
        directPackFixture(EFFECT_PACKAGE_ID, {
          output: { kind: 'test-effect', payload: { schemaVersion: 1 }, refs: [] },
        }),
      ),
    );
    await writeFile(join(broken, 'broken.pack.json'), '{not-json');
    const plugin = pluginPack({ roots: [active, broken] }, { transportBase: `${base}/` });
    close = () => plugin.closeBundle();
    const middlewares = capturePackMiddleware(plugin);
    const binding = (generation: number) => activeScope(generation, base);
    const catalog = (generation: number) =>
      request(middlewares, activeScope(generation).catalogUrl);
    const expectedUrl = (generation: number) =>
      `${binding(generation).packageUrlBase}/__forgeax-ddc/${EFFECT_PACKAGE_ID}.runtime-pack.json`;

    const bound = await plugin.rebind(binding(7), [active]);
    expect(bound).toMatchObject({ status: 'ready', authority: 'authoritative' });
    expect(plugin.runtimeBinding()).toMatchObject({
      scopeId: 'active',
      generation: 7,
      status: 'ready',
    });

    const stringify = vi.spyOn(JSON, 'stringify');
    const snapshotWrites = () =>
      stringify.mock.calls.filter(
        ([value]) => value?.schemaVersion === RUNTIME_CATALOG_SNAPSHOT_SCHEMA,
      );
    const first = await catalog(7);
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(decodeCatalogWire(JSON.parse(first.body)).unwrap()).toMatchObject([
      { guid: GUID, packageUrl: expectedUrl(7) },
    ]);
    for (const response of await Promise.all([catalog(7), catalog(7)]))
      expect(response.body).toBe(first.body);
    expect(snapshotWrites()).toHaveLength(1);
    const pack = await request(middlewares, expectedUrl(7));
    expect(pack.statusCode).toBe(200);
    expect(JSON.parse(pack.body).assets[0].guid).toBe(GUID);
    const prefixed = await request(middlewares, binding(7).catalogUrl);
    expect(prefixed.statusCode).toBe(200);
    expect(JSON.parse(prefixed.body).authority).toBe('authoritative');

    for (const path of [
      '/__pack/index',
      '/pack-index.json',
      `/__forgeax-ddc/${EFFECT_PACKAGE_ID}.runtime-pack.json`,
      '/__pack/scopes/other/7/catalog.json',
    ])
      expect((await request(middlewares, path)).statusCode).toBe(404);
    expect((await request(middlewares, `/__import/${GUID}`, 'POST')).statusCode).toBe(404);
    expect((await catalog(6)).statusCode).toBe(410);

    await plugin.rebind(binding(8), [active]);
    expect((await catalog(7)).statusCode).toBe(410);
    const next = await catalog(8);
    expect(JSON.parse(next.body)).toMatchObject({ generation: 8 });
    expect(decodeCatalogWire(JSON.parse(next.body)).unwrap()).toMatchObject([
      { packageUrl: expectedUrl(8) },
    ]);
    expect((await catalog(8)).body).toBe(next.body);
    expect(snapshotWrites()).toHaveLength(2);
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
      metaFixture('pixel.png', 'image', [{ guid: IMAGE_GUID, sourceIndex: 0, kind: 'texture' }], {
        colorSpace: 'srgb',
        mipmap: false,
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

    const plugin = pluginPack(
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
    expect(decodeCatalogWire(JSON.parse(afterSecondImport.body)).unwrap()).toEqual(
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
    const snapshot = decodeCatalogWire(JSON.parse(catalog.body)).unwrap();
    const entry = snapshot.find((candidate) => candidate.guid === IMAGE_GUID);
    expect(entry?.publication).toMatchObject({ schemaVersion: 'asset-publication/1' });
    expect(entry?.publication?.generation).toBeGreaterThan(0);
    const changed = deltas
      .flatMap((delta) => delta.changed)
      .reverse()
      .find((row) => row.guid === IMAGE_GUID);
    expect(changed).toEqual(entry);
    expect((await request(middlewares, changed?.packageUrl ?? '')).statusCode).toBe(200);
    expect(
      (await request(middlewares, `/__forgeax-ddc/${IMAGE_GUID}.runtime-pack.json`)).statusCode,
    ).toBe(404);

    const authoredPath = join(active, 'added.pack.json');
    await writeFile(
      authoredPath,
      JSON.stringify(
        directPackFixture(EFFECT_PACKAGE_ID, {
          output: { kind: 'test-effect', payload: {}, refs: [] },
        }),
      ),
    );
    await expect
      .poll(() => deltas.flatMap((delta) => delta.added).find((row) => row.guid === GUID))
      .toBeDefined();
    const added = deltas
      .flatMap((delta) => delta.added)
      .reverse()
      .find((row) => row.guid === GUID);
    const nextCatalog = decodeCatalogWire(
      JSON.parse((await request(middlewares, bound.catalogUrl)).body),
    ).unwrap();
    expect(added).toEqual(nextCatalog.find((row) => row.guid === GUID));
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
      metaFixture('hud.ui.html', 'ui', [{ guid: UI_GUID, sourceIndex: 0, kind: 'ui' }]),
    );

    const plugin = pluginPack({
      roots: [active],
      producerReadiness: 'on-demand',
      importers: [createUiImporter()],
      ddc: projectDdcForTest(root),
    });
    close = () => plugin.closeBundle();
    const middlewares = capturePackMiddleware(plugin);

    await plugin.rebind(activeScope(11), [active]);

    const initial = await request(middlewares, '/__pack/scopes/active/11/catalog.json');
    const initialSnapshot = decodeCatalogWire(JSON.parse(initial.body)).unwrap();
    const initialEntry = initialSnapshot.find((entry) => entry.guid === UI_GUID);
    expect(initialEntry).toBeDefined();
    expect(initialEntry?.publication).toBeUndefined();

    const packageResponse = await request(middlewares, initialEntry?.packageUrl ?? '');
    expect(packageResponse.statusCode).toBe(200);
    const pack = JSON.parse(packageResponse.body);
    expect(pack).toMatchObject({ scopeId: 'active', assets: [{ guid: UI_GUID }] });

    const afterPackage = await request(middlewares, '/__pack/scopes/active/11/catalog.json');
    const afterPackageSnapshot = decodeCatalogWire(JSON.parse(afterPackage.body)).unwrap();
    const published = afterPackageSnapshot.find((entry) => entry.guid === UI_GUID);
    expect(published?.publication).toMatchObject({
      generation: pack.generation,
      digest: pack.digest,
      outputSetDigest: pack.outputSetDigest,
    });

    const imported = await request(
      middlewares,
      `/__pack/scopes/active/11/import/${UI_GUID}`,
      'POST',
    );
    expect(imported.statusCode).toBe(200);
    const afterImport = await request(middlewares, '/__pack/scopes/active/11/catalog.json');
    const afterImportSnapshot = decodeCatalogWire(JSON.parse(afterImport.body)).unwrap();
    expect(afterImportSnapshot.find((entry) => entry.guid === UI_GUID)).toEqual(published);
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
      JSON.stringify(
        directPackFixture(EFFECT_PACKAGE_ID, {
          output: { kind: 'test-effect', payload: { schemaVersion: 1 }, refs: [] },
        }),
      ),
    );
    await writeFile(join(brokenRoot, 'broken.pack.json'), '{not-json');

    const plugin = pluginPack({ roots: [active] });
    close = () => plugin.closeBundle();
    const middlewares = capturePackMiddleware(plugin);

    const bound = await plugin.rebind(activeScope(8), [validRoot, brokenRoot]);
    expect(bound.status).toBe('degraded');
    expect(bound.authority).toBe('degraded');
    expect(bound.diagnostics?.length).toBeGreaterThan(0);

    const catalog = await request(middlewares, '/__pack/scopes/active/8/catalog.json');
    expect(catalog.statusCode).toBe(500);

    const imported = await request(middlewares, `/__pack/scopes/active/8/import/${GUID}`, 'POST');
    expect(imported.statusCode).toBe(500);
  });
});
