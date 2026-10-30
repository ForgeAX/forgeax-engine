import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, normalizePath, type Plugin, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RawData, WebSocket } from 'ws';
import { type ForgeAXShaderPlugin, forgeaxShader } from '../index.js';

// The first direct WGSL transform cold-starts the naga/WASM compiler. On a
// clean CI worker that startup can consume more than the old 15 s budget
// before the actual watcher/HMR assertions begin. Keep the timeout bounded,
// but leave enough room for one cold compiler start plus the native watcher
// round-trip.
const DIRECT_WGSL_HMR_TEST_TIMEOUT_MS = 30_000;

interface HmrObservation {
  readonly watcherFiles: string[];
  readonly transformIds: string[];
  readonly hookCalls: Array<{
    readonly file: string;
    readonly modules: Array<{
      readonly id: string | null;
      readonly url: string | null;
      readonly file: string | null;
      readonly isSelfAccepting: boolean;
    }>;
  }>;
  readonly returnedModules: Array<{
    readonly id: string | null;
    readonly url: string | null;
    readonly file: string | null;
    readonly isSelfAccepting: boolean;
  }>;
  readonly payloads: unknown[];
  readonly payloadListeners: Set<(payload: unknown) => void>;
}

interface FixtureServer {
  readonly root: string;
  readonly shaderPath: string;
  readonly rawShaderPath: string;
  readonly controlPath: string;
  readonly server: ViteDevServer;
  readonly hmrClient: WebSocket;
  readonly observation: HmrObservation;
}

async function findFreePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolvePort, rejectPort) => {
    probe.once('error', rejectPort);
    probe.listen({ host: '127.0.0.1', port: 0 }, () => resolvePort());
  });
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  if (port === undefined) throw new Error('free-port probe did not expose a TCP port');
  return port;
}

function describeModule(value: unknown) {
  const module = typeof value === 'object' && value !== null ? value : {};
  const id = 'id' in module && typeof module.id === 'string' ? module.id : null;
  const url = 'url' in module && typeof module.url === 'string' ? module.url : null;
  const file = 'file' in module && typeof module.file === 'string' ? module.file : null;
  const isSelfAccepting = 'isSelfAccepting' in module && module.isSelfAccepting === true;
  return {
    id,
    url,
    file,
    isSelfAccepting,
  };
}

function observePlugin(
  plugin: ForgeAXShaderPlugin,
  observation: HmrObservation,
): ForgeAXShaderPlugin {
  return {
    ...plugin,
    async transform(this, code, id) {
      observation.transformIds.push(id);
      return plugin.transform.call(this, code, id);
    },
    handleHotUpdate(ctx) {
      observation.hookCalls.push({
        file: ctx.file,
        modules: ctx.modules.map(describeModule),
      });
      const returned = plugin.handleHotUpdate(ctx);
      if (returned !== undefined) {
        observation.returnedModules.push(...returned.map(describeModule));
      }
      return returned;
    },
  };
}

