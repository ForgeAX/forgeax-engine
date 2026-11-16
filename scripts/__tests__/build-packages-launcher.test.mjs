import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('the package launcher forwards an admitted Assets export to the Content lifecycle', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-content-source-launch-'));
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', EXPECTED_PRODUCT_SHA: '' };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Source test');
    git(root, 'config', 'user.email', 'source@example.invalid');
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\nverifyDepsBeforeRun: false\nshellEmulator: true\n",
    );
    const remote = join(root, 'source');
    mkdirSync(remote);
    git(remote, 'init', '-q');
    git(remote, 'config', 'user.name', 'Source test');
    git(remote, 'config', 'user.email', 'source@example.invalid');
    git(remote, 'config', 'core.autocrlf', 'false');
    mkdirSync(join(remote, 'water'));
    const original = join(process.cwd(), 'packages/content/assets/water');
    const provenance = JSON.parse(readFileSync(join(original, 'provenance.json'), 'utf8'));
    for (const { file } of provenance.files)
      writeFileSync(join(remote, 'water', file), readFileSync(join(original, file)));
    git(remote, 'add', '.');
    git(remote, 'commit', '-qm', 'original Water sources');
    git(root, 'submodule', 'add', remote, 'forgeax-engine-assets');
    const pkg = join(root, 'packages/content');
    mkdirSync(join(pkg, 'assets/water'), { recursive: true });
    writeFileSync(join(pkg, 'assets/water/provenance.json'), JSON.stringify(provenance));
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-content',
        scripts: { build: 'node build.mjs' },
      }),
    );
    // Launcher isolation control; the real Content preparation runs before this child.
    writeFileSync(
      join(pkg, 'build.mjs'),
      "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('dist'); writeFileSync('dist/args', JSON.stringify(process.argv.slice(2)));\n",
    );
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'Content lifecycle fixture');
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../build-packages.mjs', import.meta.url)),
        '--target=@forgeax/engine-content',
        '--assets-source-root',
        remote,
      ],
      {
        cwd: root,
        env: { ...env, FORGEAX_REPO_ROOT: root, FORGEAX_PACKAGE_BUILD_RUNNER: 'pnpm' },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(join(pkg, 'dist/args'), 'utf8')), [
      '--source-root',
      join(remote, 'water'),
    ]);
    assert.deepEqual(
      readFileSync(join(pkg, 'assets/water', provenance.files[0].file)),
      readFileSync(join(original, provenance.files[0].file)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clean package build waits for a declared development compiler', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-package-compiler-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"private":true}');
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\nverifyDepsBeforeRun: false\nshellEmulator: true\n",
    );
    for (const [name, manifest, source] of [
      [
        'compiler',
        {},
        "await new Promise(resolve => setTimeout(resolve, 100)); writeFileSync('dist/program', 'compiled');",
      ],
      [
        'consumer',
        {
          devDependencies: { '@forgeax/compiler': 'workspace:*' },
          forgeax: { buildDependencies: ['@forgeax/compiler'] },
        },
        "writeFileSync('dist/program', readFileSync('../compiler/dist/program'));",
      ],
    ]) {
      const directory = join(root, 'packages', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name: `@forgeax/${name}`,
          scripts: { build: 'node build.mjs' },
          ...manifest,
        }),
      );
      writeFileSync(
        join(directory, 'build.mjs'),
        `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'; mkdirSync('dist', {recursive:true}); ${source}\n`,
      );
    }
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../build-packages.mjs', import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          FORGEAX_REPO_ROOT: root,
          FORGEAX_BUILD_NO_TASK_CACHE: '1',
          FORGEAX_PACKAGE_BUILD_CONCURRENCY: '2',
          FORGEAX_PACKAGE_BUILD_RUNNER: 'pnpm',
        },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(join(root, 'packages/consumer/dist/program'), 'utf8'), 'compiled');
    const consumer = JSON.parse(readFileSync(join(root, 'packages/consumer/package.json'), 'utf8'));
    assert.equal(consumer.dependencies, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nightly package build keeps the pnpm launcher context', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../../.github/workflows/nightly.yml', import.meta.url)),
    'utf8',
  );
  const step = workflow.match(/ {6}- name: Build \(\.mjs[^\n]*\n(?:(?! {6}- name: ).*\n)*/)?.[0];
  assert.ok(step, 'nightly package build step is present');
  assert.match(step, /pnpm exec node scripts\/build-packages\.mjs/);
});

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
