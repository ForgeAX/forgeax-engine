import { expect, it } from 'vitest';
import { audioImporter } from '../audio-importer';
import { indexPcmWave } from '../pcm-wave';
import { toneWav } from './support-tone';

it('cooks bounded windows through the normal audio producer and refuses compressed streaming', async () => {
  const bytes = toneWav();
  const context = {
    source: 'bgm.wav',
    importSettings: { playback: 'stream' },
    subAssets: [{ guid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', kind: 'audio' }],
    readSource: async () => ({ ok: true, value: bytes }),
  };
  const result = await audioImporter.import(context as never);
  expect(result.ok).toBe(true);
  const asset = result.value.assets[0];
  expect(asset.payload).not.toHaveProperty('bytes');
  expect(asset.payload.stream).toMatchObject({
    format: 'wav-pcm16/1',
    frames: 96000,
    chunkFrames: 48000,
  });
  expect(asset.payload.stream.hashes).toHaveLength(2);
  expect(asset.artifacts.source).toMatchObject({
    delivery: 'stream',
    assetCodec: { name: 'forgeax-pcm16-stream', version: '1' },
  });
  const bad = await audioImporter.import({
    ...context,
    source: 'bgm.mp3',
    readSource: async () => ({ ok: true, value: Uint8Array.of(1, 2) }),
  } as never);
  expect(bad).toMatchObject({ ok: false, error: { code: 'source-validation-failed' } });
  await expect(indexPcmWave(bytes.subarray(0, bytes.length - 1))).rejects.toThrow();
});
