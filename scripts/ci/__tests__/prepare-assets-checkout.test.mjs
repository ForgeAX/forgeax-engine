import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { submoduleGitEnvironment } from '../submodule-git-environment.mjs';

test('already-forwarded checkout authorization is propagated once to actual Git config', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-assets-authorization-'));
  const authorization = 'AUTHORIZATION: fixture-only';
  const key = 'http.https://github.com/.extraheader';
  const changedKeys = [
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
  ];
  const before = Object.fromEntries(changedKeys.map((name) => [name, process.env[name]]));
  const git = (args, env = process.env) =>
    spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' });
  const read = (env) => {
    const actual = git(['config', '--get-all', key], env);
    assert.equal(actual.status, 0, actual.stderr);
    return actual.stdout.trimEnd().split('\n');
  };
  // Git's extraheader list is reset by an empty value. Preserve the raw list
  // witness; main's cold HTTP owner independently checks the sent header count.
  const effective = (values) =>
    values.reduce((headers, value) => (value === '' ? [] : [...headers, value]), []);
  try {
    const emptyGlobal = join(root, 'empty-global-config');
    writeFileSync(emptyGlobal, '');
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: key,
      GIT_CONFIG_VALUE_0: authorization,
      GIT_CONFIG_GLOBAL: emptyGlobal,
      GIT_CONFIG_NOSYSTEM: '1',
    });
    assert.equal(git(['init', '-q']).status, 0);
    writeFileSync(
      join(root, '.gitmodules'),
      '[submodule "forgeax-engine-assets"]\n path = forgeax-engine-assets\n url = https://github.com/ForgeAX/forgeax-engine-assets.git\n',
    );
    const environment = { ...process.env };
    const duplicate = {
      ...environment,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: key,
      GIT_CONFIG_VALUE_1: authorization,
    };
    assert.equal(
      read(duplicate).filter((value) => value === authorization).length,
      2,
      'old double-injection path exposes duplicate header values',
    );
    assert.equal(effective(read(duplicate)).length, 2);
    const actual = submoduleGitEnvironment(root, 'forgeax-engine-assets');
    assert.equal(actual.GIT_CONFIG_COUNT, '3');
    assert.deepEqual(read(actual), [authorization, '', authorization]);
    assert.deepEqual(effective(read(actual)), [authorization]);
    assert.deepEqual(
      { ...process.env },
      environment,
      'central helper must not mutate caller environment',
    );

    // A different existing Git option is preserved while the parent credential
    // is sourced from the real checkout's Git configuration.
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.abbrev',
      GIT_CONFIG_VALUE_0: '12',
    });
    assert.equal(git(['config', key, authorization]).status, 0);
    const unrelated = { ...process.env };
    const appended = submoduleGitEnvironment(root, 'forgeax-engine-assets');
    assert.equal(appended.GIT_CONFIG_KEY_0, 'core.abbrev');
    assert.equal(appended.GIT_CONFIG_VALUE_0, '12');
    assert.equal(appended.GIT_CONFIG_COUNT, '3');
    assert.deepEqual(effective(read(appended)), [authorization]);
    assert.deepEqual({ ...process.env }, unrelated);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const script = resolve('scripts/ci/prepare-assets-checkout.mjs');
test('CI asset consumers use recoverable hydration while math benchmarks remain asset-free', () => {
  for (const path of ['ci.yml', 'sdk-pr-preflight.yml', 'ci-focus.yml']) {
    const workflow = readFileSync(resolve('.github/workflows', path), 'utf8');
    assert.doesNotMatch(workflow, /^\s+submodules: (?:recursive|true)$/m);
    const jobs = workflow.split(/\n(?= {2}[a-zA-Z0-9_-]+:\n)/);
    for (const job of jobs.filter((block) =>
      block.includes('node scripts/ci/prepare-assets-checkout.mjs'),
    )) {
      const preparation = job.indexOf('node scripts/ci/prepare-assets-checkout.mjs');
      const checkout = job.indexOf('actions/checkout@v5');
      const node = job.search(/actions\/setup-node@|\.github\/actions\/setup-node-pnpm/);
      assert.ok(checkout >= 0 && checkout < node);
      assert.ok(node >= 0 && node < preparation);
      const install = job.indexOf('pnpm install');
      if (install !== -1) assert.ok(preparation < install);
    }
  }
  const bench = readFileSync(resolve('.github/workflows/bench.yml'), 'utf8');
  assert.match(bench, /submodules: false/);
  assert.doesNotMatch(bench, /prepare-assets-checkout/);
  assert.match(bench, /pnpm -F @forgeax\/engine-math bench:json/);
});

test('shared producer prepares the pinned submodule after source checkout and before install', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const job = workflow.split('\n  shared-app-inputs:\n')[1].split(/\n(?= {2}[a-zA-Z0-9_-]+:\n)/)[0];
  assert.match(
    job,
    /actions\/checkout@v5[\s\S]*?ref: \$\{\{ env.EXPECTED_PRODUCT_SHA \}\}[\s\S]*?submodules: false/,
  );
  const preparation = job.indexOf('node scripts/ci/prepare-assets-checkout.mjs');
  assert.ok(preparation > job.indexOf('actions/checkout@v5'));
  assert.ok(preparation < job.indexOf('node scripts/ci/prepare-pnpm-workspace.mjs --install'));
});

