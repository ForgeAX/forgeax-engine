import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import { chromium } from 'playwright';
import { createLogger, createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { defined } from '../../__tests__/assert-defined.js';
import { assertSoftwareGraphicsGuard } from '../../__tests__/native-unit-owner.js';
import { installBrowserHostGraphicsGuard } from '../../__tests__/support/browser-host-graphics-guard.js';
import { discoverPluginAssets } from '../plugin-assets.js';
import { exportModule, pluginProgramsBuild, pluginRuntimeProjection } from '../plugin-programs.js';

interface SessionProbe {
  sameToken: boolean;
  version: number;
  lazyVersion?: number;
  directValue?: number;
  read(): Promise<number>;
}

it.each([
  'js',
  'json',
  'virtual',
  'external',
  'raw',
] as const)('fences %s lazy imports and archives across Host replacement', async (kind) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-dev-session-')));
  const base = '/games/session/';
  const servers: ViteDevServer[] = [];
  let current: ViteDevServer | undefined;
  const http = createHttpServer((request, response) => {
    if (current) current.middlewares(request, response);
    else {
      response.statusCode = 503;
      response.end();
    }
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const errors: string[] = [];
  const logger = createLogger('silent');
  logger.error = (message) => errors.push(message);
  try {
    const engine = resolve(root, 'node_modules/@forgeax/engine');
    await mkdir(resolve(engine, 'dist'), { recursive: true });
    await writeFile(
      resolve(engine, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        version: '1',
        exports: { './package.json': './package.json' },
      }),
    );
    await mkdir(resolve(root, 'assets'));
    await mkdir(resolve(root, 'dist'));
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      resolve(root, 'assets/behavior.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000994',
        assets: {
          main: { kind: 'plugin', payload: { module: { specifier: '../dist/entry.js' } } },
        },
      }),
    );
    const lazy =
      kind === 'virtual'
        ? 'virtual:late-program'
        : kind === 'external'
          ? 'session-dependency'
          : `./lazy.${kind === 'raw' ? 'txt?raw' : kind}`;
    const selection =
      kind === 'json'
        ? 'module.default.value'
        : kind === 'raw'
          ? 'Number(module.default)'
          : 'module.value';
    await writeFile(
      resolve(root, 'dist/entry.js'),
      `import { token } from './shared.js'; export default { token, read: () => import(${JSON.stringify(lazy)}).then(module => ${selection}) };`,
    );
    const start = async (version: number, enabled = true) => {
      await writeFile(
        resolve(root, 'dist/shared.js'),
        `export const token = { version: ${version} };`,
      );
      const lazyCode = `globalThis.lazyVersion = ${version}; export const value = ${version};`;
      if (kind === 'json')
        await writeFile(resolve(root, 'dist/lazy.json'), JSON.stringify({ value: version }));
      else if (kind === 'raw') await writeFile(resolve(root, 'dist/lazy.txt'), String(version));
      else if (kind === 'external') {
        const dependency = resolve(root, 'node_modules/session-dependency');
        await mkdir(dependency, { recursive: true });
        await writeFile(
          resolve(dependency, 'package.json'),
          JSON.stringify({
            name: 'session-dependency',
            version: '1',
            type: 'module',
            exports: './index.js',
          }),
        );
        await writeFile(resolve(dependency, 'index.js'), lazyCode);
      } else await writeFile(resolve(root, 'dist/lazy.js'), lazyCode);
      const generated = resolve(root, `.forgeax/generated/serve-${version}`);
      await mkdir(generated, { recursive: true });
      await writeFile(
        resolve(generated, 'index.html'),
        '<script type="module" src="/main.js"></script>',
      );
      await writeFile(
        resolve(generated, 'main.js'),
        `
        import plugin from ${JSON.stringify(exportModule(resolve(root, 'dist/entry.js'), 'default'))};
        import { token } from ${JSON.stringify(resolve(root, 'dist/shared.js'))};
        globalThis.sameToken = plugin.token === token;
        globalThis.version = token.version;
        globalThis.read = plugin.read;
      `,
      );
      const directModule = lazy.startsWith('.') ? resolve(root, 'dist', lazy) : lazy;
      await writeFile(
        resolve(generated, 'direct.js'),
        `import * as module from ${JSON.stringify(directModule)}; globalThis.directValue = ${selection};`,
      );
      const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
      const guid = defined([...inventory.assets.keys()][0]);
      const server = await createServer({
        root: generated,
        base,
        configFile: false,
        logLevel: 'silent',
        customLogger: logger,
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [root] } },
        plugins: [
          {
            name: 'fixture:foreign-virtual',
            resolveId: (id) => (id === 'virtual:late-program' ? '\0virtual:late-program' : null),
            load: (id) => (id === '\0virtual:late-program' ? lazyCode : null),
          },
          pluginRuntimeProjection(root, inventory.sourceInputs),
          pluginProgramsBuild({
            projectRoot: root,
            roots: enabled ? { engine: guid } : {},
            tools: [],
            inventory: async () => {
              if (!enabled) throw new Error('asset-only startup must not prepare plugin inventory');
              return inventory;
            },
            binding: createStandaloneRuntimeAssetBinding('test'),
            pack: {
              ready: async () => {
                if (!enabled) throw new Error('asset-only startup must not await Pack cooking');
              },
              catalogSnapshot: () => [],
            } as unknown as PluginPack,
          }),
        ],
      });
      servers.push(server);
      return server;
    };
    current = await start(1);
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({
      ...(process.env.FORGEAX_CHROME_CHANNEL !== undefined
        ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
        : {}),
      headless: true,
      args: ['--disable-gpu'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    await installBrowserHostGraphicsGuard(page);
    const modules: string[] = [];
    page.on('request', (request) => modules.push(request.url()));
    await page.goto(origin + base);
    await page.waitForFunction(() => 'read' in globalThis);
    await assertSoftwareGraphicsGuard(page);
    expect(
      await page.evaluate(() => {
        const probe = globalThis as unknown as SessionProbe;
        return { same: probe.sameToken, version: probe.version, lazy: probe.lazyVersion };
      }),
    ).toEqual({ same: true, version: 1, lazy: undefined });
    const facade = new URL(defined(modules.find((url) => url.includes('plugin-export/'))));
    const archiveUrl = new URL(
      `${base}@id/__x00__virtual:forgeax/plugin-programs/engine.programs.json`,
      origin,
    );
    archiveUrl.search = facade.search;
    const before = await page.request.get(archiveUrl.href);
    expect(before.status()).toBe(200);
    const archive = (await before.json()) as { error?: string; urls: Record<string, string> };
    expect(archive.error).toBeUndefined();
    const frozenUrl = defined(Object.values(archive.urls)[0]);
    const old = current;
    const oldEnvironment = defined(old.environments.client);
    const frozenCode = defined(await oldEnvironment.transformRequest(frozenUrl)).code;
    expect(defined(await oldEnvironment.transformRequest(`${frozenUrl}&t=123&import`)).code).toBe(
      frozenCode,
    );
    current = await start(2);
    expect(defined(await oldEnvironment.transformRequest(frozenUrl)).code).toBe(frozenCode);
    const result = await page.evaluate(async () => {
      try {
        return await (globalThis as unknown as SessionProbe).read();
      } catch (cause) {
        return String(cause);
      }
    });
    expect(result).toContain('Failed to fetch dynamically imported module');
    expect(
      await page.evaluate(() => (globalThis as unknown as SessionProbe).lazyVersion),
    ).toBeUndefined();
    expect((await page.request.get(archiveUrl.href)).status()).toBe(410);
    const next = await browser.newPage();
    await installBrowserHostGraphicsGuard(next);
    await next.goto(origin + base);
    await next.waitForFunction(() => 'read' in globalThis);
    await assertSoftwareGraphicsGuard(next);
    expect(
      await next.evaluate(async () => {
        const probe = globalThis as unknown as SessionProbe;
        return { same: probe.sameToken, version: probe.version, value: await probe.read() };
      }),
    ).toEqual({ same: true, version: 2, value: 2 });
    await next.addScriptTag({ type: 'module', url: `${origin}${base}direct.js` });
    await next.waitForFunction(
      () => (globalThis as unknown as SessionProbe).directValue !== undefined,
    );
    expect(await next.evaluate(() => (globalThis as unknown as SessionProbe).directValue)).toBe(2);
    await old.close();
    await expect(oldEnvironment.transformRequest(frozenUrl)).rejects.toBeDefined();
    current = await start(3, false);
    expect((await page.request.get(archiveUrl.href)).status()).toBe(410);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    for (const server of servers) await server.close();
    await new Promise<void>((done) => http.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
