import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { submoduleGitEnvironment } from '../submodule-git-environment.mjs';

test('an exact exported asset tree preserves the shared dirty checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-assets-export-'));
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', EXPECTED_PRODUCT_SHA: '' };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const init = (directory) => {
    mkdirSync(directory, { recursive: true });
    git(directory, 'init', '-q');
    git(directory, 'config', 'user.name', 'Source test');
    git(directory, 'config', 'user.email', 'source@example.invalid');
    git(directory, 'config', 'core.autocrlf', 'false');
  };
  try {
    const remote = join(root, 'remote');
    const parent = join(root, 'parent');
    const exported = join(root, 'export');
    init(remote);
    init(parent);
    const files = {
      'README.md': 'Pinned asset library\n',
      'textures/noise.txt': 'pinned texture source\n',
      'meshes/cube.txt': 'pinned mesh source\n',
    };
    for (const [file, bytes] of Object.entries(files)) {
      for (const directory of [remote, exported]) {
        mkdirSync(dirname(resolve(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), bytes);
      }
    }
    git(remote, 'add', '.');
    git(remote, 'commit', '-qm', 'original asset tree');
    const pin = git(remote, 'rev-parse', 'HEAD');
    git(parent, 'submodule', 'add', remote, 'forgeax-engine-assets');
    git(parent, 'add', '.');
    git(parent, 'commit', '-qm', 'pinned asset source');
    const shared = join(parent, 'forgeax-engine-assets');
    git(shared, 'rm', '-r', 'textures');
    git(
      shared,
      '-c',
      'user.name=Source test',
      '-c',
      'user.email=source@example.invalid',
      'commit',
      '-qm',
      'different active shared checkout',
    );
    writeFileSync(join(shared, 'user-baseline.png'), 'unrelated dirty baseline');
    git(shared, 'add', 'user-baseline.png');
    writeFileSync(join(shared, 'user-baseline.png'), 'preserved user working bytes');
    const head = git(shared, 'rev-parse', 'HEAD');
    const index = readFileSync(join(git(shared, 'rev-parse', '--absolute-git-dir'), 'index'));
    // Export admission fetches the pin without changing the active checkout or index.
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/ci/prepare-assets-checkout.mjs'), '--source-root', exported],
      { cwd: parent, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).expected, pin);
    assert.equal(JSON.parse(result.stdout).actual, pin);
    assert.equal(git(shared, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(
      readFileSync(join(git(shared, 'rev-parse', '--absolute-git-dir'), 'index')),
      index,
    );
    assert.equal(
      readFileSync(join(shared, 'user-baseline.png'), 'utf8'),
      'preserved user working bytes',
    );
    assert.equal(existsSync(join(parent, 'packages/content')), false);
    for (const [file, bytes] of Object.entries(files)) {
      writeFileSync(join(exported, file), 'changed source');
      const rejected = spawnSync(
        process.execPath,
        [resolve('scripts/ci/prepare-assets-checkout.mjs'), '--source-root', exported],
        { cwd: parent, env, encoding: 'utf8' },
      );
      assert.equal(rejected.status, 1, rejected.stdout);
      assert.match(rejected.stderr, /exported source mismatch/);
      writeFileSync(join(exported, file), bytes);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
test('Native GI hydrates the pinned asset sources before every fresh Engine package build', () => {
  const workflow = parse(readFileSync(resolve('.github/workflows/native-ray-query.yml'), 'utf8'));
  const job = workflow.jobs['native-node-gi'];
  const steps = job.steps;
  const checkout = steps.find((step) => step.uses === 'actions/checkout@v5');
  assert.equal(checkout.with.submodules, false);
  const prepare = steps.findIndex(
    (step) => step.run?.trim() === 'node scripts/ci/prepare-assets-checkout.mjs',
  );
  const node = steps.findIndex((step) => step.uses === './.github/actions/setup-node-pnpm');
  const install = steps.findIndex((step) => step.name === 'Install workspace dependencies');
  const build = steps.findIndex((step) => step.name === 'Build engine packages');
  assert.ok(prepare > node && prepare > install && prepare < build);
  assert.equal(steps[prepare].if, "steps.ci-repair.outputs.reused != 'true'");
  assert.equal(steps[prepare].if, steps[build].if);
  assert.equal(
    steps[build].run,
    "pnpm --filter './packages/*' --workspace-concurrency=16 run build",
  );
  assert.deepEqual(
    job.strategy.matrix.include.map(({ group }) => group),
    ['foundation', 'mutation', 'gather'],
  );
});

test('Bun rebuild hydrates pinned assets before input recovery and its uncached package build', () => {
  const workflow = parse(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'));
  const steps = workflow.jobs['portability-bun'].steps;
  const checkout = steps.find((step) => step.uses === 'actions/checkout@v5');
  assert.equal(checkout.with.submodules, false);
  const node = steps.findIndex((step) => step.uses === './.github/actions/setup-node-pnpm');
  const prepare = steps.findIndex(
    (step) => step.run?.trim() === 'node scripts/ci/prepare-assets-checkout.mjs',
  );
  const recover = steps.findIndex((step) => step.uses === './.github/actions/prepare-ci-inputs');
  const build = steps.findIndex((step) => step.name === 'Bun topological package build');
  assert.ok(prepare > node, 'fresh Bun builds must prepare the pinned asset source');
  assert.ok(prepare < recover && prepare < build);
  assert.equal(steps[prepare].if, "steps.ci-repair.outputs.reused != 'true'");
  assert.equal(steps[prepare].if, steps[build].if);
  assert.equal(steps[build].env.FORGEAX_PACKAGE_BUILD_RUNNER, 'bun');
  assert.equal(steps[build].env.FORGEAX_BUILD_NO_TASK_CACHE, '1');
  assert.equal(steps[build].run, 'node scripts/build-packages.mjs');
});

test('ci-core prepares exact asset inputs for a clean checkout without submodules before package build', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const job = workflow.split('\n  core-build:\n')[1].split(/\n(?= {2}[a-zA-Z0-9_-]+:\n)/)[0];
  const preparation = job.indexOf('node scripts/ci/prepare-assets-checkout.mjs');
  assert.ok(preparation > job.indexOf('./.github/actions/setup-node-pnpm'));
  assert.ok(
    preparation <
      job.indexOf("pnpm --filter './packages/**' -r --workspace-concurrency=4 --if-present build"),
  );

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgeax-core-asset-inputs-')));
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
    git(path, 'config', 'core.autocrlf', 'false');
  };
  try {
    const source = join(root, 'source');
    const parent = join(root, 'parent');
    const checkout = join(root, 'checkout');
    init(source);
    init(parent);
    mkdirSync(join(source, 'textures'), { recursive: true });
    writeFileSync(join(source, '.gitattributes'), '*.txt -text\n');
    writeFileSync(join(source, 'README.md'), 'Pinned asset library\n');
    writeFileSync(join(source, 'textures/checker.txt'), 'pinned checker source\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'exact asset source');
    const expected = git(source, 'rev-parse', 'HEAD');
    git(parent, 'submodule', 'add', source, 'forgeax-engine-assets');
    git(parent, 'add', '.');
    git(parent, 'commit', '-qm', 'source with pinned asset inputs');
    git(root, '-c', 'core.autocrlf=false', 'clone', '--no-recurse-submodules', parent, checkout);
    const output = join(checkout, 'forgeax-engine-assets');
    assert.equal(existsSync(join(output, 'textures/checker.txt')), false);
    const prepared = spawnSync(process.execPath, [script], {
      cwd: checkout,
      env,
      encoding: 'utf8',
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).actual, expected);
    assert.equal(git(output, 'rev-parse', 'HEAD'), expected);
    assert.equal(
      readFileSync(join(output, 'textures/checker.txt'), 'utf8'),
      'pinned checker source\n',
    );
    assert.equal(existsSync(join(checkout, 'packages/content')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CI asset consumers use recoverable hydration', () => {
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
});

test('combined Core producer prepares the pinned submodule before install', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const job = workflow.split('\n  core-build:\n')[1].split(/\n(?= {2}[a-zA-Z0-9_-]+:\n)/)[0];
  assert.match(
    job,
    /actions\/checkout@v5[\s\S]*?ref: \$\{\{ env.EXPECTED_PRODUCT_SHA \}\}[\s\S]*?submodules: false/,
  );
  const preparation = job.indexOf('node scripts/ci/prepare-assets-checkout.mjs');
  assert.ok(preparation > job.indexOf('actions/checkout@v5'));
  assert.ok(preparation < job.indexOf('node scripts/ci/prepare-pnpm-workspace.mjs --install'));
});

test('Bun portability restores the pinned assets before its frozen workspace install', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const job = workflow.split('\n  portability-bun:\n')[1].split(/\n(?= {2}[a-zA-Z0-9_-]+:\n)/)[0];
  const preparation = job.indexOf('node scripts/ci/prepare-assets-checkout.mjs');
  assert.ok(preparation > job.indexOf('actions/checkout@v5'));
  assert.ok(preparation < job.indexOf('bun install --frozen-lockfile'));
  assert.match(
    job,
    /if: steps\.ci-repair\.outputs\.reused != 'true'\s+run: node scripts\/ci\/prepare-assets-checkout\.mjs/,
  );
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
    git(path, 'config', 'core.autocrlf', 'false');
  };
  try {
    const source = join(root, 'source');
    const parent = join(root, 'parent');
    init(source);
    init(parent);
    writeFileSync(join(source, 'asset.txt'), 'pinned asset bytes\n');
    writeFileSync(join(source, '.gitattributes'), 'asset.txt -text\n');
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
    rmSync(join(assets, '.git'));
    writeFileSync(join(assets, '.git'), `gitdir: ${join(source, '.git')}\n`);
    const foreign = spawnSync(process.execPath, [script], { cwd: parent, env, encoding: 'utf8' });
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /refusing foreign submodule Git directory/);
    assert.equal(git(source, 'rev-parse', 'HEAD'), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
