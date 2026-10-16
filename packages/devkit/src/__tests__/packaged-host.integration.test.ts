// @perf-budget-skip: real staged DevKit and Vite consumer regression.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('serves and builds an external game from the packaged DevKit closure, preserving project precedence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-packaged-host-')));
  const packages = fileURLToPath(new URL('../../..', import.meta.url));
  const scope = join(root, 'desktop/resources/engine/node_modules/@forgeax');
  try {
    // These are physical distribution packages, outside any source workspace.
    // Node-only prerequisites reuse the installed dependency graph; the game
    // and umbrella package have no links back to the contributor checkout.
    for (const directory of ['devkit', 'engine', 'math', 'pack']) {
      const source = join(packages, directory);
      const staged = join(scope, directory === 'engine' ? 'engine' : `engine-${directory}`);
      await mkdir(staged, { recursive: true });
      await cp(join(source, 'package.json'), join(staged, 'package.json'));
      await cp(join(source, 'dist'), join(staged, 'dist'), { recursive: true });
      if (directory === 'devkit' || directory === 'pack') {
        // Resolve each installed prerequisite before linking it. Relative pnpm
        // links cannot be re-rooted through a node_modules junction on Windows.
        const dependencies = join(source, 'node_modules');
        const destination = join(staged, 'node_modules');
        await mkdir(destination, { recursive: true });
        for (const name of await readdir(dependencies)) {
          if (name.startsWith('.')) continue;
          if (name.startsWith('@')) {
            await mkdir(join(destination, name));
            for (const child of await readdir(join(dependencies, name)))
              await symlink(
                await realpath(join(dependencies, name, child)),
                join(destination, name, child),
                'junction',
              );
          } else {
            await symlink(
              await realpath(join(dependencies, name)),
              join(destination, name),
              'junction',
            );
          }
        }
      }
    }
    const game = join(root, 'game');
    await mkdir(join(game, 'assets'), { recursive: true });
    await writeFile(
      join(game, 'package.json'),
      JSON.stringify({ name: 'external-game', type: 'module' }),
    );
    await writeFile(
      join(game, 'forge.json'),
      JSON.stringify({
        id: 'external-game',
        name: 'External Game',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    await writeFile(
      join(game, 'main.js'),
      `
      import { vec3 } from '@forgeax/engine/math';
      import { isValidAssetGuidString } from '@forgeax/engine-pack/guid';
      globalThis.engineProbe = {
        dot: vec3.dot([1, 2, 3], [4, 5, 6]),
        guid: isValidAssetGuidString('4846fa5b-8f80-57c0-9cdc-e345102fdb6b'),
      };
    `,
    );
    const runner = join(scope, 'engine-devkit/probe.mjs');
    await writeFile(
      runner,
      `
      import assert from 'node:assert/strict';
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { runInNewContext } from 'node:vm';
      import { build, createServer } from 'vite';
      import { createViteConfig, readProjectFacts } from './dist/index.mjs';
      const game = process.cwd();
      const facts = await readProjectFacts(game);
      assert.equal(facts.ok, true);
      const results = [];
      for (const expected of [32, 101]) {
        if (expected === 101) {
          const installed = join(game, 'node_modules/@forgeax/engine');
          await mkdir(installed, { recursive: true });
          await writeFile(join(installed, 'package.json'), JSON.stringify({
            name: '@forgeax/engine', type: 'module', exports: { './math': './math.js' },
          }));
          await writeFile(join(installed, 'math.js'), 'export const vec3 = { dot: () => 101 };');
        }
        const generated = await createViteConfig(facts.value, 'serve');
        const resolver = generated.plugins.find(p => p?.name === 'forgeax:devkit-engine-workspace-resolver');
        assert.ok(resolver, 'packaged DevKit must contribute its dependency resolver');
        const config = {
          configFile: false, root: game, plugins: [resolver], logLevel: 'silent',
          optimizeDeps: { noDiscovery: true, include: [] },
        };
        const server = await createServer({ ...config, server: { host: '127.0.0.1', port: 0 } });
        try {
          await server.listen();
          const response = await fetch('http://127.0.0.1:' + server.httpServer.address().port + '/main.js');
          assert.equal(response.status, 200, await response.text());
        } finally { await server.close(); }
        const output = await build({ ...config, build: {
          write: false, minify: false,
          lib: { entry: join(game, 'main.js'), formats: ['iife'], name: 'Probe' },
        } });
        const chunk = (Array.isArray(output) ? output[0] : output).output.find(o => o.type === 'chunk');
        const context = {};
        runInNewContext(chunk.code, context);
        assert.equal(context.engineProbe.dot, expected);
        assert.equal(context.engineProbe.guid, true);
        results.push(context.engineProbe);
      }
      console.log(JSON.stringify(results));
    `,
    );
    const { stdout } = await promisify(execFile)(process.execPath, [runner], {
      cwd: game,
      env: { ...process.env, FORGEAX_DISABLE_UPDATE_CHECK: '1' },
      timeout: 30_000,
    });
    expect(JSON.parse(stdout)).toEqual([
      { dot: 32, guid: true },
      { dot: 101, guid: true },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
