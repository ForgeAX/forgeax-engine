import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  audioContribution,
  loadMusicScore,
  type MusicPreparation,
  type MusicScore,
} from '@forgeax/engine-audio';
import { expect, it, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';

it('rejects the same score bounds before asset loading and native preparation', async () => {
  const stem = { clip: 'aaaaaaaa-aaaa-4aaa-8aaa-000000002300' };
  const base: MusicScore = { bpm: 120, beatsPerBar: 4, loopBeats: 4, stems: [stem] };
  const invalid: MusicScore[] = [
    ...[NaN, Infinity, 19.99, 400.01].map((bpm) => ({ ...base, bpm })),
    ...[0, 1.5, 17].map((beatsPerBar) => ({ ...base, beatsPerBar })),
    ...[0, 1.5, 1025].map((loopBeats) => ({ ...base, loopBeats })),
    { ...base, stems: [] },
    { ...base, stems: Array.from({ length: 17 }, () => stem) },
    ...[-1, NaN, Infinity].map((offsetSeconds) => ({
      ...base,
      stems: [{ ...stem, offsetSeconds }],
    })),
  ];
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const clip = assets
    .create({
      kind: 'audio',
      sourceKey: 'score-admission',
      mediaType: 'audio/wav',
      bytes: new Uint8Array([1]),
    })
    .unwrap();
  const load = vi.spyOn(assets, 'load');
  const context = new OfflineAudioContext(1, 128, 48000);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  try {
    for (const [index, score] of invalid.entries()) {
      const result = await loadMusicScore(score, assets);
      expect(!result.ok && result.error.code).toBe('invalid-score');
      expect(load).not.toHaveBeenCalled();
      const preparation: MusicPreparation = {
        ...score,
        assets,
        stems: score.stems.map((item) => ({ ...item, clip })),
      };
      consumer.prepareMusic(index + 1, preparation);
      const state = consumer.state().music;
      expect(state?.receipts.at(-1)?.failure?.code).toBe('invalid-score');
      expect(state?.epoch).toBe(0);
      expect(state?.nodes).toBe(0);
    }
  } finally {
    consumer.dispose();
    assets.dispose();
  }
});
