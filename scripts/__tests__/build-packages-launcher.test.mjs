import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('package build reuses the owning pnpm entry without a pnpm executable on PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-package-launch-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    // This dependency-free fixture tests the lifecycle launcher, without pnpm
    // treating the deliberately absent node_modules tree as an install request.
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n  - 'apps/*'\nverifyDepsBeforeRun: false\nshellEmulator: true\n",
    );
    const pkg = join(root, 'packages/probe');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-launch-probe',
        scripts: { build: 'node build.mjs' },
      }),
    );
    writeFileSync(
      join(pkg, 'build.mjs'),
      "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist');\nwriteFileSync('dist/marker', 'built through pnpm');\n",
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../build-packages.mjs', import.meta.url))],
      {
        cwd: root,
        env: {
          ...env,
          PATH: dirname(process.execPath),
          FORGEAX_REPO_ROOT: root,
          FORGEAX_BUILD_NO_TASK_CACHE: '1',
          FORGEAX_PACKAGE_BUILD_RUNNER: 'pnpm',
        },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(join(pkg, 'dist/marker'), 'utf8'), 'built through pnpm');
    const app = join(root, 'apps/probe');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@forgeax/app-launch-probe',
        scripts: { typecheck: 'node check.mjs' },
      }),
    );
    writeFileSync(
      join(app, 'check.mjs'),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('checked', 'checked through pnpm');\nprocess.exit(Number(process.env.PROBE_CHECK_EXIT));\n",
    );
    for (const exit of [0, 7]) {
      const checked = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../typecheck-apps.mjs', import.meta.url))],
        {
          cwd: root,
          env: { ...env, PATH: dirname(process.execPath), PROBE_CHECK_EXIT: String(exit) },
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      assert.equal(checked.status, exit === 0 ? 0 : 1, `${checked.stdout}\n${checked.stderr}`);
      if (exit !== 0)
        assert.match(`${checked.stdout}\n${checked.stderr}`, /(?:exit code|Exit status) 7/);
      assert.equal(readFileSync(join(app, 'checked'), 'utf8'), 'checked through pnpm');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
