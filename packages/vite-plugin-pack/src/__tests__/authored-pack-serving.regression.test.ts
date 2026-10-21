import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureAssetPublication, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const GUID = '01900000-0000-7000-8000-00000000000a';

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

interface Response {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  end(chunk: string | Uint8Array): void;
}

type Middleware = (
  req: { url?: string; method?: string },
  res: Response,
  next: () => void,
) => unknown;

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

async function request(
  middlewares: readonly Middleware[],
  url: string,
  method = 'GET',
): Promise<Response> {
  const response: Response = {
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
    if (middleware !== undefined) await middleware({ url, method }, response, () => undefined);
  };
  await next();
  return response;
}

describe('authored development pack serving', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('reads current direct authored bytes without watcher invalidation', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-authored-pack-serving-'));
    const sourcePath = join(root, 'scene.pack.json');
    const source = (marker: string) =>
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [{ guid: GUID, kind: 'mesh', payload: { marker }, refs: [], artifacts: {} }],
      });
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
    const updatedBody = `${source('updated')}\n`;
    await writeFile(sourcePath, updatedBody);
    await utimes(sourcePath, sourceTime.atime, sourceTime.mtime);
    expect(Math.abs((await stat(sourcePath)).mtimeMs - sourceTime.mtimeMs)).toBeLessThan(1);

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

  it('keeps legacy authored packs readable after a direct refresh', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-legacy-authored-pack-serving-'));
    const sourcePath = join(root, 'font.pack.json');
    const source = (marker: string) =>
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: GUID,
            kind: 'font',
            payload: {
              marker,
              atlasGuid: '01900000-0000-760b-ae18-fe6775dc046a',
              samplerGuid: '01900000-0000-7313-b4f0-f5d55536acd2',
            },
            refs: ['01900000-0000-760b-ae18-fe6775dc046a', '01900000-0000-7313-b4f0-f5d55536acd2'],
          },
        ],
      });
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
    if (entry === undefined) throw new Error('expected the legacy authored pack catalog entry');

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
        ? JSON.stringify({
            schemaVersion: '3.0.0',
            packageId: '019ffa97-0000-7000-8000-000000000052',
            assets: {
              item: { kind: 'clock-fixture', payload: { marker }, refs: [] },
            },
          })
        : `export default { schemaVersion: '2.0.0', packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,82]),
          build: () => ({ ok: true, value: { item: { kind: 'clock-fixture', execution: 'cooked', source: { marker: ${marker} } } } }) };`;
    await writeFile(sourcePath, source(1));
    // Avoid rounding a fractional filesystem timestamp across a millisecond boundary.
    await utimes(sourcePath, 1, 1);
    const sourceTime = await stat(sourcePath);
    const plugin = pluginPack({
      roots: [root],
      watch: false,
      ddc: { projectDdcRoot: join(root, 'ddc') },
      cookers: [
        {
          key: 'clock-fixture',
          cook: ({ guid, source }) => ({
            guid,
            payload: { kind: 'clock-fixture', ...(source as object) },
            refs: [],
            artifacts: {},
            inputFingerprint: JSON.stringify(source),
          }),
        },
      ],
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
      await plugin.rebuildCatalogInPlace([sourcePath]);
      const after = plugin.catalogSnapshot()[0];
      expect(after?.publication?.generation).toBeGreaterThan(before?.publication?.generation ?? 0);
      // Source observation remains provenance; publication order has its own clock.
      expect(after?.revision?.observedAt).toBe(before?.revision?.observedAt);
      expect(after?.revision?.digest).not.toBe(before?.revision?.digest);
    } finally {
      await plugin.closeBundle();
    }
  });
});
