import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertBuildRoots } from '../build-inputs.js';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const LIFECYCLE_EVENT_TIMEOUT_MS = 30_000;

const watcherControl = vi.hoisted(() => ({
  enabled: false,
  autoRelease: 0,
  readyFailure: undefined as Error | undefined,
  watchers: [] as Array<{
    stopCalls: number;
    releaseStop: () => void;
    emit: (filename: string) => void;
  }>,
}));

vi.mock('../dev/watcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dev/watcher.js')>();
  return {
    ...actual,
    watchDevRoots: (options: Parameters<typeof actual.watchDevRoots>[0]) => {
      const handle = actual.watchDevRoots(options);
      if (!watcherControl.enabled) return handle;
      const readyFailure = watcherControl.readyFailure;
      watcherControl.readyFailure = undefined;
      let releaseStop!: () => void;
      const stopReleased = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      if (watcherControl.autoRelease > 0) {
        watcherControl.autoRelease -= 1;
        releaseStop();
      }
      const record = {
        stopCalls: 0,
        releaseStop,
        emit(filename: string) {
          void Promise.resolve()
            .then(() => options.onBatch({ revision: 0, sidecars: [], sources: [{ filename }] }))
            .catch(() => undefined);
        },
      };
      watcherControl.watchers.push(record);
      const stop = async (): Promise<void> => {
        record.stopCalls += 1;
        await stopReleased;
        await handle.stop();
      };
      const wrapped = (() => handle()) as typeof handle;
      Object.defineProperties(wrapped, {
        ready: {
          configurable: false,
          enumerable: true,
          value: readyFailure === undefined ? handle.ready : Promise.reject(readyFailure),
          writable: false,
        },
        stop: { configurable: false, enumerable: true, value: stop, writable: false },
      });
      return wrapped;
    },
  };
});

interface RecordedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

interface MiddlewareServer {
  middlewares: { use(handler: Middleware): void };
  ws: { send(payload: { type: string } & Record<string, unknown>): void; calls: unknown[] };
}

