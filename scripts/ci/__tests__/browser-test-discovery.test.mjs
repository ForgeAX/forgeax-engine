import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import hostFiles from '../browser-host-files.json' with { type: 'json' };
import { browserTestFiles } from '../run-split-vitest-browser.mjs';

test('Host coordinator and Browser service do not share a dependency optimizer cache', () => {
  const program = `
    import assert from 'node:assert/strict';
    import { createVitest } from 'vitest/node';
    const owner = 'packages/audio-webaudio/src/__tests__/pcm-stream.browser.test.ts';
    process.argv = [process.execPath, process.cwd() + '/node_modules/vitest/vitest.mjs',
      'run', '--config', 'config/vitest.browser-host.config.ts', '--project=browser', owner];
    const ctx = await createVitest('test', { config: 'config/vitest.browser-host.config.ts', project: ['browser'], run: true, watch: false });
    try {
      await ctx.globTestSpecifications([owner]);
      await ctx._initBrowserServers();
      const project = ctx.projects.find(project => project.browser);
      assert.notEqual(ctx.vite.config.cacheDir, project.browser.vite.config.cacheDir,
        'two live optimizers must not publish into the same directory');
    } finally { await ctx.close(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('Host optimizer discovers the selected owner and preserves the complete roster for broad or foreign selectors', () => {
  const owner = 'packages/audio-webaudio/src/__tests__/pcm-stream.browser.test.ts';
  const foreign = 'packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts';
  const selections = [[owner], ['packages/audio-webaudio', owner], [foreign], []];
  const program = `
    import { createVitest } from 'vitest/node';
    import { relative, sep } from 'node:path';
    const rows = [];
    for (const filters of ${JSON.stringify(selections)}) {
      process.argv = [process.execPath, process.cwd() + '/node_modules/vitest/vitest.mjs',
        'list', '--config', 'config/vitest.browser-host.config.ts', '--project=browser',
        '--filesOnly', ...filters];
      const ctx = await createVitest('test', { config: 'config/vitest.browser-host.config.ts', project: ['browser'], run: true, watch: false });
      try {
        const project = ctx.projects.find(project => project.config.browser.enabled);
        const { testFiles } = await project.globTestFiles();
        rows.push(testFiles.map(file => relative(process.cwd(), file).split(sep).join('/')).sort());
      } finally { await ctx.close(); }
    }
    process.stdout.write(JSON.stringify(rows));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const [selected, ...broad] = JSON.parse(result.stdout);
  assert.deepEqual(selected, [owner]);
  for (const files of broad) assert.deepEqual(files, [...hostFiles].sort());
});

