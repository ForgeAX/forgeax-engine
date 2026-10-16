import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const EFFECT_GUID = 'f7b169a1-73cc-4cc4-b0c1-6f93d8db44a1';
const MATERIAL_GUID = 'cc0c6eaf-086b-4a02-b0d3-ea068b178105';
const IMPORTED_GUID = '01900000-0000-7000-8000-eeeeeeeeeeee';
const SIBLING_EFFECT_GUID = '01900000-0000-7000-8000-dddddddddddd';

describe('roots-scoped native catalog publication', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('uses the plugin native cooker and DDC while isolating malformed sibling roots', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-scoped-pack-'));
    const active = join(root, 'active');
    const brokenSibling = join(root, 'broken-sibling');
    await mkdir(active, { recursive: true });
    await mkdir(brokenSibling, { recursive: true });
    const activePack = join(active, 'effect.pack.json');
    await writeFile(
      activePack,
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: EFFECT_GUID,
            kind: 'test-effect',
            execution: 'cooked',
            payload: { schemaVersion: 1, emitters: [{ id: 'spark' }] },
            refs: [],
            artifacts: {},
          },
        ],
      }),
    );
    await writeFile(join(brokenSibling, 'broken.pack.json'), '{not-json');

    const cooker: NativeCooker = {
      key: 'test-effect',
      cook: ({ guid, source }) => ({
        guid,
        payload: { ...(source as Record<string, unknown>), compiled: true },
        refs: [MATERIAL_GUID],
        inputFingerprint: 'sha256:test-effect-source',
        artifacts: {
          program: {
            mediaType: 'application/json',
            bytes: new TextEncoder().encode('{"program":"native"}'),
          },
        },
      }),
    };
    const plugin = pluginPack({
      roots: [active, brokenSibling],
      cookers: [cooker],
      ddc: { projectDdcRoot: join(root, 'ddc') },
    });
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    const binding = await plugin.rebind(runtimeBinding('active', 1), [active]);
    expect(binding.status).toBe('ready');
    const catalogResponse = await request(middlewares, binding.catalogUrl);
    const entries = (JSON.parse(catalogResponse.body) as { entries: PackEntry[] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      guid: EFFECT_GUID,
      kind: 'test-effect',
      packageUrl: `/__pack/scopes/active/1/asset/__forgeax-ddc/${EFFECT_GUID}.pack.json`,
      refs: [MATERIAL_GUID],
      publication: {
        schemaVersion: 'asset-publication/1',
        generation: expect.any(Number),
        digest: expect.stringMatching(/^sha256:/),
        outputSetDigest: expect.stringMatching(/^sha256:/),
      },
    });
    const entry = entries[0];
    if (entry === undefined) throw new Error('expected the active scoped catalog entry');
    if (entry.publication === undefined) throw new Error('expected cooked Pack publication');

    const packResponse = await request(middlewares, entry.packageUrl);
    expect(packResponse.statusCode).toBe(200);
    const pack = JSON.parse(packResponse.body) as {
      scopeId: string;
      generation: number;
      digest: string;
      outputSetDigest: string;
      assets: Array<{
        payload: { compiled: boolean };
        artifacts: Record<string, { path: string }>;
      }>;
    };
    expect(pack).toMatchObject({
      scopeId: binding.scopeId,
      generation: entry.publication.generation,
      digest: entry.publication.digest,
      outputSetDigest: entry.publication.outputSetDigest,
    });
    expect(pack.assets[0]?.payload.compiled).toBe(true);
    const artifactPath = pack.assets[0]?.artifacts.program?.path;
    expect(artifactPath).toBeDefined();
    if (artifactPath === undefined) throw new Error('expected the cooked program artifact');
    const artifactUrl = new URL(artifactPath, `http://forgeax.test${entry.packageUrl}`).pathname;
    const artifactResponse = await request(middlewares, artifactUrl);
    expect(artifactResponse.body).toBe('{"program":"native"}');

    await writeFile(activePack, '{broken-after-success');
    // A rebind cannot expose the old scope after its only restoration root has
    // become invalid: close both failed generations and fail closed instead of
    // returning an unbound or stale runtime binding.
    await expect(plugin.rebind(runtimeBinding('active', 2), [active])).rejects.toMatchObject({
      code: 'scan-failed',
      detail: { stage: 'scan' },
    });
    expect(plugin.runtimeBinding()).toBeUndefined();
    await plugin.closeBundle();
  });

  it('keeps scoped lazy import reachable when an unrelated root degrades the union catalog', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-scoped-import-'));
    const active = join(root, 'active');
    const brokenSibling = join(root, 'broken-sibling');
    await mkdir(active, { recursive: true });
    await mkdir(brokenSibling, { recursive: true });
    await writeFile(join(active, 'level.reel.json'), '{"title":"scoped"}');
    await writeFile(
      join(active, 'level.reel.json.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'reel-game-blob',
        source: 'level.reel.json',
        importSettings: {},
        subAssets: [{ guid: IMPORTED_GUID, sourceIndex: 0, kind: 'reel-game-blob' }],
      }),
    );
    await writeFile(join(brokenSibling, 'broken.pack.json'), '{not-json');

    let importCalls = 0;
    const importer: Importer = {
      key: 'reel-game-blob',
      async import(ctx) {
        importCalls++;
        const source = await ctx.readSource();
        if (!source.ok) throw new Error('source was not readable');
        return {
          ok: true,
          value: {
            assets: [
              {
                guid: IMPORTED_GUID,
                kind: 'reel-game-blob',
                payload: { text: new TextDecoder().decode(source.value) } as never,
                refs: [],
                artifacts: {},
              },
            ],
            sourceDependencies: [],
          },
        };
      },
    };
    const plugin = pluginPack({
      roots: [active, brokenSibling],
      importers: [importer],
      producerReadiness: 'on-demand',
      ddc: { projectDdcRoot: join(root, 'ddc') },
    });
    const middlewares: Middleware[] = [];
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware as never) },
      ws: { send: () => {} },
    });

    const binding = await plugin.rebind(runtimeBinding('active', 1), [active]);
    const catalogResponse = await request(middlewares, binding.catalogUrl);
    const discovered = (JSON.parse(catalogResponse.body) as { entries: PackEntry[] }).entries;
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      guid: IMPORTED_GUID,
      kind: 'reel-game-blob',
      lifecycle: 'missing',
    });

    const imported = await request(
      middlewares,
      `${binding.importUrlBase}/${IMPORTED_GUID}`,
      'POST',
    );
    expect(imported.statusCode).toBe(200);
    expect(importCalls).toBe(1);
    const rows = JSON.parse(imported.body) as Array<{
      guid: string;
      packageUrl: string;
      lifecycle: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guid: IMPORTED_GUID, lifecycle: 'current' });
    const row = rows[0];
    if (row === undefined) throw new Error('expected the imported scoped catalog entry');
    const body = await request(middlewares, row.packageUrl);
    expect(body.statusCode).toBe(200);
    expect(JSON.parse(body.body).assets[0].payload.text).toBe('{"title":"scoped"}');
    await plugin.closeBundle();
  });

  it('filters the finalized production catalog without recooking or synthesizing DDC URLs', async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-scoped-build-'));
    const active = join(root, 'active');
    const sibling = join(root, 'sibling');
    await mkdir(active, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const writeEffect = (directory: string, guid: string) =>
      writeFile(
        join(directory, 'effect.pack.json'),
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid,
              kind: 'test-effect',
              execution: 'cooked',
              payload: { schemaVersion: 1, emitters: [{ id: 'spark' }] },
              refs: [],
              artifacts: {},
            },
          ],
        }),
      );
    await Promise.all([
      writeEffect(active, EFFECT_GUID),
      writeEffect(sibling, SIBLING_EFFECT_GUID),
    ]);

    let cookCalls = 0;
    const cooker: NativeCooker = {
      key: 'test-effect',
      cook: ({ guid, source }) => {
        cookCalls++;
        return {
          guid,
          payload: { ...(source as Record<string, unknown>), compiled: true },
          refs: [],
          inputFingerprint: `sha256:${guid}`,
          artifacts: {},
        };
      },
    };
    const plugin = pluginPack({
      roots: [active, sibling],
      cookers: [cooker],
      ddc: { projectDdcRoot: join(root, 'ddc') },
    });
    const emitted = new Map<
      string,
      {
        fileName?: string;
        name?: string;
        source: string | Uint8Array;
      }
    >();
    let sequence = 0;
    await plugin.generateBundle.call({
      emitFile(asset) {
        const referenceId = `asset-${++sequence}`;
        emitted.set(referenceId, asset);
        return referenceId;
      },
      getFileName(referenceId) {
        const asset = emitted.get(referenceId);
        if (asset?.fileName !== undefined) return asset.fileName;
        return `assets/${asset?.name ?? referenceId}-${referenceId}`;
      },
    });

    const globalIndexAsset = [...emitted.values()].find(
      (asset) => asset.fileName === 'pack-index.json',
    );
    expect(globalIndexAsset).toBeDefined();
    if (globalIndexAsset === undefined) throw new Error('expected the emitted global pack index');
    const globalRows = decodeCatalogWire(JSON.parse(String(globalIndexAsset.source))).unwrap();
    const globalActive = globalRows.find((row) => row.guid === EFFECT_GUID);
    expect(globalActive).toBeDefined();
    if (globalActive === undefined)
      throw new Error('expected the active effect in the global index');
    expect(globalRows.map((row) => row.guid).sort()).toEqual(
      [EFFECT_GUID, SIBLING_EFFECT_GUID].sort(),
    );
    expect(globalActive.packageUrl).toContain('/assets/');
    expect(globalActive.packageUrl).not.toContain('/__forgeax-ddc/');
    expect(cookCalls).toBeGreaterThan(0);
  });
});

interface PackEntry {
  guid: string;
  packageUrl: string;
  kind?: string;
  refs?: string[];
  lifecycle?: string;
  publication?: {
    schemaVersion: string;
    generation: number;
    digest: string;
    outputSetDigest: string;
  };
}

function runtimeBinding(scopeId: string, generation: number) {
  return {
    schemaVersion: 'runtime-asset-binding-v1' as const,
    gameId: scopeId,
    scopeId,
    generation,
    status: 'unbound' as const,
    catalogUrl: `/__pack/scopes/${scopeId}/${generation}/catalog.json`,
    importUrlBase: `/__pack/scopes/${scopeId}/${generation}/import`,
    packageUrlBase: `/__pack/scopes/${scopeId}/${generation}/asset`,
  };
}

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
    if (middleware !== undefined)
      await middleware({ url, method }, response, () => {
        void next();
      });
  };
  await next();
  return response;
}
