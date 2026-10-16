import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ExecutionReport } from '@forgeax/engine-app';
import type { PackProgramSource } from '@forgeax/engine-pack/runtime';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { chromium, type Page } from 'playwright';
import { build, createServer, preview, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { runtimeBrowserLaunchOptions } from './browser-launch.js';
import { executionWorkerEntries } from '../src/build/execution-workers.js';
import { prepareRuntimePackProgram } from '../src/build/pack-program.js';
import { runtimePacksSource } from '../src/build/runtime-packs-source.js';

type Fixture = Record<string, (...args: unknown[]) => Promise<unknown>>;
interface Inspection {
  world: string;
  gameTicks: number;
  unrelated: number[];
  width?: number;
  typed?: boolean;
  frames: {
    submitted: number;
    completed: number;
    ready: number;
    backends: string[];
    errors: unknown[];
  };
  renderer: string;
  refs: number;
  packs: number;
  programs: number;
  builds: number;
  pluginTicks: number;
  pluginActive: number;
}
const inspect = async (page: Page) => (await call(page, 'inspect')) as Inspection;
const call = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    async ({ method, args }) => {
      const operation = (globalThis as unknown as { fixture: Fixture }).fixture.call;
      if (!operation) throw new Error('Worker fixture transport missing');
      return await operation(method, ...args);
    },
    { method, args },
  );
const host = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    async ({ method, args }) => {
      try {
        const operation = (globalThis as unknown as { fixture: Fixture }).fixture[method];
        if (!operation) throw new Error(`Host fixture operation missing: ${method}`);
        return await operation(...args);
      } catch (error) {
        throw new Error(
          JSON.stringify(error, (_key, value) =>
            value instanceof Error
              ? { ...value, message: value.message, stack: value.stack }
              : value,
          ),
        );
      }
    },
    { method, args },
  );

