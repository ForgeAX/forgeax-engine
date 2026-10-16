import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ENGINE_ROOT = resolve(import.meta.dirname, '../..', '..');

function runPackageBuild(stage) {
  // Every build mode executes the same canonical-kit staging recovery. The
  // package mode preserves that real path without compiling unrelated shaders.
  return spawnSync('pnpm', ['build:packages'], {
    cwd: ENGINE_ROOT,
    env: {
      ...process.env,
      FORGEAX_SKIP_HARNESS_SYNC: '1',
      FORGEAX_CANONICAL_KIT_OUTPUT: stage,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('engine build recovers canonical-kit staging after package cache hits', () => {
  const stage = mkdtempSync(join(tmpdir(), 'forgeax-canonical-kit-stage-'));
  try {
    const first = runPackageBuild(stage);
    assert.equal(
      first.status,
      0,
      `first build failed\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`,
    );
    const source = readFileSync(join(stage, 'sky.hdr'));
    const meta = readFileSync(join(stage, 'sky.hdr.meta.json'));
    assert.ok(source.byteLength > 0);
    assert.ok(meta.byteLength > 0);

    unlinkSync(join(stage, 'sky.hdr'));
    const second = runPackageBuild(stage);
    assert.equal(
      second.status,
      0,
      `recovery build failed\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`,
    );
    assert.deepEqual(readFileSync(join(stage, 'sky.hdr')), source);
    assert.deepEqual(readFileSync(join(stage, 'sky.hdr.meta.json')), meta);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
