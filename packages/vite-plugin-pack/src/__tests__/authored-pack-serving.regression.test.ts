import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureAssetPublication, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directPackFixture } from '../../../pack/src/__tests__/support/direct-pack-fixture.js';
import {
  capturePackMiddleware,
  type Middleware,
  requestText as request,
} from './middleware-fixture.js';

vi.mock('../dev/revision-observer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dev/revision-observer.js')>();
  return {
    ...actual,
    createRevisionObserver: (): import('../dev/revision-observer.js').RevisionObserver => ({
      ready: Promise.resolve(),
      reconcile: async () => 0,
      drain: async () => {},
      revision: () => 0,
      close: async () => {},
    }),
  };
});

import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const GUID = '54314fdc-26db-540e-9634-876eead78dc5';

interface RuntimeBinding {
  readonly schemaVersion: 'runtime-asset-binding-v1';
  readonly gameId: string;
  readonly scopeId: string;
  readonly generation: number;
  readonly status: 'unbound';
  readonly catalogUrl: string;
  readonly importUrlBase: string;
  readonly packageUrlBase: string;
}

function runtimeBinding(): RuntimeBinding {
  return {
    schemaVersion: 'runtime-asset-binding-v1',
    gameId: 'authored-pack-test',
    scopeId: 'authored-pack-test',
    generation: 1,
    status: 'unbound',
    catalogUrl: '/__pack/scopes/authored-pack-test/1/catalog.json',
    importUrlBase: '/__pack/scopes/authored-pack-test/1/import',
    packageUrlBase: '/__pack/scopes/authored-pack-test/1/asset',
  };
}

