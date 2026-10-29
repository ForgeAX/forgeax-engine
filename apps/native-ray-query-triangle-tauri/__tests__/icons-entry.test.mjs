import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('real icon CLI enters through a native file path and preserves the owning manager', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'forgeax tauri entry '));
  try {
    const manager = resolve(fixture, 'pnpm.mjs');
    const receipt = resolve(fixture, 'receipt.json');
    writeFileSync(manager, `import {writeFileSync} from 'node:fs';writeFileSync(process.env.FORGEAX_ICON_ENTRY_RECEIPT,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));`);
    const entry = fileURLToPath(new URL('../scripts/generate-icons.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [entry], {
      env: { ...process.env, npm_execpath: manager, FORGEAX_ICON_ENTRY_RECEIPT: receipt },
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const recorded = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.deepEqual(recorded.args.slice(0, 3), ['exec', 'tauri', 'icon']);
    assert.equal(recorded.args.length, 4);
    assert.match(readFileSync(recorded.args[3], 'utf8'), /^<svg /);
    assert.equal(recorded.cwd, fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, ''));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
