import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const workflowPaths = ['ci.yml', 'native-ray-query.yml'];
const viewPinCommand = 'git submodule update --init --depth=1 -- tools/view';
const viewPinAction = 'uses: ./.github/actions/prepare-view-checkout';

test('root workspace installation admits the tracked View revision, not a cached View manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-view-pin-'));
  const env = {
    ...process.env,
    GIT_ALLOW_PROTOCOL: 'file',
    FORGEAX_PACKAGE_BUILD_CONCURRENCY: '1',
    FORGEAX_SHADER_COMPILE_WORKERS: '1',
    CARGO_BUILD_JOBS: '1',
  };
  const run = (cwd, command, args) =>
    spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const checked = (cwd, command, args) => {
    const result = run(cwd, command, args);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (cwd, ...args) => checked(cwd, 'git', args);
  const pnpm = (cwd, frozen) =>
    run(cwd, 'pnpm', [
      'install',
      '--offline',
      '--ignore-scripts',
      ...(frozen ? ['--frozen-lockfile'] : ['--no-frozen-lockfile']),
    ]);
  try {
    const source = join(root, 'view-source');
    const engine = join(root, 'engine');
    for (const path of [source, engine]) {
      git(root, 'init', '-q', path);
      git(path, 'config', 'user.name', 'View pin regression');
      git(path, 'config', 'user.email', 'view-pin@example.invalid');
    }
    const manifest = (specifier) =>
      JSON.stringify({
        name: '@fixture/view-components',
        private: true,
        version: '0.0.0',
        devDependencies: { react: specifier, 'react-dom': specifier },
      });
    mkdirSync(join(source, 'packages/view-components'), { recursive: true });
    const componentManifest = (base) => join(base, 'packages/view-components/package.json');
    writeFileSync(join(source, '.gitignore'), 'node_modules/\n');
    writeFileSync(componentManifest(source), manifest('^19.1.0'));
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'Pinned View manifest');
    const pin = git(source, 'rev-parse', 'HEAD');
    writeFileSync(componentManifest(source), manifest('^19.2.8'));
    git(source, 'commit', '-qam', 'Newer unrelated View manifest');
    const newer = git(source, 'rev-parse', 'HEAD');
    writeFileSync(
      join(engine, 'package.json'),
      JSON.stringify({ name: 'view-pin-fixture', private: true, packageManager: 'pnpm@11.7.0' }),
    );
    writeFileSync(join(engine, '.gitignore'), 'node_modules/\n');
    // Only manifest admission is under test; local workspace dependencies keep
    // real pnpm installs deterministic and independent of registry availability.
    for (const name of ['react', 'react-dom']) {
      const directory = join(engine, 'fixture-packages', name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '19.1.0' }));
    }
    writeFileSync(
      join(engine, 'pnpm-workspace.yaml'),
      "packages:\n  - 'tools/view/packages/*'\n  - 'fixture-packages/*'\nlinkWorkspacePackages: true\npreferWorkspacePackages: true\n",
    );
    git(engine, 'submodule', 'add', '-q', source, 'tools/view');
    const view = join(engine, 'tools/view');
    git(view, 'checkout', '-q', pin);
    const install = pnpm(engine, false);
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    git(engine, 'add', '.');
    git(engine, 'commit', '-qm', 'Fixed Engine consumer inputs');
    const engineHead = git(engine, 'rev-parse', 'HEAD');
    const lock = readFileSync(join(engine, 'pnpm-lock.yaml'));

    git(view, 'checkout', '-q', newer);
    const red = pnpm(engine, true);
    assert.notEqual(red.status, 0);
    assert.match(red.stdout + red.stderr, /ERR_PNPM_OUTDATED_LOCKFILE/);
    assert.equal(git(engine, 'rev-parse', 'HEAD'), engineHead);
    assert.deepEqual(readFileSync(join(engine, 'pnpm-lock.yaml')), lock);

    const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const producer = workflow.split('\n  shared-app-inputs:\n')[1].split(/\n(?= {2}[\w-]+:\n)/)[0];
    const pinAt = producer.indexOf(viewPinAction);
    assert.ok(
      pinAt >= 0 &&
        pinAt < producer.indexOf('node scripts/ci/prepare-pnpm-workspace.mjs --install'),
      'shared producer must admit its View gitlink before workspace installation',
    );
    checked(engine, 'git', ['submodule', 'update', '--init', '--depth=1', '--', 'tools/view']);
    assert.equal(git(view, 'rev-parse', 'HEAD'), pin);
    assert.equal(readFileSync(componentManifest(view), 'utf8'), manifest('^19.1.0'));
    const green = pnpm(engine, true);
    assert.equal(green.status, 0, `${green.stdout}\n${green.stderr}`);
    assert.equal(git(engine, 'rev-parse', 'HEAD'), engineHead);
    assert.deepEqual(readFileSync(join(engine, 'pnpm-lock.yaml')), lock);

    git(view, 'checkout', '-q', newer);
    const work = `${manifest('^19.2.8')}\n`;
    writeFileSync(componentManifest(view), work);
    const refusal = run(engine, 'git', [
      'submodule',
      'update',
      '--init',
      '--depth=1',
      '--',
      'tools/view',
    ]);
    assert.notEqual(refusal.status, 0, 'ordinary checkout must preserve an overlapping local edit');
    assert.equal(git(view, 'rev-parse', 'HEAD'), newer);
    assert.equal(readFileSync(componentManifest(view), 'utf8'), work);
    assert.equal(git(engine, 'rev-parse', 'HEAD'), engineHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every root frozen install restores the View pin unless that job already checks out its exact View source', () => {
  for (const path of workflowPaths) {
    const workflow = readFileSync(resolve('.github/workflows', path), 'utf8');
    for (const job of workflow.split(/\n(?= {2}[\w-]+:\n)/)) {
      const install = job.search(
        /run: (?:pnpm install --frozen-lockfile|node scripts\/ci\/prepare-pnpm-workspace\.mjs --install)/,
      );
      if (install < 0) continue;
      const before = job.slice(0, install);
      assert.ok(
        before.includes(viewPinAction) ||
          before.includes(viewPinCommand) ||
          (before.includes('git rev-parse HEAD:tools/view') && before.includes('path: tools/view')),
        `${path}: ${job.slice(0, job.indexOf('\n'))} must admit the View pin before pnpm discovers its workspace`,
      );
    }
  }
});
