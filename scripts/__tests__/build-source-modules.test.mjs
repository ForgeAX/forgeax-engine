import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('scripts/build.mjs');

test('build fails fast with one actionable line when the modeling submodule is missing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-build-source-modules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, '--engine'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /build-source-module-missing: modeling submodule missing: run bun fx setup/,
  );
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find/);
});
