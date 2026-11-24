import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
    write(join(source, '.gitignore'), 'dist/\npkg/\nnode_modules/\n.wasm-build/\ntarget/\n');
    write(join(source, 'packages/a/src/index.ts'), 'export {};\n');
    write(join(source, 'packages/a/Cargo.toml'), '[package]\nname="seeded_a"\nversion="0.0.0"\n');
    write(join(source, 'packages/a/src/lib.rs'), 'pub fn seeded() {}\n');
    write(join(source, 'packages/b/src/index.ts'), 'export {};\n');
    write(
      join(source, 'packages/b/native/Cargo.toml'),
      '[package]\nname="seeded_b"\nversion="0.0.0"\n',
    );
    write(join(source, 'packages/b/native/src/lib.rs'), 'pub fn seeded() {}\n');
    write(join(source, 'packages/plain/src/index.ts'), 'export {};\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'init');
    git(source, 'worktree', 'add', '-q', '--detach', target);

    write(join(source, 'packages/a/dist/index.mjs'), 'built a');
    write(join(source, 'packages/a/pkg/a.wasm'), 'wasm');
    write(join(source, 'packages/a/.wasm-build/scratch'), 'rust scratch');
    write(join(source, 'packages/a/target/debug/scratch'), 'standard Cargo scratch');
    write(join(source, 'packages/b/native/target/debug/scratch'), 'nested Cargo scratch');
    write(join(source, 'packages/plain/target/published.bin'), 'non-Rust producer output');
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
      'packages/plain/target',
    ]);
    assert.deepEqual(result.kept, ['packages/b/dist']);
    assert.equal(readFileSync(join(target, 'packages/a/dist/index.mjs'), 'utf8'), 'built a');
    assert.equal(readFileSync(join(target, 'packages/b/dist/index.mjs'), 'utf8'), 'local b');
    assert.ok(existsSync(join(target, 'node_modules/.cache/forgeax-build/summary.json')));
    assert.ok(!existsSync(join(target, 'packages/a/.wasm-build')));
    assert.ok(!existsSync(join(target, 'packages/a/node_modules')));
    assert.ok(!existsSync(join(target, 'packages/a/target')));
    assert.ok(!existsSync(join(target, 'packages/b/native/target')));
    assert.equal(
      readFileSync(join(target, 'packages/plain/target/published.bin'), 'utf8'),
      'non-Rust producer output',
    );
    assert.throws(() => seedBuildOutputs({ root: target, from: target, log: () => {} }));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('whole ignored apps exclude nested mutable installs and Rust scratch without following links', () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'forgeax-seed-nested-')));
  const source = join(base, 'built');
  const target = join(base, 'fresh');
  const external = join(base, 'other-worktree-dependencies');
  try {
    mkdirSync(source);
    git(source, 'init', '-q');
    write(join(source, '.gitignore'), 'apps/generated/\nnode_modules/\n');
    write(join(source, 'entry.txt'), 'tracked');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'init');
    git(source, 'worktree', 'add', '-q', '--detach', target);
    write(join(source, 'node_modules/.cache/forgeax-build/summary.json'), '{}');
    write(join(source, 'node_modules/.cache/forgeax-build/nested/node_modules/mutable'), 'install');
    write(join(source, 'apps/generated/dist/asset.bin'), 'valid output');
    write(join(source, 'apps/generated/nested/.git/private'), 'private Git state');
    write(join(source, 'apps/generated/nested/.wasm-build/scratch'), 'toolchain scratch');
    write(join(source, 'apps/generated/nested/rust/Cargo.toml'), '[package]\n');
    write(join(source, 'apps/generated/nested/rust/target/debug/scratch'), 'Rust scratch');
    write(join(source, 'apps/generated/nested/plain/target/asset.bin'), 'valid non-Rust output');
    write(join(external, 'mutable.txt'), 'do not share or modify');
    mkdirSync(join(source, 'apps/generated/nested/node_modules'), { recursive: true });
    const link = join(source, 'apps/generated/nested/node_modules/foreign');
    symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    const originalLink = readlinkSync(link);
    seedBuildOutputs({ root: target, from: source, log: () => {} });
    assert.equal(
      readFileSync(join(target, 'apps/generated/dist/asset.bin'), 'utf8'),
      'valid output',
    );
    for (const relative of ['node_modules', '.git', '.wasm-build', 'rust/target'])
      assert.ok(!existsSync(join(target, 'apps/generated/nested', relative)), relative);
    assert.ok(!existsSync(join(target, 'node_modules/.cache/forgeax-build/nested/node_modules')));
    assert.equal(
      readFileSync(join(target, 'apps/generated/nested/plain/target/asset.bin'), 'utf8'),
      'valid non-Rust output',
    );
    assert.equal(readlinkSync(link), originalLink);
    assert.equal(readFileSync(join(external, 'mutable.txt'), 'utf8'), 'do not share or modify');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
