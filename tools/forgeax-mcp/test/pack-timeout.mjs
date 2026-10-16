import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/bridge.mjs';

const root = await mkdtemp(join(tmpdir(), 'forgeax-codex-pack-timeout-'));
try {
  const canonicalRoot = await realpath(root);
  const sourcePath = join(canonicalRoot, 'stalled.pack.ts');
  await writeFile(sourcePath, 'while (true) {}\n');
  const started = Date.now();
  const result = await dispatch(undefined, canonicalRoot, 'asset.inspect', { subject: sourcePath });
  const elapsedMs = Date.now() - started;
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, 'pack-inspect-timeout', JSON.stringify(result));
  assert.ok(elapsedMs >= 4_500 && elapsedMs < 10_000, `inspection took ${elapsedMs} ms`);
  console.log(JSON.stringify({ code: result.error.code, elapsedMs }));
} finally {
  await rm(root, { recursive: true, force: true });
}
