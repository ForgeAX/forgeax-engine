import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build, type Plugin } from 'vite';
import { expect, it } from 'vitest';
import { engineUseLocalCommand } from '../engine-binding.js';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it('uses the selected Engine in actual nested Vite Worker bundles', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-nested-worker-binding-'));
  const game = resolve(root, 'game');
  const engine = resolve(root, 'engine');
  const json = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
  try {
    await mkdir(resolve(game, 'assets'), { recursive: true });
    await mkdir(resolve(engine, 'packages/engine/dist'), { recursive: true });
    await mkdir(resolve(game, 'node_modules/@forgeax/engine'), { recursive: true });
    await writeFile(resolve(engine, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    for (const [directory, marker] of [
      [resolve(engine, 'packages/engine'), 'selected-source-engine'],
      [resolve(game, 'node_modules/@forgeax/engine'), 'installed-engine'],
    ] as const) {
      await json(resolve(directory, 'package.json'), {
        name: '@forgeax/engine',
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': './dist/index.mjs',
          './geometry': './dist/index.mjs',
          './package.json': './package.json',
        },
      });
      await mkdir(resolve(directory, 'dist'), { recursive: true });
      await writeFile(resolve(directory, 'dist/index.mjs'), `export const source = '${marker}';`);
    }
    await json(resolve(game, 'package.json'), { name: 'nested-worker-binding', type: 'module' });
    await json(resolve(game, 'forge.json'), {
      id: 'nested-worker-binding',
      name: 'Nested Worker Binding',
      schemaVersion: '3.0.0',
      roots: {},
    });
    await writeFile(
      resolve(game, 'main.ts'),
      "new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module' });",
    );
    await writeFile(
      resolve(game, 'engine-worker.ts'),
      "import { source } from '@forgeax/engine/geometry'; self.postMessage(source); new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' });",
    );
    await writeFile(
      resolve(game, 'mesh-worker.ts'),
      "import { source } from '@forgeax/engine/geometry'; self.postMessage(source);",
    );
    expect((await engineUseLocalCommand({ root: game, path: engine })).ok).toBe(true);
    const facts = await readProjectFacts(game);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'build');
    const output = resolve(root, 'built');
    // Retain the host's resolution and disposal owners; this fixture has no Pack assets.
    const plugins = (config.plugins as Plugin[]).filter(
      (plugin) =>
        plugin.name === 'forgeax:devkit-engine-workspace-resolver' ||
        plugin.name === 'forgeax:project-session',
    );
    await build({
      ...config,
      plugins,
      build: {
        ...config.build,
        outDir: output,
        minify: false,
        rollupOptions: { input: resolve(game, 'main.ts') },
      },
    });
    const names = await readdir(resolve(output, 'assets'));
    const workers = names.filter((name) => /^(engine|mesh)-worker-.*\.js$/.test(name));
    expect(workers).toHaveLength(2);
    for (const worker of workers) {
      const code = await readFile(resolve(output, 'assets', worker), 'utf8');
      expect(code).toContain('selected-source-engine');
      expect(code).not.toContain('installed-engine');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
