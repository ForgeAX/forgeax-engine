import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

function fixture(t, missing) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-fbx-ready-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['packages/fbx/scripts/ensure-wasm.mjs', 'scripts/lib/ensure-wasm-lib.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(resolve(file), join(root, file));
  }
  for (const name of ['fbx-wasm.mjs', 'fbx-wasm.wasm']) {
    if (missing === 'all' || name === missing) continue;
    const path = join(root, 'packages/fbx/pkg', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'fixture payload');
  }
  const run = (...args) => spawnSync(process.execPath, ['packages/fbx/scripts/ensure-wasm.mjs', ...args], {
    cwd: root, env: { ...process.env, FORGEAX_SKIP_FBX_WASM_FETCH: '1' }, encoding: 'utf8',
  });
  return { root, run };
}

for (const missing of ['all', 'fbx-wasm.mjs', 'fbx-wasm.wasm', undefined]) {
  test(`FBX strict readiness rejects ${missing ?? 'no'} missing files`, (t) => {
    const f = fixture(t, missing);
    const result = f.run('--check');
    assert.equal(result.status, missing ? 1 : 0, result.stdout + result.stderr);
  });
}

for (const name of ['fbx-wasm.mjs', 'fbx-wasm.wasm']) {
  test(`FBX strict readiness rejects empty ${name}`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.root, 'packages/fbx/pkg', name), '');
    assert.equal(f.run('--check').status, 1);
  });
}

test('FBX best-effort install still succeeds when payload fetching is disabled', (t) => {
  const f = fixture(t, 'all');
  assert.equal(f.run().status, 0);
});
