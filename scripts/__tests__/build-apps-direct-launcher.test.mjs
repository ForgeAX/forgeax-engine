import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appPackages } from '../build-task-cache.mjs';
import {
  createPrebuildInvocation,
  createViteBuildInvocation,
  resolveViteCli,
  validateCanonicalAppBuild,
  validateCanonicalAppBuilds,
} from '../lib/app-build-launcher.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('resolves the installed Vite CLI from the repository package manifest', () => {
  const cliPath = resolveViteCli(repoRoot);
  assert.equal(cliPath, realpathSync(resolve(repoRoot, 'node_modules/vite/bin/vite.js')));
  assert.equal(existsSync(cliPath), true);
});

test('the discovered app fleet uses the canonical Vite build script', () => {
  const apps = appPackages(repoRoot);
  assert.ok(apps.length > 0, 'canonical validation must cover a non-empty app fleet');
  validateCanonicalAppBuilds(apps);
});

test('rejects an app build script outside the canonical fleet contract', () => {
  assert.throws(
    () =>
      validateCanonicalAppBuild({ manifest: { name: '@fixture/app', scripts: { build: 'true' } } }),
    /unsupported build script for @fixture\/app: expected "vite build", received "true"/,
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
      FORGEAX_BUILD_METRICS_DIR: '/tmp/facts',
    },
  });
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
