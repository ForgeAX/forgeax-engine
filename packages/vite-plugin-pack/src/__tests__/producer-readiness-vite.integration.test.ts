import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzip } from 'node:zlib';
import {
  type DdcEntry,
  DdcEntryStore,
  DdcGenerationSession,
  ddcOutputDigest,
} from '@forgeax/engine-ddc';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

vi.mock('node:zlib', async () => {
  const actual = await vi.importActual<typeof import('node:zlib')>('node:zlib');
  return { ...actual, gzip: vi.fn(actual.gzip) };
});

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const SECOND_GUID = '019e3969-1d48-7c3b-ac24-6d68f4570660';

interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

interface Server {
  middlewares: { use(handler: Handler): void };
  ws: { send(payload: { type: string } & Record<string, unknown>): void };
  handler?: Handler;
}

type Handler = (
  req: {
    url?: string;
    method?: string;
    headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  },
  res: Response & {
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => void | Promise<void>;

function server(): Server {
  const result = {
    middlewares: {
      use(handler: Handler) {
        result.handler = handler;
      },
    },
    ws: { send() {} },
  } as Server;
  return result;
}

async function request(
  target: Server,
  url: string,
  method = 'GET',
  headers?: Readonly<Record<string, string>>,
): Promise<Response> {
  const response: Response = { statusCode: 200, headers: {}, body: undefined };
  if (target.handler === undefined) throw new Error('plugin middleware was not registered');
  await target.handler(
    { url, method, ...(headers === undefined ? {} : { headers }) },
    {
      headers: response.headers,
      get body() {
        return response.body;
      },
      get statusCode() {
        return response.statusCode;
      },
      set statusCode(value: number) {
        response.statusCode = value;
      },
      setHeader(name, value) {
        response.headers[name] = value;
      },
      end(body) {
        response.body = body;
      },
    },
    () => {},
  );
  return response;
}

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
            body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
          },
        },
      ],
      sourceDependencies: [],
    },
  }),
};

