import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolvePackagedExecutable } from '../scripts/packaged-executable.mjs';

test('resolves a macOS bundle from CARGO_TARGET_DIR', () => {
  const appRoot = mkdtempSync(resolve(tmpdir(), 'forgeax-ray-query-artifact-'));
  const target = resolve(appRoot, '.cargo-target/native-ray-query');
  const executable = resolve(
    target,
    'release/bundle/macos/ForgeaX Native Ray Query Triangle.app/Contents/MacOS/forgeax-native-ray-query-triangle',
  );
  mkdirSync(resolve(executable, '..'), { recursive: true });
  writeFileSync(executable, '');

  assert.equal(
    resolvePackagedExecutable({
      appRoot,
      cargoTargetDir: target,
      platform: 'darwin',
    }),
    executable,
  );
});

test('preserves the local src-tauri target default', () => {
  const appRoot = '/workspace/app';
  assert.equal(
    resolvePackagedExecutable({ appRoot, platform: 'win32' }),
    '/workspace/app/src-tauri/target/release/forgeax-native-ray-query-triangle.exe',
  );
});
