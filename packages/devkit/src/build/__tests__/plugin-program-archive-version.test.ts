import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import type { PluginPack } from '@forgeax/engine-vite-plugin-pack';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { defined } from '../../__tests__/assert-defined.js';
import { executionWorkerEntries } from '../execution-workers.js';
import { discoverPluginAssets } from '../plugin-assets.js';
import { pluginProgramsBuild, pluginRuntimeProjection } from '../plugin-programs.js';

it('binds every provider archive URL to all targets and the full Engine identity', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-archive-version-'));
  try {
    const engine = resolve(root, 'node_modules/@forgeax/engine');
    await mkdir(resolve(engine, 'dist'), { recursive: true });
    await writeFile(
      resolve(engine, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        version: '1.0.0',
        type: 'module',
        exports: {
          './package.json': './package.json',
          './scene': './dist/scene.js',
          './pack/runtime': './dist/runtime.js',
        },
      }),
    );
    await writeFile(resolve(engine, 'dist/scene.js'), 'export const token = {};');
    await writeFile(
      resolve(engine, 'dist/runtime.js'),
      'export const verifyPackProgram = value => ({ unwrap: () => value }); export const packProgramModuleIdentity = value => ({ unwrap: () => JSON.stringify(value.modules) });',
    );
    await writeFile(resolve(root, 'package.json'), '{"name":"consumer","type":"module"}');
    await mkdir(resolve(root, 'assets'));
    await mkdir(resolve(root, 'dist'));
    await writeFile(resolve(root, 'dist/shared.js'), 'export const shared = {};');
    await writeFile(
      resolve(root, 'direct.js'),
      "import { shared } from './dist/shared.js'; globalThis.directShared = shared;",
    );
    await writeFile(
      resolve(root, 'dist/front.js'),
      "import { token } from '@forgeax/engine/scene'; import { shared } from './shared.js'; export default { apply() { globalThis.frontValue = [token, shared]; } };",
    );
    await writeFile(
      resolve(root, 'assets/plugins.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000995',
        assets: {
          front: { kind: 'plugin', payload: { module: { specifier: '../dist/front.js' } } },
          engine: { kind: 'plugin', payload: { module: { specifier: '../dist/engine.js' } } },
        },
      }),
    );
    for (const target of ['frontend', 'engine'])
      await writeFile(
        resolve(root, `${target}.js`),
        `import { createPrograms } from 'virtual:forgeax/plugin-programs/${target}'; globalThis.${target}Programs = createPrograms('session', '${target}', 1);`,
      );
    const compile = async (value: number, unusedEngineValue: number) => {
      await writeFile(
        resolve(root, 'dist/engine.js'),
        `export default { apply() { globalThis.engineValue = ${value}; } };`,
      );
      // This changes the Host capability identity without changing imported facade bytes.
      await writeFile(
        resolve(engine, 'dist/unused.js'),
        `export const value = ${unusedEngineValue};`,
      );
      const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
      const records = [...inventory.assets.values()];
      const rows = records.map((record) => ({
        guid: record.definition.guid,
        publication: { generation: 1, digest: 'stable', outputSetDigest: 'stable' },
      }));
      let delayedTables = 0;
      const output = await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          executionWorkerEntries([]),
          pluginRuntimeProjection(root, inventory.sourceInputs),
          {
            name: 'fixture:slow-program-table',
            enforce: 'pre',
            async load(id) {
              if (id.startsWith('\0virtual:forgeax/plugin-programs/')) {
                delayedTables++;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            },
          },
          pluginProgramsBuild({
            projectRoot: root,
            roots: {
              frontend: defined(records.find((record) => record.sourceKey === 'front')).definition
                .guid,
              engine: defined(records.find((record) => record.sourceKey === 'engine')).definition
                .guid,
            },
            tools: [],
            inventory: async () => inventory,
            binding: createStandaloneRuntimeAssetBinding('test'),
            pack: { ready: async () => {}, catalogSnapshot: () => rows } as unknown as PluginPack,
          }),
        ],
        build: {
          write: false,
          minify: false,
          modulePreload: false,
          rollupOptions: {
            input: {
              direct: resolve(root, 'direct.js'),
              frontend: resolve(root, 'frontend.js'),
              engine: resolve(root, 'engine.js'),
            },
          },
        },
      });
      if (Array.isArray(output) || !('output' in output)) throw new Error('missing output');
      expect(delayedTables).toBe(2);
      const selected = defined(
        output.output.find(
          (chunk) =>
            chunk.type === 'chunk' &&
            Object.hasOwn(chunk.modules, '\0virtual:forgeax/plugin-programs/frontend'),
        ),
      );
      const sidecar = output.output.find(
        (chunk) => chunk.fileName === `${selected.fileName}.programs.json`,
      );
      if (sidecar?.type !== 'asset') throw new Error('missing archive');
      const data = JSON.parse(String(sidecar.source));
      expect(data.error).toBeUndefined();
      expect(Object.keys(data.programs)).toHaveLength(2);
      return { filename: sidecar.fileName, source: String(sidecar.source) };
    };
    const before = await compile(1, 1);
    const otherTarget = await compile(2, 1);
    expect(otherTarget.source).not.toBe(before.source);
    expect(otherTarget.filename).not.toBe(before.filename);
    const identityOnly = await compile(2, 2);
    expect(identityOnly.source).not.toBe(otherTarget.source);
    expect(identityOnly.filename).not.toBe(otherTarget.filename);
    expect(await compile(2, 2)).toEqual(identityOnly);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