async function createFixtureServer(): Promise<FixtureServer> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-direct-wgsl-hmr-')));
  const shaderPath = normalizePath(join(root, 'alpha-test.wgsl'));
  const rawShaderPath = normalizePath(join(root, 'raw-shader.wgsl'));
  const controlPath = normalizePath(join(root, 'control.js'));
  await Promise.all([
    writeFile(join(root, 'index.html'), '<script type="module" src="/main.ts"></script>\n', 'utf8'),
    writeFile(
      join(root, 'main.ts'),
      "import './alpha-test.wgsl';\n" +
        "import rawSource from './raw-shader.wgsl?raw';\n" +
        'void rawSource;\n' +
        "import './control.js';\n",
      'utf8',
    ),
    writeFile(
      shaderPath,
      '#define_import_path direct_hmr::alpha\nfn alpha_value() -> f32 { return 1.0; }\n',
      'utf8',
    ),
    writeFile(
      rawShaderPath,
      '#define_import_path direct_hmr::raw\nfn raw_value() -> f32 { return 3.0; }\n',
      'utf8',
    ),
    writeFile(
      controlPath,
      "export const control = 'initial';\nif (import.meta.hot) import.meta.hot.accept(() => {});\n",
      'utf8',
    ),
  ]);

  const observation: HmrObservation = {
    watcherFiles: [],
    transformIds: [],
    hookCalls: [],
    returnedModules: [],
    payloads: [],
    payloadListeners: new Set(),
  };
  const plugin = observePlugin(forgeaxShader({ engineEntries: false }), observation);
  // Vite 8 treats `port: 0` as its default 5173 rather than asking the OS for
  // an ephemeral port. Other local previews may occupy that default (or the
  // next fallback ports), making a second fixture server stall before its
  // watcher is even ready. Reserve a real free loopback port for this fixture
  // and require Vite to keep it, so the HMR client and HTTP server share one
  // deterministic endpoint without probing unrelated processes.
  const port = await findFreePort();
  const server = await createServer({
    root,
    configFile: false,
    plugins: [plugin as unknown as Plugin],
    server: {
      fs: { allow: [root] },
      host: '127.0.0.1',
      port,
      strictPort: true,
      // FSEvents can report the initial directory scan without delivering a
      // subsequent same-file write in a short-lived macOS temp fixture. The
      // polling watcher is deterministic here and still exercises Vite's
      // real file->HMR path; production projects keep their own watch policy.
      // Keep chokidar's default 100 ms polling interval. Its change-event
      // throttle lasts 50 ms; polling at that same boundary can consume a
      // rapid repair's stat change while suppressing its only change event.
      watch: { usePolling: true },
    },
    optimizeDeps: { noDiscovery: true },
  });
  const watcherReady = new Promise<void>((resolveReady) => {
    server.watcher.once('ready', resolveReady);
  });
  // Observe the actual WebSocket delivery once. Recording both server.send
  // and client.message can credit an edit with the previous packet's duplicate.
  server.watcher.on('change', (file) => observation.watcherFiles.push(normalizePath(file)));
  await server.listen();
  // `getWatched()` can list files before chokidar has completed its initial
  // scan. Wait for its explicit `ready` event so the native handle is active
  // before the first fixture write (especially important on macOS FSEvents).
  await Promise.race([
    watcherReady,
    new Promise<never>((_, rejectReady) =>
      setTimeout(() => rejectReady(new Error('Vite file watcher did not become ready')), 10_000),
    ),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    await server.close();
    await rm(root, { recursive: true, force: true });
    throw new Error('Vite HTTP server did not expose an ephemeral address');
  }
  const hmrClient = new WebSocket(`ws://127.0.0.1:${address.port}`, 'vite-hmr');
  await new Promise<void>((resolveOpen, rejectOpen) => {
    hmrClient.once('open', () => resolveOpen());
    hmrClient.once('error', rejectOpen);
  });
  hmrClient.on('message', (raw: RawData) => {
    const payload = JSON.parse(raw.toString()) as unknown;
    observation.payloads.push(payload);
    for (const listener of observation.payloadListeners) listener(payload);
  });
  return { root, shaderPath, rawShaderPath, controlPath, server, hmrClient, observation };
}

async function closeFixtureServer(fixture: FixtureServer): Promise<void> {
  fixture.hmrClient.close();
  await fixture.server.close();
  await rm(fixture.root, { recursive: true, force: true });
}

function waitForFileChange(server: ViteDevServer, expectedFile: string): Promise<string> {
  return new Promise<string>((resolveChange) => {
    const onChange = (file: string): void => {
      if (normalizePath(file) !== expectedFile) return;
      server.watcher.off('change', onChange);
      resolveChange(normalizePath(file));
    };
    server.watcher.on('change', onChange);
  });
}

function waitForPayload(
  observation: HmrObservation,
  predicate: (payload: unknown) => boolean,
): Promise<unknown> {
  const existing = observation.payloads.find(predicate);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise<unknown>((resolvePayload) => {
    const listener = (payload: unknown): void => {
      if (!predicate(payload)) return;
      observation.payloadListeners.delete(listener);
      resolvePayload(payload);
    };
    observation.payloadListeners.add(listener);
  });
}

let activeFixture!: FixtureServer;

