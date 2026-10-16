import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

for (const requested of [undefined, '1']) {
  test(`acoustic native rejects missing admission before evidence creation (requested=${requested})`, () => {
    const output = resolve(tmpdir(), `roi22-no-admission-${process.pid}-${requested}`);
    const env = { ...process.env, FORGEAX_AUDIO_EVIDENCE: output };
    delete env.FORGEAX_LOCAL_GPU_LEASE;
    delete env.FORGEAX_LOCAL_GPU_LEASE_HELD;
    if (requested) env.FORGEAX_LOCAL_GPU_LEASE = requested;
    const result = spawnSync(process.execPath, ['packages/audio-webaudio/bench/acoustic/run.mjs'], {
      cwd: resolve(import.meta.dirname, '../..'),
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /local-gpu-lease\.mjs --timeout-ms 2700000/);
    assert.equal(existsSync(output), false);
  });
}
