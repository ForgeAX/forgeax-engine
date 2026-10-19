import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { build, createServer, type Plugin, preview, type ViteDevServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { defined } from '../../__tests__/assert-defined.js';
import { type BrowserCaptureSession, createBrowserCapture } from '../../browser-capture.js';
import { executionWorkerEntries } from '../execution-workers.js';
import { runtimePacksSource } from '../runtime-packs-source.js';

describe('native Pack modules in the browser graph', () => {
  it.each([
    'build',
    'dev',
    'live-browser',
  ] as const)('%s executes new cyclic JS, shares Engine tokens in main and Worker, and recovers offline', async (mode) => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-program-browser-')));
    const base = '/games/runtime/';
    let server: Awaited<ReturnType<typeof preview>> | undefined;
    let dev: ViteDevServer | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let liveSession: BrowserCaptureSession | undefined;
    try {
      const repository = resolve(import.meta.dirname, '../../../../..');
      await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
      await symlink(
        resolve(repository, 'packages/engine'),
        resolve(root, 'node_modules/@forgeax/engine'),
        'junction',
      );
      await writeFile(resolve(root, 'runtime-packs.ts'), runtimePacksSource);
      await writeFile(
        resolve(root, 'runtime-tools.js'),
        await readFile(
          new URL('./fixtures/runtime-pack-tools-browser.mjs', import.meta.url),
          'utf8',
        ),
      );
      await writeFile(
        resolve(root, 'index.html'),
        '<canvas width="16" height="16"></canvas><script type="module" src="/main.js"></script>',
      );
      await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'program-browser' }));
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          id: 'program-browser',
          name: 'Program browser',
          schemaVersion: '3.0.0',
          roots: {},
        }),
      );
      await writeFile(
        resolve(root, 'main.js'),
        `
        import { Transform } from '@forgeax/engine/scene';
        import { preparePackProgram, loadPackProgram } from '@forgeax/engine/pack/runtime';
        import { createRuntimePackOptions, serveRuntimePackDelivery, prepareRuntimePackDelivery } from './runtime-packs';
        import workerUrl from 'virtual:worker-probe';
        import { runTools } from './runtime-tools.js';
        const delivery = undefined;
        const { imports, programHost: host } = await createRuntimePackOptions('test', delivery);
        globalThis.fixture = { prepareDelivery: prepareRuntimePackDelivery, async nativeImports() {
          let load;
          const nativeHost = { publish() { throw new Error('not published'); } };
          const options = await createRuntimePackOptions('native', {error:'CacheStorage unavailable'},
            (bindings, loadImport) => { load = loadImport; return nativeHost; });
          const scene = await load('@forgeax/engine/scene');
          return { sameHost: options.programHost === nativeHost, sameToken: scene.Transform === Transform };
        }, async tools() {
          const worker = new Worker(workerUrl, { type: 'module' });
          const channel = crypto.randomUUID();
          const stop = serveRuntimePackDelivery(channel);
          try {
            const result = await runTools(delivery);
            localStorage.setItem('saved-tools', JSON.stringify(result.snapshot));
            const outcome = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('Worker tools timeout')), 10000);
              worker.onmessage = e => { clearTimeout(timer); resolve(e.data); };
              worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
              worker.postMessage({ tools: result.snapshot, channel });
            });
            return { main: result, worker: outcome };
          } finally { stop(); worker.terminate(); }
        }, async recoverTools() {
          return runTools(delivery, JSON.parse(localStorage.getItem('saved-tools')));
        }, async unavailable() {
          const options = await createRuntimePackOptions('unavailable', { error: 'test delivery unavailable' });
          const program = preparePackProgram({ entry: 'disabled.js', export: 'value', modules: {
            'disabled.js': 'globalThis.unavailableProgramExecuted = true; export const value = 1;'
          } }).unwrap();
          const result = await loadPackProgram(program, options.imports, options.programHost);
          return { result, executed: globalThis.unavailableProgramExecuted === true };
        }, async execute(modules) {
          const program = preparePackProgram({ entry: 'main.js', export: 'result', modules,
            imports: { '@forgeax/engine/scene': imports['@forgeax/engine/scene'].identity } }).unwrap();
          const worker = new Worker(workerUrl, { type: 'module' });
          const channel = crypto.randomUUID();
          const stop = serveRuntimePackDelivery(channel);
          const outcome = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Worker program timeout')), 10000);
            worker.onmessage = e => { clearTimeout(timer); resolve(e.data); }; worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
            worker.postMessage({ program, channel });
          }); stop(); worker.terminate();
          const result = (await loadPackProgram(program, imports, host)).unwrap();
          const helper = preparePackProgram({ entry: 'helper.js', export: 'read', modules,
            imports: program.imports }).unwrap();
          const sharedRead = (await loadPackProgram(helper, { ...imports, unused: { identity: 'unused', url: 'ignored' } }, host)).unwrap();
          localStorage.setItem('saved-program', JSON.stringify(program));
          return { sameToken: result.token === Transform, sharedExport: sharedRead === result.read, value: result.read(), worker: outcome };
        }, async recover() {
          const program = JSON.parse(localStorage.getItem('saved-program'));
          const loaded = await loadPackProgram(program, imports, host); if (!loaded.ok) return loaded;
          const result = loaded.value; return { sameToken: result.token === Transform, value: result.read() };
        } };
      `,
      );
      await writeFile(
        resolve(root, 'worker.js'),
        `
        import { Transform } from '@forgeax/engine/scene';
        import { loadPackProgram, preparePackProgram } from '@forgeax/engine/pack/runtime';
        import { createRuntimePackOptions, createRuntimePackDeliveryClient } from './runtime-packs';
        import { runTools } from './runtime-tools.js';
        self.onmessage = async e => {
          const lifetime = new AbortController();
          const delivery = createRuntimePackDeliveryClient(e.data.channel, lifetime.signal);
          try {
            if (e.data.tools) { self.postMessage(await runTools(delivery, e.data.tools)); return; }
            const { imports, programHost: host } = await createRuntimePackOptions('test', delivery); const result = (await loadPackProgram(e.data.program, imports, host)).unwrap();
            const helper = preparePackProgram({ entry: 'helper.js', export: 'read', modules: e.data.program.modules, imports: e.data.program.imports }).unwrap();
            const sharedRead = (await loadPackProgram(helper, { ...imports, unused: { identity: 'unused', url: 'ignored' } }, host)).unwrap();
            self.postMessage({ sameToken: result.token === Transform, sharedExport: sharedRead === result.read, value: result.read() });
          } catch (error) { self.postMessage({ error: String(error) }); }
          finally { lifetime.abort(); }
        };
      `,
      );
      const workerEntry: Plugin = {
        name: 'worker-probe-entry',
        resolveId(id) {
          return id === 'virtual:worker-probe' ? '\0worker-probe' : null;
        },
        load(id) {
          if (id !== '\0worker-probe') return null;
          if (mode !== 'build')
            return `export default new URL(${JSON.stringify(`${base}worker.js`)}, globalThis.location.origin).href;`;
          const ref = this.emitFile({
            type: 'chunk',
            id: resolve(root, 'worker.js'),
            preserveSignature: 'strict',
          });
          return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
        },
      };
      const config = {
        root,
        base,
        configFile: false as const,
        logLevel: 'error' as const,
        plugins: [
          executionWorkerEntries(['@forgeax/engine/scene', '@forgeax/engine/plugin']),
          workerEntry,
        ],
      };
      if (mode === 'build') {
        await build({ ...config, build: { target: 'es2022' } });
        server = await preview({
          root,
          base,
          configFile: false,
          logLevel: 'error',
          preview: { host: '127.0.0.1', port: 0 },
        });
      } else {
        dev = await createServer({
          ...config,
          server: {
            host: '127.0.0.1',
            port: 0,
            ...(process.platform === 'darwin'
              ? { watch: { usePolling: true, interval: 100 } }
              : {}),
            fs: { allow: [root, repository] },
          },
        });
        await dev.listen();
      }
      const serverUrl = defined(defined(defined(server ?? dev).resolvedUrls).local[0]);
      if (mode === 'live-browser') {
        // The live project owner must deliver the same native module graph as
        // ordinary browser consumers, including Engine Worker requests.
        liveSession = await createBrowserCapture(root).open({
          serverUrl,
          backend: 'software',
          headless: true,
          width: 16,
          height: 16,
        });
      } else {
        browser = await chromium.launch({
          ...(process.env.FORGEAX_CHROME_CHANNEL !== undefined
            ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
            : {}),
          headless: true,
          args: ['--disable-gpu'],
          chromiumSandbox: true,
        });
      }
      const page = liveSession?.page ?? (await defined(browser).newPage());
      const errors: string[] = [];
      const failedRequests: string[] = [];
      page.on('requestfailed', (request) =>
        failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`),
      );
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(10000);
      page.on('pageerror', (error) => errors.push(error.message));
      if (liveSession === undefined) await page.goto(serverUrl);
      await page.waitForFunction(() => 'fixture' in globalThis);
      expect(
        await page.evaluate(() =>
          (
            globalThis as unknown as { fixture: { nativeImports(): Promise<unknown> } }
          ).fixture.nativeImports(),
        ),
      ).toEqual({ sameHost: true, sameToken: true });
      expect(
        await page.evaluate(() =>
          (
            globalThis as unknown as { fixture: { unavailable(): Promise<unknown> } }
          ).fixture.unavailable(),
        ),
      ).toMatchObject({
        executed: false,
        result: {
          ok: false,
          error: {
            code: 'pack-program-load-failed',
            detail: { reason: 'Error: test delivery unavailable' },
          },
        },
      });
      expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
      const result = await page.evaluate(async () =>
        (
          globalThis as unknown as {
            fixture: {
              execute(modules: Record<string, string>): Promise<unknown>;
            };
          }
        ).fixture.execute({
          'main.js':
            "import { Transform } from '@forgeax/engine/scene'; import { read } from './helper.js'; export const value = 42; export const result = { token: Transform, read };",
          'helper.js': "import { value } from './main.js'; export const read = () => value;",
        }),
      );
      expect(result).toMatchObject({
        sameToken: true,
        sharedExport: true,
        value: 42,
        worker: { sameToken: true, sharedExport: true, value: 42 },
      });
      const tools = await page.evaluate(() =>
        (globalThis as unknown as { fixture: { tools(): Promise<unknown> } }).fixture.tools(),
      );
      const expectedTools = {
        lazyAdmission: true,
        lazyExecutor: true,
        terminal: { value: 42, active: 1 },
        pinned: { value: 8, active: 1 },
        retired: 'failed',
      };
      expect(tools).toMatchObject({ main: expectedTools, worker: expectedTools });
      const savedPath = resolve(root, 'runtime-save.json');
      await writeFile(
        savedPath,
        JSON.stringify(
          await page.evaluate(() => ({
            program: localStorage.getItem('saved-program'),
            tools: localStorage.getItem('saved-tools'),
          })),
        ),
      );
      expect(errors).toEqual([]);
      await liveSession?.close();
      liveSession = undefined;
      await browser?.close();
      browser = await chromium.launch({
        ...(process.env.FORGEAX_CHROME_CHANNEL !== undefined
          ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
          : {}),
        headless: true,
        args: ['--disable-gpu'],
        chromiumSandbox: true,
      });
      const restoredContext = await browser.newContext();
      const restoredPage = await restoredContext.newPage();
      restoredPage.on('pageerror', (error) => errors.push(error.message));
      await restoredPage.goto(defined(defined(defined(server ?? dev).resolvedUrls).local[0]));
      await restoredPage.waitForFunction(() => 'fixture' in globalThis);
      expect(await restoredPage.evaluate(() => caches.keys())).toEqual([]);
      expect(await restoredPage.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
      // Install only the consumer Host's transport. No saved program has been
      // admitted or published, and the new browser has no derived module cache.
      expect(
        await restoredPage.evaluate(() =>
          (
            globalThis as unknown as { fixture: { prepareDelivery(): Promise<unknown> } }
          ).fixture.prepareDelivery(),
        ),
      ).toMatchObject({ scope: expect.any(String) });
      expect(
        await restoredPage.evaluate(async () => {
          const keys = await caches.keys();
          return (
            await Promise.all(
              keys.map(async (key) =>
                (await (await caches.open(key)).keys()).map((request) => request.url),
              ),
            )
          ).flat();
        }),
      ).toEqual([]);
      await restoredPage.evaluate(
        (saved) => {
          localStorage.setItem('saved-program', saved.program);
          localStorage.setItem('saved-tools', saved.tools);
        },
        JSON.parse(await readFile(savedPath, 'utf8')),
      );
      await restoredContext.setOffline(true);
      expect(
        await restoredPage.evaluate(() =>
          (
            globalThis as unknown as {
              fixture: {
                recover(): Promise<unknown>;
              };
            }
          ).fixture.recover(),
        ),
        JSON.stringify(failedRequests),
      ).toEqual({ sameToken: true, value: 42 });
      expect(
        await restoredPage.evaluate(() =>
          (
            globalThis as unknown as { fixture: { recoverTools(): Promise<unknown> } }
          ).fixture.recoverTools(),
        ),
      ).toMatchObject(expectedTools);
      const rebuilt = await restoredPage.evaluate(async () => {
        const keys = await caches.keys();
        return (
          await Promise.all(
            keys.map(async (key) =>
              (await (await caches.open(key)).keys()).map((request) => request.url),
            ),
          )
        ).flat();
      });
      expect(rebuilt.length).toBeGreaterThanOrEqual(5);
      expect(
        rebuilt.every((url) => new URL(url).pathname.startsWith(`${base}__forgeax_programs__/`)),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await liveSession?.close();
      await browser?.close();
      await dev?.close();
      await new Promise<void>((done) => (server ? server.httpServer.close(() => done()) : done()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
