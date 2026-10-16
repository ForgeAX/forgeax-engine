import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertPortableRustArtifact, portableRustFlags } from '../rust-build-paths.mjs';

test('canonical Rust flags cover source, Cargo, toolchain and home roots as separate encoded arguments', () => {
  const home = resolve('builder fixture');
  const engine = resolve(home, 'engine source');
  const flags = portableRustFlags(engine, { CARGO_HOME: resolve('cargo cache') }, home).split(
    '\x1f',
  );
  for (const [root, destination] of [
    [home, '/build/user'],
    [engine, '/src/engine'],
    [resolve('cargo cache'), '/cargo'],
    [resolve(home, '.rustup'), '/rust-toolchain'],
  ])
    assert.ok(flags.includes(`--remap-path-prefix=${root}=${destination}`));
  assert.ok(flags.every((flag) => flag.startsWith('--remap-path-prefix=')));
  assert.ok(
    flags.indexOf(`--remap-path-prefix=${engine}=/src/engine`) >
      flags.indexOf(`--remap-path-prefix=${home}=/build/user`),
  );
});

test('unowned Rust flag overrides cannot silently disable the canonical recipe', () => {
  for (const name of [
    'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS',
    'CARGO_BUILD_RUSTFLAGS',
    'CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS',
  ])
    assert.throws(() => portableRustFlags('.', { [name]: '-g' }), /recipe overrides/);
});

test('all Rust artifact bytes are checked, including panic paths in data rather than debug sections', () => {
  for (const prefix of [
    ['', 'home'],
    ['', 'data', 'home'],
    ['', 'Users'],
    ['C:', 'Users'],
  ]) {
    const path = [...prefix, 'sample-builder', 'registry', 'source.rs'].join('/');
    assert.throws(
      () => assertPortableRustArtifact(Buffer.from(`\x00asm\x01\x00data:${path}`)),
      /machine-path/,
    );
  }
  assertPortableRustArtifact(
    Buffer.from('/src/engine/lib.rs\x00/cargo/registry/source.rs\x00/build/user/file'),
  );
});