describe('authored development pack serving', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it.each([true, false])('fences same-stat Direct Pack writes with watch=%s', async (watch) => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-authored-pack-serving-'));
    const sourcePath = join(root, 'scene.pack.json');
    const source = (marker: string) =>
      JSON.stringify(
        directPackFixture('01900000-0000-7000-8000-00000000000a', {
          output: { kind: 'fixture-mesh', payload: { marker }, refs: [] },
        }),
      );
    await writeFile(sourcePath, source('initial'));
    await utimes(sourcePath, 1, 1);

    const middlewares: Middleware[] = [];
    const plugin = pluginPack({ roots: [root], watch });
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
      ws: { send: () => {} },
    });
    const binding = await plugin.rebind(runtimeBinding(), [root]);

    const catalogResponse = await request(middlewares, binding.catalogUrl);
    expect(catalogResponse.statusCode).toBe(200);
    const catalog = decodeCatalogWire(JSON.parse(catalogResponse.body)).unwrap();
    const entry = catalog.find((candidate) => candidate.guid === GUID);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('expected the authored pack catalog entry');

    const firstResponse = await request(middlewares, entry.packageUrl);
    expect(firstResponse.statusCode).toBe(200);
    expect(JSON.parse(firstResponse.body).assets[0].payload.marker).toBe('initial');
    const capture = await captureAssetPublication(
      entry,
      catalog,
      createCatalogSource({ entries: catalog }),
      async (url) => {
        const response = await request(middlewares, String(url));
        return new globalThis.Response(response.body, { status: response.statusCode });
      },
    );
    expect(capture.ok, JSON.stringify(capture)).toBe(true);

    const sourceTime = await stat(sourcePath);
    const updatedBody = source('updated');
    await writeFile(sourcePath, updatedBody);
    await utimes(sourcePath, sourceTime.atime, sourceTime.mtime);
    expect(Math.abs((await stat(sourcePath)).mtimeMs - sourceTime.mtimeMs)).toBeLessThan(1);

    expect((await stat(sourcePath)).size).toBe(sourceTime.size);
    if (!watch) {
      const refused = await request(middlewares, entry.packageUrl);
      expect(refused.statusCode).toBe(422);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'stale-generation' });
      await plugin.rebuildCatalogInPlace([sourcePath]);
    }

    const secondResponse = await request(middlewares, entry.packageUrl);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.headers['cache-control']).toBe('no-store');
    expect(secondResponse.body).not.toBe(updatedBody);
    expect(JSON.parse(secondResponse.body)).toMatchObject({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      scopeId: binding.scopeId,
      generation: expect.any(Number),
      digest: expect.stringMatching(/^sha256:/),
      outputSetDigest: expect.stringMatching(/^sha256:/),
      assets: [{ payload: { marker: 'updated' } }],
    });

    await plugin.closeBundle();
  });

  it('keeps a scoped Runtime Pack v2 readable after a direct refresh', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-runtime-pack-refresh-'));
    const sourcePath = join(root, 'level.pack.json');
    const source = (marker: string) =>
      JSON.stringify(
        directPackFixture('01900000-0000-7000-8000-00000000000a', {
          output: { kind: 'fixture-level', payload: { marker }, refs: [] },
        }),
      );
    await writeFile(sourcePath, source('initial'));

    const middlewares: Middleware[] = [];
    const plugin = pluginPack({ roots: [root] });
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as Middleware) },
      ws: { send: () => {} },
    });
    const binding = await plugin.rebind(runtimeBinding(), [root]);

    const catalogResponse = await request(middlewares, binding.catalogUrl);
    expect(catalogResponse.statusCode).toBe(200);
    const catalog = decodeCatalogWire(JSON.parse(catalogResponse.body)).unwrap();
    const entry = catalog.find((candidate) => candidate.guid === GUID);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('expected the authored pack catalog entry');

    const firstResponse = await request(middlewares, entry.packageUrl);
    expect(firstResponse.statusCode).toBe(200);
    expect(JSON.parse(firstResponse.body).schemaVersion).toBe('2.0.0');

    await writeFile(sourcePath, source('updated'));

    const secondResponse = await request(middlewares, entry.packageUrl);
    expect(secondResponse.statusCode).toBe(200);
    const refreshed = JSON.parse(secondResponse.body) as {
      schemaVersion: string;
      assets: Array<{ payload: { marker: string } }>;
    };
    expect(refreshed.schemaVersion).toBe('2.0.0');
    expect(refreshed.assets[0]?.payload.marker).toBe('updated');

    await plugin.closeBundle();
  });
  it.each([
    'direct',
    'scriptable',
  ] as const)('orders %s cooked publications independently from source mtime', async (format) => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-publication-clock-'));
    const sourcePath = join(root, format === 'direct' ? 'clock.pack.json' : 'clock.pack.ts');
    const source = (marker: number) =>
      format === 'direct'
        ? JSON.stringify(
            directPackFixture('019ffa97-0000-7000-8000-000000000052', {
              item: { kind: 'clock-fixture', payload: { marker }, refs: [] },
            }),
          )
        : `export default { schemaVersion: '2.0.0', packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,82]),
          build: () => ({ ok: true, value: { item: { kind: 'clock-fixture', execution: 'cooked', source: { marker: ${marker} } } } }) };`;
    await writeFile(sourcePath, source(1));
    // Avoid rounding a fractional filesystem timestamp across a millisecond boundary.
    await utimes(sourcePath, 1, 1);
    const sourceTime = await stat(sourcePath);
    const cook = vi.fn<NativeCooker['cook']>(({ guid, source }) => ({
      guid,
      payload: { kind: 'clock-fixture', ...(source as object) },
      refs: [],
      artifacts: {},
      inputFingerprint: JSON.stringify(source),
    }));
    const plugin = pluginPack({
      roots: [root],
      watch: false,
      ddc: { projectDdcRoot: join(root, 'ddc') },
      cookers: [{ key: 'clock-fixture', cook }],
    });
    plugin.configureServer({ middlewares: { use: () => {} }, ws: { send: () => {} } });
    try {
      await plugin.rebind(runtimeBinding(), [root], join(root, 'ddc'));
      const before = plugin.catalogSnapshot()[0];
      expect(before?.publication?.generation).toBeGreaterThan(0);
      expect(before?.revision?.observedAt).toBeGreaterThan(0);
      await writeFile(sourcePath, source(2));
      await utimes(sourcePath, sourceTime.atime, sourceTime.mtime);
      expect(Math.abs((await stat(sourcePath)).mtimeMs - sourceTime.mtimeMs)).toBeLessThan(1);
      cook.mockClear();
      await plugin.rebuildCatalogInPlace([sourcePath]);
      if (format === 'scriptable') expect(cook).toHaveBeenCalledTimes(1);
      const after = plugin.catalogSnapshot()[0];
      expect(after?.publication?.generation).toBe((before?.publication?.generation ?? 0) + 1);
      expect(after?.publication?.current?.generation).toBe(after?.publication?.generation);
      // Source observation remains provenance; publication order has its own clock.
      expect(after?.revision?.observedAt).toBe(before?.revision?.observedAt);
      expect(after?.revision?.digest).not.toBe(before?.revision?.digest);
    } finally {
      await plugin.closeBundle();
    }
  });

  it.each([
    undefined,
    'webgpu-storage',
  ] as const)('advances the %s native material publication with a single cook', async (profile) => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-authored-material-generation-'));
    const sourcePath = join(root, 'material.pack.ts');
    const material = createBuiltinMaterialAsset('standard');
    const source = (key: string) => `export default {
      schemaVersion: '2.0.0',
      packageId: new Uint8Array([1, 159, 250, 151, 0, 0, 112, 0, 128, 0, 0, 0, 0, 0, 0, 83]),
      build: () => ({ ok: true, value: { ${JSON.stringify(key)}: ${JSON.stringify(material)} } }),
    };`;
    await writeFile(sourcePath, source('material/first'));
    const { cacheIdentity: _cacheIdentity, ...native } = createMaterialPackCooker(
      [],
      profile === undefined ? {} : { profile },
    );
    const cook = vi.fn<NativeCooker['cook']>((input) => native.cook(input));
    const plugin = pluginPack({
      roots: [sourcePath],
      watch: false,
      ddc: { projectDdcRoot: join(root, 'ddc') },
      cookers: [{ ...native, cook }],
    });
    const middlewares = capturePackMiddleware(plugin);
    try {
      const binding = await plugin.rebind(runtimeBinding(), [root], join(root, 'ddc'));
      expect(plugin.catalogSnapshot()[0]?.publication?.generation).toBe(1);
      cook.mockClear();
      await writeFile(sourcePath, source('material/second'));
      await plugin.rebuildCatalogInPlace([sourcePath]);
      expect(cook).toHaveBeenCalledTimes(1);
      const catalog = await request(middlewares, binding.catalogUrl);
      const [row] = decodeCatalogWire(JSON.parse(catalog.body)).unwrap();
      if (!row) throw new Error('missing published material');
      const response = await request(middlewares, row.packageUrl);
      expect(response.statusCode).toBe(200);
      const published = decodeMaterialProgramWire(JSON.parse(response.body)).unwrap();
      expect(published).toMatchObject({ generation: 2 });
      expect(published).toMatchObject({
        assets: [
          {
            payload:
              profile === undefined
                ? { template: { schemaVersion: 'material-template/1' } }
                : {
                    cooked: {
                      publicationGeneration: 2,
                      receipt: { identity: { cookGeneration: 2 } },
                    },
                  },
          },
        ],
      });
      expect(row).toMatchObject({
        sourceKey: 'material/second',
        publication: { generation: 2, current: { generation: 2 } },
      });
    } finally {
      await plugin.closeBundle();
    }
  });
});
