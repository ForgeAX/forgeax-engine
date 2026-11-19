import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { consumerInputConfig, consumerInputExternal } from '../build-app-inputs.mjs';
import { appPackages } from '../build-task-cache.mjs';
import {
  appBuildOutputMode,
  createAppBuildInvocation,
  createPrebuildInvocation,
  createViteBuildInvocation,
  resolveViteCli,
  validateCanonicalAppBuild,
  validateCanonicalAppBuilds,
} from '../lib/app-build-launcher.mjs';
import { runnerResources, shaderProducerHeapSize } from '../lib/runner-resources.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('input producers retain complete preview and project builds while full mode stays the default', () => {
  const app = { manifest: { scripts: { build: 'vite build' } } };
  assert.equal(appBuildOutputMode(app), 'full');
  assert.equal(appBuildOutputMode(app, true), 'consumer-inputs');
  assert.equal(
    appBuildOutputMode(
      { manifest: { ...app.manifest, forgeax: { smokeArtifacts: { preview: true } } } },
      true,
    ),
    'full',
  );
  const project = appPackages(repoRoot).find(
    ({ manifest }) => manifest.name === '@forgeax/app-vc-ue5',
  );
  assert.ok(project);
  assert.equal(appBuildOutputMode(project, true), 'full');
  const invocation = createAppBuildInvocation({
    app: { ...app, directory: '/tmp/fixture-app' },
    outputMode: 'consumer-inputs',
    baseEnv: { KEEP_ME: 'yes' },
  });
  assert.deepEqual(invocation.args, [resolve(repoRoot, 'scripts/build-app-inputs.mjs')]);
  assert.equal(invocation.options.env.KEEP_ME, 'yes');
  assert.equal(invocation.options.cwd, '/tmp/fixture-app');
});

test('input builds preserve authored Shader traversal and the original external policy', () => {
  const external = consumerInputExternal(['already-external', /^custom:/], '/repo/packages');
  for (const id of [
    '@forgeax/engine',
    '@forgeax/engine/render',
    '@forgeax/engine-render',
    '/repo/packages/render/dist/index.mjs',
    'already-external',
    'custom:module',
  ])
    assert.equal(external(id), true, id);
  for (const id of [
    './src/material.wgsl',
    '@forgeax/engine-shader/default-standard-pbr.wgsl?raw',
    '@forgeax/engine/package.json',
    '/repo/packages/engine/package.json',
    '/repo/packages/shader/src/pbr.wgsl',
    './src/scene.ts',
    '/repo/apps/shared/materials.ts',
  ])
    assert.equal(external(id), false, id);
  const calls = [];
  const delegated = consumerInputExternal((...args) => {
    calls.push(args);
    return args[0] === 'custom';
  });
  assert.equal(delegated('custom', 'importer', true), true);
  assert.deepEqual(calls, [['custom', 'importer', true]]);
});

test('program and execution hosts retain the complete Vite facade graph', async () => {
  for (const name of ['forgeax:execution-worker-entries', 'forgeax:plugin-programs']) {
    const config = {
      plugins: [false, Promise.resolve([{ name }])],
      build: { rollupOptions: { external: ['custom'] } },
    };
    assert.equal(await consumerInputConfig(config), config);
  }
  const config = {
    plugins: [{ name: 'forgeax:shader' }],
    build: { rollupOptions: { external: ['custom'] } },
  };
  const selected = await consumerInputConfig(config);
  assert.notEqual(selected, config);
  assert.equal(selected.build.rollupOptions.external('custom'), true);
  assert.equal(selected.build.rollupOptions.external('@forgeax/engine-render'), true);
  assert.equal(selected.build.rollupOptions.external('@forgeax/engine/package.json'), false);
});

test('resolves the installed Vite CLI from the repository package manifest', () => {
  const cliPath = resolveViteCli(repoRoot);
  assert.equal(cliPath, realpathSync(resolve(repoRoot, 'node_modules/vite/bin/vite.js')));
  assert.equal(existsSync(cliPath), true);
});

test('the discovered app fleet uses a supported direct build entrypoint', () => {
  const apps = appPackages(repoRoot);
  assert.ok(apps.length > 0, 'canonical validation must cover a non-empty app fleet');
  validateCanonicalAppBuilds(apps);
});

test('rejects an app build script outside the canonical fleet contract', () => {
  assert.throws(
    () =>
      validateCanonicalAppBuild({ manifest: { name: '@fixture/app', scripts: { build: 'true' } } }),
    /unsupported build script for @fixture\/app: expected "vite build" or "node \.\.\/\.\.\/\.\.\/scripts\/vite-app\.mjs build", received "true"/,
  );
});

