import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('../check-no-binary-assets.mjs', import.meta.url));

function repositoryWith(name, bytes) {
  const cwd = mkdtempSync(join(tmpdir(), 'forgeax-no-binary-'));
  execFileSync('git', ['init', '--quiet'], { cwd });
  writeFileSync(join(cwd, name), bytes);
  execFileSync('git', ['add', name], { cwd });
  return cwd;
}

test('accepts tracked ASCII FBX source', () => {
  const cwd = repositoryWith('fixture.fbx', '; FBX 7.4.0 project file\nObjects: {}\n');
  const result = spawnSync(process.execPath, [gate], { cwd, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /zero binaries tracked/);
});

test('rejects tracked binary FBX source', () => {
  const cwd = repositoryWith(
    'fixture.fbx',
    Buffer.from([0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0, 1]),
  );
  const result = spawnSync(process.execPath, [gate], { cwd, encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /banned binary extension \.fbx/);
});
