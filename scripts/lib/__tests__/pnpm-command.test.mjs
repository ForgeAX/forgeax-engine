import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pnpmCommand } from '../pnpm-command.mjs';

test('rejects an inherited npm or yarn entry instead of running workspace install with it', () => {
  for (const entry of ['/npm/npm-cli.js', '/yarn/yarn.js', 'C:\\npm\\npm-cli.js']) {
    assert.deepEqual(pnpmCommand({ npm_execpath: entry, COREPACK_ROOT: '/corepack' }), [
      process.execPath,
      join('/corepack', 'dist/pnpm.js'),
    ]);
  }
});

test('retains the owning pnpm entry including Windows and bundled executable paths', () => {
  for (const entry of ['/pnpm/pnpm.cjs', 'C:\\pnpm\\pnpm.cjs'])
    assert.deepEqual(pnpmCommand({ npm_execpath: entry }), [process.execPath, entry]);
  for (const entry of ['/bin/pnpm', '/corepack/pnpm-native', 'C:\\pnpm\\pnpm-native.exe'])
    assert.deepEqual(pnpmCommand({ npm_execpath: entry }), [entry]);
});
