import { applyTestCanvasBudget } from '../../../scripts/test/browser-canvas-budget.mjs';
import testQuality from '../../../scripts/test/render-quality.json' with { type: 'json' };
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ExecutionReport } from '@forgeax/engine-app';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { chromium, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries } from '../src/build/execution-workers.js';
import { createViteConfig } from '../src/host.js';
import { readProjectFacts } from '../src/project.js';
import { runtimeBrowserLaunchOptions } from './browser-launch.js';

type Snapshot = { owner: string; execution: ExecutionReport; errors: string[] };
const snapshot = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as { fixture: { snapshot(): Snapshot } }).fixture.snapshot(),
  );

// Real App owner and generated DOM; no Game/private application RPC surface.
it('shows an entered terminal App fault while pointer-lock rejection stays recoverable', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-host-runtime-fault-')));
  const repository = resolve(import.meta.dirname, '../../..');
  let server: ViteDevServer | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let primaryFailure: unknown;
  let failed = false;
  let cleanupFailures: unknown[] = [];
  try {
    await mkdir(resolve(root, 'assets'));
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(repository, 'packages/engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'runtime-fault',
        name: 'Runtime Fault',
        roots: {},
      }),
    );
    await writeFile(resolve(root, 'package.json'), '{"name":"runtime-fault","type":"module"}');
    await writeFile(resolve(root, 'main.ts'), 'export default () => undefined;');
    const facts = await readProjectFacts(root);
    expect(facts.ok, JSON.stringify(facts)).toBe(true);
    if (!facts.ok) throw new Error(JSON.stringify(facts.error));
    await createViteConfig(facts.value, 'build');
    const generatedHtml = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    const generatedMain = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
    const start = generatedMain.indexOf('removeStartupErrorListener = app.onError(');
    const end = generatedMain.indexOf('\n      removeStartupInputBinding', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const errorBinding = generatedMain.slice(start, end);
    await writeFile(
      resolve(root, 'index.html'),
      generatedHtml.replace(/<script type="module"[^>]*>[\s\S]*?<\/script>/g, '') +
        '<script type="module" src="/fixture.mjs"></script>',
    );
    await writeFile(
      resolve(root, 'execution-bootstrap.ts'),
      await readFile(
        new URL('./fixtures/host-runtime-fault-bootstrap.mjs', import.meta.url),
        'utf8',
      ),
    );
    await writeFile(
      resolve(root, 'fixture.mjs'),
      `
      import { createApp } from '@forgeax/engine/app/browser';
      const startup = globalThis.__forgeaxStartup;
      const canvas = document.querySelector('#app');
      const channel = new MessageChannel();
      const errors = [];
      const app = (await createApp(canvas, {
        execution: { workers: {engine:true,render:true,kernels:false},
          bootstrap: new URL('./execution-bootstrap.ts', import.meta.url),
          bootstrapPort: channel.port2, startupTimeoutMs: 90000 },
        lockProvider: { requestLock() { throw new Error('Fixture lock denial'); }, exitLock() {} },
      }, { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href })).unwrap();
      app.onError(error => errors.push(error.code));
      let removeStartupErrorListener;
      ${errorBinding}
      startup.bindSession(app.execution.report().world.identity);
      startup.bindInput(enabled => { app.input?.setInputAllowed?.(enabled); if(!enabled) app.input?.clear?.(); });
      const owner = crypto.randomUUID();
      globalThis.fixture = Object.freeze({
        snapshot: () => ({ owner, execution: app.execution.report(), errors: [...errors] }),
        terminal: () => channel.port1.postMessage('terminal-update'),
        dispose: async () => { removeStartupErrorListener(); channel.port1.close(); (await app.dispose()).unwrap(); },
      });
      startup.prepare();
      window.addEventListener('pagehide', () => { channel.port1.close(); void app.dispose(); }, { once: true });
      app.start().unwrap();
    `,
    );
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'error',
      plugins: [
        executionWorkerEntries([
          '@forgeax/engine/ecs',
          '@forgeax/engine/geometry',
          '@forgeax/engine/render',
          '@forgeax/engine/scene',
        ]),
        forgeaxShader(),
      ],
      define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': '"0"' },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, repository] } },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('Fixture server URL unavailable');
    const options = runtimeBrowserLaunchOptions();
    browser = await chromium.launch({ ...options, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    await page.addInitScript(applyTestCanvasBudget, {
      width: testQuality.squareSize,
      height: testQuality.squareSize,
    });
    await page.goto(url);
    await page.waitForFunction(() => 'fixture' in globalThis);
    await expect
      .poll(async () => (await snapshot(page)).execution.render?.completedFrame, { timeout: 90000 })
      .toBeGreaterThanOrEqual(2);
    expect(
      await page.locator('#app').evaluate((canvas) => [
        Number(canvas.getAttribute('width')), Number(canvas.getAttribute('height')),
      ]),
    ).toEqual([testQuality.squareSize, testQuality.squareSize]);
    await expect
      .poll(() => page.locator('#forgeax-loading').evaluate((el) => getComputedStyle(el).display))
      .toBe('none');
    const before = await snapshot(page);
    expect(before.execution.fault).toBeNull();
    expect(before.errors).toEqual([]);
    expect(before.execution.render?.state).toBe('alive');
    expect(before.execution.workers).toMatchObject({
      engine: { enabled: true },
      render: { enabled: true },
      kernels: { enabled: false },
    });
    // Native canvas click reaches the real Input provider and App error fan-out.
    await page.locator('#app').click();
    await expect
      .poll(async () => (await snapshot(page)).errors)
      .toContain('app-pointer-lock-failed');
    const recoverable = await snapshot(page);
    expect(recoverable.execution.fault).toBeNull();
    expect(recoverable.errors).toEqual(['app-pointer-lock-failed']);
    expect(
      await page.locator('#forgeax-fatal').evaluate((el) => getComputedStyle(el).display),
    ).toBe('none');
    await expect
      .poll(async () => (await snapshot(page)).execution.render?.completedFrame)
      .toBeGreaterThan(before.execution.render?.completedFrame ?? 0);
    await page.evaluate(() =>
      (globalThis as unknown as { fixture: { terminal(): void } }).fixture.terminal(),
    );
    await expect
      .poll(async () => (await snapshot(page)).execution.fault, { timeout: 10000 })
      .not.toBeNull();
    const terminal = await snapshot(page);
    const evidence = resolve(repository, 'artifacts/host-runtime-fault');
    await mkdir(evidence, { recursive: true });
    await writeFile(
      resolve(evidence, 'execution.json'),
      JSON.stringify({ before, recoverable, terminal }, null, 2),
    );
    expect(terminal.execution.engine.health).toBe('faulted');
    expect(terminal.execution.world.identity).toBe(before.execution.world.identity);
    expect(terminal.execution.world.health).toBe('poisoned');
    expect(terminal.execution.fault?.source).toBe('world');
    expect(terminal.execution.fault?.partialWrite).toBe(true);
    expect(terminal.errors).toContain('app-execution-kernel-failed');
    await expect
      .poll(() => page.locator('#forgeax-fatal').evaluate((el) => getComputedStyle(el).display))
      .toBe('grid');
    expect(await page.locator('#forgeax-fatal-message').textContent()).toBe(
      'The game stopped because execution failed.',
    );
    expect(await page.locator('#forgeax-fatal-details').textContent()).toContain(
      'Host runtime fault fixture Update failure',
    );
    expect(
      await page.locator('#forgeax-fatal-reload').evaluate((el) => el === document.activeElement),
    ).toBe(true);

    await page.screenshot({ path: resolve(evidence, 'terminal.png') });
    const owner = terminal.owner;
    await page.locator('#forgeax-fatal-reload').click();
    await page.waitForFunction((previous) => {
      const f = (globalThis as unknown as { fixture?: { snapshot(): Snapshot } }).fixture;
      return f !== undefined && f.snapshot().owner !== previous;
    }, owner);
    expect((await snapshot(page)).execution.fault).toBeNull();
    await page.evaluate(() =>
      (globalThis as unknown as { fixture: { dispose(): Promise<void> } }).fixture.dispose(),
    );
  } catch (cause) {
    primaryFailure = cause;
    failed = true;
  } finally {
    const closed = await Promise.allSettled([browser?.close(), server?.close()]);
    const removed = await Promise.allSettled([rm(root, { recursive: true, force: true })]);
    cleanupFailures = [...closed, ...removed]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
  }
  if (failed) throw primaryFailure;
  if (cleanupFailures.length > 0)
    throw new AggregateError(cleanupFailures, 'Fixture cleanup failed');
}, 180000);