test('actual Browser optimizers resolve runtime, guide, Parity and native Worker dependencies before imports', () => {
  const program = `
    import assert from 'node:assert/strict';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { createRequire } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createServer, createLogger, loadConfigFromFile } from 'vite';
    const root = process.cwd();
    const runtime = [
      ['packages/rhi-debug/package.json', 'pako'],
      ['packages/rhi-debug/package.json', '@noble/hashes/blake3.js'],
    ];
    const cases = [
      ['packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts',
        'config/vitest.browser.config.ts', runtime],
      ['packages/ui-blitz/src/__tests__/dom.browser.test.ts',
        'config/vitest.browser.config.ts', [...runtime,
          ['packages/pack/package.json', '@noble/hashes/legacy.js'],
          ['packages/pack/package.json', '@noble/hashes/utils.js'],
          ['packages/pack/package.json', 'acorn'],
          ['packages/pack/package.json', 'uuidv7'],
          ['packages/ui/package.json', 'i18next'],
        ]],
      ['apps/parity/color-lighting/cases/extended-lighting/__tests__/probe.browser.test.ts',
        'config/vitest.browser.config.ts', [...runtime,
          ['package.json', 'ajv/dist/2020.js'],
          ['apps/parity/color-lighting/package.json', 'three'],
          ['apps/parity/color-lighting/package.json', 'three/addons/lights/RectAreaLightUniformsLib.js'],
          ['apps/parity/color-lighting/package.json', 'three/addons/lights/RectAreaLightTexturesLib.js'],
          ['apps/parity/color-lighting/package.json', 'three/webgpu'],
        ]],
      ['packages/app/src/__tests__/render-worker-preload-errors.browser.test.ts',
        'config/vitest.render-preload-fixture.config.ts', [
          ['packages/ui/package.json', 'css-tree/dist/csstree.esm'],
          ['packages/ui/package.json', 'parse5'],
        ]],
    ];
    const rows = [];
    for (const [owner, configFile, dependencies] of cases) {
      const parity = owner.startsWith('apps/parity/');
      process.argv = [process.execPath, root + '/node_modules/vitest/vitest.mjs',
        'list', '--config', configFile, '--project=browser', '--filesOnly', owner];
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, configFile);
      const project = loaded.config.test.projects[0];
      const warnings = [];
      const errors = [];
      const logger = createLogger('error');
      logger.warn = message => warnings.push(String(message));
      const logError = logger.error.bind(logger);
      logger.error = (message, ...args) => {
        errors.push(String(message));
        return logError(message, ...args);
      };
      const cacheDir = mkdtempSync(join(tmpdir(), 'forgeax-browser-optimizer-'));
      let server;
      try {
        // Exercise Vite's actual optimizer and the actual Browser config.
        // No asset/shader producer, Chromium, adapter or GPU lease is started.
        server = await createServer({ root, configFile: false, cacheDir,
          customLogger: logger, resolve: project.resolve,
          optimizeDeps: { ...project.optimizeDeps, entries: project.optimizeDeps.entries ?? [], force: true },
          server: { port: 0, fs: { allow: [root] } } });
        await server.listen();
        const optimizer = server.environments.client.depsOptimizer;
        await optimizer.scanProcessing;
        const previousMetadata = optimizer.metadata;
        const optimizerStartedAt = Date.now();
        await optimizer.run();
        const expected = dependencies.map(([owner, id]) => {
          const source = createRequire(join(root, owner)).resolve(id).replaceAll('\\\\', '/');
          const name = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
          const marker = '/node_modules/' + name + '/';
          const packageRoot = source.slice(0, source.lastIndexOf(marker) + marker.length);
          assert.ok(source.includes(marker), 'installed dependency must have an identifiable package owner');
          // Browser export conditions may select ESM while Node selects CJS.
          // Require the same import ID and same actual installed package.
          return { id, packageRoot };
        });
        const prepared = expected => Object.values(optimizer.metadata.optimized).some(entry =>
          entry.id.split(/\\s*>\\s*/).at(-1) === expected.id && entry.src.startsWith(expected.packageRoot));
        // Vite 8's depsOptimizer.run() returns void and schedules the actual
        // bundle. Metadata can be replaced before every requested dependency
        // has been published, so wait for the complete owner set.
        const deadline = optimizerStartedAt + 60_000;
        while (
          (optimizer.metadata === previousMetadata || !expected.every(prepared)) &&
          errors.length === 0 &&
          Date.now() < deadline
        ) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const optimized = Object.values(optimizer.metadata.optimized);
        const optimizerState = {
          elapsedMs: Date.now() - optimizerStartedAt,
          completed: optimizer.metadata !== previousMetadata && expected.every(prepared),
          errors,
          optimized: optimized.map(({ id, src }) => ({ id, src })),
        };
        assert.deepEqual(warnings, [], 'every configured dependency must resolve from its installed owner');
        assert.notEqual(
          optimizer.metadata,
          previousMetadata,
          'actual optimizer did not publish completed metadata: ' + JSON.stringify(optimizerState),
        );
        for (const source of expected) {
          assert.ok(
            prepared(source),
            'actual optimizer did not prepare ' + JSON.stringify({ expected: source, ...optimizerState }),
          );
        }
        const loader = await server.transformRequest('/packages/physics-rapier3d/src/wasm-loader.ts');
        const browserLoaderPath = '/packages/physics-rapier3d/dist/wasm-browser.mjs';
        assert.ok(loader?.code.includes(browserLoaderPath),
          'the actual source facade must select the browser WASM runtime export');
        const browserLoader = await server.transformRequest(browserLoaderPath);
        assert.ok(browserLoader?.code.includes('/packages/physics-rapier3d/pkg/rapier.mjs'),
          'the selected browser runtime must resolve the package-owned Rapier payload');
        for (const module of [loader, browserLoader]) {
          assert.ok(!module.code.includes('@dimforge/rapier3d-compat'),
            'the actual browser loading chain must not resolve the unpatched npm backend');
          assert.ok(!module.code.includes('/physics-rapier3d/dist/native.mjs'),
            'the actual browser loading chain must not select the native Host runtime');
        }
        const payload = await server.transformRequest('/packages/physics-rapier3d/pkg/rapier.mjs');
        assert.ok(payload?.code.length > 0, 'Vite must serve the real embedded WASM module');
        if (!parity) assert.ok(!optimized.some(entry => entry.id.startsWith('three')), 'runtime owner must not prepare Parity');
        rows.push({ owner, optimizedCount: optimized.length });
      } finally {
        await server?.close();
        rmSync(cacheDir, { recursive: true, force: true });
      }
    }
    process.stdout.write(JSON.stringify(rows));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).length, 4);
});

test('Browser optimizer discovery uses explicit CLI files and conserves broad selection', () => {
  const owner = 'packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts';
  const nativeOwner =
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
  const program = `
    import { createVitest } from 'vitest/node';
    import { relative, sep } from 'node:path';
    const rows = [];
    for (const filters of ${JSON.stringify([[owner, nativeOwner], ['packages/runtime', owner], []])}) {
      process.argv = [process.execPath, process.cwd() + '/node_modules/vitest/vitest.mjs',
        'list', '--config', 'config/vitest.browser.config.ts', '--project=browser',
        '--filesOnly', '--testNamePattern', 'unused.browser.test.ts', ...filters];
      const ctx = await createVitest('test', {
        config: 'config/vitest.browser.config.ts', project: ['browser'], run: true, watch: false,
      });
      try {
        await ctx.globTestSpecifications(filters);
        const project = ctx.projects.find(project => project.config.browser.enabled);
        // The Browser optimizer calls this without the CLI filters. Exercise
        // that actual discovery path without initializing a Browser provider.
        const { testFiles } = await project.globTestFiles();
        rows.push(testFiles.map(file => relative(process.cwd(), file).split(sep).join('/')).sort());
      } finally { await ctx.close(); }
    }
    process.stdout.write(JSON.stringify(rows));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const [selected, mixed, all] = JSON.parse(result.stdout);
  assert.deepEqual(selected, [owner, nativeOwner].sort());
  const complete = [...browserTestFiles(), nativeOwner].sort();
  assert.deepEqual(mixed, complete, 'mixed selectors preserve full discovery');
  assert.deepEqual(all, complete, 'unfiltered discovery preserves the complete roster');
});

