import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

test('strict lint executes the package Node entry and preserves diagnostic failures', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'forgeax strict lint '));
  try {
    mkdirSync(resolve(root, 'scripts'));
    mkdirSync(resolve(root, 'node_modules/@biomejs/biome/bin'), { recursive: true });
    mkdirSync(resolve(root, 'node_modules/.bin'), { recursive: true });
    writeFileSync(resolve(root, 'package.json'), '{"type":"module"}');
    copyFileSync(resolve('scripts/lint-biome-strict.mjs'), resolve(root, 'scripts/lint.mjs'));
    writeFileSync(resolve(root, 'node_modules/.bin/biome'), '#!/bin/sh\nexit 99\n', {
      mode: 0o755,
    });
    for (const [infos, exit, expected] of [
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 1],
      [0, 7, 7],
    ]) {
      writeFileSync(
        resolve(root, 'node_modules/@biomejs/biome/bin/biome'),
        `
        if (JSON.stringify(process.argv.slice(2)) !== '["ci",".","--reporter=summary"]') process.exit(98);
        console.log('Found ${infos} infos.');
        process.exit(${exit});
      `,
      );
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/lint.mjs')], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, result.stderr);
      assert.match(result.stdout, new RegExp(`Found ${infos} infos`));
      if (infos > 0) assert.match(result.stderr, /info-level diagnostic/);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
