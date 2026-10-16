import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries } from '../execution-workers.js';
import { runtimeProgramIdentity } from '../pack-program-imports.js';

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
