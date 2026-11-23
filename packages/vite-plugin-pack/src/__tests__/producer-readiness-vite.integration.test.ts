import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gunzipSync, gzip } from 'node:zlib';
import { type DdcEntry, DdcEntryStore, DdcLifecycle, ddcOutputDigest } from '@forgeax/engine-ddc';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectories } from '../../../../scripts/test/temporary-directories.mjs';
import { testGate } from '../../../../scripts/test/test-gate.mjs';
import { metaFixture } from '../../../pack/src/__tests__/support/direct-pack-fixture.js';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';
import { requestServer as request, createServer as server } from './middleware-fixture.js';

vi.mock('node:zlib', async () => {
  const actual = await vi.importActual<typeof import('node:zlib')>('node:zlib');
  return { ...actual, gzip: vi.fn(actual.gzip) };
});

const GUID = '758d015c-7f40-56ef-b6c3-4d63eba1f032';
const SECOND_GUID = '019e3969-1d48-7c3b-ac24-6d68f4570660';

function fixtureMeta(
  source: string,
  guid: string,
  importer = 'fixture',
  importSettings: Record<string, unknown> = {},
): string {
  return metaFixture(
    source,
    importer,
    [{ guid, sourceIndex: 0, kind: 'fixture-mesh' }],
    importSettings,
  );
}

function importedFixture(
  guid: string,
  bytes?: Uint8Array,
  payload = { kind: 'fixture-mesh', vertexCount: 3 } as Record<string, unknown>,
) {
  return {
    ok: true as const,
    value: {
      assets: [
        {
          guid,
          kind: 'fixture-mesh',
          payload,
          refs: [],
          artifacts:
            bytes === undefined
              ? {}
              : {
                  body: { mediaType: 'application/octet-stream', bytes },
                },
        },
      ],
      sourceDependencies: [],
    },
  };
}

const fixtureImporter: Importer = {
  key: 'fixture',
  import: async () => importedFixture(GUID, new Uint8Array([1, 2, 3])),
};

function pauseImport(key: string, guid: string) {
  const { promise: started, resolve: markStarted } = testGate();
  const { promise: gate, resolve: release } = testGate();
  const importer: Importer = {
    key,
    async import() {
      markStarted();
      await gate;
      return importedFixture(guid, new Uint8Array([4, 5, 6]));
    },
  };
  return { importer, started, release };
}

function fixtureGuid(context: Parameters<Importer['import']>[0]) {
  const guid = context.subAssets[0]?.guid;
  if (guid === undefined) throw new Error('fixture meta lacks a guid');
  return guid;
}

async function fixtureRevision(context: Parameters<Importer['import']>[0]) {
  const source = await context.readSource();
  if (!source.ok) throw new Error('fixture source read failed');
  return new TextDecoder().decode(source.value);
}