test('build invocation preserves app cwd, explicit environment, and direct Node CLI shape', () => {
  const invocation = createViteBuildInvocation({
    app: { directory: '/tmp/fixture-app', manifest: { name: '@fixture/app' } },
    viteCliPath: '/repo/node_modules/vite/bin/vite.js',
    appFactsDir: '/tmp/facts',
    baseEnv: { KEEP_ME: 'yes', FORGEAX_SHARED_APP_INPUTS_MANIFEST: '/tmp/shared/manifest.json' },
  });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ['/repo/node_modules/vite/bin/vite.js', 'build']);
  assert.deepEqual(invocation.options, {
    cwd: '/tmp/fixture-app',
    stdio: 'inherit',
    shell: false,
    env: {
      KEEP_ME: 'yes',
      FORGEAX_SHARED_APP_INPUTS_MANIFEST: '/tmp/shared/manifest.json',
      NODE_OPTIONS: `--max-old-space-size=${shaderProducerHeapSize(runnerResources())}`,
      FORGEAX_BUILD_METRICS_DIR: '/tmp/facts',
    },
  });
});

test('launches the cloud project through its installed Engine CLI and preserves its worker policy', () => {
  const app = appPackages(repoRoot).find(({ manifest }) => manifest.name === '@forgeax/app-vc-ue5');
  assert.ok(app);
  const invocation = createAppBuildInvocation({
    app,
    baseEnv: { FORGEAX_SHARED_APP_INPUTS_MANIFEST: '/tmp/shared/manifest.json' },
  });
  assert.equal(invocation.command, process.execPath);
  assert.equal(
    invocation.args[0],
    realpathSync(resolve(repoRoot, 'packages/engine/dist/bin/forgeax.mjs')),
  );
  assert.deepEqual(invocation.args.slice(1), ['project', 'build']);
  assert.equal(invocation.options.cwd, app.directory);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(JSON.parse(invocation.options.env.FORGEAX_EXECUTION_WORKERS), {
    engine: false,
    render: false,
    kernels: false,
  });
  assert.equal(
    invocation.options.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST,
    '/tmp/shared/manifest.json',
  );
});

test('prebuild invocation preserves the package lifecycle before direct Vite builds', () => {
  assert.equal(
    createPrebuildInvocation({
      app: { directory: '/tmp/fixture-app', manifest: { scripts: { build: 'vite build' } } },
      baseEnv: { KEEP_ME: 'yes', npm_execpath: '/manager/pnpm.cjs' },
    }),
    null,
  );
  assert.deepEqual(
    createPrebuildInvocation({
      app: {
        directory: '/tmp/fixture-app',
        manifest: { scripts: { prebuild: 'node assets/gen-png.mjs' } },
      },
      baseEnv: { KEEP_ME: 'yes', npm_execpath: '/manager/pnpm.cjs' },
    }),
    {
      command: process.execPath,
      args: ['/manager/pnpm.cjs', 'run', 'prebuild'],
      options: {
        cwd: '/tmp/fixture-app',
        stdio: 'inherit',
        shell: false,
        env: { KEEP_ME: 'yes', npm_execpath: '/manager/pnpm.cjs' },
      },
    },
  );
});

test('real prebuild lifecycle preserves cwd, environment, assets and failure exit', async () => {
  const directory = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'forgeax prebuild % ')));
  assert.ok(
    process.env.npm_execpath || process.env.COREPACK_ROOT,
    'run lifecycle regression through pnpm exec',
  );
  try {
    writeFileSync(
      resolve(directory, 'package.json'),
      JSON.stringify({
        name: 'prebuild-transport',
        private: true,
        type: 'module',
        packageManager: JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
          .packageManager,
        scripts: { prebuild: 'node generate.mjs' },
      }),
    );
    writeFileSync(
      resolve(directory, 'generate.mjs'),
      `
      import {writeFileSync} from 'node:fs';
      writeFileSync('asset.json', JSON.stringify({cwd:process.cwd(),value:process.env.PREBUILD_VALUE}));
      process.exit(Number(process.env.PREBUILD_EXIT));
    `,
    );
    const app = { directory, manifest: { scripts: { prebuild: 'node generate.mjs' } } };
    for (const code of [0, 7]) {
      const invocation = createPrebuildInvocation({
        app,
        baseEnv: {
          ...process.env,
          PREBUILD_VALUE: 'retained % $ value',
          PREBUILD_EXIT: String(code),
        },
      });
      const result = spawnSync(invocation.command, invocation.args, {
        ...invocation.options,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, code, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(resolve(directory, 'asset.json'), 'utf8')), {
        cwd: directory,
        value: 'retained % $ value',
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
