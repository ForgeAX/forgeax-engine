import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries } from '../execution-workers.js';

it.each([
  'browser',
  'native',
] as const)('preserves native dynamic-import results and failures in the shared %s graph', async (delivery) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-worker-preload-'));
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await Promise.all([
      writeFile(resolve(root, 'package.json'), '{"type":"module"}'),
      writeFile(
        resolve(root, 'entry.js'),
        "export const success = () => import('./success.js');\nexport const failure = () => import('./failure.js');",
      ),
      writeFile(resolve(root, 'success.js'), "import './lazy.css'; export const value = 42;"),
      writeFile(resolve(root, 'lazy.css'), '.lazy-panel { color: rgb(1, 2, 3); }'),
      writeFile(
        resolve(root, 'failure.js'),
        "throw Object.assign(new Error('Original program failure'), { code: 'program-failed' });",
      ),
    ]);
    await build({
      configFile: false,
      root,
      base: './',
      logLevel: 'silent',
      plugins: [executionWorkerEntries([], delivery)],
      build: {
        modulePreload: false,
        outDir: resolve(root, 'dist'),
        rolldownOptions: {
          input: resolve(root, 'entry.js'),
          preserveEntrySignatures: 'strict',
          output: { entryFileNames: 'entry.js' },
        },
      },
    });
    expect(typeof globalThis.window).toBe('undefined');
    const module = await import(pathToFileURL(resolve(root, 'dist/entry.js')).href);
    await expect(module.success()).resolves.toMatchObject({ value: 42 });
    await expect(module.failure()).rejects.toMatchObject({
      message: 'Original program failure',
      code: 'program-failed',
    });

    // The same graph runs in a Window: preserve Vite's CSS, relative URLs,
    // CSP nonce and preload-error event instead of dropping dependencies.
    await writeFile(
      resolve(root, 'dist/index.html'),
      '<meta property="csp-nonce" nonce="fixture-nonce"><div class="lazy-panel">Lazy CSS</div><script type="module">import * as fixture from "./entry.js"; globalThis.fixture = fixture;</script>',
    );
    server = await preview({
      root,
      configFile: false,
      logLevel: 'error',
      preview: { host: '127.0.0.1', port: 0 },
    });
    browser = await chromium.launch({
      ...(process.env.FORGEAX_CHROME_CHANNEL !== undefined
        ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
        : {}),
      headless: true,
      args: ['--disable-gpu'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls?.local[0] ?? '');
    await page.waitForFunction(() => 'fixture' in globalThis);
    const result = await page.evaluate(async () => {
      const fixture = (
        globalThis as unknown as {
          fixture: {
            success(): Promise<{ value: number }>;
            failure(): Promise<unknown>;
          };
        }
      ).fixture;
      const events: { message: string; code: string }[] = [];
      window.addEventListener('vite:preloadError', (event) => {
        const payload = (event as Event & { payload: { message: string; code: string } }).payload;
        events.push({ message: payload.message, code: payload.code });
      });
      const first = await fixture.success();
      const second = await fixture.success();
      let failure: unknown;
      try {
        await fixture.failure();
      } catch (cause) {
        const error = cause as { message: string; code: string };
        failure = { message: error.message, code: error.code };
      }
      return {
        values: [first.value, second.value],
        failure,
        events,
        color: getComputedStyle(document.querySelector('.lazy-panel') as Element).color,
        stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].map(
          (link) => ({ nonce: link.nonce, loaded: link.sheet !== null }),
        ),
      };
    });
    expect(result).toEqual({
      values: [42, 42],
      failure: { message: 'Original program failure', code: 'program-failed' },
      events: [{ message: 'Original program failure', code: 'program-failed' }],
      color: 'rgb(1, 2, 3)',
      stylesheets: [{ nonce: 'fixture-nonce', loaded: true }],
    });
  } finally {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
