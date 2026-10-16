import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { retainNativeEvidence } from '../../../packages/audio-webaudio/bench/music/retain-native-evidence.mjs';

test('native retention writes ordered binary chunks and preserves negative offsets without overwriting bytes', async () => {
  const output = await mkdtemp(join(tmpdir(), 'music-pcm-retention-'));
  const send = (offset, bytes) =>
    retainNativeEvidence(output, 'native', {
      wavOffset: offset,
      wavBase64: bytes.toString('base64'),
    });
  try {
    const header = Buffer.from('RIFF');
    const samples = Buffer.from([0, 128, 255, 1]);
    await send(0, header);
    await assert.rejects(send(3, samples), /offset mismatch/);
    assert.deepEqual(await readFile(join(output, 'native.wav')), header);
    await send(4, samples);
    await assert.rejects(send(4, samples), /offset mismatch/);
    await assert.rejects(send(0, samples), /EEXIST/);
    await assert.rejects(send(-1, samples), /bounded ordered chunk/);
    await assert.rejects(send(8, Buffer.alloc(1024 * 1024 + 1)), /native PCM retention/);
    await retainNativeEvidence(output, 'native', { pcmFrames: 2 });
    assert.deepEqual(await readFile(join(output, 'native.wav')), Buffer.concat([header, samples]));
    assert.deepEqual(JSON.parse(await readFile(join(output, 'native.json'), 'utf8')), {
      pcmFrames: 2,
    });
  } finally {
    await rm(output, { recursive: true });
  }
});
