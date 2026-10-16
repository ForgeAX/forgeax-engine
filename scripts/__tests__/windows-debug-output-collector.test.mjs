import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('Windows debug collector drains descendants before a subsequent collection', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, () => {
  const script = fileURLToPath(
    new URL(
      '../../packages/rhi-wgpu-native/scripts/test-debug-output-collector.ps1',
      import.meta.url,
    ),
  );
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 25000,
    },
  );
  assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.match(result.stdout, /PASS: followed child output is drained/);
});
