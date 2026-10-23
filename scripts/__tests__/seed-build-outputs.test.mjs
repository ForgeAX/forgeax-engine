import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { newestBuiltWorktree, seedBuildOutputs } from '../seed-build-outputs.mjs';

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

test('seeds ignored build outputs and receipts from a built sibling without replacing local state', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'forgeax-seed-build-outputs-')));
  const source = join(base, 'built');
  const target = join(base, 'fresh');
  try {
    mkdirSync(source);
    git(source, 'init', '-q');
    write(join(source, '.gitignore'), 'dist/\npkg/\nnode_modules/\n.wasm-build/\n');
    write(join(source, 'packages/a/src/index.ts'), 'export {};\n');
    write(join(source, 'packages/b/src/index.ts'), 'export {};\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'init');
    git(source, 'worktree', 'add', '-q', '--detach', target);

    write(join(source, 'packages/a/dist/index.mjs'), 'built a');
    write(join(source, 'packages/a/pkg/a.wasm'), 'wasm');
    write(join(source, 'packages/a/.wasm-build/scratch'), 'rust scratch');
    write(join(source, 'packages/a/node_modules/dep/index.js'), 'installed');
    write(join(source, 'packages/b/dist/index.mjs'), 'built b');
    write(join(source, 'node_modules/.cache/forgeax-build/summary.json'), '{}');
    write(join(target, 'packages/b/dist/index.mjs'), 'local b');

    assert.equal(newestBuiltWorktree(target), source);
    const result = seedBuildOutputs({ root: target, from: source, log: () => {} });

    assert.deepEqual(result.copied, [
      'node_modules/.cache/forgeax-build',
      'packages/a/dist',
      'packages/a/pkg',
    ]);
    assert.deepEqual(result.kept, ['packages/b/dist']);
    assert.equal(readFileSync(join(target, 'packages/a/dist/index.mjs'), 'utf8'), 'built a');
    assert.equal(readFileSync(join(target, 'packages/b/dist/index.mjs'), 'utf8'), 'local b');
    assert.ok(existsSync(join(target, 'node_modules/.cache/forgeax-build/summary.json')));
    assert.ok(!existsSync(join(target, 'packages/a/.wasm-build')));
    assert.ok(!existsSync(join(target, 'packages/a/node_modules')));
    assert.throws(() => seedBuildOutputs({ root: target, from: target, log: () => {} }));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