type Middleware = (
  req: { url?: string; method?: string },
  res: RecordedResponse & {
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => void | Promise<void>;

function createServer(): MiddlewareServer & { handler?: Middleware } {
  const server: MiddlewareServer & { handler?: Middleware } = {
    middlewares: {
      use(handler) {
        server.handler = handler;
      },
    },
    ws: {
      calls: [],
      send(payload) {
        server.ws.calls.push(payload);
      },
    },
  };
  return server;
}

async function request(server: MiddlewareServer & { handler?: Middleware }, url: string) {
  const response: RecordedResponse = { statusCode: 200, headers: {}, body: undefined };
  const handler = server.handler;
  if (handler === undefined) throw new Error('plugin middleware was not registered');
  await handler(
    { url, method: 'GET' },
    {
      headers: response.headers,
      body: response.body,
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + LIFECYCLE_EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('expected lifecycle event was not observed');
}

describe('Pack plugin lifecycle characterization', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
    watcherControl.enabled = false;
    watcherControl.autoRelease = 0;
    watcherControl.readyFailure = undefined;
    watcherControl.watchers.length = 0;
  });

  it.each([
    'result',
    'throw',
  ] as const)('rejects ready with the original %s producer failure before publication', async (failureMode) => {
    watcherControl.enabled = true;
    watcherControl.autoRelease = 1;
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-producer-ready-failure-'));
    temporaryRoots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const sourcePath = join(assets, 'failed.pack.ts');
    await writeFile(
      sourcePath,
      `export default {
        schemaVersion: '2.0.0',
        packageId: new Uint8Array([1, 144, 0, 0, 0, 0, 112, 0, 128, 0, 0, 0, 0, 0, 9, 147]),
        build() {
          const error = {
            code: 'pack-build-failed',
            expected: 'the fixture producer to publish its declared output',
            hint: 'repair the fixture producer',
            detail: { phase: 'build', sourcePath: ${JSON.stringify(sourcePath)} },
          };
          ${failureMode === 'throw' ? 'throw error;' : 'return { ok: false, error };'}
        },
      };`,
    );
    const server = createServer();
    const plugin = pluginPack({
      roots: [assets],
      runtimeBinding: createStandaloneRuntimeAssetBinding('producer-ready-failure'),
      ddc: {
        buildCacheRoot: join(root, 'build-cache'),
        projectDdcRoot: join(root, '.forgeax', 'ddc', 'v2'),
      },
    });
    try {
      plugin.configureServer(server);
      // A later configureServer hook may delay the first ready consumer.
      await waitFor(() => plugin.runtimeBinding()?.status === 'degraded');
      await new Promise<void>((resolve) => setImmediate(resolve));
      const cause = {
        code: 'pack-build-failed',
        expected: 'the fixture producer to publish its declared output',
        hint: 'repair the fixture producer',
        detail: { phase: 'build', sourcePath },
      };
      await expect(plugin.ready()).rejects.toMatchObject({
        code: 'produce-failed',
        detail: { stage: 'produce' },
        cause,
      });
      await expect(plugin.ready()).rejects.toMatchObject({ code: 'produce-failed', cause });
      expect(plugin.catalogSnapshot()).toEqual([]);
      await writeFile(
        sourcePath,
        `export default {
          schemaVersion: '2.0.0',
          packageId: new Uint8Array([1, 144, 0, 0, 0, 0, 112, 0, 128, 0, 0, 0, 0, 0, 9, 147]),
          build: () => ({ ok: true, value: { 'scene/main': { kind: 'scene', entities: {} } } }),
        };`,
      );
      watcherControl.watchers[0]?.emit(sourcePath);
      await waitFor(() => plugin.runtimeBinding()?.status === 'ready');
      await expect(plugin.ready()).resolves.toBeUndefined();
      expect(plugin.catalogSnapshot()).toHaveLength(1);
      expect(plugin.catalogSnapshot()[0]).toMatchObject({ kind: 'scene', publication: {} });
    } finally {
      await plugin.closeBundle();
    }
  });

  it('keeps serve startup, watcher, routes, and build emission observable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-lifecycle-'));
    temporaryRoots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const server = createServer();
    const plugin = pluginPack({
      roots: [assets],
      ddc: {
        buildCacheRoot: join(root, 'build-cache'),
        projectDdcRoot: join(root, '.forgeax', 'ddc', 'v2'),
      },
    });
    plugin.configureServer(server);
    const binding = createStandaloneRuntimeAssetBinding('pack-lifecycle');
    await plugin.rebind(binding, [assets]);

    const initialIndex = await request(server, binding.catalogUrl);
    expect(initialIndex.statusCode).toBe(200);
    expect(initialIndex.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(initialIndex.body)).entries).toEqual([]);

    const missing = await request(
      server,
      '/__pack/scopes/pack-lifecycle/1/asset/__pack/lookup/unknown-guid',
    );
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(String(missing.body))).toEqual({
      error: 'not-found',
      guid: 'unknown-guid',
    });

    await writeFile(join(assets, 'level.reel.json'), '{"version":1}');
    await waitFor(() =>
      server.ws.calls.some((payload) => (payload as { type?: string }).type === 'full-reload'),
    );
    await plugin.closeBundle();

    const buildPlugin = pluginPack({ roots: [] });
    await expect(
      buildPlugin.generateBundle.call({
        emitFile() {
          throw new Error('build must fail before emitting a Pack index');
        },
        getFileName(referenceId) {
          return referenceId;
        },
      }),
    ).rejects.toMatchObject({
      code: 'config-failed',
      detail: { stage: 'config', subject: 'pack-roots' },
    });

    const missingRoot = join(root, 'missing-assets');
    const missingRootBuildPlugin = pluginPack({ roots: [missingRoot] });
    await expect(
      missingRootBuildPlugin.generateBundle.call({
        emitFile() {
          throw new Error('build must fail before emitting a Pack index');
        },
        getFileName(referenceId) {
          return referenceId;
        },
      }),
    ).rejects.toMatchObject({
      code: 'config-failed',
      detail: { stage: 'config', subject: missingRoot },
    });
  });

  it('keeps a host-managed catalog fixed until the host replaces its session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-frozen-session-'));
    temporaryRoots.push(root);
    await writeFile(join(root, 'package.json'), '{"name":"frozen-pack"}');
    const source = join(root, 'plugin.pack.json');
    const pack = (speed: number) =>
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000141',
        assets: {
          root: {
            kind: 'plugin',
            payload: { module: { specifier: './plugin.ts' }, config: { speed } },
          },
        },
      });
    await writeFile(source, pack(1));
    await writeFile(join(root, 'plugin.ts'), 'export default { apply() {} };');
    const server = createServer();
    const binding = createStandaloneRuntimeAssetBinding('frozen-pack');
    const plugin = pluginPack({ roots: [root], watch: false, runtimeBinding: binding });
    try {
      plugin.configureServer(server);
      await plugin.ready();
      const before = await request(server, binding.catalogUrl);
      expect(before.statusCode, String(before.body)).toBe(200);
      const definitions = await plugin.readPluginDefinitions();
      expect(definitions[0]?.definition.asset.config).toEqual({ speed: 1 });
      await writeFile(source, pack(2));
      // A catalog request normally reconciles filesystem revisions; this session must retain its accepted bytes.
      const after = await request(server, binding.catalogUrl);
      expect(after.body).toBe(before.body);
      expect((await plugin.readPluginDefinitions())[0]?.definition.asset.config).toEqual({
        speed: 1,
      });
      expect(server.ws.calls).toEqual([]);
    } finally {
      await plugin.closeBundle();
    }
  });

  it('keeps the characterization fixture free of producer readiness policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-lifecycle-source-'));
    temporaryRoots.push(root);
    const source = join(root, 'asset.pack.json');
    await writeFile(source, JSON.stringify({ schemaVersion: '2.0.0', assets: [] }));
    expect(await readFile(source, 'utf8')).toContain('schemaVersion');
  });

  it('accepts an explicit file root for sidecar-scoped projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-file-root-'));
    temporaryRoots.push(root);
    const source = join(root, 'asset.pack.json');
    await writeFile(source, JSON.stringify({ schemaVersion: '2.0.0', assets: [] }));

    await expect(assertBuildRoots([source])).resolves.toBeUndefined();
  });

  it('does not resolve closeBundle before the async watcher close fence', async () => {
    watcherControl.enabled = true;
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-close-fence-'));
    temporaryRoots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const server = createServer();
    const plugin = pluginPack({ roots: [assets] });
    plugin.configureServer(server);

    let closed = false;
    const closing = plugin.closeBundle().then(() => {
      closed = true;
    });
    await waitFor(() => watcherControl.watchers.length === 1);
    expect(watcherControl.watchers[0]?.stopCalls).toBe(1);
    expect(closed).toBe(false);

    watcherControl.watchers[0]?.releaseStop();
    await closing;
    expect(closed).toBe(true);
    expect(watcherControl.watchers[0]?.stopCalls).toBe(1);
  });

  it('fences failed-rebind and restored watchers without losing a close handle', async () => {
    watcherControl.enabled = true;
    watcherControl.autoRelease = 2;
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-rebind-fence-'));
    temporaryRoots.push(root);
    const assets = join(root, 'assets');
    const brokenAssets = join(root, 'broken-assets');
    await mkdir(assets);
    await mkdir(brokenAssets);
    await writeFile(
      join(assets, 'stable.pack.json'),
      JSON.stringify({ schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [] }),
    );
    await writeFile(join(brokenAssets, 'broken.pack.json'), '{broken');
    const server = createServer();
    const plugin = pluginPack({ roots: [assets] });
    plugin.configureServer(server);
    const binding = createStandaloneRuntimeAssetBinding('rebind-close-fence');
    await plugin.rebind(binding, [assets]);
    expect(watcherControl.watchers).toHaveLength(2);

    let rebound = false;
    const rebinding = plugin
      .rebind({ ...binding, generation: binding.generation + 1 }, [brokenAssets])
      .then(() => {
        rebound = true;
      });
    await waitFor(
      () => watcherControl.watchers.length === 3 && watcherControl.watchers[2]?.stopCalls === 1,
    );
    expect(rebound).toBe(false);
    expect(watcherControl.watchers.slice(0, 2).map((watcher) => watcher.stopCalls)).toEqual([1, 1]);

    watcherControl.watchers[2]?.releaseStop();
    await rebinding;
    expect(rebound).toBe(true);
    expect(watcherControl.watchers).toHaveLength(4);
    expect(watcherControl.watchers.slice(0, 3).map((watcher) => watcher.stopCalls)).toEqual([
      1, 1, 1,
    ]);

    const closing = plugin.closeBundle();
    await waitFor(
      () => watcherControl.watchers.length === 4 && watcherControl.watchers[3]?.stopCalls === 1,
    );
    watcherControl.watchers[3]?.releaseStop();
    await closing;
    expect(watcherControl.watchers.map((watcher) => watcher.stopCalls)).toEqual([1, 1, 1, 1]);

    const wsCallsAfterClose = server.ws.calls.length;
    await writeFile(join(assets, 'after-close.pack.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.ws.calls).toHaveLength(wsCallsAfterClose);
  });

  it('rolls back a rejected watcher-ready rebind before exposing the old scope', async () => {
    watcherControl.enabled = true;
    watcherControl.autoRelease = 8;
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-ready-rejection-'));
    temporaryRoots.push(root);
    const assets = join(root, 'assets');
    const replacementAssets = join(root, 'replacement-assets');
    await mkdir(assets);
    await mkdir(replacementAssets);
    await writeFile(
      join(assets, 'stable.pack.json'),
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
            kind: 'fixture',
            payload: { marker: 'stable' },
            refs: [],
            artifacts: {},
          },
        ],
      }),
    );
    const server = createServer();
    const plugin = pluginPack({ roots: [assets] });
    plugin.configureServer(server);
    const binding = createStandaloneRuntimeAssetBinding('ready-rejection');
    await plugin.rebind(binding, [assets]);

    watcherControl.readyFailure = new Error('ready barrier failed');
    const restored = await plugin.rebind(
      { ...binding, generation: binding.generation + 1 },
      [replacementAssets],
      join(root, 'replacement-ddc'),
    );

    expect(restored).toMatchObject({
      scopeId: binding.scopeId,
      generation: binding.generation,
      status: 'degraded',
    });
    expect(restored.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'watch-failed' })]),
    );
    expect(watcherControl.watchers).toHaveLength(4);
    expect(watcherControl.watchers.map((watcher) => watcher.stopCalls)).toEqual([1, 1, 1, 0]);
    const callsBeforeFailedEvent = server.ws.calls.length;
    watcherControl.watchers[2]?.emit(join(replacementAssets, 'late.pack.json'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.ws.calls).toHaveLength(callsBeforeFailedEvent);
    const catalogResponse = await request(server, binding.catalogUrl);
    expect(catalogResponse.statusCode).toBe(200);
    expect(JSON.parse(String(catalogResponse.body)).entries).toHaveLength(1);

    const callsAfterRollback = server.ws.calls.length;
    await plugin.closeBundle();
    expect(watcherControl.watchers.map((watcher) => watcher.stopCalls)).toEqual([1, 1, 1, 1]);
    await writeFile(join(assets, 'after-close.pack.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.ws.calls).toHaveLength(callsAfterRollback);
  });

  it('fails closed instead of returning an unbound scope after an initial ready rejection', async () => {
    watcherControl.enabled = true;
    watcherControl.autoRelease = 4;
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-initial-ready-rejection-'));
    temporaryRoots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const server = createServer();
    const plugin = pluginPack({ roots: [assets] });
    plugin.configureServer(server);
    const binding = createStandaloneRuntimeAssetBinding('initial-ready-rejection');
    watcherControl.readyFailure = new Error('initial ready barrier failed');

    await expect(plugin.rebind(binding, [assets])).rejects.toMatchObject({
      code: 'watch-failed',
      detail: { stage: 'watch', subject: assets },
    });
    expect(watcherControl.watchers).toHaveLength(3);
    expect(watcherControl.watchers.map((watcher) => watcher.stopCalls)).toEqual([1, 1, 0]);
    expect(plugin.runtimeBinding()).toBeUndefined();
    await plugin.closeBundle();
    expect(watcherControl.watchers.map((watcher) => watcher.stopCalls)).toEqual([1, 1, 1]);
  });

  it('closes the restored generation when rollback startup also fails', async () => {
    watcherControl.enabled = true;
    watcherControl.autoRelease = 8;
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-restore-failure-'));
    temporaryRoots.push(root);
    const assets = join(root, 'assets');
    const replacementAssets = join(root, 'replacement-assets');
    await mkdir(assets);
    await mkdir(replacementAssets);
    const stablePack = join(assets, 'stable.pack.json');
    await writeFile(
      stablePack,
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
            kind: 'fixture',
            payload: { marker: 'stable' },
            refs: [],
            artifacts: {},
          },
        ],
      }),
    );
    const server = createServer();
    const plugin = pluginPack({ roots: [assets] });
    plugin.configureServer(server);
    const binding = createStandaloneRuntimeAssetBinding('restore-failure');
    await plugin.rebind(binding, [assets]);

    await writeFile(stablePack, '{broken');
    watcherControl.readyFailure = new Error('replacement ready barrier failed');
    await expect(
      plugin.rebind(
        { ...binding, generation: binding.generation + 1 },
        [replacementAssets],
        join(root, 'replacement-ddc'),
      ),
    ).rejects.toMatchObject({ code: 'scan-failed', detail: { stage: 'scan' } });
    expect(watcherControl.watchers).toHaveLength(4);
    expect(watcherControl.watchers.map((watcher) => watcher.stopCalls)).toEqual([1, 1, 1, 1]);
    expect(plugin.runtimeBinding()).toBeUndefined();
    await plugin.closeBundle();
  });

  it('reopens a fresh dispatcher and production session for a sequential server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-lifecycle-reopen-'));
    temporaryRoots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const plugin = pluginPack({ roots: [assets] });
    const first = createServer();
    const firstBinding = createStandaloneRuntimeAssetBinding('pack-lifecycle-first');
    plugin.configureServer(first);
    await plugin.rebind(firstBinding, [assets]);
    const firstHandler = first.handler;
    expect((await request(first, firstBinding.catalogUrl)).statusCode).toBe(200);

    await plugin.closeBundle();
    expect((await request(first, firstBinding.catalogUrl)).statusCode).toBe(410);

    const second = createServer();
    const secondBinding = createStandaloneRuntimeAssetBinding('pack-lifecycle-second');
    plugin.configureServer(second);
    await plugin.rebind(secondBinding, [assets]);
    expect(first.handler).toBe(firstHandler);
    expect((await request(second, secondBinding.catalogUrl)).statusCode).toBe(200);
    // The old Connect middleware is terminally closed and must not revive when
    // the same plugin instance starts the next Vite server generation.
    expect((await request(first, firstBinding.catalogUrl)).statusCode).toBe(410);
    await plugin.closeBundle();
  });
});
