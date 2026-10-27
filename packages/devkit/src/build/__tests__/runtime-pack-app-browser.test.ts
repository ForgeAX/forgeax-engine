import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { PackProgramSource } from '@forgeax/engine-pack/runtime';
import { chromium, type Page, type Request } from 'playwright';
import ts from 'typescript';
import { build, createServer, preview, type ViteDevServer } from 'vite';
import { expect, it, onTestFailed, vi } from 'vitest';
import { defined } from '../../__tests__/assert-defined.js';
import { executionWorkerEntries } from '../execution-workers.js';
import { prepareRuntimePackProgram } from '../pack-program.js';
import { runtimePacksSource } from '../runtime-packs-source.js';

const compilation = vi.hoisted(() => ({
  armed: false,
  calls: { prepare: 0, transpile: 0, build: 0 },
  hit(kind: 'prepare' | 'transpile' | 'build') {
    if (!this.armed) return;
    this.calls[kind]++;
    throw new Error(`runtime compilation forbidden: ${kind}`);
  },
}));
vi.mock('../pack-program.js', async (original) => {
  const actual = await original<typeof import('../pack-program.js')>();
  return {
    ...actual,
    prepareRuntimePackProgram(...args: Parameters<typeof actual.prepareRuntimePackProgram>) {
      compilation.hit('prepare');
      return actual.prepareRuntimePackProgram(...args);
    },
  };
});
vi.mock('typescript', async (original) => {
  const actual = await original<{ default: typeof ts }>();
  return {
    ...actual,
    default: {
      ...actual.default,
      transpileModule(...args: Parameters<typeof ts.transpileModule>) {
        compilation.hit('transpile');
        return actual.default.transpileModule(...args);
      },
    },
  };
});
vi.mock('vite', async (original) => {
  const actual = await original<typeof import('vite')>();
  return {
    ...actual,
    async build(...args: Parameters<typeof actual.build>) {
      compilation.hit('build');
      return actual.build(...args);
    },
  };
});