describe('producer readiness in the Vite serve lifecycle', () => {
  const roots: string[] = [];
  const pluginClosers: Array<() => Promise<void>> = [];
  const originalCwd = process.cwd();

  function ownPlugin<T extends { closeBundle(): Promise<void> }>(plugin: T): T {
    pluginClosers.push(() => plugin.closeBundle());
    return plugin;
  }

  afterEach(async () => {
    process.chdir(originalCwd);
    await Promise.all(pluginClosers.splice(0).map((close) => close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('settles the source package before the first catalog read and package GET', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'scene.fixture',
        importSettings: {},
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );

    const target = server();
    const plugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [fixtureImporter],
        producerReadiness: 'before-consume',
      }),
    );
    plugin.configureServer(target);
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness');
    await plugin.rebind(binding, [assets]);
    const index = JSON.parse(String((await request(target, binding.catalogUrl)).body)) as {
      entries: Array<{
        guid: string;
        lifecycle?: string;
        packageUrl: string;
      }>;
    };
    const row = index.entries.find((entry) => entry.guid.toLowerCase() === GUID);

    expect(row?.lifecycle).toBe('current');
    expect(row?.packageUrl).toBe(
      `/__pack/scopes/producer-readiness/1/asset/__forgeax-ddc/${GUID}.pack.json`,
    );
    const packageResponse = await request(target, row?.packageUrl ?? '');
    expect(packageResponse.statusCode).toBe(200);
    expect(JSON.parse(String(packageResponse.body)).assets).toHaveLength(1);

    const packDdcPath = resolve(
      root,
      'node_modules/.cache/forgeax-ddc/runtime/producer-readiness-1',
      `${GUID}.pack.json`,
    );
    expect(JSON.parse(await readFile(packDdcPath, 'utf8')).assets).toHaveLength(1);
    await expect(
      readFile(
        resolve(
          root,
          'node_modules/.cache/forgeax-ddc/runtime/producer-readiness-1',
          `${GUID}.meta.pack.bin`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await plugin.closeBundle();
  });

  it('rehydrates an accepted Pack and artifact closure in a fresh plugin process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-cross-process-'));
    roots.push(root);
    const assets = join(root, 'assets');
    const ddcRoot = join(root, '.forgeax', 'ddc', 'v2');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'scene.fixture',
        importSettings: {},
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-cross-process');
    const firstTarget = server();
    const firstPlugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [fixtureImporter],
        producerReadiness: 'on-demand',
        runtimeBinding: binding,
        ddc: { projectDdcRoot: ddcRoot },
      }),
    );
    firstPlugin.configureServer(firstTarget);
    const firstIndex = JSON.parse(
      String((await request(firstTarget, binding.catalogUrl)).body),
    ) as {
      entries: Array<{ guid: string; packageUrl: string }>;
    };
    const firstRow = firstIndex.entries.find((entry) => entry.guid.toLowerCase() === GUID);
    expect(firstRow).toBeDefined();
    const imported = await request(firstTarget, `${binding.importUrlBase}/${GUID}`, 'POST');
    expect(imported.statusCode).toBe(200);
    const firstPackResponse = await request(firstTarget, firstRow?.packageUrl ?? '');
    expect(firstPackResponse.statusCode).toBe(200);
    const firstPack = JSON.parse(String(firstPackResponse.body)) as {
      assets: Array<{ artifacts: Record<string, { path: string }> }>;
    };
    const artifactPath = firstPack.assets[0]?.artifacts.body?.path;
    expect(artifactPath).toBeDefined();
    if (artifactPath === undefined) return;
    const artifactUrl = new URL(artifactPath, `http://forgeax.test${firstRow?.packageUrl ?? ''}`)
      .pathname;
    const runtimeDdcRoot = join(ddcRoot, 'runtime', 'producer-readiness-cross-process-1');
    const ddcStore = new DdcEntryStore(runtimeDdcRoot);
    const ddcKeys = await ddcStore.listKeys();
    expect(ddcKeys).toHaveLength(1);
    const ddcEntry = await ddcStore.read(ddcKeys[0] ?? '');
    expect(ddcEntry?.artifacts).toHaveProperty(`${GUID}/body.bin`);

    await firstPlugin.closeBundle();

    let importCalls = 0;
    const secondImporter: Importer = {
      key: 'fixture',
      import: async () => {
        importCalls += 1;
        throw new Error('fresh process must use the accepted DDC closure');
      },
    };
    const secondTarget = server();
    const secondPlugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [secondImporter],
        producerReadiness: 'on-demand',
        runtimeBinding: binding,
        ddc: { projectDdcRoot: ddcRoot },
      }),
    );
    secondPlugin.configureServer(secondTarget);
    const secondIndex = JSON.parse(
      String((await request(secondTarget, binding.catalogUrl)).body),
    ) as {
      entries: Array<{ guid: string; packageUrl: string }>;
    };
    const secondRow = secondIndex.entries.find((entry) => entry.guid.toLowerCase() === GUID);
    const secondPackResponse = await request(secondTarget, secondRow?.packageUrl ?? '');
    expect(secondPackResponse.statusCode).toBe(200);
    expect(JSON.parse(String(secondPackResponse.body))).toEqual(firstPack);
    const secondArtifactResponse = await request(secondTarget, artifactUrl);
    expect(secondArtifactResponse.statusCode).toBe(200);
    expect(secondArtifactResponse.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(importCalls).toBe(0);
  });

  it('repairs an incomplete accepted DDC closure before serving a fresh artifact request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-incomplete-'));
    roots.push(root);
    const assets = join(root, 'assets');
    const ddcRoot = join(root, '.forgeax', 'ddc', 'v2');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'scene.fixture',
        importSettings: {},
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );

    const stalePack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: GUID,
          kind: 'fixture-mesh',
          payload: { kind: 'fixture-mesh', revision: 'stale' },
          refs: [],
          artifacts: {
            body: {
              path: `${GUID}/body.bin`,
              mediaType: 'application/octet-stream',
              contentEncoding: 'identity',
              byteLength: 3,
              integrity: { algorithm: 'sha256', digest: `sha256:${'0'.repeat(64)}` },
            },
          },
        },
      ],
    };
    const staleKey = 'a'.repeat(64);
    const staleEntry: DdcEntry = {
      key: staleKey,
      guid: GUID,
      payload: stalePack,
      refs: [],
      artifacts: {},
      receipt: {
        guid: GUID,
        key: staleKey,
        producer: 'test/incomplete-closure',
        inputFingerprint: staleKey,
        outputDigest: ddcOutputDigest({
          guid: GUID,
          payload: stalePack,
          refs: [],
          artifacts: {},
        }),
      },
    };
    const runtimeDdcRoot = join(ddcRoot, 'runtime', 'producer-readiness-incomplete-1');
    const seedSession = new DdcGenerationSession(runtimeDdcRoot, { generation: 1 });
    const seedCandidate = await seedSession.stageEntry(staleEntry);
    await seedSession.commitEntry(seedCandidate, staleKey);
    await seedSession.close();

    let importCalls = 0;
    const repairingImporter: Importer = {
      key: 'fixture',
      import: async (context) => {
        importCalls += 1;
        const source = await context.readSource();
        if (!source.ok) throw new Error('fixture source read failed');
        return fixtureImporter.import(context);
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-incomplete');
    const target = server();
    const plugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [repairingImporter],
        producerReadiness: 'on-demand',
        runtimeBinding: binding,
        ddc: { projectDdcRoot: ddcRoot },
      }),
    );
    plugin.configureServer(target);
    const index = JSON.parse(String((await request(target, binding.catalogUrl)).body)) as {
      entries: Array<{ guid: string; packageUrl: string }>;
    };
    const row = index.entries.find((entry) => entry.guid.toLowerCase() === GUID);
    expect(row).toBeDefined();
    if (row === undefined) return;
    const artifactUrl = new URL(`${GUID}/body.bin`, `http://forgeax.test${row.packageUrl}`)
      .pathname;
    const response = await request(target, artifactUrl);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(importCalls).toBe(1);
  });

  it('waits for before-consume startup before a scoped import request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-route-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    const delayedGuid = '019e3969-1d48-7c3b-ac24-6d68f4570650';
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture-delayed',
        source: 'scene.fixture',
        importSettings: {},
        subAssets: [{ guid: delayedGuid, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );

    let signalImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      signalImportStarted = resolve;
    });
    let releaseImport!: () => void;
    const importRelease = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const delayedImporter: Importer = {
      key: 'fixture-delayed',
      import: async () => {
        signalImportStarted();
        await importRelease;
        return {
          ok: true,
          value: {
            assets: [
              {
                guid: delayedGuid,
                kind: 'fixture-mesh',
                payload: { kind: 'fixture-mesh', vertexCount: 3 },
                refs: [],
                artifacts: {
                  body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([4, 5, 6]) },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-route');
    const target = server();
    const plugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [delayedImporter],
        producerReadiness: 'before-consume',
        runtimeBinding: binding,
      }),
    );
    plugin.configureServer(target);

    await importStarted;
    const pending = request(target, `${binding.importUrlBase}/${delayedGuid}`, 'POST');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseImport();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual(
      expect.arrayContaining([expect.objectContaining({ guid: delayedGuid })]),
    );
    await plugin.closeBundle();
  });

  it('aborts intake before draining a delayed lazy import on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-close-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const closingGuid = SECOND_GUID;
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture-close',
        source: 'scene.fixture',
        importSettings: {},
        subAssets: [{ guid: closingGuid, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );

    let signalImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => {
      signalImportStarted = resolve;
    });
    let releaseImport!: () => void;
    const importRelease = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const delayedImporter: Importer = {
      key: 'fixture-close',
      import: async () => {
        signalImportStarted();
        await importRelease;
        return {
          ok: true,
          value: {
            assets: [
              {
                guid: closingGuid,
                kind: 'fixture-mesh',
                payload: { kind: 'fixture-mesh', vertexCount: 3 },
                refs: [],
                artifacts: {
                  body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([4, 5, 6]) },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-close');
    const target = server();
    const plugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [delayedImporter],
        producerReadiness: 'on-demand',
        runtimeBinding: binding,
      }),
    );
    plugin.configureServer(target);
    await plugin.rebind(binding, [assets]);

    const pending = request(target, `${binding.importUrlBase}/${closingGuid}`, 'POST');
    await importStarted;
    let closed = false;
    const closing = plugin.closeBundle().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    releaseImport();
    await closing;
    const closedResponse = await pending;
    expect(closedResponse.statusCode).toBe(410);
  });

  it('publishes multiple startup packages without losing an earlier catalog commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-multiple-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    for (const [name, guid] of [
      ['first', GUID],
      ['second', SECOND_GUID],
    ] as const) {
      await writeFile(join(assets, `${name}.fixture`), name);
      await writeFile(
        join(assets, `${name}.fixture.meta.json`),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'fixture-multiple',
          source: `${name}.fixture`,
          importSettings: {},
          subAssets: [{ guid, sourceIndex: 0, kind: 'fixture-mesh' }],
        }),
      );
    }
    const multipleImporter: Importer = {
      key: 'fixture-multiple',
      import: async (context) => {
        const guid = context.subAssets[0]?.guid;
        if (guid === undefined) throw new Error('fixture meta lacks a guid');
        if (guid === GUID) await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return {
          ok: true,
          value: {
            assets: [
              {
                guid,
                kind: 'fixture-mesh',
                payload: { kind: 'fixture-mesh', vertexCount: 3 },
                refs: [],
                artifacts: {
                  body: {
                    mediaType: 'application/octet-stream',
                    bytes: new Uint8Array([1, 2, 3]),
                  },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const target = server();
    const plugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [multipleImporter],
        producerReadiness: 'before-consume',
      }),
    );
    plugin.configureServer(target);
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-multiple');
    await plugin.rebind(binding, [assets]);
    const index = JSON.parse(String((await request(target, binding.catalogUrl)).body)) as {
      entries: Array<{ guid: string; lifecycle?: string; packageUrl: string }>;
    };
    for (const guid of [GUID, SECOND_GUID]) {
      const row = index.entries.find((entry) => entry.guid.toLowerCase() === guid);
      expect(row?.lifecycle).toBe('current');
      expect((await request(target, row?.packageUrl ?? '')).statusCode).toBe(200);
    }
    await plugin.closeBundle();
  });

  it('compresses only new artifacts when independent lazy packages are published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-compression-'));
    roots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    for (const guid of [GUID, SECOND_GUID]) {
      await writeFile(join(assets, `${guid}.fixture`), guid);
      await writeFile(
        join(assets, `${guid}.fixture.meta.json`),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'fixture-compression',
          source: `${guid}.fixture`,
          importSettings: {},
          subAssets: [{ guid, sourceIndex: 0, kind: 'fixture-mesh' }],
        }),
      );
    }
    const importer: Importer = {
      key: 'fixture-compression',
      import: async (context) => {
        const guid = context.subAssets[0]?.guid;
        if (guid === undefined) throw new Error('fixture meta lacks a guid');
        return {
          ok: true,
          value: {
            assets: [
              {
                guid,
                kind: 'fixture-mesh',
                payload: {},
                refs: [],
                artifacts: {
                  body: {
                    mediaType: 'application/octet-stream',
                    bytes: new Uint8Array(4096).fill(guid === GUID ? 41 : 149),
                  },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-compression');
    const target = server();
    const plugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [importer],
        producerReadiness: 'on-demand',
        runtimeBinding: binding,
        ddc: { projectDdcRoot: join(root, 'ddc') },
      }),
    );
    plugin.configureServer(target);
    expect((await request(target, binding.catalogUrl)).statusCode).toBe(200);
    vi.mocked(gzip).mockClear();
    for (const guid of [GUID, SECOND_GUID]) {
      expect((await request(target, `${binding.importUrlBase}/${guid}`, 'POST')).statusCode).toBe(
        200,
      );
      const index = JSON.parse(String((await request(target, binding.catalogUrl)).body)) as {
        entries: Array<{ guid: string; packageUrl: string }>;
      };
      // Both the earlier and newly published closures must remain fetchable.
      for (const acceptedGuid of guid === GUID ? [GUID] : [GUID, SECOND_GUID]) {
        const row = index.entries.find((entry) => entry.guid === acceptedGuid);
        expect(row).toBeDefined();
        const pack = JSON.parse(String((await request(target, row?.packageUrl ?? '')).body)) as {
          assets: Array<{ artifacts: { body: { path: string } } }>;
        };
        const artifactPath = pack.assets[0]?.artifacts.body.path;
        expect(artifactPath).toBeDefined();
        const url = new URL(artifactPath ?? '', `http://forgeax.test${row?.packageUrl ?? ''}`)
          .pathname;
        const response = await request(target, url, 'GET', { 'accept-encoding': 'gzip' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['Content-Encoding']).toBe('gzip');
        expect(gunzipSync(response.body as Uint8Array)).toEqual(
          Buffer.alloc(4096, acceptedGuid === GUID ? 41 : 149),
        );
      }
      expect(vi.mocked(gzip)).toHaveBeenCalledTimes(guid === GUID ? 1 : 2);
    }
  });

  it('keeps the prior Pack body until an explicit rebuild succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-ddc-retry-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const primarySource = join(assets, 'primary.fixture');
    const siblingSource = join(assets, 'sibling.fixture');
    const primaryMetaPath = join(assets, 'primary.fixture.meta.json');
    await writeFile(primarySource, 'revision-old');
    await writeFile(siblingSource, 'sibling-stable');
    await writeFile(
      primaryMetaPath,
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture-retry',
        source: 'primary.fixture',
        importSettings: { revision: 'old' },
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );
    const siblingMeta = JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'fixture-retry',
      source: 'sibling.fixture',
      importSettings: {},
      subAssets: [{ guid: SECOND_GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
    });
    await writeFile(join(assets, 'sibling.fixture.meta.json'), siblingMeta);

    const retryImporter: Importer = {
      key: 'fixture-retry',
      import: async (context) => {
        const source = await context.readSource();
        if (!source.ok) throw new Error('fixture source read failed');
        const revision = new TextDecoder().decode(source.value);
        const guid = context.subAssets[0]?.guid;
        if (guid === undefined) throw new Error('fixture meta lacks a guid');
        return {
          ok: true,
          value: {
            assets: [
              {
                guid,
                kind: 'fixture-mesh',
                payload: { kind: 'fixture-mesh', vertexCount: 3, revision },
                refs: [],
                artifacts: {
                  body: {
                    mediaType: 'application/octet-stream',
                    bytes: new Uint8Array([1, 2, 3]),
                  },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const target = server();
    const plugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [retryImporter],
        producerReadiness: 'before-consume',
      }),
    );
    plugin.configureServer(target);
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-ddc-retry');
    await plugin.rebind(binding, [assets]);

    const packDirectory = resolve(
      root,
      'node_modules/.cache/forgeax-ddc/runtime/producer-readiness-ddc-retry-1',
    );
    const primaryPackPath = join(packDirectory, `${GUID}.pack.json`);
    const siblingPackPath = join(packDirectory, `${SECOND_GUID}.pack.json`);
    const oldPrimaryBody = await readFile(primaryPackPath, 'utf8');
    const stableSiblingBody = await readFile(siblingPackPath, 'utf8');
    await writeFile(primarySource, 'revision-new');
    await writeFile(
      primaryMetaPath,
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture-retry',
        source: 'primary.fixture',
        importSettings: { revision: 'new' },
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
      }),
    );
    const metaBefore = await readFile(primaryMetaPath, 'utf8');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await chmod(packDirectory, 0o555);
    try {
      const refused = await request(target, `${binding.importUrlBase}/${GUID}`, 'POST', {
        'x-forgeax-import-mode': 'rebuild',
      });
      expect(refused.statusCode).toBe(200);
      expect(JSON.parse(String(refused.body))).toEqual(
        expect.arrayContaining([expect.objectContaining({ guid: GUID })]),
      );
      // Publication now treats DDC plus transport as one transaction. A
      // refused transport restores the previous LKG and returns its route;
      // the old post-commit warning would falsely imply the new DDC was live.
      expect(
        warning.mock.calls.filter(
          ([message]) => message === '[forgeax-pack] persist DDC pack failed:',
        ).length,
      ).toBe(0);
      expect(await readFile(primaryPackPath, 'utf8')).toBe(oldPrimaryBody);
      expect(JSON.parse(await readFile(primaryPackPath, 'utf8')).assets[0].payload.revision).toBe(
        'revision-old',
      );
      const failedCatalog = JSON.parse(
        String((await request(target, binding.catalogUrl)).body),
      ) as { entries: Array<{ guid: string; packageUrl: string }> };
      const failedRow = failedCatalog.entries.find((entry) => entry.guid === GUID);
      expect(failedRow?.packageUrl).toContain(`${GUID}.pack.json`);
      expect(
        JSON.parse(String((await request(target, failedRow?.packageUrl ?? '')).body)).assets[0]
          .payload.revision,
      ).toBe('revision-old');
      expect(await readFile(siblingPackPath, 'utf8')).toBe(stableSiblingBody);
    } finally {
      warning.mockRestore();
      await chmod(packDirectory, 0o755);
    }

    // The failed transaction leaves the accepted LKG imported. A normal
    // lookup must continue serving it; recovery explicitly requests a new
    // producer generation after the sidecar destination is repaired.
    const retried = await request(target, `${binding.importUrlBase}/${GUID}`, 'POST', {
      'x-forgeax-import-mode': 'rebuild',
    });
    expect(retried.statusCode).toBe(200);
    const repairedBody = await readFile(primaryPackPath, 'utf8');
    expect(JSON.parse(repairedBody).assets[0].payload.revision).toBe('revision-new');
    expect(await readFile(siblingPackPath, 'utf8')).toBe(stableSiblingBody);
    expect(await readFile(primaryMetaPath, 'utf8')).toBe(metaBefore);
    expect(await readFile(join(assets, 'sibling.fixture.meta.json'), 'utf8')).toBe(siblingMeta);
    expect((await readdir(packDirectory)).some((name) => name.includes('.tmp'))).toBe(false);
    await expect(readFile(join(packDirectory, `${GUID}.meta.pack.bin`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await plugin.closeBundle();
  });

  it('coalesces a watcher generation before materializing an overlapping route request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-producer-readiness-overlap-'));
    roots.push(root);
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const sourcePath = join(assets, 'overlap.fixture');
    const metaPath = join(assets, 'overlap.fixture.meta.json');
    await writeFile(sourcePath, 'revision-old');
    const writeMeta = (revision: string) =>
      writeFile(
        metaPath,
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'fixture-overlap',
          source: 'overlap.fixture',
          importSettings: { revision },
          subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'fixture-mesh' }],
        }),
      );
    await writeMeta('old');
    let releaseRebuild!: () => void;
    let sawRebuild = false;
    let markRebuildStarted!: () => void;
    const rebuildStarted = new Promise<void>((resolve) => {
      markRebuildStarted = resolve;
    });
    const rebuildRelease = new Promise<void>((resolve) => {
      releaseRebuild = resolve;
    });
    const overlapImporter: Importer = {
      key: 'fixture-overlap',
      import: async (context) => {
        const source = await context.readSource();
        if (!source.ok) throw new Error('fixture source read failed');
        const revision = new TextDecoder().decode(source.value);
        if (revision === 'revision-new' && !sawRebuild) {
          sawRebuild = true;
          markRebuildStarted();
          await rebuildRelease;
        }
        return {
          ok: true,
          value: {
            assets: [
              {
                guid: GUID,
                kind: 'fixture-mesh',
                payload: { kind: 'fixture-mesh', vertexCount: 3, revision },
                refs: [],
                artifacts: {
                  body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([7, 8, 9]) },
                },
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const target = server();
    const plugin = ownPlugin(
      pluginPack({
        roots: [assets],
        importers: [overlapImporter],
        producerReadiness: 'before-consume',
      }),
    );
    plugin.configureServer(target);
    const binding = createStandaloneRuntimeAssetBinding('producer-readiness-overlap');
    await plugin.rebind(binding, [assets]);
    await writeFile(sourcePath, 'revision-new');
    await writeMeta('new');
    const pending = request(target, `${binding.importUrlBase}/${GUID}`, 'POST');
    await rebuildStarted;
    expect(sawRebuild).toBe(true);
    releaseRebuild();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual(
      expect.arrayContaining([expect.objectContaining({ guid: GUID })]),
    );
    const packPath = join(
      root,
      'node_modules/.cache/forgeax-ddc/runtime/producer-readiness-overlap-1',
      `${GUID}.pack.json`,
    );
    expect(JSON.parse(await readFile(packPath, 'utf8')).assets[0].payload.revision).toBe(
      'revision-new',
    );
    await plugin.closeBundle();
  });
});
