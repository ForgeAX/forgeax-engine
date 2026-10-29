import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build, createServer, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries } from '../execution-workers.js';

it.each([
  'static',
  'dynamic',
] as const)('keeps %s Engine imports separate and hashes final relative URLs across facade dependency changes', async (kind) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-engine-facades-')));
  try {
    const engine = resolve(root, 'node_modules/@forgeax/engine-scene');
    await mkdir(engine, { recursive: true });
    await writeFile(resolve(root, 'package.json'), '{"name":"consumer","type":"module"}');
    await writeFile(
      resolve(engine, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-scene',
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      }),
    );
    await writeFile(resolve(engine, 'index.js'), "export { token } from './dependency.js';");
    await writeFile(
      resolve(root, 'main.js'),
      kind === 'static'
        ? "import { token } from '@forgeax/engine-scene'; globalThis.readToken = () => token;"
        : "globalThis.readToken = () => import('@forgeax/engine-scene').then(module => module.token);",
    );
    const compile = async (value: number) => {
      await writeFile(
        resolve(engine, 'dependency.js'),
        `export const token = { value: ${value} };`,
      );
      const output = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [executionWorkerEntries([])],
        build: {
          target: 'es2022',
          minify: false,
          modulePreload: false,
          manifest: true,
          rollupOptions: {
            input: { main: resolve(root, 'main.js') },
            output: {
              entryFileNames: '[name]-[hash].js',
              chunkFileNames: '.chunks/[name]-[hash].js',
            },
          },
        },
      });
      if (Array.isArray(output) || !('output' in output)) throw new Error('missing bundle');
      const chunks = output.output.filter((chunk) => chunk.type === 'chunk');
      const main = chunks.find(
        (chunk) => chunk.facadeModuleId === resolve(root, 'main.js').replaceAll('\\', '/'),
      );
      const facade = chunks.find(
        (chunk) => chunk.facadeModuleId === resolve(engine, 'index.js').replaceAll('\\', '/'),
      );
      if (!main || !facade) throw new Error('missing public facade or consumer');
      expect(Object.keys(main.modules).filter((id) => id !== '\0vite/preload-helper.js')).toEqual([
        resolve(root, 'main.js').replaceAll('\\', '/'),
      ]);
      expect(facade.exports).toContain('token');
      if (kind === 'static') expect(main.code).toMatch(/import\s*\{\s*token\s*\}/);
      expect(kind === 'static' ? main.imports : main.dynamicImports).toContain(facade.fileName);
      const manifest = JSON.parse(
        await readFile(resolve(root, 'dist/.vite/manifest.json'), 'utf8'),
      );
      const mainManifest = manifest['main.js'];
      const dependencies = kind === 'static' ? mainManifest.imports : mainManifest.dynamicImports;
      expect(dependencies?.length).toBeGreaterThan(0);
      expect(dependencies.map((id: string) => manifest[id]?.file)).toContain(facade.fileName);
      const names = new Set(chunks.map((chunk) => chunk.fileName));
      for (const chunk of chunks) {
        expect(chunk.code).not.toMatch(/forgeax-host-import:|!~\{/);
        expect(await readFile(resolve(root, 'dist', chunk.fileName), 'utf8')).toBe(chunk.code);
        for (const specifier of [...chunk.imports, ...chunk.dynamicImports])
          expect(names.has(specifier)).toBe(true);
        for (const match of chunk.code.matchAll(/(?:from\s*|import\s*\()["']([^"']+)["']/g)) {
          expect(match[1]).toMatch(/^(?:\.\/|\.\.\/)/);
          const url = new URL(match[1] ?? '', `https://example.invalid/${chunk.fileName}`);
          expect(names.has(url.pathname.slice(1))).toBe(true);
        }
      }
      return { main, facade };
    };
    const before = await compile(1);
    const after = await compile(2);
    expect(after.facade.code).not.toBe(before.facade.code);
    expect(after.facade.fileName).not.toBe(before.facade.fileName);
    expect(after.main.code).not.toBe(before.main.code);
    expect(after.main.fileName).not.toBe(before.main.fileName);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects conflicting Engine resolutions instead of silently replacing a native module', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-engine-conflict-')));
  try {
    await writeFile(resolve(root, 'package.json'), '{"name":"consumer","type":"module"}');
    for (const [directory, value] of [
      [root, 1],
      [resolve(root, 'nested'), 2],
    ] as const) {
      const engine = resolve(directory, 'node_modules/@forgeax/engine-scene');
      await mkdir(engine, { recursive: true });
      await writeFile(
        resolve(engine, 'package.json'),
        JSON.stringify({
          name: '@forgeax/engine-scene',
          version: '1.0.0',
          type: 'module',
          exports: './index.js',
        }),
      );
      await writeFile(resolve(engine, 'index.js'), `export const token = { value: ${value} };`);
    }
    await writeFile(
      resolve(root, 'nested/part.js'),
      "export { token } from '@forgeax/engine-scene';",
    );
    await writeFile(
      resolve(root, 'main.js'),
      "import { token as a } from '@forgeax/engine-scene'; import { token as b } from './nested/part.js'; globalThis.tokens = [a, b];",
    );
    await expect(
      build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [executionWorkerEntries([])],
        build: { write: false, rollupOptions: { input: resolve(root, 'main.js') } },
      }),
    ).rejects.toThrow('Engine capability resolves to multiple modules in one player');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['?v=old', '?v=new'],
  ['?raw&v=old', '?v=new&raw'],
  ['?forgeax-program-session=one&v=old&worker', '?forgeax-program-session=one&v=new&worker'],
  ['?v=old&v=older', '?v=new'],
])('canonicalizes only development cache versions: %s and %s', async (first, second) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-facade-version-')));
  const entry = resolve(root, 'scene.mjs');
  let query = first;
  let selectedEntry = entry;
  let server: ViteDevServer | undefined;
  try {
    await writeFile(resolve(root, 'package.json'), '{"name":"consumer","type":"module"}');
    await writeFile(entry, 'export const token = {};');
    const umbrella = resolve(root, 'node_modules/@forgeax/engine');
    await mkdir(umbrella, { recursive: true });
    await writeFile(
      resolve(umbrella, 'package.json'),
      '{"name":"@forgeax/engine","dependencies":{}}',
    );
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { watch: null, hmr: false, ws: false },
      plugins: [
        executionWorkerEntries([]),
        {
          name: 'fixture:facade-version',
          enforce: 'pre',
          resolveId(id) {
            return id === '@forgeax/engine-scene' ? selectedEntry + query : null;
          },
        },
      ],
    });
    const container = server.environments.client?.pluginContainer;
    if (!container) throw new Error('missing client container');
    const before = await container.resolveId(
      '@forgeax/engine-scene',
      resolve(root, 'bootstrap.js'),
    );
    query = second;
    const after = await container.resolveId('@forgeax/engine-scene', resolve(root, 'game.pack.js'));
    expect(before?.id).toBe(entry.replaceAll('\\', '/') + first);
    expect(after?.id).toBe(before?.id);
    for (const semantic of ['?forgeax-program-session=other', '?raw=changed', '?worker=other']) {
      query = semantic;
      await expect(
        container.resolveId('@forgeax/engine-scene', resolve(root, 'child.js')),
      ).rejects.toThrow('Engine capability resolves to multiple modules in one player');
    }
    selectedEntry = resolve(root, 'other-scene.mjs');
    await writeFile(selectedEntry, 'export const token = {};');
    query = first;
    await expect(
      container.resolveId('@forgeax/engine-scene', resolve(root, 'other.js')),
    ).rejects.toThrow('Engine capability resolves to multiple modules in one player');
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  false,
  true,
])('compares cache-independent identity while retaining Vite load URLs (conflict: %s)', async (conflictingSession) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-engine-dev-facades-')));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await writeFile(resolve(root, 'package.json'), '{"name":"consumer","type":"module"}');
    const umbrella = resolve(root, 'node_modules/@forgeax/engine');
    await mkdir(umbrella, { recursive: true });
    await writeFile(
      resolve(umbrella, 'package.json'),
      '{"name":"@forgeax/engine","dependencies":{}}',
    );
    const file = resolve(root, 'scene.js');
    await writeFile(file, 'export const token = {};');
    const first = resolve(root, 'first.js');
    const second = resolve(root, 'second.js');
    await writeFile(first, '');
    await writeFile(second, '');
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true },
      plugins: [
        executionWorkerEntries([]),
        {
          name: 'fixture-engine-cache-resolution',
          enforce: 'pre',
          resolveId(id, importer) {
            if (id !== '@forgeax/engine-scene') return null;
            const session = conflictingSession && importer === second ? 'other' : 'same';
            return `${file}?session=${session}&v=${importer === first ? 'one' : 'two'}`;
          },
        },
      ],
    });
    const container = server.environments.client?.pluginContainer;
    if (container === undefined) throw new Error('missing client environment');
    const initial = await container.resolveId('@forgeax/engine-scene', first);
    const repeated = container.resolveId('@forgeax/engine-scene', second);
    if (conflictingSession) {
      await expect(repeated).rejects.toThrow('Engine capability resolves to multiple modules');
    } else {
      expect(await repeated).toMatchObject({
        id: `${file.replaceAll('\\', '/')}?session=same&v=one`,
      });
      expect(initial?.id).toBe(`${file.replaceAll('\\', '/')}?session=same&v=one`);
    }
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
