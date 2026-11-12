import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DdcEntryStore, DdcLifecycle } from '@forgeax/engine-ddc';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import {
  createStandaloneRuntimeAssetBinding,
  type Importer,
  runtimeScopePath,
} from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const MAIN_GUID = '00000000-0000-4000-8000-000000000001';
const CHILD_GUID = '00000000-0000-4000-8000-000000000002';

interface Response {
  statusCode: number;
  body: string | Uint8Array | undefined;
  headers: Record<string, string>;
}

interface Server {
  middlewares: { use(handler: Handler): void };
  ws: { send(): void };
  handler?: Handler;
}

type Handler = (
  req: { url?: string; method?: string; headers?: Record<string, string> },
  res: Response & {
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => void | Promise<void>;

function createServer(): Server {
  const server: Server & { handler?: Handler } = {
    middlewares: {
      use(handler) {
        server.handler = handler;
      },
    },
    ws: { send() {} },
  };
  return server;
}

async function request(
  server: Server,
  url: string,
  headers?: Record<string, string>,
): Promise<Response> {
  const response: Response = { statusCode: 200, body: undefined, headers: {} };
  if (server.handler === undefined) throw new Error('plugin middleware was not registered');
  await server.handler(
    { url, method: 'GET', ...(headers === undefined ? {} : { headers }) },
    {
      ...response,
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

function fixtureImporterWithBody(bytes: Uint8Array): Importer {
  return {
    key: 'fixture',
    import: async () => ({
      ok: true,
      value: {
        assets: [
          {
            guid: MAIN_GUID,
            kind: 'fixture-mesh',
            payload: { kind: 'fixture-mesh', vertexCount: 3 },
            refs: [{ guid: CHILD_GUID }],
            artifacts: {
              body: { mediaType: 'application/octet-stream', bytes },
            },
          },
          {
            guid: CHILD_GUID,
            kind: 'fixture-material',
            payload: { kind: 'fixture-material', label: 'fixture' },
            refs: [],
            artifacts: {},
          },
        ],
        sourceDependencies: ['scene.fixture'],
      },
    }),
  };
}
const fixtureImporter = fixtureImporterWithBody(new Uint8Array([1, 2, 3]));

function meta(): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'fixture',
    source: 'scene.fixture',
    importSettings: {},
    subAssets: [
      { guid: MAIN_GUID, sourceIndex: 0, sourceKey: 'mesh/main', kind: 'fixture-mesh' },
      { guid: CHILD_GUID, sourceIndex: 1, sourceKey: 'material/main', kind: 'fixture-material' },
    ],
  });
}

function semanticPack(pack: {
  assets: readonly {
    guid: string;
    kind: string;
    name?: string;
    payload: unknown;
    refs: readonly string[];
    artifacts?: Readonly<Record<string, Record<string, unknown>>>;
  }[];
}): string {
  return JSON.stringify(
    pack.assets.map((asset) => ({
      guid: asset.guid,
      kind: asset.kind,
      name: asset.name,
      payload: asset.payload,
      refs: asset.refs,
      artifacts: Object.fromEntries(
        Object.entries(asset.artifacts ?? {}).map(([key, descriptor]) => {
          const { path: _path, ...semanticDescriptor } = descriptor as Record<string, unknown>;
          return [key, semanticDescriptor];
        }),
      ),
    })),
  );
}

describe('source package dev/build parity', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reopens unchanged Meta catalog and artifact routes without republishing DDC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-meta-publication-warm-'));
    roots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture source');
    await writeFile(join(assets, 'scene.fixture.meta.json'), meta());
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const binding = createStandaloneRuntimeAssetBinding('warm-publication');
      const expectedBytes = new Uint8Array(4096).fill(7);
      const importer = fixtureImporterWithBody(expectedBytes);
      const reopen = async () => {
        const plugin = pluginPack({ roots: [assets], importers: [importer] });
        const server = createServer();
        plugin.configureServer(server);
        try {
          await plugin.rebind(binding, [assets]);
          const catalogResponse = await request(server, binding.catalogUrl);
          expect(catalogResponse.statusCode, String(catalogResponse.body)).toBe(200);
          const decoded = decodeCatalogWire(JSON.parse(String(catalogResponse.body)));
          expect(decoded.ok, String(catalogResponse.body)).toBe(true);
          const catalog = decoded.unwrap();
          const row = catalog.find((entry) => entry.guid === MAIN_GUID);
          if (row === undefined) throw new Error('missing restored catalog row');
          const response = await request(server, row.packageUrl);
          expect(response.statusCode).toBe(200);
          const pack = JSON.parse(String(response.body));
          const artifact = await request(
            server,
            `${runtimeScopePath(binding)}/asset/__forgeax-ddc/${MAIN_GUID}/body.bin`,
            { 'accept-encoding': 'gzip' },
          );
          expect(artifact.statusCode).toBe(200);
          expect(artifact.headers['Content-Encoding']).toBe('gzip');
          expect(new Uint8Array(gunzipSync(artifact.body as Uint8Array))).toEqual(expectedBytes);
          return { row, pack };
        } finally {
          await plugin.closeBundle();
        }
      };
      const first = await reopen();
      const begin = vi.spyOn(DdcLifecycle.prototype, 'beginWithSnapshot');
      const stage = vi.spyOn(DdcEntryStore.prototype, 'stage');
      const second = await reopen();
      expect(second.pack).toEqual(first.pack);
      expect(second.row.revision).toMatchObject({ digest: first.row.revision?.digest });
      expect(second.row.publication).toEqual(first.row.publication);
      expect(begin).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('retains warm DDC entries when a source revision changes without changing cooked bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-publication-key-'));
    roots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture.meta.json'), meta());
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const binding = createStandaloneRuntimeAssetBinding('publication-key');
      const publish = async (source: string) => {
        // This importer deliberately produces the same semantic assets for both
        // inputs. Source revision still belongs to the publication identity.
        await writeFile(join(assets, source), 'unchanged source bytes');
        await writeFile(
          join(assets, 'scene.fixture.meta.json'),
          JSON.stringify({ ...JSON.parse(meta()), source }),
        );
        const plugin = pluginPack({ roots: [assets], importers: [fixtureImporter] });
        const server = createServer();
        plugin.configureServer(server);
        try {
          await plugin.rebind(binding, [assets]);
          const response = await request(server, binding.catalogUrl);
          expect(response.statusCode).toBe(200);
          const catalog = decodeCatalogWire(JSON.parse(String(response.body))).unwrap();
          const row = catalog.find((entry) => entry.guid === MAIN_GUID);
          if (row?.publication === undefined) throw new Error('expected the source publication');
          const pack = JSON.parse(String((await request(server, row.packageUrl)).body));
          return { publication: row.publication, pack };
        } finally {
          await plugin.closeBundle();
        }
      };
      const first = await publish('scene.fixture');
      const second = await publish('relocated.fixture');
      expect(second.pack.assets).toEqual(first.pack.assets);
      expect(second.publication.sourceRevision).not.toBe(first.publication.sourceRevision);
      expect(second.pack.generation).not.toBe(first.pack.generation);
      expect(second.publication.receipt.inputFingerprint).not.toBe(
        first.publication.receipt.inputFingerprint,
      );
      const repeated = await publish('relocated.fixture');
      expect(repeated.pack).toEqual(second.pack);
      expect(repeated.publication.receipt.inputFingerprint).toBe(
        second.publication.receipt.inputFingerprint,
      );
      const restored = await publish('scene.fixture');
      expect(restored.pack).toEqual(first.pack);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('keeps semantic product facts equal while sink locators differ', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-parity-'));
    roots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(join(assets, 'scene.fixture'), 'fixture source');
    await writeFile(join(assets, 'scene.fixture.meta.json'), meta());
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const dev = pluginPack({ roots: [assets], importers: [fixtureImporter] });
      const server = createServer();
      dev.configureServer(server);
      const binding = createStandaloneRuntimeAssetBinding('pack-parity');
      await dev.rebind(binding, [assets]);
      const catalog = decodeCatalogWire(
        JSON.parse(String((await request(server, binding.catalogUrl)).body)),
      ).unwrap();
      const devRow = catalog.find((entry) => entry.guid.toLowerCase() === MAIN_GUID);
      expect(devRow).toBeDefined();
      expect(devRow?.publication?.sourcePath).toBe(devRow?.sourcePath);
      const devPack = JSON.parse(
        String(await request(server, devRow?.packageUrl ?? '').then((result) => result.body)),
      ) as Parameters<typeof semanticPack>[0];

      const emitted: Array<{ fileName?: string; name?: string; source?: string | Uint8Array }> = [];
      const build = pluginPack({ roots: [assets], importers: [fixtureImporter] });
      await build.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName(referenceId) {
          return `assets/${referenceId}`;
        },
      });
      const buildPackAsset = emitted.find((asset) =>
        asset.name?.startsWith(`${MAIN_GUID}.pack.json`),
      );
      expect(buildPackAsset).toBeDefined();
      expect(buildPackAsset?.source).toBeInstanceOf(Uint8Array);
      const buildText = new TextDecoder().decode(buildPackAsset?.source as Uint8Array);
      const buildPack = JSON.parse(buildText) as {
        assets: Parameters<typeof semanticPack>[0]['assets'];
      };

      expect(semanticPack(devPack)).toBe(semanticPack(buildPack));
      expect(devRow?.packageUrl).toContain('/__forgeax-ddc/');
      expect(buildText).toContain('body.bin');
      expect(
        emitted.find((asset) => asset.fileName === `assets/${MAIN_GUID}-body.bin`)?.source,
      ).toEqual(new Uint8Array([1, 2, 3]));
      await dev.closeBundle();
    } finally {
      process.chdir(previousCwd);
    }
  });
  it('uses the standard bounded production executor for a cold live Pack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-pack-production-'));
    roots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await writeFile(
      join(assets, 'cold.pack.ts'),
      `
      export default {
        schemaVersion: '2.0.0',
        packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,93]),
        async build() {
          await new Promise(resolve => setTimeout(resolve, 15_250));
          return { ok: true, value: { sampler: { kind: 'sampler', magFilter: 'linear' } } };
        },
      };
    `,
    );
    const previousCwd = process.cwd();
    process.chdir(root);
    const plugin = pluginPack({ roots: [assets] });
    const server = createServer();
    plugin.configureServer(server);
    try {
      const binding = createStandaloneRuntimeAssetBinding('cold-production');
      await plugin.rebind(binding, [assets]);
      const response = await request(server, binding.catalogUrl);
      const catalog = decodeCatalogWire(JSON.parse(String(response.body))).unwrap();
      expect(catalog.some((row) => row.kind === 'sampler')).toBe(true);
    } finally {
      await plugin.closeBundle();
      process.chdir(previousCwd);
    }
  });
});
