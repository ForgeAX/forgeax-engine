import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { main as prepareInputs } from '../prepare-ci-inputs.mjs';

const script = resolve(import.meta.dirname, '../prepare-source-checkout.mjs');

test('Source preparation restores the Engine pin without accessing unrelated private submodules', async (t) => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'forgeax-wgpu-checkout-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const source = resolve(temporary, 'source');
  const root = resolve(temporary, 'engine');
  for (const path of [source, root]) {
    git(temporary, 'init', '-q', path);
    git(path, 'config', 'user.name', 'CI test');
    git(path, 'config', 'user.email', 'ci@example.invalid');
  }
  writeFileSync(resolve(source, 'Cargo.toml'), '[package]\nname = "fixture"\n');
  writeFileSync(resolve(source, 'source.rs'), 'old source\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'source');
  const previous = git(source, 'rev-parse', 'HEAD');
  writeFileSync(resolve(source, 'source.rs'), 'pinned source\n');
  git(source, 'commit', '-qam', 'update source');
  const expected = git(source, 'rev-parse', 'HEAD');
  git(root, 'submodule', 'add', source, 'third_party/wgpu');
  git(root, 'submodule', 'add', source, 'third_party/blitz');
  git(root, 'config', '-f', '.gitmodules', 'submodule.assets.path', 'forgeax-engine-assets');
  git(
    root,
    'config',
    '-f',
    '.gitmodules',
    'submodule.assets.url',
    resolve(temporary, 'inaccessible-assets'),
  );
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${expected},forgeax-engine-assets`);
  git(root, 'add', '.gitmodules');
  git(root, 'commit', '-qm', 'pin');
  git(root, 'submodule', 'deinit', '--force', '--', 'third_party/wgpu');
  git(root, 'submodule', 'deinit', '--force', '--', 'third_party/blitz');
  writeFileSync(resolve(source, 'source.rs'), 'newer unselected source\n');
  git(source, 'commit', '-qam', 'advance upstream');
  for (let index = 0; index < 2; index += 1) {
    const result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { path: 'third_party/wgpu', commit: expected },
      { path: 'third_party/blitz', commit: expected },
    ]);
  }
  await t.test(
    'consumer preparation updates existing stale checkouts before admitting inputs',
    async () => {
      for (const path of ['third_party/wgpu', 'third_party/blitz']) {
        git(root, '-C', path, 'checkout', '--detach', previous);
        assert.ok(existsSync(resolve(root, path, 'Cargo.toml')));
      }
      mkdirSync(resolve(root, 'scripts/ci'), { recursive: true });
      writeFileSync(
        resolve(root, 'scripts/ci/build-artifact-contract.json'),
        JSON.stringify({ consumers: { fixture: { requiredArtifactClasses: ['engine-dist'] } } }),
      );
      const receipt = await prepareInputs(['--consumer', 'fixture', '--mode', 'restore'], {
        root,
        runCommand: async ([node, command, ...args], options) => {
          assert.equal(command, 'scripts/ci/prepare-source-checkout.mjs');
          const result = spawnSync(node, [script, ...args], { ...options, env, encoding: 'utf8' });
          return { status: result.status, failure: result.stderr };
        },
      });
      assert.equal(receipt.source, 'pending');
      for (const path of ['third_party/wgpu', 'third_party/blitz']) {
        assert.equal(git(root, '-C', path, 'rev-parse', 'HEAD'), expected);
      }
    },
  );
  assert.equal(existsSync(resolve(root, 'forgeax-engine-assets/.git')), false);
});