// Decode the actual compositor screenshot in a scratch 2D canvas. The fixture
// uses a solid clear color; pixels must differ from its top-left background.
const pixels = (page: Page, png: Buffer) =>
  page.evaluate(
    async (data) => {
      const bitmap = await createImageBitmap(await (await fetch(data)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Screenshot decoder unavailable');
      ctx.drawImage(bitmap, 0, 0);
      const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width,
        right = -1,
        top = canvas.height,
        bottom = -1,
        count = 0;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const offset = (y * canvas.width + x) * 4;
          if (
            Math.max(
              ...[0, 1, 2].map((c) => Math.abs((bytes[offset + c] ?? 0) - (bytes[c] ?? 0))),
            ) <= 15
          )
            continue;
          count++;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      bitmap.close();
      return { count, width: right - left + 1, height: bottom - top + 1 };
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );

// Explicit graphics gate: run under an owned display (for example xvfb-run -a).
// Mac/Windows use native Metal/D3D12; Linux uses SwiftShader for WebGPU correctness.
// This gate does not measure hardware performance.
it.each([
  ['build', 'js'],
  ['build', 'ts'],
  ['dev', 'js'],
  ['dev', 'ts'],
] as const)('%s %s generates assets and a native plugin after Engine Worker startup and renders 60 completed frames', async (mode, language) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-runtime-worker-')));
  const repository = resolve(import.meta.dirname, '../../..');
  const evidence =
    process.env.FORGEAX_RUNTIME_PACK_EVIDENCE ??
    resolve(repository, 'artifacts/runtime-pack-worker');
  const base = '/games/runtime-worker/';
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  let dev: ViteDevServer | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const errors: string[] = [];
  try {
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await mkdir(evidence, { recursive: true });
    await mkdir(resolve(root, 'public'), { recursive: true });
    await writeFile(resolve(root, 'public/pack-index.json'), '[]');
    await symlink(
      resolve(repository, 'packages/engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await writeFile(resolve(root, 'runtime-packs.ts'), runtimePacksSource);
    for (const name of ['execution-bootstrap.ts', 'runtime-pack-worker-host.mjs']) {
      await writeFile(
        resolve(root, name),
        await readFile(
          new URL(`./fixtures/${name.replace('.ts', '.mjs')}`, import.meta.url),
          'utf8',
        ),
      );
    }
    await writeFile(
      resolve(root, 'main.js'),
      "import * as fixture from './runtime-pack-worker-host.mjs'; globalThis.fixture = fixture;",
    );
    await writeFile(
      resolve(root, 'index.html'),
      '<link rel="icon" href="data:,"><style>body{margin:0;background:#151921}canvas{display:block;width:384px;height:384px}</style><canvas width="384" height="384"></canvas><script type="module" src="/main.js"></script>',
    );
    const config = {
      root,
      base,
      configFile: false as const,
      logLevel: 'error' as const,
      plugins: [
        executionWorkerEntries([
          '@forgeax/engine/assets-runtime',
          '@forgeax/engine/geometry',
          '@forgeax/engine/pack/source',
          '@forgeax/engine/render',
          '@forgeax/engine/scene',
          '@forgeax/engine/plugin',
          '@forgeax/engine/ecs',
        ]),
        forgeaxShader(),
      ],
      define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': '"0"' },
    };
    if (mode === 'build') {
      await build({
        ...config,
        build: {
          target: 'es2022',
          // Match DevKit Host's realm-neutral build (no DOM preload helper).
          modulePreload: false,
          rolldownOptions: {
            preserveEntrySignatures: 'strict',
            input: {
              main: resolve(root, 'index.html'),
              'execution-bootstrap': resolve(root, 'execution-bootstrap.ts'),
            },
            output: { entryFileNames: '[name].js' },
          },
        },
      });
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
        server: { host: '127.0.0.1', port: 0, fs: { allow: [root, repository] } },
      });
      await dev.listen();
    }
    const url = (server ?? dev)?.resolvedUrls?.local[0];
    if (!url) throw new Error('Vite URL unavailable');
    const browserEnv = Object.fromEntries(
      ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY'].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    );
    const launch = () => {
      const options = runtimeBrowserLaunchOptions();
      return chromium.launch({
        ...options,
        env: browserEnv,
        args: [...options.args, '--disable-gpu-watchdog'],
        chromiumSandbox: true,
      });
    };
    browser = await launch();
    const page = await browser.newPage({ viewport: { width: 384, height: 384 } });
    const workers = new Set();
    const watch = (page: Page) => {
      page.on('worker', (worker) => {
        workers.add(worker);
        worker.on('close', () => workers.delete(worker));
      });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('requestfailed', (request) =>
        errors.push(`${request.url()}: ${request.failure()?.errorText}`),
      );
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
    };
    watch(page);
    await page.goto(url);
    await page.waitForFunction(() => 'fixture' in globalThis);
    const opened = await host(
      page,
      'open',
      mode === 'build' ? 'execution-bootstrap.js' : 'execution-bootstrap.ts',
    );
    expect(opened).toMatchObject({ engine: { realm: 'worker', health: 'running' }, fault: null });
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 90000 })
      .toBeGreaterThan(2);
    const initial = await inspect(page);
    expect(initial).toMatchObject({
      packs: 0,
      programs: 0,
      renderer: 'alive',
      unrelated: [12, 3, 1],
    });
    const sources = (await call(page, 'sources', language)) as Record<string, PackProgramSource>;
    const programs =
      language === 'js'
        ? await call(page, 'prepareJs', sources)
        : Object.fromEntries(
            Object.entries(sources).map(([key, source]) => [
              key,
              prepareRuntimePackProgram(source).unwrap(),
            ]),
          );
    await call(page, 'admit', programs, language);
    const generation = await call(page, 'generate', 2);
    expect(generation, JSON.stringify(generation)).toEqual({ ok: true });
    expect(await call(page, 'replace')).toMatchObject({
      width: 2,
      typed: true,
      world: initial.world,
      unrelated: [12, 3, 1],
    });
    expect(await call(page, 'install')).toEqual({ lazy: true, lazyExecutor: true, active: 1 });
    expect(await call(page, 'tool')).toMatchObject({
      outcome: 'succeeded',
      result: { value: 42, active: 1 },
    });
    const first = await inspect(page);
    await expect
      .poll(async () => (await inspect(page)).pluginTicks)
      .toBeGreaterThan(first.pluginTicks);
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 90000 })
      .toBeGreaterThan(first.frames.ready + 10);
    const narrowImage = await page.screenshot({
      path: resolve(evidence, `${mode}-${language}-width-2.png`),
    });
    const narrowPixels = await pixels(page, narrowImage);
    expect(await call(page, 'generate', 2)).toEqual({ ok: true });
    expect((await inspect(page)).builds).toBe(first.builds);
    expect(await call(page, 'generate', 4)).toEqual({ ok: true });
    expect((await inspect(page)).width).toBe(2);
    const replacement = (await call(page, 'replace')) as Inspection;
    expect(replacement).toMatchObject({
      width: 4,
      typed: true,
      refs: first.refs,
      world: initial.world,
      unrelated: [12, 3, 1],
      pluginActive: 1,
    });
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 90000 })
      .toBeGreaterThan(replacement.frames.ready + 10);
    const wideImage = await page.screenshot({
      path: resolve(evidence, `${mode}-${language}-width-4.png`),
    });
    const widePixels = await pixels(page, wideImage);
    expect(narrowPixels.count).toBeGreaterThan(1000);
    expect(widePixels.width).toBeGreaterThan(narrowPixels.width * 1.7);
    expect(widePixels.count).toBeGreaterThan(narrowPixels.count * 1.7);
    expect(Math.abs(widePixels.height - narrowPixels.height)).toBeLessThanOrEqual(3);
    const publication = await call(page, 'publication');
    const beforeInvalid = await inspect(page);
    expect(await call(page, 'generate', 6)).toMatchObject({ ok: false });
    expect(await call(page, 'publication')).toEqual(publication);
    expect((await inspect(page)).builds).toBe(beforeInvalid.builds);
    expect(await call(page, 'generate', 3, true)).toMatchObject({ ok: false });
    expect(await call(page, 'publication')).toEqual(publication);
    expect((await inspect(page)).width).toBe(4);
    await writeFile(
      resolve(evidence, `${mode}-${language}-snapshot.json`),
      JSON.stringify(await call(page, 'snapshot')),
    );
    expect(await call(page, 'withdraw')).toMatchObject({ programs: 0, width: 4, pluginActive: 1 });
    expect(await call(page, 'tool')).toMatchObject({
      outcome: 'succeeded',
      result: { value: 42, active: 1 },
    });
    const withdrawn = await inspect(page);
    await expect
      .poll(async () => (await inspect(page)).pluginTicks)
      .toBeGreaterThan(withdrawn.pluginTicks);
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 120000 })
      .toBeGreaterThanOrEqual(first.frames.ready + 60);
    const detached = (await call(page, 'disposePlugin')) as Inspection;
    expect(detached).toMatchObject({ state: 'disposed', pluginActive: 0 });
    await expect
      .poll(async () => (await inspect(page)).frames.ready, { timeout: 120000 })
      .toBeGreaterThan(detached.frames.ready + 10);
    const final = await inspect(page);
    expect(final.pluginTicks).toBe(detached.pluginTicks);
    expect(final.gameTicks).toBeGreaterThan(initial.gameTicks);
    expect(final.frames.errors).toEqual([]);
    expect(final.frames.backends).toEqual(['webgpu']);
    expect(final).toMatchObject({
      world: initial.world,
      unrelated: [12, 3, 1],
      width: 4,
      renderer: 'alive',
    });
    const report = (await host(page, 'report')) as ExecutionReport;
    expect(report).toMatchObject({ engine: { realm: 'worker', health: 'running' }, fault: null });
    expect(report.frame.completed).toBeGreaterThanOrEqual(60);
    const closed = await host(page, 'close');
    expect(closed).toMatchObject({ errors: [], pending: 0 });
    await expect.poll(() => workers.size).toBe(0);
    expect(errors).toEqual([]);
    let recovery: unknown;
    if (mode === 'build') {
      // Close the process, preserve only the saved Pack, then prepare the new
      // consumer's Engine modules, empty Catalog and Host SW before disconnect.
      // No generated program has been admitted in this new browser yet.
      await browser.close();
      expect(browser.isConnected()).toBe(false);
      browser = await launch();
      const context = await browser.newContext({ viewport: { width: 384, height: 384 } });
      const restored = await context.newPage();
      watch(restored);
      await restored.goto(url);
      await restored.waitForFunction(() => 'fixture' in globalThis);
      await host(restored, 'open', 'execution-bootstrap.js');
      await expect
        .poll(async () => (await inspect(restored)).frames.ready, { timeout: 90000 })
        .toBeGreaterThan(2);
      const empty = await inspect(restored);
      expect(empty).toMatchObject({ packs: 0, programs: 0, builds: 0, pluginTicks: 0 });
      // World identity is realm-local and may restart at world-1 in a new process.
      await call(restored, 'publication');
      expect(await restored.evaluate(() => caches.keys())).toEqual([]);
      expect(await host(restored, 'prepareDelivery')).toHaveProperty('scope');
      expect(
        await restored.evaluate(
          async () =>
            (
              await Promise.all(
                (await caches.keys()).map(async (name) => (await caches.open(name)).keys()),
              )
            ).flat().length,
        ),
      ).toBe(0);
      const saved = JSON.parse(
        await readFile(resolve(evidence, `${mode}-${language}-snapshot.json`), 'utf8'),
      );
      await context.setOffline(true);
      await call(restored, 'restore', saved);
      const recovered = (await call(restored, 'replace')) as Inspection;
      expect(recovered).toMatchObject({ width: 4, typed: true, world: empty.world });
      expect(await call(restored, 'install')).toEqual({
        lazy: true,
        lazyExecutor: true,
        active: 1,
      });
      expect(await call(restored, 'tool')).toMatchObject({
        outcome: 'succeeded',
        result: { value: 42, active: 1 },
      });
      await expect.poll(async () => (await inspect(restored)).pluginTicks).toBeGreaterThan(2);
      expect(await call(restored, 'generate', 2)).toEqual({ ok: true });
      const regenerated = (await call(restored, 'replace')) as Inspection;
      expect(regenerated).toMatchObject({ width: 2, typed: true, world: empty.world });
      await expect
        .poll(async () => (await inspect(restored)).frames.ready, { timeout: 120000 })
        .toBeGreaterThanOrEqual(regenerated.frames.ready + 60);
      const offlineImage = await restored.screenshot({
        path: resolve(evidence, `${mode}-${language}-offline.png`),
      });
      const offlinePixels = await pixels(restored, offlineImage);
      expect(offlinePixels).toEqual(narrowPixels);
      const offlineFinal = await inspect(restored);
      expect(offlineFinal.frames.errors).toEqual([]);
      expect(offlineFinal.pluginActive).toBe(1);
      expect(offlineFinal.pluginTicks).toBeGreaterThan(regenerated.pluginTicks);
      const offlineDetached = (await call(restored, 'disposePlugin')) as Inspection;
      expect(offlineDetached).toMatchObject({ state: 'disposed', pluginActive: 0 });
      await expect
        .poll(async () => (await inspect(restored)).frames.ready)
        .toBeGreaterThan(offlineDetached.frames.ready + 10);
      expect((await inspect(restored)).pluginTicks).toBe(offlineDetached.pluginTicks);
      expect(offlineFinal.frames.backends).toEqual(['webgpu']);
      const offlineClosed = await host(restored, 'close');
      expect(offlineClosed).toMatchObject({ errors: [], pending: 0 });
      await expect.poll(() => workers.size).toBe(0);
      expect(errors).toEqual([]);
      recovery = { empty, recovered, regenerated, offlinePixels, offlineFinal, offlineClosed };
    }
    await writeFile(
      resolve(evidence, `${mode}-${language}-result.json`),
      JSON.stringify(
        {
          initial,
          first,
          replacement,
          detached,
          final,
          report,
          closed,
          recovery,
          narrowPixels,
          widePixels,
          errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      resolve(evidence, `${mode}-${language}-failure.json`),
      JSON.stringify({ errors, message: String(error) }, null, 2),
    );
    throw error;
  } finally {
    await browser?.close();
    await dev?.close();
    const running = server;
    if (running) await new Promise<void>((done) => running.httpServer.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
