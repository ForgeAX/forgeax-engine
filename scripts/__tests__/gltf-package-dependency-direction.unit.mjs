import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('glTF package graph declares production import edge and test-only runtime edges', async () => {
  const { stdout } = await run('node', [
    'scripts/check-material-package-dependency-direction.mjs',
    '--scope',
    'gltf',
  ]);
  assert.match(stdout, /gltf OK/);
});
