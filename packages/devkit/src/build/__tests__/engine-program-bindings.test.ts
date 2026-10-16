import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { executionWorkerEntries } from '../execution-workers.js';

it('emits complete lazy bindings with real URLs and changes importer hashes with capability bytes', async () => {
  const state = globalThis as typeof globalThis & { delayedBindingEvaluation?: number };
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-delayed-bindings-')));
  try {
    const engine = resolve(root, 'node_modules/@forgeax/engine');
    const physical = resolve(root, 'node_modules/@forgeax/engine-extra');
    await mkdir(resolve(engine, 'dist'), { recursive: true });
    await mkdir(physical, { recursive: true });
    await writeFile(resolve(root, 'package.json'), '{"name":"consumer","type":"module"}');
    await writeFile(
      resolve(engine, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        version: '1',
        type: 'module',
        dependencies: { '@forgeax/engine-extra': '1' },
        exports: {
          './package.json': './package.json',
          './scene': './dist/scene.js',
          './extra': './dist/extra.js',
        },
      }),
    );
    await writeFile(
      resolve(physical, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-extra',
        version: '1',
        type: 'module',
        exports: { '.': './index.js', './package.json': './package.json' },
      }),
    );
    await mkdir(resolve(physical, 'dist'));
    await writeFile(resolve(physical, 'index.js'), "export { token } from './dist/extra.js';");
    await writeFile(resolve(engine, 'dist/scene.js'), 'export const scene = {};');
    await writeFile(
      resolve(engine, 'dist/extra.js'),
      "export { token } from '@forgeax/engine-extra';",
    );
    await writeFile(
      resolve(root, 'main.js'),
      "import bindings from 'virtual:forgeax/pack-program-imports'; export { bindings }; export const read = () => Promise.all([import('@forgeax/engine/extra'),import('@forgeax/engine-extra')]);",
    );
    const compile = async (value: number) => {
      await writeFile(
        resolve(physical, 'dist/extra.js'),
        `globalThis.delayedBindingEvaluation = (globalThis.delayedBindingEvaluation ?? 0) + 1; export const token = { value: ${value} };`,
      );
      const result = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [executionWorkerEntries(['@forgeax/engine/scene'])],
        build: {
          target: 'es2022',
          modulePreload: false,
          rollupOptions: { input: resolve(root, 'main.js'), preserveEntrySignatures: 'strict' },
        },
      });
      if (Array.isArray(result) || !('output' in result)) throw new Error('no output');
      const main = result.output.find(
        (chunk) =>
          chunk.type === 'chunk' &&
          chunk.facadeModuleId === resolve(root, 'main.js').replaceAll('\\', '/'),
      );
      if (main?.type !== 'chunk') throw new Error('missing main chunk');
      for (const chunk of result.output)
        if (chunk.type === 'chunk')
          expect(chunk.code).not.toMatch(
            /__forgeax_delivered_program_imports__|forgeax-host-import:|!~\{/,
          );
      return { filename: main.fileName, code: main.code };
    };
    const first = await compile(1);
    const module = await import(pathToFileURL(resolve(root, 'dist', first.filename)).href);
    expect(state.delayedBindingEvaluation).toBeUndefined();
    expect(Object.keys(module.bindings).sort()).toEqual(
      ['@forgeax/engine-extra', '@forgeax/engine/extra', '@forgeax/engine/scene'].sort(),
    );
    const [umbrella, physicalModule] = await module.read();
    expect(umbrella.token).toBe(physicalModule.token);
    for (const key of ['@forgeax/engine/extra', '@forgeax/engine-extra'])
      expect((await import(module.bindings[key].url)).token).toBe(umbrella.token);
    expect(state.delayedBindingEvaluation).toBe(1);
    const second = await compile(2);
    expect(second.filename).not.toBe(first.filename);
    expect(second.code).not.toBe(first.code);
  } finally {
    delete state.delayedBindingEvaluation;
    await rm(root, { recursive: true, force: true });
  }
});