test('primary CI prepares every pinned private submodule before reachability checks', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const job = workflow.split('\n  primary-pnpm:\n')[1].split(/\n(?= {2}[a-zA-Z0-9_-]+:\n)/)[0];
  const checkout = job.indexOf('actions/checkout@v5');
  const assets = job.indexOf('node scripts/ci/prepare-assets-checkout.mjs');
  const wgpu = job.indexOf('node scripts/ci/prepare-source-checkout.mjs');
  const reachability = job.indexOf('Submodule pin reachability');
  assert.ok(checkout >= 0);
  assert.ok(assets > checkout);
  assert.ok(wgpu > assets);
  assert.ok(reachability > wgpu);
});

test('repairs a broken submodule HEAD using the pinned local object and verifies exact bytes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgeax-assets-checkout-')));
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', EXPECTED_PRODUCT_SHA: '' };
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
    const source = join(root, 'source');
    const parent = join(root, 'parent');
    init(source);
    init(parent);
    writeFileSync(join(source, 'asset.txt'), 'pinned asset bytes\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'asset');
    const expected = git(source, 'rev-parse', 'HEAD');
    git(parent, 'submodule', 'add', source, 'forgeax-engine-assets');
    git(parent, 'commit', '-qam', 'pin');
    const assets = join(parent, 'forgeax-engine-assets');
    git(assets, 'symbolic-ref', 'HEAD', 'refs/heads/missing');
    const red = spawnSync('git', ['submodule', 'update', '--init', '--force', '--recursive'], {
      cwd: parent,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(red.status, 0);
    assert.match(red.stderr, /Unable to find current revision|Needed a single revision/);
    const repaired = spawnSync(process.execPath, [script], { cwd: parent, env, encoding: 'utf8' });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.deepEqual(JSON.parse(repaired.stdout), {
      path: 'forgeax-engine-assets',
      expected,
      actual: expected,
      repaired: true,
    });
    assert.equal(readFileSync(join(assets, 'asset.txt'), 'utf8'), 'pinned asset bytes\n');
    const healthy = spawnSync(process.execPath, [script], { cwd: parent, env, encoding: 'utf8' });
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.equal(JSON.parse(healthy.stdout).repaired, false);

    git(assets, 'symbolic-ref', 'HEAD', 'refs/heads/missing-again');
    const objectPath = git(
      assets,
      'rev-parse',
      '--git-path',
      `objects/${expected.slice(0, 2)}/${expected.slice(2)}`,
    );
    rmSync(resolve(assets, objectPath));
    // A cancelled fetch leaves shallow.lock in reused runner metadata. Local
    // preparation must preserve it; the next exclusive Actions checkout can
    // recover a lock that predates its own source checkout.
    const lock = join(parent, '.git/modules/forgeax-engine-assets/shallow.lock');
    writeFileSync(lock, '');
    utimesSync(lock, new Date(0), new Date(0));
    const localLocked = spawnSync(process.execPath, [script], {
      cwd: parent,
      env: { ...env, GITHUB_ACTIONS: '' },
      encoding: 'utf8',
    });
    assert.notEqual(localLocked.status, 0);
    assert.match(localLocked.stderr, /shallow.lock/);
    assert.equal(existsSync(lock), true);
    const actionsEnv = { ...env, GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: parent };
    const newer = new Date(Date.now() + 60_000);
    utimesSync(lock, newer, newer);
    const currentLocked = spawnSync(process.execPath, [script], {
      cwd: parent,
      env: actionsEnv,
      encoding: 'utf8',
    });
    assert.notEqual(currentLocked.status, 0);
    assert.equal(existsSync(lock), true, 'current-job locks must survive');
    utimesSync(lock, new Date(0), new Date(0));
    const foreignWorkspace = spawnSync(process.execPath, [script], {
      cwd: parent,
      env: { ...actionsEnv, GITHUB_WORKSPACE: source },
      encoding: 'utf8',
    });
    assert.notEqual(foreignWorkspace.status, 0);
    assert.equal(existsSync(lock), true, 'another workspace cannot clear this lock');
    const fetched = spawnSync(process.execPath, [script], {
      cwd: parent,
      env: actionsEnv,
      encoding: 'utf8',
    });
    assert.equal(fetched.status, 0, fetched.stderr);
    assert.equal(JSON.parse(fetched.stdout).actual, expected);
    assert.equal(JSON.parse(fetched.stdout).repaired, true);
    assert.equal(readFileSync(join(assets, 'asset.txt'), 'utf8'), 'pinned asset bytes\n');

    git(parent, 'submodule', 'deinit', '--force', '--', 'forgeax-engine-assets');
    const cold = spawnSync(process.execPath, [script], { cwd: parent, env, encoding: 'utf8' });
    assert.equal(cold.status, 0, cold.stderr);
    assert.equal(JSON.parse(cold.stdout).actual, expected);
    assert.equal(readFileSync(join(assets, 'asset.txt'), 'utf8'), 'pinned asset bytes\n');
    writeFileSync(join(assets, '.git'), `gitdir: ${join(source, '.git')}\n`);
    const foreign = spawnSync(process.execPath, [script], { cwd: parent, env, encoding: 'utf8' });
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /refusing foreign submodule Git directory/);
    assert.equal(git(source, 'rev-parse', 'HEAD'), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
