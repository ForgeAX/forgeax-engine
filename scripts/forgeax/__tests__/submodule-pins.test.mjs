import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const checker = resolve('scripts/forgeax/check_submodule_pins.py');

test('every tracked source gitlink requires its maintained submodule declaration', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-pin-declaration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Pin fixture');
  git('config', 'user.email', 'pins@example.invalid');
  writeFileSync(join(root, 'source.txt'), 'source\n');
  git('add', 'source.txt');
  git('commit', '-qm', 'source');
  git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},tools/view`);
  git('commit', '-qm', 'source pin without declaration');

  for (const declaration of [
    undefined,
    '',
    '[submodule "other"]\npath = other\nurl = other.git\n',
  ]) {
    if (declaration !== undefined) writeFileSync(join(root, '.gitmodules'), declaration);
    const result = spawnSync('python3', [checker, '--repo', root], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /tools\/view/);
    assert.match(result.stdout + result.stderr, /missing its \.gitmodules declaration/);
  }
});

test('gitless source retains its CLI boundary even inside another repository', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-pin-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'sdk-source');
  mkdirSync(source);
  const check = () => spawnSync('python3', [checker, '--repo', source], { encoding: 'utf8' });
  let result = check();
  assert.equal(
    result.status,
    2,
    'Standalone gitless source retains the CLI not-a-repository error',
  );
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Pin fixture');
  git('config', 'user.email', 'pins@example.invalid');
  writeFileSync(join(root, 'source.txt'), 'parent source\n');
  git('add', 'source.txt');
  git('commit', '-qm', 'parent source');
  git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},foreign/view`);
  git('commit', '-qm', 'parent source pin');
  result = check();
  assert.equal(result.status, 2, result.stdout + result.stderr);
  writeFileSync(
    join(source, '.gitmodules'),
    '[submodule "view"]\npath = tools/view\nurl = view.git\n',
  );
  result = check();
  assert.equal(result.status, 2, 'Declared pins without an owned repository must fail closed');
});