test('actual Vitest discovery matches every Engine browser owner and excludes external experiments', () => {
  const target =
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
  const discovery = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'list',
      '--config',
      'config/vitest.browser.config.ts',
      '--project=browser',
      '--filesOnly',
      '--json',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(discovery.status, 0, discovery.stderr);
  const files = JSON.parse(discovery.stdout).map(({ file }) =>
    relative(process.cwd(), file).split(sep).join('/'),
  );
  assert.deepEqual(files.sort(), [...browserTestFiles(), target].sort());
});

test('actual Vitest discovery refuses a browser test in the floating harness', () => {
  const harness = join(process.cwd(), '.forgeax-harness');
  mkdirSync(harness, { recursive: true });
  const directory = mkdtempSync(join(harness, 'browser-discovery-regression-'));
  const target = relative(process.cwd(), join(directory, 'probe.browser.test.ts'));
  try {
    writeFileSync(target, "import { it } from 'vitest'; it('harness experiment', () => {});\n");
    const discovery = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'list',
        '--config',
        'config/vitest.browser.config.ts',
        '--project=browser',
        target,
        '--filesOnly',
        '--json',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    assert.deepEqual(JSON.parse(discovery.stdout), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('file-only discovery does not consume renderer input publications', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-browser-discovery-'));
  const missingManifest = join(directory, 'missing-renderer-inputs.json');
  try {
    const discovery = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'list',
        '--config',
        'config/vitest.browser.config.ts',
        '--project=browser',
        '--filesOnly',
        '--json',
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, FORGEAX_SHARED_APP_INPUTS_MANIFEST: missingManifest },
      },
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    const files = JSON.parse(discovery.stdout).map(({ file }) =>
      relative(process.cwd(), file).split(sep).join('/'),
    );
    const target =
      'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
    assert.deepEqual(files.sort(), [...browserTestFiles(), target].sort());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('actual Browser execution still consumes renderer input publications', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-browser-execution-'));
  const missingManifest = join(directory, 'missing-renderer-inputs.json');
  try {
    const execution = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'config/vitest.browser.config.ts',
        '--project=browser',
        'packages/app/__tests__/thin-wrapper.browser.test.ts',
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, FORGEAX_SHARED_APP_INPUTS_MANIFEST: missingManifest },
      },
    );
    assert.equal(execution.status, 1, execution.stderr);
    assert.ok(execution.stderr.includes(missingManifest), execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
