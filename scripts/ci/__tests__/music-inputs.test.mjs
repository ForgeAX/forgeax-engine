import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { sourceHashes } from '../../../packages/audio-webaudio/bench/music/inputs.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('music admission fences current native provider files and their provenance', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-music-inputs-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    const relative = 'packages/dawn-node/dist/native/darwin-arm64/dawn.node';
    const provenance = 'packages/dawn-node/dist/native/darwin-arm64/provenance.json';
    await mkdir(resolve(root, 'packages/dawn-node/dist/native/darwin-arm64'), { recursive: true });
    await writeFile(resolve(root, relative), 'native-v1');
    await writeFile(resolve(root, provenance), '{}');
    const before = await sourceHashes(root);
    assert.equal(before[relative], digest('native-v1'));
    assert.equal(before[provenance], digest('{}'));
    await writeFile(resolve(root, relative), 'native-v2');
    await writeFile(resolve(root, provenance), '{"revision":2}');
    const after = await sourceHashes(root);
    assert.equal(after[relative], digest('native-v2'));
    assert.equal(after[provenance], digest('{"revision":2}'));
    assert.notDeepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
