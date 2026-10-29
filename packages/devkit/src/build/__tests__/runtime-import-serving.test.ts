import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createServer, normalizePath, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries, runtimeDependencyEntries } from '../execution-workers.js';
import { runtimeProgramIdentity } from '../pack-program-imports.js';

it('discovers dependencies from declared runtime subpaths before any page request', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime subpath discovery-')));
  const engine = join(root, 'node_modules/@forgeax/engine');
  const app = join(root, 'node_modules/@forgeax/engine-app');
  const dependency = join(engine, 'node_modules/late-dependency');
  let server: ViteDevServer | undefined;
  try {
    await mkdir(join(engine, 'dist'), { recursive: true });
    await mkdir(join(app, 'dist'), { recursive: true });
    await mkdir(dependency, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'index.html'), '<html></html>');
    await writeFile(
      join(engine, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        version: '1.0.0',
        type: 'module',
        exports: {
          './package.json': './package.json',
          './feature': { import: './dist/feature.mjs' },
        },
        dependencies: { '@forgeax/engine-app': '1.0.0', 'late-dependency': '1.0.0' },
      }),
    );
    await writeFile(
      join(engine, 'dist/feature.mjs'),
      "import value from 'late-dependency'; export default value;",
    );
    await writeFile(
      join(app, 'package.json'),
      '{"name":"@forgeax/engine-app","main":"dist/index.mjs"}',
    );
    await writeFile(join(app, 'dist/index.mjs'), 'export default {};');
    await writeFile(
      join(dependency, 'package.json'),
      '{"name":"late-dependency","main":"index.js"}',
    );
    await writeFile(join(dependency, 'index.js'), 'module.exports = 42;');
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, hmr: false, ws: false, watch: null },
      build: { outDir: join(root, 'dist') },
      plugins: [executionWorkerEntries(['@forgeax/engine/feature'])],
    });
    await server.listen();
    const optimizer = server.environments.client?.depsOptimizer;
    expect(optimizer).toBeDefined();
    await optimizer?.scanProcessing;
    const metadata = optimizer?.metadata;
    const discovered = [
      ...Object.values(metadata?.discovered ?? {}),
      ...Object.values(metadata?.optimized ?? {}),
    ];
    expect(discovered.some(({ src }) => src === normalizePath(join(dependency, 'index.js')))).toBe(
      true,
    );
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects an incomplete delivered Engine before accepting page requests', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'runtime import admission-')));
  const root = join(temporary, 'game');
  const engine = join(temporary, 'installed-engine');
  let server: ViteDevServer | undefined;
  try {
    await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
    await mkdir(engine);
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(engine, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        version: '1.0.0',
        type: 'module',
        exports: { './package.json': './package.json' },
      }),
    );
    await symlink(engine, join(root, 'node_modules/@forgeax/engine'), 'dir');
    await expect(
      (async () => {
        server = await createServer({
          root,
          configFile: false,
          logLevel: 'silent',
          optimizeDeps: { noDiscovery: true, include: [] },
          server: { host: '127.0.0.1', port: 0, hmr: false, ws: false, watch: null },
          plugins: [executionWorkerEntries(['@forgeax/engine/geometry'])],
        });
        await server.listen();
      })(),
    ).rejects.toThrow(/ENOENT.*dist/);
  } finally {
    await server?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

it.each([
  null,
  'e0d0a973-2ac7-420b-b46b-c083ec38ec13',
])('serves admitted lazy native modules outside the project root with session: %s', async (session) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'runtime import serving-')));
  const root = join(temporary, 'game');
  const engine = join(temporary, 'installed-engine');
  const entry = join(engine, 'dist/geometry.mjs');
  const helper = join(engine, 'dist/helper.mjs');
  const unrelated = join(engine, 'dist/private.mjs');
  let server: ViteDevServer | undefined;
  try {
    await mkdir(join(root, 'node_modules/@forgeax'), { recursive: true });
    await mkdir(join(engine, 'dist'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(engine, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        version: '1.0.0',
        type: 'module',
        exports: { './package.json': './package.json', './geometry': './dist/geometry.mjs' },
      }),
    );
    await writeFile(entry, "export { value } from './helper.mjs';");
    await writeFile(helper, 'export const value = 42;');
    await writeFile(unrelated, 'export const privateValue = 99;');
    await symlink(engine, join(root, 'node_modules/@forgeax/engine'), 'dir');
    server = await createServer({
      root,
      base: '/game/',
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias:
          session === null
            ? []
            : [
                {
                  find: '@forgeax/engine/geometry',
                  replacement: `${entry}?forgeax-program-session=${session}`,
                },
              ],
      },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, hmr: false, ws: false, fs: { allow: [root] } },
      plugins: [executionWorkerEntries(['@forgeax/engine/geometry'])],
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('missing Vite listener');
    const origin = `http://127.0.0.1:${address.port}/game/`;
    const nativeURL = (file: string) => `${origin}@fs${pathToFileURL(file).pathname}`;
    expect((await fetch(nativeURL(entry))).status).toBe(403);
    const table = await fetch(`${origin}@id/__x00__virtual:forgeax/pack-program-imports`);
    expect(table.status).toBe(200);
    const source = await table.text();
    expect(source).toContain('@forgeax/engine/geometry');
    expect(source).toContain(await runtimeProgramIdentity(join(engine, 'package.json')));
    const generatedURL = source.match(
      /new URL\(("(?:\\.|[^"\\])*"), globalThis\.location\.origin\)/,
    )?.[1];
    if (generatedURL === undefined) throw new Error('missing runtime import URL');
    const entryURL = new URL(JSON.parse(generatedURL) as string, new URL(origin).origin).href;
    expect(entryURL).toBe(
      nativeURL(entry) + (session === null ? '' : `?forgeax-program-session=${session}`),
    );
    expect(new URL(entryURL).searchParams.get('forgeax-program-session')).toBe(session);
    const loaded = await fetch(entryURL);
    expect(loaded.status).toBe(200);
    expect(await loaded.text()).toContain('helper.mjs');
    expect((await fetch(nativeURL(helper))).status).toBe(200);
    expect((await fetch(nativeURL(unrelated))).status).toBe(403);
    expect(server.config.server.fs.allow).not.toContain(engine);
    expect(server.config.server.fs.allow).not.toContain(temporary);
  } finally {
    await server?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

it('scans browser runtime exports without admitting Node-only dependency entries', async () => {
  const require = createRequire(import.meta.url);
  const appManifest = require.resolve('@forgeax/engine-app/package.json');
  const entries = await runtimeDependencyEntries(appManifest);
  const importRoot = dirname(require.resolve('@forgeax/engine-import/package.json'));
  const ddcRoot = dirname(require.resolve('@forgeax/engine-ddc/package.json'));
  expect(entries).toContain(normalizePath(join(importRoot, 'dist/browser.mjs')));
  expect(entries).not.toContain(normalizePath(join(importRoot, 'dist/index.mjs')));
  expect(entries).not.toContain(normalizePath(join(ddcRoot, 'dist/index.mjs')));
});

it.each([
  true,
  false,
])('shares Engine tokens across bootstrap and plugin imports after restarting Vite (versioned: %s)', async (versioned) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime facade versions-')));
  const engine = join(root, 'node_modules/@forgeax/engine');
  const entry = join(engine, 'dist/scene.mjs');
  let server: ViteDevServer | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(join(engine, 'dist'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"consumer","type":"module"}');
    await writeFile(
      join(engine, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        version: '1.0.0',
        type: 'module',
        exports: { './package.json': './package.json', './scene': './dist/scene.mjs' },
      }),
    );
    await writeFile(entry, 'export const token = {};');
    await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
    await writeFile(
      join(root, 'game.pack.js'),
      `
      import { token } from '@forgeax/engine/scene';
      import table, { loadImport } from 'virtual:forgeax/pack-program-imports';
      export async function verify() {
        const delivered = await import(table['@forgeax/engine/scene'].url);
        const lazy = await loadImport('@forgeax/engine/scene');
        return token === delivered.token && token === lazy.token;
      }
    `,
    );
    await writeFile(
      join(root, 'worker.js'),
      `
      import { verify } from './game.pack.js?forgeax-plugin-runtime';
      postMessage(await verify());
    `,
    );
    await writeFile(
      join(root, 'main.js'),
      `
      import { verify } from './game.pack.js?forgeax-plugin-runtime';
      const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      const workerResult = new Promise(resolve => worker.onmessage = event => resolve(event.data));
      globalThis.result = [await verify(), await workerResult];
      worker.terminate();
    `,
    );
    browser = await chromium.launch({
      ...(process.env.FORGEAX_CHROME_CHANNEL !== undefined
        ? { channel: process.env.FORGEAX_CHROME_CHANNEL }
        : {}),
      headless: true,
      chromiumSandbox: true,
    });
    for (let run = 0; run < 2; run += 1) {
      let resolutions = 0;
      server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: '127.0.0.1', port: 0, hmr: false, ws: false },
        plugins: [
          executionWorkerEntries(['@forgeax/engine/scene']),
          {
            name: 'fixture:vite-facade-cache-versions',
            enforce: 'pre',
            resolveId(id) {
              if (id === '@forgeax/engine/scene') {
                resolutions += 1;
                return entry + (versioned ? `?v=${run}-${resolutions % 2}` : '');
              }
              return null;
            },
          },
        ],
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('missing Vite listener');
      const page = await browser.newPage();
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(error.message));
      try {
        await page.goto(`http://127.0.0.1:${address.port}`);
        await page.waitForFunction(() => 'result' in globalThis, undefined, { timeout: 5000 });
        expect(await page.evaluate('globalThis.result')).toEqual([true, true]);
        expect(failures).toEqual([]);
        expect(resolutions).toBeGreaterThan(1);
      } finally {
        await page.close();
      }
      await server.close();
      server = undefined;
    }
  } finally {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
