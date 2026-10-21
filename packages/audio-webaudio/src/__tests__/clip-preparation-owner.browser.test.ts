import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { audioContribution, createAudioIntentBackend } from '@forgeax/engine-audio';
import type { AssetHandle } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';
import { pcmWav } from './support-tone';

it('holds real decoded PCM before the first source without creating a preparation voice', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const context = new OfflineAudioContext(1, 4800, 48000),
    engine = new WebAudioEngine({ context }),
    host = createHostAudioConsumer(engine);
  const decode = vi.spyOn(engine, 'decode'),
    worker = createAudioIntentBackend({
      emit: (intent) => host.consume(structuredClone(intent)),
      state: () => structuredClone(host.state()),
    });
  const clips: AssetHandle<'audio'>[] = Array.from({ length: 2 }, (_, i) =>
    assets
      .create({
        kind: 'audio',
        sourceKey: `clip-${i}`,
        mediaType: 'audio/wav',
        bytes: pcmWav(new Float32Array(2400)),
      })
      .unwrap(),
  );
  try {
    worker.prepareClips?.('native-pcm-request', assets, clips);
    await vi.waitFor(() => expect(worker.getState().preparation?.status).toBe('ready'));
    expect(decode).toHaveBeenCalledTimes(2);
    expect(host.state().cache?.decodedBytes).toBe(19200);
    expect(engine.getState().activeSourceCount).toBe(0);
    const first = clips[0];
    if (!first) throw Error('Missing first clip');
    worker.play(1, assets, first, { loop: false, volume: 0.1, spatialBlend: 0, bus: 'sfx' });
    await vi.waitFor(() => expect(engine.getState().activeSourceCount).toBe(1));
    expect(decode).toHaveBeenCalledTimes(2);
  } finally {
    host.dispose();
    assets.dispose();
  }
});