describe('producer readiness in the Vite serve lifecycle', () => {
  const scratch = temporaryDirectories();
  const pluginClosers: Array<() => Promise<void>> = [];
  const originalCwd = process.cwd();

  function ownPlugin<T extends { closeBundle(): Promise<void> }>(plugin: T): T {
    pluginClosers.push(() => plugin.closeBundle());
    return plugin;
  }

  afterEach(async () => {
    process.chdir(originalCwd);
    await Promise.all(pluginClosers.splice(0).map((close) => close()));
    await scratch.clear();
  });

  it('settles the source package before the first catalog read and package GET', async () => {
    const root = await scratch.make('forgeax-producer-readiness-');
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    await writeFile(join(assets, 'scene.fixture.meta.json'), fixtureMeta('scene.fixture', GUID));

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
    const index = decodeCatalogWire(
      JSON.parse(String((await request(target, binding.catalogUrl)).body)),
    ).unwrap();
    const row = index.find((entry) => entry.guid.toLowerCase() === GUID);

    expect(row?.lifecycle).toBe('current');
    expect(row?.packageUrl).toBe(
      `/__pack/scopes/producer-readiness/1/asset/__forgeax-ddc/${GUID}.runtime-pack.json`,
    );
    const packageResponse = await request(target, row?.packageUrl ?? '');
    expect(packageResponse.statusCode).toBe(200);
    expect(JSON.parse(String(packageResponse.body)).assets).toHaveLength(1);

    const packDdcRoot = resolve(
      root,
      'node_modules/.cache/forgeax-ddc/runtime/producer-readiness-1',
    );
    const current = await new DdcLifecycle(packDdcRoot).readCurrentEntry(GUID);
    expect(current.entry?.payload).toMatchObject({ assets: [{ guid: GUID }] });
    await plugin.closeBundle();
  });

  it.each([
    true,
    false,
  ])('publishes both startup packages (parallel=%s)', async (parallelPreparation) => {
    const root = await scratch.make('forgeax-parallel-meta-preparation-');
    const assets = join(root, 'assets');
    await mkdir(assets);
    for (const [name, guid] of [
      ['a', GUID],
      ['b', SECOND_GUID],
    ] as const) {
      const source = `${name}.fixture`;
      await writeFile(join(assets, source), 'fixture');
      await writeFile(join(assets, `${source}.meta.json`), fixtureMeta(source, guid));
    }

    const { promise: firstGate, resolve: releaseFirst } = testGate();
    const started: string[] = [];
    const binding = createStandaloneRuntimeAssetBinding('parallel-meta-preparation');
    const target = server();
    const plugin = ownPlugin(
      pluginPack({
        roots: [assets],
        runtimeBinding: binding,
        producerReadiness: 'before-consume',
        importers: [
          {
            key: 'fixture',
            ...(parallelPreparation
              ? { capabilities: { parallelPreparation: true as const } }
              : {}),
            async import(context) {
              const guid = fixtureGuid(context);
              started.push(guid);
              if (guid === GUID) await firstGate;
              return importedFixture(guid);
            },
          },
        ],
      }),
    );
    plugin.configureServer(target);
    let settled = false;
    const pending = request(target, binding.catalogUrl).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(started).toContain(GUID));
      if (parallelPreparation) await vi.waitFor(() => expect(started).toContain(SECOND_GUID));
      else expect(started).toEqual([GUID]);
      expect(settled).toBe(false);
    } finally {
      releaseFirst();
      await pending;
    }
    const catalog = decodeCatalogWire(JSON.parse(String((await pending).body))).unwrap();
    for (const guid of [GUID, SECOND_GUID]) {
      const row = catalog.find((entry) => entry.guid.toLowerCase() === guid);
      expect(row?.lifecycle).toBe('current');
      const response = await request(target, row?.packageUrl ?? '');
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(String(response.body)).assets[0].guid).toBe(guid);
    }
    expect(started).toHaveLength(2);
  });

  it('repairs an incomplete accepted DDC closure before serving a fresh artifact request', async () => {
    const root = await scratch.make('forgeax-producer-readiness-incomplete-');
    const assets = join(root, 'assets');
    const ddcRoot = join(root, '.forgeax', 'ddc', 'v2');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    await writeFile(join(assets, 'scene.fixture.meta.json'), fixtureMeta('scene.fixture', GUID));

    const stalePack = {
      schemaVersion: '3.0.0',
      packageId: '019e3969-1d48-7c3b-ac24-6d68f457065f',
      assets: {
        output: {
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
      },
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
    const seed = await new DdcLifecycle(runtimeDdcRoot).stagePublication(staleEntry);
    await seed.commit();

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
    const index = decodeCatalogWire(
      JSON.parse(String((await request(target, binding.catalogUrl)).body)),
    ).unwrap();
    const row = index.find((entry) => entry.guid.toLowerCase() === GUID);
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
    const root = await scratch.make('forgeax-producer-readiness-route-');
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    const delayedGuid = '019e3969-1d48-7c3b-ac24-6d68f4570650';
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      fixtureMeta('scene.fixture', delayedGuid, 'fixture-delayed'),
    );

    const {
      importer: delayedImporter,
      started: importStarted,
      release: releaseImport,
    } = pauseImport('fixture-delayed', delayedGuid);
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
    const root = await scratch.make('forgeax-producer-readiness-close-');
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const closingGuid = SECOND_GUID;
    await writeFile(join(assets, 'scene.fixture'), 'fixture');
    await writeFile(
      join(assets, 'scene.fixture.meta.json'),
      fixtureMeta('scene.fixture', closingGuid, 'fixture-close'),
    );

    const {
      importer: delayedImporter,
      started: importStarted,
      release: releaseImport,
    } = pauseImport('fixture-close', closingGuid);
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

  it('compresses only new artifacts when independent lazy packages are published', async () => {
    const root = await scratch.make('forgeax-producer-readiness-compression-');
    const assets = join(root, 'assets');
    await mkdir(assets);
    for (const guid of [GUID, SECOND_GUID]) {
      await writeFile(join(assets, `${guid}.fixture`), guid);
      await writeFile(
        join(assets, `${guid}.fixture.meta.json`),
        fixtureMeta(`${guid}.fixture`, guid, 'fixture-compression'),
      );
    }
    const importer: Importer = {
      key: 'fixture-compression',
      import: async (context) => {
        const guid = fixtureGuid(context);
        return importedFixture(guid, new Uint8Array(4096).fill(guid === GUID ? 41 : 149), {});
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
      const index = decodeCatalogWire(
        JSON.parse(String((await request(target, binding.catalogUrl)).body)),
      ).unwrap();
      // Both the earlier and newly published closures must remain fetchable.
      for (const acceptedGuid of guid === GUID ? [GUID] : [GUID, SECOND_GUID]) {
        const row = index.find((entry) => entry.guid === acceptedGuid);
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
    const root = await scratch.make('forgeax-producer-readiness-ddc-retry-');
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
      fixtureMeta('primary.fixture', GUID, 'fixture-retry', { revision: 'old' }),
    );
    const siblingMeta = fixtureMeta('sibling.fixture', SECOND_GUID, 'fixture-retry');
    await writeFile(join(assets, 'sibling.fixture.meta.json'), siblingMeta);

    const retryImporter: Importer = {
      key: 'fixture-retry',
      import: async (context) => {
        return importedFixture(fixtureGuid(context), new Uint8Array([1, 2, 3]), {
          kind: 'fixture-mesh',
          vertexCount: 3,
          revision: await fixtureRevision(context),
        });
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
    const readAccepted = async (guid: string) => {
      const current = await new DdcLifecycle(packDirectory).readCurrentEntry(guid);
      const key = current.head.currentKey;
      return (
        current.entry ??
        (key === undefined ? null : await new DdcEntryStore(packDirectory).read(key))
      )?.payload;
    };
    const oldPrimaryBody = await readAccepted(GUID);
    const stableSiblingBody = await readAccepted(SECOND_GUID);
    await writeFile(primarySource, 'revision-new');
    await writeFile(
      primaryMetaPath,
      fixtureMeta('primary.fixture', GUID, 'fixture-retry', { revision: 'new' }),
    );
    const metaBefore = await readFile(primaryMetaPath, 'utf8');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const staging = join(packDirectory, 'staging');
    await rm(staging, { recursive: true, force: true });
    await writeFile(staging, 'candidate-write-blocked');
    try {
      const refused = await request(target, `${binding.importUrlBase}/${GUID}`, 'POST', {
        'x-forgeax-import-mode': 'rebuild',
      });
      expect(refused.statusCode).toBe(200);
      expect(JSON.parse(String(refused.body))).toEqual(
        expect.arrayContaining([expect.objectContaining({ guid: GUID })]),
      );
      expect(await readAccepted(GUID)).toEqual(oldPrimaryBody);
      expect(oldPrimaryBody).toMatchObject({ assets: [{ payload: { revision: 'revision-old' } }] });
      // Inspect accepted rows while the publication failure keeps the scope degraded.
      const failedCatalog = decodeCatalogWire(
        JSON.parse(String((await request(target, binding.catalogUrl)).body)).entries,
      ).unwrap();
      const failedRow = failedCatalog.find((entry) => entry.guid === GUID);
      expect(failedRow?.packageUrl).toContain(`${GUID}.runtime-pack.json`);
      expect(
        JSON.parse(String((await request(target, failedRow?.packageUrl ?? '')).body)).assets[0]
          .payload.revision,
      ).toBe('revision-old');
      expect(await readAccepted(SECOND_GUID)).toEqual(stableSiblingBody);
    } finally {
      warning.mockRestore();
      await rm(staging, { force: true });
      await mkdir(staging);
    }

    // The failed transaction leaves the accepted LKG imported. A normal
    // lookup must continue serving it; recovery explicitly requests a new
    // producer generation after DDC staging is repaired.
    const retried = await request(target, `${binding.importUrlBase}/${GUID}`, 'POST', {
      'x-forgeax-import-mode': 'rebuild',
    });
    expect(retried.statusCode).toBe(200);
    expect(await readAccepted(GUID)).toMatchObject({
      assets: [{ payload: { revision: 'revision-new' } }],
    });
    expect(await readAccepted(SECOND_GUID)).toEqual(stableSiblingBody);
    expect(await readFile(primaryMetaPath, 'utf8')).toBe(metaBefore);
    expect(await readFile(join(assets, 'sibling.fixture.meta.json'), 'utf8')).toBe(siblingMeta);
    await plugin.closeBundle();
  });

  it('coalesces a watcher generation before materializing an overlapping route request', async () => {
    const root = await scratch.make('forgeax-producer-readiness-overlap-');
    process.chdir(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const sourcePath = join(assets, 'overlap.fixture');
    const metaPath = join(assets, 'overlap.fixture.meta.json');
    await writeFile(sourcePath, 'revision-old');
    const writeMeta = (revision: string) =>
      writeFile(metaPath, fixtureMeta('overlap.fixture', GUID, 'fixture-overlap', { revision }));
    await writeMeta('old');
    let sawRebuild = false;
    const { promise: rebuildStarted, resolve: markRebuildStarted } = testGate();
    const { promise: rebuildRelease, resolve: releaseRebuild } = testGate();
    const overlapImporter: Importer = {
      key: 'fixture-overlap',
      import: async (context) => {
        const revision = await fixtureRevision(context);
        if (revision === 'revision-new' && !sawRebuild) {
          sawRebuild = true;
          markRebuildStarted();
          await rebuildRelease;
        }
        return importedFixture(GUID, new Uint8Array([7, 8, 9]), {
          kind: 'fixture-mesh',
          vertexCount: 3,
          revision,
        });
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
    const [{ packageUrl }] = JSON.parse(String(response.body));
    const packResponse = await request(target, packageUrl);
    expect(packResponse.statusCode).toBe(200);
    expect(JSON.parse(String(packResponse.body)).assets[0].payload.revision).toBe('revision-new');
    await plugin.closeBundle();
  });
});
