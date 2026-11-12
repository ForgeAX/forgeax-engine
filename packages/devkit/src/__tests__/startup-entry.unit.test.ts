import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { expect, it } from 'vitest';
import { createStartupCacheIdentity } from '../host/startup-cache-identity.js';
import { startupEntrySource } from '../host/startup-cache-source.js';

it('compiles versioned and retry TypeScript entries through Vite with their CSS and distinct URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-startup-entry-'));
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await writeFile(
      join(root, 'index.html'),
      `<script type="module">${startupEntrySource(createStartupCacheIdentity({ project: 'entry-test', game: 'game-1', engine: 'engine-1' }))}</script>`,
    );
    await writeFile(
      join(root, 'main.ts'),
      "import './main.css';const value: number = 42;globalThis.entryValue=value;",
    );
    await writeFile(join(root, 'main.css'), 'body {background-color: rgb(12, 34, 56)}');
    await build({ root, configFile: false, logLevel: 'error', build: { outDir: 'dist' } });
    const html = await readFile(join(root, 'dist/index.html'), 'utf8');
    const path = html.match(/src="([^"]+)"/)?.[1];
    if (!path) throw Error('Missing compiled Engine bootstrap URL');
    const bootstrap = await readFile(join(root, 'dist', path), 'utf8');
    expect(bootstrap).not.toContain('main.ts');
    server = await preview({
      root,
      configFile: false,
      logLevel: 'error',
      preview: { host: '127.0.0.1', port: 0 },
    });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw Error('Missing preview address');
    const executablePath = [
      process.env.FORGEAX_BROWSER_EXECUTABLE,
      '/opt/google/chrome-beta/chrome',
      chromium.executablePath(),
    ].find((path): path is string => path !== undefined && existsSync(path));
    browser = await chromium.launch({
      headless: true,
      ...(executablePath === undefined ? {} : { executablePath }),
      chromiumSandbox: true,
    });
    const imports: string[] = [];
    for (const query of ['', '?forgeax-startup-retry=1']) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.on('request', (request) => {
          if (/\/main-[^/]+\.js$/.test(new URL(request.url()).pathname))
            imports.push(request.url());
        });
        await page.goto(`http://127.0.0.1:${address.port}/${query}`);
        await page.waitForFunction(() => Reflect.get(globalThis, 'entryValue') === 42);
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
          'rgb(12, 34, 56)',
        );
      } finally {
        await context.close();
      }
    }
    expect(imports).toHaveLength(2);
    expect(new Set(imports).size).toBe(2);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('serves cache-only reset headers in dev and preview without clearing origin storage', async () => {
  const { createServer, preview } = await import('vite');
  const { startupCacheHttp } = await import('../host/startup-cache-http.js');
  const root = await mkdtemp(join(tmpdir(), 'forgeax-startup-http-'));
  try {
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>dev</title>');
    await writeFile(join(root, 'dist/index.html'), '<!doctype html><title>preview</title>');
    for (const mode of ['dev', 'preview'] as const) {
      const config = {
        root,
        configFile: false as const,
        plugins: [startupCacheHttp()],
        logLevel: 'error' as const,
        server: { host: '127.0.0.1', port: 0 },
        preview: { host: '127.0.0.1', port: 0 },
      };
      const server = mode === 'dev' ? await createServer(config) : await preview(config);
      try {
        if ('listen' in server) await server.listen();
        const address = server.httpServer?.address();
        if (!address || typeof address === 'string') throw Error('Missing HTTP address');
        const url = `http://127.0.0.1:${address.port}/`;
        expect((await fetch(url)).headers.get('clear-site-data')).toBeNull();
        const response = await fetch(`${url}?forgeax-startup-cache-reset=1`);
        expect(response.headers.get('clear-site-data')).toBe('"cache"');
        expect(response.headers.get('cache-control')).toBe('no-store');
      } finally {
        await server.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
