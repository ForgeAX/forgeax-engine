import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const scriptPath = new URL('../check-pack-browser-entry.mjs', import.meta.url);

async function runWithEntry(source) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-browser-entry-'));
  await mkdir(join(root, 'packages/pack/dist'), { recursive: true });
  await writeFile(join(root, 'packages/pack/dist/index.mjs'), source);
  return spawnSync('node', [scriptPath, '--root', root], { encoding: 'utf8' });
}

test('Pack root entry rejects Node crypto dependencies', async () => {
  const result = await runWithEntry("import { createHash } from 'node:crypto';");
  assert.equal(result.status, 1);
});
