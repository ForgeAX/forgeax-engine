import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('both normal consumer CLIs reject an outer lease before preparing or installing inputs', () => {
  for (const file of ['verify-sdk.mjs', 'check-sdk-npm-consumer.mjs']) {
    assert.throws(
      () =>
        execFileSync(process.execPath, [fileURLToPath(new URL(`../${file}`, import.meta.url))], {
          env: { ...process.env, FORGEAX_LOCAL_GPU_LEASE: '1', FORGEAX_LOCAL_GPU_LEASE_HELD: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        }),
      /sdk-outer-gpu-lease-forbidden/,
    );
  }
});
