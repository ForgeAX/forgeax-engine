import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { imageKindSidecars } from '../lint/grep-image-kind-convergence.mjs';

test('sidecar lint finds nested violations and fails on unavailable roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax lint % '));
  try {
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const invalid = join(nested, 'invalid.meta.json');
    writeFileSync(invalid, '{"kind": "image"}');
    writeFileSync(join(root, 'valid.meta.json'), '{"kind":"texture"}');
    writeFileSync(join(root, 'ordinary.json'), '{"kind": "image"}');
    assert.deepEqual(imageKindSidecars([root]), [invalid]);
    assert.throws(() => imageKindSidecars([join(root, 'absent')]), { code: 'ENOENT' });
    rmSync(invalid);
    assert.deepEqual(imageKindSidecars([root]), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const script of [
  'lint/grep-error-hints.mjs',
  'lint/grep-runtime-catalog-routing.mjs',
  'grep/check-pack-schema-dist-fresh.mjs',
  'check-material-contract-inventory.mjs',
]) {
  test(`real source gate resolves repository paths: ${script}`, () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`../${script}`, import.meta.url))],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
