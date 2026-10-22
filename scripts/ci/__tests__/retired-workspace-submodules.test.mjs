import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pnpmCommand } from '../../lib/pnpm-command.mjs';

const script = resolve('scripts/ci/prepare-pnpm-workspace.mjs');
const packageManager = JSON.parse(readFileSync('package.json', 'utf8')).packageManager;

function fixture(t, lockfile = false) {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-retired-workspace-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'product');
  const source = join(directory, 'source');
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  for (const path of [root, source]) {
    mkdirSync(path);
    git(path, 'init', '-q');
    git(path, 'config', 'user.name', 'CI fixture');
    git(path, 'config', 'user.email', 'ci@example.invalid');
    git(path, 'config', 'submodule.recurse', 'false');
  }
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: '@fixture/retired',
      version: '0.0.0',
      dependencies: { '@fixture/root': 'workspace:*' },
    }),
  );
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'workspace source');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@fixture/root',
      version: '0.0.0',
      private: true,
      packageManager,
    }),
  );
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  const pnpm = (...args) => {
    const [command, ...prefix] = pnpmCommand();
    return spawnSync(command, [...prefix, ...args], { cwd: root, env, encoding: 'utf8' });
  };
  if (lockfile) {
    const result = pnpm('install', '--lockfile-only', '--ignore-scripts');
    assert.equal(result.status, 0, result.stderr);
  }
  git(root, 'add', '.');
  git(
    root,
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${git(source, 'rev-parse', 'HEAD')},tools/view`,
  );
  git(root, 'commit', '-qm', 'target source without retired workspace');
  const target = git(root, 'rev-parse', 'HEAD');
  git(root, 'submodule', 'add', '--quiet', '--name', 'legacy-owner', source, 'packages/retired');
  git(root, 'commit', '-qm', 'previous source with workspace submodule');
  const previous = git(root, 'rev-parse', 'HEAD');
  git(root, 'clean', '-ffdx');
  git(root, 'checkout', '--detach', target);
  const checkout = join(root, 'packages', 'retired');
  assert.ok(existsSync(join(checkout, 'package.json')));
  const metadata = resolve(root, git(root, 'rev-parse', '--git-path', 'modules/legacy-owner'));
  const prepare = (args = [], overrides = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...env, GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: root, ...overrides },
      encoding: 'utf8',
    });
  return { root, source, git, target, previous, checkout, metadata, prepare, pnpm };
}

test('frozen CI install removes an owned retired submodule after switching source', (t) => {
  const f = fixture(t, true);
  const lock = readFileSync(join(f.root, 'pnpm-lock.yaml'));
  const failed = f.pnpm('install', '--frozen-lockfile', '--ignore-scripts');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout + failed.stderr, /ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER/);
  const recovered = f.prepare(['--install']);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.match(recovered.stderr, /removed retired workspace submodule path=packages\/retired/);
  assert.equal(existsSync(f.checkout), false);
  assert.ok(existsSync(join(f.metadata, 'config')));
  assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), f.target);
  assert.deepEqual(readFileSync(join(f.root, 'pnpm-lock.yaml')), lock);
  const repeated = f.prepare(['--install']);
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  assert.doesNotMatch(repeated.stderr, /removed retired workspace submodule/);
});

test('preserves local workspaces and a different Actions workspace', (t) => {
  const f = fixture(t);
  for (const overrides of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_WORKSPACE: f.source }]) {
    const result = f.prepare([], overrides);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(f.checkout, 'package.json')));
  }
});

test('frozen CI install removes a retired gitlink materialized by an independent checkout', (t) => {
  const f = fixture(t, true);
  const lock = readFileSync(join(f.root, 'pnpm-lock.yaml'));
  rmSync(f.checkout, { recursive: true });
  f.git(f.root, 'clone', '--quiet', f.source, f.checkout);
  f.git(f.root, 'config', '--remove-section', 'submodule.legacy-owner');
  rmSync(resolve(f.root, f.git(f.root, 'rev-parse', '--git-path', 'modules')), { recursive: true });
  const failed = f.pnpm('install', '--frozen-lockfile', '--ignore-scripts');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout + failed.stderr, /ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER/);
  const recovered = f.prepare(['--install']);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(existsSync(f.checkout), false);
  assert.deepEqual(readFileSync(join(f.root, 'pnpm-lock.yaml')), lock);
  assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), f.target);
});

test('preserves an unrelated nested repository with no historical gitlink', (t) => {
  const f = fixture(t);
  const unrelated = join(f.root, 'packages', 'unrelated');
  f.git(f.root, 'clone', '--quiet', f.source, unrelated);
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(unrelated, 'package.json')));
});

test('preserves a retired checkout whose commit no longer matches a historical gitlink', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, 'new-source.txt'), 'independent source\n');
  f.git(
    f.checkout,
    '-c',
    'user.name=CI fixture',
    '-c',
    'user.email=ci@example.invalid',
    'add',
    'new-source.txt',
  );
  f.git(
    f.checkout,
    '-c',
    'user.name=CI fixture',
    '-c',
    'user.email=ci@example.invalid',
    'commit',
    '-qm',
    'independent source change',
  );
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.checkout, 'new-source.txt')));
});

test('preserves a submodule still tracked by the target source', (t) => {
  const f = fixture(t);
  f.git(f.root, 'checkout', '--detach', f.previous);
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.checkout, 'package.json')));
});

test('preserves a former submodule path replaced with tracked ordinary source', (t) => {
  const f = fixture(t);
  const blob = f.git(f.root, 'hash-object', '-w', join(f.checkout, 'package.json'));
  f.git(
    f.root,
    'update-index',
    '--add',
    '--cacheinfo',
    `100644,${blob},packages/retired/package.json`,
  );
  f.git(f.root, 'commit', '-qm', 'expanded tracked package source');
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.checkout, 'package.json')));
});

test('preserves checkouts using foreign Git metadata', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, '.git'), `gitdir: ${join(f.source, '.git')}\n`);
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.checkout, 'package.json')));
  assert.ok(existsSync(join(f.source, 'package.json')));
});

test('preserves a retired checkout outside the Actions root', (t) => {
  const f = fixture(t);
  f.git(f.root, 'config', '--file', join(f.metadata, 'config'), 'core.worktree', f.source);
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.checkout, 'package.json')));
  assert.ok(existsSync(join(f.source, 'package.json')));
});

test('preserves a retired checkout symlink that escapes the Actions root', {
  skip: process.platform === 'win32',
}, (t) => {
  const f = fixture(t);
  rmSync(f.checkout, { recursive: true });
  symlinkSync(f.source, f.checkout, 'dir');
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.source, 'package.json')));
});