it.each([
  ['build', 'js'],
  ['build', 'ts'],
  ['dev', 'js'],
  ['dev', 'ts'],
] as const)(
  '%s %s uses actual App providers for generation, Scene consumption, plugin disposal and cold offline restore',
  async (mode, language) => {
    compilation.armed = false;
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-runtime-app-')));
    const repository = resolve(import.meta.dirname, '../../../../..');
    const base = '/games/app/';
    let server: Awaited<ReturnType<typeof preview>> | undefined;
    let dev: ViteDevServer | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let compilerImports = 0;
    const pendingRequests = new Map<Request, number>();
    const began = performance.now();
    const events: { kind: string; target: string; time: number }[] = [];
    let phase = { kind: 'phase', target: 'fixture-prepare', time: began };
    const record = (kind: string, target: string) => {
      const event = { kind, target, time: performance.now() };
      if (kind === 'phase' || kind === 'operation') phase = event;
      events.push(event);
      if (events.length > 128) events.shift();
    };
    // Exercise native browser modules instead of Vitest's transformed module cache.
    const call = (page: Page, method: string, args: unknown[] = []) => {
      record('operation', method);
      return page.evaluate(
        async ({ method, args }) => {
          const fixture = (
            globalThis as unknown as {
              fixture: Record<string, (...args: unknown[]) => unknown>;
            }
          ).fixture;
          const operation = fixture[method];
          if (!operation) throw new Error(`missing fixture operation ${method}`);
          try {
            return await operation(...args);
          } catch (cause) {
            throw new Error(
              `${method}: ${JSON.stringify(cause, (_key, value) => (value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value))}`,
            );
          }
        },
        { method, args },
      );
    };
    onTestFailed(async ({ task }) => {
      const failedAt = performance.now();
      const directory = resolve(repository, `artifacts/runtime-pack/failure-${mode}-${language}`);
      const snapshot = {
        mode,
        language,
        began,
        failedAt,
        originalDeadlineMs: 120000,
        errors: task.result?.errors,
        phase,
        events: [...events],
        phaseAtDeadline: events
          .filter(
            ({ kind, time }) =>
              (kind === 'phase' || kind === 'operation') && time <= began + 120000,
          )
          .at(-1),
        pendingRequests: Array.from(pendingRequests, ([request, started]) => ({
          url: request.url(),
          resourceType: request.resourceType(),
          elapsedMs: failedAt - started,
        })),
      };
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, 'failed-stage.json'), JSON.stringify(snapshot, null, 2));
    });
    const compilerGuard = {
      name: 'proof-no-browser-compiler',
      enforce: 'pre' as const,
      resolveId(id: string) {
        // Vite injects this browser preload helper; it exposes no build/compiler API.
        if (id === 'vite/modulepreload-polyfill') return null;
        if (/^(?:typescript|vite|esbuild|rolldown|@swc\/core)(?:\/|$)/.test(id)) {
          compilerImports++;
          throw new Error(`browser compiler import forbidden: ${id}`);
        }
        return null;
      },
    };
    try {
      await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
      await symlink(
        resolve(repository, 'packages/engine'),
        resolve(root, 'node_modules/@forgeax/engine'),
        'dir',
      );
      await writeFile(resolve(root, 'runtime-packs.ts'), runtimePacksSource);
      await writeFile(
        resolve(root, 'fixture.js'),
        await readFile(new URL('./fixtures/runtime-pack-app-browser.mjs', import.meta.url), 'utf8'),
      );
      await writeFile(
        resolve(root, 'main.js'),
        "import * as fixture from './fixture.js'; globalThis.fixture = fixture;",
      );
      await writeFile(
        resolve(root, 'index.html'),
        '<script type="module" src="/main.js"></script>',
      );
      const config = {
        root,
        base,
        configFile: false as const,
        logLevel: 'error' as const,
        plugins: [
          compilerGuard,
          executionWorkerEntries([
            '@forgeax/engine/geometry',
            '@forgeax/engine/pack/source',
            '@forgeax/engine/render',
            '@forgeax/engine/scene',
            '@forgeax/engine/plugin',
          ]),
        ],
        define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': '"0"' },
      };
      record('phase', 'compiler-guard-create');
      const guardServer = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [compilerGuard],
        server: { middlewareMode: true, ws: false },
      });
      try {
        for (const id of [
          'typescript',
          'typescript/lib/typescript.js',
          'vite',
          'vite/dist/node/index.js',
          'vite/modulepreload-polyfill/child',
          'esbuild',
          'rolldown',
          '@swc/core',
        ]) {
          await expect(guardServer.pluginContainer.resolveId(id)).rejects.toThrow(
            'browser compiler import forbidden',
          );
        }
        expect(compilerImports).toBe(8);
      } finally {
        record('phase', 'compiler-guard-close');
        await guardServer.close();
      }
      compilerImports = 0;
      record('phase', mode === 'build' ? 'build' : 'dev-create');
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
          server: { host: '127.0.0.1', port: 0, ws: false, fs: { allow: [root, repository] } },
        });
        const observeClose = (owner: { close(): Promise<void> }, name: string) => {
          const close = owner.close.bind(owner);
          owner.close = () => {
            record('retirement-begin', name);
            const pending = close();
            void pending.then(
              () => record('retirement-complete', name),
              () => record('retirement-rejected', name),
            );
            return pending;
          };
        };
        observeClose(dev.watcher, 'watcher');
        observeClose(dev.ws, 'websocket');
        for (const [name, environment] of Object.entries(dev.environments)) {
          observeClose(environment, `environment-${name}`);
          observeClose(environment.pluginContainer, `plugins-${name}`);
          if (environment.depsOptimizer)
            observeClose(environment.depsOptimizer, `optimizer-${name}`);
        }
        dev.httpServer?.once('close', () => record('retirement-complete', 'http'));
        record('phase', 'dev-listen');
        await dev.listen();
      }
      const url = defined(defined(defined(server ?? dev).resolvedUrls).local[0]);
      const errors: string[] = [];
      const watch = (page: Page) => {
        page.on('request', (request) => {
          pendingRequests.set(request, performance.now());
          record('request', request.url());
        });
        page.on('requestfinished', (request) => {
          pendingRequests.delete(request);
          record('finished', request.url());
        });
        page.on('requestfailed', (request) => {
          pendingRequests.delete(request);
          record('failed', request.url());
        });
        page.on('load', () => record('load', page.url()));
        page.on('domcontentloaded', () => record('domcontentloaded', page.url()));
        page.on('pageerror', (error) => {
          errors.push(error.message);
          record('pageerror', error.message);
        });
        page.on('requestfailed', (request) =>
          errors.push(`${request.url()}: ${request.failure()?.errorText}`),
        );
        page.setDefaultTimeout(15000);
      };
      browser = await chromium.launch({
        ...(process.env.FORGEAX_CHROME_CHANNEL !== undefined
          ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
          : {}),
        headless: true,
        args: ['--disable-gpu'],
        chromiumSandbox: true,
      });
      const page = await browser.newPage();
      watch(page);
      record('phase', 'navigation');
      await page.goto(url);
      await page.waitForFunction(() => 'fixture' in globalThis);
      expect(await call(page, 'open')).toEqual({ packs: 0, programs: 0 });
      const sources = (await call(page, 'sources', [language])) as Record<
        string,
        PackProgramSource
      >;
      // No conversion runs on the JS branch. The TS branch uses actual typed
      // source and preserves that source beside its emitted executable closure.
      const forbidCompilation = async () => {
        compilation.armed = true;
        expect(() => prepareRuntimePackProgram(defined(sources.build))).toThrow(
          'runtime compilation forbidden: prepare',
        );
        expect(() => ts.transpileModule('export {};', {})).toThrow(
          'runtime compilation forbidden: transpile',
        );
        await expect(build({ configFile: false })).rejects.toThrow(
          'runtime compilation forbidden: build',
        );
        expect(compilation.calls).toEqual({ prepare: 1, transpile: 1, build: 1 });
        // The only reset is between negative controls and the complete journey.
        compilation.calls = { prepare: 0, transpile: 0, build: 0 };
      };
      if (language === 'js') await forbidCompilation();
      const programs =
        language === 'js'
          ? await call(page, 'prepareJs', [sources])
          : Object.fromEntries(
              Object.entries(sources).map(([key, source]) => [
                key,
                prepareRuntimePackProgram(source).unwrap(),
              ]),
            );
      if (language === 'ts') await forbidCompilation();
      await call(page, 'admit', [programs, language]);
      const generated = await call(page, 'generate', [2]);
      expect(generated, JSON.stringify(generated)).toMatchObject({ ok: true });
      const original = (await call(page, 'replace')) as {
        assets: number;
        positions: number[];
        indices: number[];
      };
      expect(original).toMatchObject({
        width: 2,
        position: [2, 0, 0],
        typed: true,
        skyZenith: [0.125, 0.25, 0.5],
      });
      expect(await call(page, 'install')).toEqual({ lazy: true, lazyExecutor: true, members: 1 });
      expect(await call(page, 'tool')).toMatchObject({
        outcome: 'succeeded',
        result: { value: 42, active: 1 },
      });
      expect(await call(page, 'sibling')).toEqual({
        both: true,
        original: true,
        removed: true,
        programs: ['behavior', 'executor'],
      });
      expect(await call(page, 'tool')).toMatchObject({
        outcome: 'succeeded',
        result: { value: 42, active: 1 },
      });
      const beforeCache = (await call(page, 'buildCalls')) as number;
      expect(await call(page, 'generate', [2])).toEqual(generated);
      expect(await call(page, 'buildCalls')).toBe(beforeCache);
      expect(await call(page, 'tool')).toMatchObject({
        outcome: 'succeeded',
        result: { value: 42, active: 1 },
      });
      expect(await call(page, 'generate', [4])).toMatchObject({ ok: true });
      expect(await call(page, 'buildCalls')).toBe(beforeCache + 1);
      expect(await call(page, 'inspect')).toMatchObject({ width: 2 });
      const replaced = (await call(page, 'replace')) as { assets: number };
      expect(replaced).toMatchObject({ width: 4, typed: true, assets: original.assets });
      expect(await call(page, 'generate', [6])).toMatchObject({ ok: false });
      expect(await call(page, 'buildCalls')).toBe(beforeCache + 1);
      expect(await call(page, 'inspect')).toEqual(replaced);
      expect(await call(page, 'generate', [3, true])).toMatchObject({ ok: false });
      expect(await call(page, 'inspect')).toEqual(replaced);
      const savedPath = resolve(root, 'saved.json');
      await writeFile(savedPath, JSON.stringify(await call(page, 'snapshot')));
      expect(await call(page, 'withdraw')).toMatchObject({
        programs: 0,
        definitions: 0,
        tool: { outcome: 'succeeded', result: { value: 42, active: 1 } },
      });
      const closed = {
        effectRemoved: true,
        markerRemoved: true,
        assets: 0,
        catalogDetached: true,
        programs: 0,
        renderer: 'disposed',
        plugin: 'disposed',
      };
      expect(await call(page, 'close')).toMatchObject(closed);
      expect(errors).toEqual([]);
      record('phase', 'fresh-browser-close');
      await browser.close();
      browser = await chromium.launch({
        ...(process.env.FORGEAX_CHROME_CHANNEL !== undefined
          ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
          : {}),
        headless: true,
        args: ['--disable-gpu'],
        chromiumSandbox: true,
      });
      const context = await browser.newContext();
      const restored = await context.newPage();
      watch(restored);
      record('phase', 'fresh-navigation');
      await restored.goto(url);
      await restored.waitForFunction(() => 'fixture' in globalThis);
      expect(await call(restored, 'open')).toEqual({ packs: 0, programs: 0 });
      expect(await restored.evaluate(() => caches.keys())).toEqual([]);
      expect(await call(restored, 'prepareDelivery')).toHaveProperty('scope');
      expect(
        await restored.evaluate(async () =>
          (
            await Promise.all(
              (await caches.keys()).map(async (name) => (await caches.open(name)).keys()),
            )
          ).flat(),
        ),
      ).toEqual([]);
      const saved = JSON.parse(await readFile(savedPath, 'utf8'));
      await context.setOffline(true);
      await call(restored, 'restore', [saved]);
      const recovered = (await call(restored, 'replace')) as {
        positions: number[];
        indices: number[];
      };
      expect(recovered).toMatchObject({
        width: 4,
        position: [2, 0, 0],
        typed: true,
        skyZenith: [0.125, 0.25, 0.5],
      });
      expect(recovered.indices).toEqual(original.indices);
      expect(await call(restored, 'install')).toEqual({
        lazy: true,
        lazyExecutor: true,
        members: 1,
      });
      expect(await call(restored, 'tool')).toMatchObject({
        outcome: 'succeeded',
        result: { value: 42, active: 1 },
      });
      // Regenerate with new parameters offline, using the persisted JS artifact
      // even when its original author source was TS.
      expect(await call(restored, 'generate', [2])).toMatchObject({ ok: true });
      expect(await call(restored, 'replace')).toMatchObject({
        width: 2,
        positions: original.positions,
        indices: original.indices,
        typed: true,
      });
      expect(await call(restored, 'close')).toMatchObject(closed);
      expect(errors).toEqual([]);
      expect(compilation.armed).toBe(true);
      expect(compilation.calls).toEqual({ prepare: 0, transpile: 0, build: 0 });
      expect(compilerImports).toBe(0);
      const evidence = {
        mode,
        language,
        browser: browser.version(),
        rhi: 'null',
        guardArmed: compilation.armed,
        calls: compilation.calls,
        browserCompilerImports: compilerImports,
        negativeControls: { prepare: 1, transpile: 1, build: 1, browserImports: 8 },
        boundary:
          'guards remain armed from JS preparation (or completed TS conversion) through native plugin, persistence, fresh browser and offline restoration',
      };
      await mkdir(resolve(repository, 'artifacts/runtime-pack'), { recursive: true });
      await writeFile(
        resolve(repository, `artifacts/runtime-pack/no-build-${mode}-${language}.json`),
        JSON.stringify(evidence, null, 2),
      );
    } catch (cause) {
      const directory = resolve(repository, `artifacts/runtime-pack/failure-${mode}-${language}`);
      await mkdir(directory, { recursive: true });
      const failedAt = performance.now();
      const requestsAtFailure = Array.from(pendingRequests, ([request, started]) => ({
        url: request.url(),
        resourceType: request.resourceType(),
        elapsedMs: failedAt - started,
      }));
      const eventsAtFailure = [...events];
      const page = browser?.contexts().flatMap((context) => context.pages())[0];
      let screenshotError: string | undefined;
      if (page) {
        await page
          .screenshot({ path: resolve(directory, 'page.png'), timeout: 5000 })
          .catch((error) => {
            screenshotError = String(error);
          });
      }
      await writeFile(
        resolve(directory, 'failure.json'),
        JSON.stringify(
          {
            mode,
            language,
            browser: browser?.version(),
            error: String(cause),
            url: page?.url(),
            navigationDeadlineMs: 15000,
            outerDeadlineMs: 120000,
            failedAt,
            pendingRequestCount: requestsAtFailure.length,
            pendingRequests: requestsAtFailure.slice(-64),
            events: eventsAtFailure,
            screenshotError,
          },
          null,
          2,
        ),
      );
      throw cause;
    } finally {
      compilation.armed = false;
      record('phase', 'browser-retire');
      await browser?.close();
      record('phase', 'dev-retire');
      await dev?.close();
      const running = server;
      if (running) await new Promise<void>((done) => running.httpServer.close(() => done()));
      record('phase', 'fixture-remove');
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