describe('direct WGSL Vite HMR ownership', () => {
  it(
    'replaces HTTP publication after source and import HMR while retaining failed edits as LKG',
    async () => {
      const fixture = await createFixtureServer();
      try {
        const { root, rawShaderPath, server, observation } = fixture;
        const dependencyPath = normalizePath(join(root, 'value.wgsl'));
        const dependency = (value: string) =>
          `#define_import_path direct_hmr::value\nfn amount() -> f32 { return ${value}; }\n`;
        const source = `#define_import_path direct_hmr::raw
#import direct_hmr::value::{amount}
@group(0) @binding(0) var<storage, read_write> output: f32;
@compute @workgroup_size(1) fn main() { output = amount(); }
`;
        await writeFile(dependencyPath, dependency('0.25'), 'utf8');
        const initialChange = waitForFileChange(server, rawShaderPath);
        await writeFile(rawShaderPath, source, 'utf8');
        await initialChange;
        await server.transformRequest('/raw-shader.wgsl?import');
        const address = server.httpServer?.address();
        if (address === undefined || address === null || typeof address === 'string')
          throw new Error('Missing fixture HTTP address');
        const readManifest = async (): Promise<string> => {
          const response = await fetch(`http://127.0.0.1:${address.port}/shaders/manifest.json`);
          expect(response.status).toBe(200);
          return response.text();
        };
        const edit = async (path: string, code: string): Promise<void> => {
          observation.payloads.length = 0;
          const changed = waitForFileChange(server, path);
          const updated = waitForPayload(
            observation,
            (payload) =>
              typeof payload === 'object' &&
              payload !== null &&
              'type' in payload &&
              (payload.type === 'update' || payload.type === 'error'),
          );
          await writeFile(path, code, 'utf8');
          await changed;
          expect(await updated).toMatchObject({ type: 'update' });
        };

        const original = await readManifest();
        expect(await Promise.all([readManifest(), readManifest()])).toEqual([original, original]);
        await edit(rawShaderPath, source.replace('output = amount()', 'output = amount() * 2.0'));
        await server.transformRequest('/raw-shader.wgsl?import');
        const sourceChanged = await readManifest();
        expect(sourceChanged).not.toBe(original);

        await edit(dependencyPath, dependency('0.75'));
        await server.transformRequest('/raw-shader.wgsl?import');
        const importChanged = await readManifest();
        expect(importChanged).not.toBe(sourceChanged);

        await edit(dependencyPath, dependency('invalid'));
        await expect(server.transformRequest('/raw-shader.wgsl?import')).rejects.toBeDefined();
        expect(await readManifest()).toBe(importChanged);

        await edit(dependencyPath, dependency('0.9'));
        await server.transformRequest('/raw-shader.wgsl?import');
        const repaired = await readManifest();
        expect(repaired).not.toBe(importChanged);
        expect(await readManifest()).toBe(repaired);
      } finally {
        await closeFixtureServer(fixture);
      }
    },
    DIRECT_WGSL_HMR_TEST_TIMEOUT_MS,
  );

  beforeAll(async () => {
    activeFixture = await createFixtureServer();
  }, DIRECT_WGSL_HMR_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (activeFixture !== undefined) await closeFixtureServer(activeFixture);
  }, DIRECT_WGSL_HMR_TEST_TIMEOUT_MS);

  it(
    'tracks a direct WGSL module from HTTP transform through a semantic update payload',
    async () => {
      const { server, shaderPath, observation } = activeFixture;
      const transformed = await server.transformRequest('/alpha-test.wgsl?import');
      const address = server.httpServer?.address();
      if (address === null || address === undefined || typeof address === 'string') {
        throw new Error('Vite HTTP server did not expose an ephemeral address');
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/alpha-test.wgsl?import`);
      expect(response.ok).toBe(true);
      const httpSource = await response.text();

      const shaderModules = server.moduleGraph.getModulesByFile(shaderPath);
      expect(shaderModules).toBeDefined();
      expect(shaderModules?.size).toBeGreaterThan(0);
      const shaderSelfAccepting = [...(shaderModules ?? [])].some(
        (module) => module.isSelfAccepting,
      );

      const shaderChange = waitForFileChange(server, shaderPath);
      await writeFile(
        shaderPath,
        '#define_import_path direct_hmr::alpha\nfn alpha_value() -> f32 { return 2.0; }\n',
        'utf8',
      );
      expect(await shaderChange).toBe(shaderPath);
      await waitForPayload(
        observation,
        (payload) =>
          typeof payload === 'object' &&
          payload !== null &&
          'type' in payload &&
          payload.type === 'update' &&
          'updates' in payload &&
          Array.isArray(payload.updates) &&
          payload.updates.some(
            (update) =>
              typeof update === 'object' &&
              update !== null &&
              'path' in update &&
              typeof update.path === 'string' &&
              update.path.includes('alpha-test.wgsl'),
          ),
      );

      expect(transformed?.code).toContain('import.meta.hot.accept');
      expect(httpSource).toContain('import.meta.hot.accept');
      expect(shaderSelfAccepting).toBe(true);
      expect(observation.transformIds).toContainEqual(expect.stringContaining('alpha-test.wgsl'));
      expect(observation.watcherFiles).toContain(shaderPath);
      expect(observation.hookCalls).toContainEqual(
        expect.objectContaining({
          file: shaderPath,
          modules: expect.arrayContaining([
            expect.objectContaining({
              file: shaderPath,
              isSelfAccepting: true,
            }),
          ]),
        }),
      );
      expect(observation.returnedModules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: shaderPath, isSelfAccepting: true }),
        ]),
      );
      expect(observation.payloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'update',
            updates: expect.arrayContaining([
              expect.objectContaining({ path: expect.stringContaining('alpha-test.wgsl') }),
            ]),
          }),
        ]),
      );
    },
    DIRECT_WGSL_HMR_TEST_TIMEOUT_MS,
  );

  it(
    'keeps an ordinary JavaScript self-accept control on the same watcher',
    async () => {
      // Keep this JS-only watcher check on its own server. The WGSL test above
      // performs a synchronous shader compile during HMR; reusing that server
      // lets its in-flight update starve the next native watcher event.
      const fixture = await createFixtureServer();
      try {
        const { server, controlPath, observation } = fixture;
        await server.transformRequest('/control.js?import');
        const controlModules = server.moduleGraph.getModulesByFile(controlPath);
        expect(controlModules).toBeDefined();
        expect([...(controlModules ?? [])].some((module) => module.isSelfAccepting)).toBe(true);

        const controlChange = waitForFileChange(server, controlPath);
        const controlPayload = waitForPayload(
          observation,
          (payload) =>
            typeof payload === 'object' &&
            payload !== null &&
            'type' in payload &&
            payload.type === 'update' &&
            'updates' in payload &&
            Array.isArray(payload.updates) &&
            payload.updates.some(
              (update) =>
                typeof update === 'object' &&
                update !== null &&
                'path' in update &&
                typeof update.path === 'string' &&
                update.path.includes('control.js'),
            ),
        );
        await writeFile(
          controlPath,
          "export const control = 'changed';\nif (import.meta.hot) import.meta.hot.accept(() => {});\n",
          'utf8',
        );
        expect(await controlChange).toBe(controlPath);
        await controlPayload;

        expect(observation.watcherFiles).toContain(controlPath);
        expect(
          observation.hookCalls.filter((call) => call.file === controlPath).length,
        ).toBeGreaterThan(0);
        expect(
          observation.returnedModules.filter((module) => module.file === controlPath),
        ).toHaveLength(0);
        expect(observation.payloads).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'update',
              updates: expect.arrayContaining([
                expect.objectContaining({ path: expect.stringContaining('control.js') }),
              ]),
            }),
          ]),
        );
      } finally {
        await closeFixtureServer(fixture);
      }
    },
    DIRECT_WGSL_HMR_TEST_TIMEOUT_MS,
  );

  it(
    'preserves a raw WGSL import as the physical source string',
    async () => {
      const { server, rawShaderPath } = activeFixture;
      const rawSource = await readFile(rawShaderPath, 'utf8');
      const transformed = await server.transformRequest('/raw-shader.wgsl?raw');

      expect(transformed?.code).toBe(`export default ${JSON.stringify(rawSource)}`);
      expect(transformed?.code).not.toContain('generated by @forgeax/engine-vite-plugin-shader');
      expect(transformed?.code).not.toContain('reflection');
      expect(transformed?.code).not.toContain('import.meta.hot');
    },
    DIRECT_WGSL_HMR_TEST_TIMEOUT_MS,
  );

  it(
    'bypasses raw query variants while retaining ForgeAX import variants',
    async () => {
      const { server, rawShaderPath } = activeFixture;
      const rawSource = await readFile(rawShaderPath, 'utf8');
      const raw = await server.transformRequest('/raw-shader.wgsl?raw');
      const rawWithTimestamp = await server.transformRequest('/raw-shader.wgsl?raw&t=1730000000');
      const imported = await server.transformRequest('/raw-shader.wgsl?import');
      const importedWithTimestamp = await server.transformRequest(
        '/raw-shader.wgsl?import&t=1730000000',
      );

      expect(raw?.code).toBe(`export default ${JSON.stringify(rawSource)}`);
      expect(rawWithTimestamp?.code).toBe(`export default ${JSON.stringify(rawSource)}`);
      expect(imported?.code).toContain('generated by @forgeax/engine-vite-plugin-shader');
      expect(importedWithTimestamp?.code).toContain(
        'generated by @forgeax/engine-vite-plugin-shader',
      );
    },
    DIRECT_WGSL_HMR_TEST_TIMEOUT_MS,
  );
});
