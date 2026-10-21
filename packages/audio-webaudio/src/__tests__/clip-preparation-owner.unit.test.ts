import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  type AudioIntent,
  audioContribution,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import type { AssetHandle, AudioClipAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';

const clip = (sourceKey: string, byte = 1): Extract<AudioClipAsset, { bytes: Uint8Array }> => ({
  kind: 'audio',
  sourceKey,
  mediaType: 'audio/ogg',
  bytes: Uint8Array.of(byte),
});
const options = { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' };
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function fixture(options: Parameters<typeof createHostAudioConsumer>[1] = {}) {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const clips = new Map<string, { handle: AssetHandle<'audio'>; byte: number }>();
  const setClip = (name: string, byte = 1) => {
    const found = clips.get(name);
    if (found) {
      if (found.byte !== byte) {
        assets.update(found.handle, { bytes: Uint8Array.of(byte) }).unwrap();
        found.byte = byte;
      }
      return found.handle;
    }
    const handle = assets.create(clip(name, byte)).unwrap();
    clips.set(name, { handle, byte });
    return handle;
  };
  const engine = new WebAudioEngine(),
    decode = vi
      .spyOn(engine, 'decode')
      .mockImplementation(async () => ({ length: 10, numberOfChannels: 1 }) as AudioBuffer),
    play = vi.spyOn(engine, 'play').mockImplementation(() => {}),
    stop = vi.spyOn(engine, 'stop');
  const host = createHostAudioConsumer(engine, options),
    intents: AudioIntent[] = [];
  const worker = createAudioIntentBackend({
    emit: (intent) => {
      intents.push(intent);
      host.consume(structuredClone(intent));
    },
    state: () => structuredClone(host.state()),
  });
  return {
    assets,
    setClip,
    engine,
    decode,
    play,
    stop,
    host,
    worker,
    intents,
    dispose: () => {
      host.dispose();
      assets.dispose();
    },
  };
}
it('prepares PCM through the real Worker publication/Host cache without playing and reuses it for the first real voice', async () => {
  const f = fixture();
  try {
    const clips = [f.setClip('primary'), f.setClip('secondary')];
    expect(f.decode).not.toHaveBeenCalled();
    f.worker.prepareClips?.('fresh-request', f.assets, clips);
    expect(f.worker.getState().preparation?.status).toBe('pending');
    expect(f.play).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    await flush();
    expect(f.worker.getState().preparation).toMatchObject({
      requestId: 'fresh-request',
      status: 'ready',
      sourceCount: 2,
    });
    expect(f.decode).toHaveBeenCalledTimes(2);
    expect(f.host.state().cache).toMatchObject({
      sources: 2,
      encodedBytes: 2,
      decodedBytes: 80,
      pendingPlays: 0,
    });
    f.worker.play(1, f.assets, f.setClip('primary'), options);
    await flush();
    expect(f.play).toHaveBeenCalledOnce();
    expect(f.decode).toHaveBeenCalledTimes(2);
    expect(f.intents.at(-1)).toMatchObject({ kind: 'play', sourceKey: 'primary' });
    expect(f.intents.at(-1)).toHaveProperty('bytes');
    // The normal first publication still validates encoded identity; it reuses
    // the prepared PCM and therefore starts no additional native decoder job.
  } finally {
    f.dispose();
  }
});
it('bounds native decode concurrency and completes the fixed prepared versions across edits', async () => {
  const f = fixture(),
    pending: (() => void)[] = [];
  let active = 0,
    peak = 0;
  f.decode.mockImplementation(
    () =>
      new Promise<AudioBuffer>((resolve) => {
        active++;
        peak = Math.max(peak, active);
        pending.push(() => {
          active--;
          resolve({ length: 10, numberOfChannels: 1 } as AudioBuffer);
        });
      }),
  );
  try {
    f.worker.prepareClips?.(
      'old',
      f.assets,
      Array.from({ length: 9 }, (_, i) => f.setClip(`s${i}`)),
    );
    expect(f.decode).toHaveBeenCalledTimes(4);
    expect(peak).toBe(4);
    f.worker.play(10, f.assets, f.setClip('s0', 2), options);
    expect(f.decode).toHaveBeenCalledTimes(5);
    while (pending.length) {
      for (const run of pending.splice(0)) run();
      await flush();
    }
    expect(f.worker.getState().preparation?.status).toBe('ready');
    f.worker.prepareClips?.('fresh', f.assets, [f.setClip('s0', 2)]);
    await flush();
    expect(f.worker.getState().preparation).toMatchObject({ requestId: 'fresh', status: 'ready' });
  } finally {
    f.dispose();
  }
});
it('keeps newer request authority, decode failures retryable and disposal fenced', async () => {
  const f = fixture();
  let release: ((buffer: AudioBuffer) => void) | undefined;
  try {
    f.decode.mockImplementationOnce(
      () =>
        new Promise<AudioBuffer>((resolve) => {
          release = resolve;
        }),
    );
    f.worker.prepareClips?.('old', f.assets, [f.setClip('slow')]);
    f.worker.prepareClips?.('new', f.assets, [f.setClip('ready')]);
    await flush();
    expect(f.worker.getState().preparation).toMatchObject({ requestId: 'new', status: 'ready' });
    release?.({ length: 10, numberOfChannels: 1 } as AudioBuffer);
    await flush();
    expect(f.worker.getState().preparation?.requestId).toBe('new');
    f.decode.mockRejectedValueOnce(Error('bad codec'));
    f.worker.prepareClips?.('bad', f.assets, [f.setClip('retry')]);
    await flush();
    expect(f.worker.getState().preparation?.status).toBe('rejected');
    f.worker.prepareClips?.('retry', f.assets, [f.setClip('retry')]);
    await flush();
    expect(f.worker.getState().preparation?.status).toBe('ready');
    const cancel = f.worker.prepareClips?.('cancel', f.assets, [f.setClip('cancel')]);
    cancel?.();
    await flush();
    expect(f.host.state().preparation).toBeUndefined();
    f.host.dispose();
    expect(f.host.state().preparation).toBeUndefined();
    expect(f.play).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});
it('rejects invalid preparations and both publication/decoded budgets without creating voices', async () => {
  const f = fixture({ maxCachedBytes: 20 });
  try {
    f.worker.prepareClips?.('', f.assets, [f.setClip('x')]);
    expect(f.worker.getState().preparation?.status).toBe('rejected');
    expect(f.decode).not.toHaveBeenCalled();
    f.worker.prepareClips?.('duplicate', f.assets, [f.setClip('x'), f.setClip('x')]);
    expect(f.worker.getState().preparation?.status).toBe('rejected');
    f.worker.prepareClips?.('too-large', f.assets, [f.setClip('x')]);
    await flush();
    expect(f.worker.getState().preparation?.status).toBe('rejected');
    expect(f.play).not.toHaveBeenCalled();
    const published: AudioIntent[] = [],
      small = createAudioIntentBackend({
        emit: (x) => {
          published.push(x);
        },
        maxPublishedBytes: 1,
      });
    small.prepareClips?.('budget', f.assets, [
      f.assets.create({ ...clip('large'), bytes: Uint8Array.of(1, 2) }).unwrap(),
    ]);
    expect(small.getState().preparation?.status).toBe('rejected');
    expect(published.some((x) => x.kind === 'prepare-clips')).toBe(false);
  } finally {
    f.dispose();
  }
});
