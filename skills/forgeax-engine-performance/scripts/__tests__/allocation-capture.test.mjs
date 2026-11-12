import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { archiveScreenshot } from '../capture_game3d_allocations.mjs';

const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

test('archives a detached screenshot before the public play path is reused', async () => {
  const output = await mkdtemp(join(tmpdir(), 'allocation-image-'));
  try {
    const path = join(output, 'public-play.png');
    let bytes = Buffer.from('first encoded picture');
    const play = { screenshot: async () => {
      await writeFile(path, bytes);
      return { name: 'picture', path, rendered: true, digest: digest(bytes) };
    } };
    const first = await archiveScreenshot(play, output, 'first');
    bytes = Buffer.from('later encoded picture');
    const second = await archiveScreenshot(play, output, 'second');
    await rm(path);
    assert.equal((await readFile(first.path)).toString(), 'first encoded picture');
    assert.equal((await readFile(second.path)).toString(), 'later encoded picture');
    assert.notEqual(first.digest, second.digest);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('rejects screenshot bytes that do not match their producer receipt', async () => {
  const output = await mkdtemp(join(tmpdir(), 'allocation-image-'));
  try {
    const path = join(output, 'public-play.png');
    await writeFile(path, 'changed picture');
    const play = { screenshot: async () => ({ path, digest: digest('old picture') }) };
    await assert.rejects(archiveScreenshot(play, output, 'invalid'));
    await assert.rejects(readFile(join(output, 'invalid.png')), { code: 'ENOENT' });
  } finally { await rm(output, { recursive: true, force: true }); }
});
