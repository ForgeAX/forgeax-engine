import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'vite';
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
