import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROBE_ENTRY_FAST, PROBE_ENTRY_FRESH, PROBE_ENTRY_INDEX } from '../../../../../packages/render/src/raytracing/probe-entry.ts';

test('the shared probe entry transport retains flags and all 30 index bits', () => {
  assert.equal(PROBE_ENTRY_INDEX, 0x3fffffff);
  for (const flags of [0, PROBE_ENTRY_FAST, PROBE_ENTRY_FRESH, PROBE_ENTRY_FAST | PROBE_ENTRY_FRESH]) {
    for (const index of [0, 1, 31, 32, PROBE_ENTRY_INDEX])
      assert.equal((flags | index) & PROBE_ENTRY_INDEX, index);
  }
});

test('actual CLI module graph reaches invalid-tape decoding before backend installation', (t) => {
  t.diagnostic(`CLI host ${process.version} (${process.execPath})`);
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-gi-inspect-'));
  const input = join(directory, 'invalid.rhitape');
  const output = join(directory, 'inspection.json');
  writeFileSync(input, new Uint8Array(8));
  try {
    // gi-inspect decodes this truncated container before installDawn,
    // requestAdapter or requestDevice; imports must not create a device.
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL('../gi-inspect.mjs', import.meta.url)), input, output,
    ], { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /tape-invalid/);
    assert.doesNotMatch(child.stderr, /ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/);
    assert.equal(existsSync(output), false);
  } finally {
    unlinkSync(input);
    if (existsSync(output)) unlinkSync(output);
    rmdirSync(directory);
  }
});
