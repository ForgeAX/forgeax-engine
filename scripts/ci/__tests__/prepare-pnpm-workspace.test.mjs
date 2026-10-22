import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pnpmCommand } from '../../lib/pnpm-command.mjs';
import { cleanRetiredModelingSubmoduleCheckout } from '../prepare-pnpm-workspace.mjs';

const script = resolve('scripts/ci/prepare-pnpm-workspace.mjs');

test('removes only an untracked retired Modeling submodule from its own CI workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-retired-modeling-checkout-'));
  const workspaceEnvironment = { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: root };
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };

  try {
    git('init', '-q');
    const modeling = join(root, 'packages/modeling');
    mkdirSync(modeling, { recursive: true });
    writeFileSync(join(modeling, '.git'), 'gitdir: ../../.git/modules/packages/modeling\n');
    writeFileSync(join(modeling, 'package.json'), '{"name":"retired-modeling"}\n');

    assert.equal(cleanRetiredModelingSubmoduleCheckout(root, workspaceEnvironment), true);
    assert.equal(existsSync(modeling), false);

    mkdirSync(modeling, { recursive: true });
    writeFileSync(join(modeling, 'package.json'), '{"name":"current-modeling"}\n');
    git('add', 'packages/modeling/package.json');
    git(
      'config',
      '--local',
      'submodule.packages/modeling.url',
      'https://example.invalid/modeling.git',
    );
    assert.equal(cleanRetiredModelingSubmoduleCheckout(root, workspaceEnvironment), false);
    assert.equal(existsSync(join(modeling, 'package.json')), true);

    assert.equal(
      cleanRetiredModelingSubmoduleCheckout(root, {
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: `${root}-different`,
      }),
      false,
    );
    assert.equal(existsSync(join(modeling, 'package.json')), true);

    git('rm', '--cached', 'packages/modeling/package.json');
    assert.equal(cleanRetiredModelingSubmoduleCheckout(root, workspaceEnvironment), true);
    assert.equal(existsSync(modeling), false);
    assert.notEqual(
      spawnSync('git', [
        '-C',
        root,
        'config',
        '--local',
        '--get',
        'submodule.packages/modeling.url',
      ]).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps the pinned View source and removes a stale uninitialized checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-pnpm-workspace-'));
  const source = join(root, 'source');
  const workspace = join(root, 'workspace');
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const init = (path) => {
    git(root, 'init', '-q', path);
    git(path, 'config', 'user.name', 'CI test');
    git(path, 'config', 'user.email', 'ci@example.invalid');
  };

  try {
    init(source);
    writeFileSync(join(source, 'package.json'), '{"peerDependencies":{"react":"^19.1.0"}}\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'pinned View source');
    const expected = git(source, 'rev-parse', 'HEAD');

    init(workspace);
    mkdirSync(join(workspace, 'tools'), { recursive: true });
    git(workspace, 'update-index', '--add', '--cacheinfo', `160000,${expected},tools/view`);
    git(workspace, 'commit', '--allow-empty', '-qm', 'pin View source');

    const view = join(workspace, 'tools', 'view');
    const clone = spawnSync('git', ['clone', '--quiet', source, view], { env, encoding: 'utf8' });
    assert.equal(clone.status, 0, clone.stderr);
    const pinned = spawnSync(process.execPath, [script], { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.deepEqual(JSON.parse(pinned.stdout), {
      path: 'tools/view',
      status: 'pinned',
      expected,
      actual: expected,
    });
    assert.match(readFileSync(join(view, 'package.json'), 'utf8'), /\^19\.1\.0/);

    writeFileSync(join(source, 'package.json'), '{"peerDependencies":{"react":"^19.2.8"}}\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'newer View source');
    const staleCommit = git(source, 'rev-parse', 'HEAD');
    git(view, 'fetch', 'origin');
    git(view, 'reset', '--hard', staleCommit);
    const stale = spawnSync(process.execPath, [script], { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(stale.status, 0, stale.stderr);
    assert.deepEqual(JSON.parse(stale.stdout), {
      path: 'tools/view',
      status: 'removed-stale-checkout',
      expected,
      actual: staleCommit,
    });
    assert.equal(existsSync(view), false);

    mkdirSync(view, { recursive: true });
    writeFileSync(join(view, 'package.json'), '{"peerDependencies":{"react":"^19.2.8"}}\n');
    const uninitialized = spawnSync(process.execPath, [script], {
      cwd: workspace,
      env,
      encoding: 'utf8',
    });
    assert.equal(uninitialized.status, 0, uninitialized.stderr);
    assert.equal(JSON.parse(uninitialized.stdout).status, 'removed-stale-checkout');
    assert.equal(existsSync(view), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CI install entrypoints clean stale workspace sources first', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const installs = workflow
    .split(/\r?\n/)
    .filter((line) => /\brun:\s.*\b(?:pnpm|bun) install --frozen-lockfile/.test(line));
  assert.ok(installs.length > 0);
  assert.ok(installs.every((line) => line.includes('scripts/ci/prepare-pnpm-workspace.mjs')));
  assert.doesNotMatch(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /node scripts\/ci\/prepare-pnpm-workspace\.mjs --install/);
  for (const path of ['sdk-pr-preflight.yml', 'bench.yml', 'ci-focus.yml']) {
    const consumer = readFileSync(`.github/workflows/${path}`, 'utf8');
    assert.doesNotMatch(consumer, /pnpm install --frozen-lockfile/);
    assert.match(consumer, /node scripts\/ci\/prepare-pnpm-workspace\.mjs --install/);
  }
  const nativeRayQuery = readFileSync('.github/workflows/native-ray-query.yml', 'utf8');
  assert.doesNotMatch(nativeRayQuery, /pnpm install --frozen-lockfile/);
  assert.equal(
    (nativeRayQuery.match(/node scripts\/ci\/prepare-pnpm-workspace\.mjs --install/g) ?? []).length,
    2,
    'both Native Ray Query workspaces must clean retired submodules before installing',
  );
});

test('ordinary CI installs only the current platform and never executes root lifecycle hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-ci-platform-install-'));
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const platforms = workflow.match(/^ {2}PNPM_CONFIG_SUPPORTED_ARCHITECTURES: '([^']+)'$/m)?.[1];
  const baselineEnvironment = { ...process.env };
  delete baselineEnvironment.PNPM_CONFIG_SUPPORTED_ARCHITECTURES;
  delete baselineEnvironment.pnpm_config_verify_deps_before_run;
  const ciEnvironment = { ...baselineEnvironment, PNPM_CONFIG_SUPPORTED_ARCHITECTURES: platforms };
  const foreign = process.platform === 'linux' ? 'darwin' : 'linux';
  const archives = new Map();
  const fetched = [];
  const server = createServer((request, response) => {
    fetched.push(request.url);
    const archive = archives.get(request.url);
    response.writeHead(archive ? 200 : 404);
    response.end(archive);
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const url = `http://127.0.0.1:${server.address().port}`;
  const execute = promisify(execFile);
  const [command, ...prefix] = pnpmCommand();
  const pnpm = (...args) =>
    execute(command, [...prefix, ...args], { cwd: root, env: baselineEnvironment });
  try {
    for (const [name, os] of [
      ['current-platform', process.platform],
      ['foreign-platform', foreign],
    ]) {
      const source = join(root, name, 'package');
      mkdirSync(source, { recursive: true });
      writeFileSync(
        join(source, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', os: [os], cpu: [process.arch] }),
      );
      const archive = join(root, `${name}.tgz`);
      await execute('tar', ['-czf', archive, '-C', join(root, name), 'package']);
      archives.set(`/${name}.tgz`, readFileSync(archive));
    }
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'ci-install-fixture',
        private: true,
        packageManager: JSON.parse(readFileSync(resolve('package.json'), 'utf8')).packageManager,
        scripts: {
          verify: 'node -e "require.resolve(\'current-platform/package.json\')"',
          postinstall: "node -e \"require('node:fs').writeFileSync('unexpected-hook', 'ran')\"",
        },
        optionalDependencies: {
          'current-platform': `${url}/current-platform.tgz`,
          'foreign-platform': `${url}/foreign-platform.tgz`,
        },
      }),
    );
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      `packages: []\nstoreDir: .store\nsupportedArchitectures:\n  os: [${process.platform}, ${foreign}]\n  cpu: [${process.arch}]\n`,
    );
    await pnpm('install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile');
    await pnpm('install', '--frozen-lockfile', '--ignore-scripts');
    assert.ok(
      existsSync(join(root, 'node_modules/foreign-platform')),
      'broad SDK policy must admit the foreign fixture',
    );
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    rmSync(join(root, '.store'), { recursive: true, force: true });
    fetched.length = 0;
    // Keep the local package server responsive while the real synchronous
    // installer runs in its ordinary child process.
    await execute(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { installPnpmWorkspace } from ${JSON.stringify(new URL('../prepare-pnpm-workspace.mjs', import.meta.url).href)}; const result = installPnpmWorkspace(); if (result.error) throw result.error; process.exit(result.status ?? 1);`,
      ],
      { cwd: root, env: ciEnvironment },
    );
    // pnpm 12 checks workspace policy before run/exec. A one-off install flag
    // must not cause those commands to reinstall the broad platform closure.
    await execute(command, [...prefix, 'exec', 'node', '-e', 'process.exit(0)'], {
      cwd: root,
      env: ciEnvironment,
    });
    await execute(command, [...prefix, 'run', 'verify'], { cwd: root, env: ciEnvironment });
    assert.ok(existsSync(join(root, 'node_modules/current-platform')));
    assert.equal(existsSync(join(root, 'node_modules/foreign-platform')), false);
    assert.equal(fetched.includes('/foreign-platform.tgz'), false);
    assert.equal(existsSync(join(root, 'unexpected-hook')), false);
    assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), lock);
  } finally {
    await new Promise((closed) => server.close(closed));
    rmSync(root, { recursive: true, force: true });
  }
});
