import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  type AudioIntent,
  AudioSource,
  audioContribution,
  audioTickSystem,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { World } from '@forgeax/engine-ecs';
import { assert, describe, expect, it, vi } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('managed audio publications', () => {
  it.each([
    'local',
    'worker',
  ])('retries a rejected publication after old native work frees its budget (%s)', async (mode) => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const clip = assets
      .create({
        kind: 'audio',
        sourceKey: 'retry',
        mediaType: 'audio/wav',
        bytes: new Uint8Array(8).fill(1),
      })
      .unwrap();
    const engine = new WebAudioEngine();
    const jobs: (() => void)[] = [];
    vi.spyOn(engine, 'decode').mockImplementation(
      (bytes) =>
        new Promise((resolve) => {
          jobs.push(() =>
            resolve({ sample: bytes[0], length: 1, numberOfChannels: 1 } as unknown as AudioBuffer),
          );
        }),
    );
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine, { maxCachedBytes: 12 });
    const queue: AudioIntent[] = [];
    const backend = createAudioIntentBackend({
      maxPublishedBytes: 12,
      emit: (intent) => {
        if (mode === 'local') return consumer.consume(structuredClone(intent));
        queue.push(structuredClone(intent));
        return undefined;
      },
    });
    const deliver = () => {
      for (const intent of queue.splice(0)) {
        const rejected = consumer.consume(intent);
        if (rejected) backend.rejectPublication(rejected);
      }
    };
    const options = { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' };
    try {
      backend.play(1, assets, clip, options);
      deliver();
      assets.update(clip, { bytes: new Uint8Array(5).fill(2) }).unwrap();
      backend.play(2, assets, clip, options);
      deliver();
      expect(jobs).toHaveLength(1);
      expect(consumer.state().lastError?.detail).toMatchObject({
        reason: 'audio cache publication budget exceeded',
      });
      jobs.shift()?.();
      await flush();
      backend.play(3, assets, clip, options);
      deliver();
      expect(jobs).toHaveLength(1);
      jobs.shift()?.();
      await flush();
      expect(play).toHaveBeenLastCalledWith(3, expect.objectContaining({ sample: 2 }), options);
      expect(consumer.state().cache).toMatchObject({
        sources: 1,
        encodedBytes: 5,
        decodedBytes: 4,
      });
      expect(consumer.state().lastError).toBeNull();
    } finally {
      consumer.dispose();
      assets.dispose();
    }
  });

  it('finishes queued old preparation without rolling the current play cache back', async () => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const clips = Array.from({ length: 5 }, (_, i) =>
      assets
        .create({
          kind: 'audio',
          sourceKey: `clip-${i}`,
          mediaType: 'audio/ogg',
          bytes: Uint8Array.of(11 + i),
        })
        .unwrap(),
    );
    const currentClip = clips[4];
    assert(currentClip !== undefined);
    const engine = new WebAudioEngine();
    const jobs = new Map<number, () => void>();
    vi.spyOn(engine, 'decode').mockImplementation(
      (bytes) =>
        new Promise((resolve) => {
          const sample = bytes[0];
          assert(sample !== undefined);
          jobs.set(sample, () =>
            resolve({ sample: bytes[0], length: 1, numberOfChannels: 1 } as unknown as AudioBuffer),
          );
        }),
    );
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);
    const backend = createAudioIntentBackend({
      emit: (intent) => consumer.consume(structuredClone(intent)),
    });
    const options = { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' };
    try {
      backend.prepareClips?.('old', assets, clips);
      expect([...jobs.keys()]).toEqual([11, 12, 13, 14]);
      assets.update(currentClip, { bytes: Uint8Array.of(25) }).unwrap();
      backend.play(50, assets, currentClip, options);
      jobs.get(25)?.();
      await flush();
      for (const sample of [11, 12, 13, 14]) jobs.get(sample)?.();
      await flush();
      expect(jobs.has(15)).toBe(true);
      jobs.get(15)?.();
      await flush();
      expect(consumer.state().preparation?.status).toBe('ready');
      backend.play(51, assets, currentClip, options);
      await flush();
      expect(play).toHaveBeenLastCalledWith(51, expect.objectContaining({ sample: 25 }), options);
      expect(consumer.state().lastError).toBeNull();
      expect(consumer.state().cache).toMatchObject({
        sources: 5,
        encodedBytes: 5,
        decodedBytes: 20,
      });
    } finally {
      consumer.dispose();
      assets.dispose();
    }
  });

  it('releases failed synchronous native decode reservations on replacement and disposal', () => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const clip = assets
      .create({
        kind: 'audio',
        sourceKey: 'sync-failure',
        mediaType: 'audio/ogg',
        bytes: Uint8Array.of(1),
      })
      .unwrap();
    const engine = new WebAudioEngine({
      context: () => {
        throw Error('native context creation failed');
      },
    });
    const consumer = createHostAudioConsumer(engine, { maxCachedBytes: 3 });
    const backend = createAudioIntentBackend({ emit: (intent) => consumer.consume(intent) });
    for (let sample = 1; sample < 5; sample++) {
      assets.update(clip, { bytes: Uint8Array.of(sample) }).unwrap();
      backend.play(sample, assets, clip, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
      expect(consumer.state().cache?.encodedBytes).toBe(1);
      expect(consumer.state().lastError?.detail).toMatchObject({
        reason: 'native context creation failed',
      });
    }
    consumer.dispose();
    expect(consumer.state().cache).toMatchObject({ sources: 0, encodedBytes: 0, decodedBytes: 0 });
    assets.dispose();
  });

  it('keeps pending voices fixed across edits and reclaims replaced cache versions without growing the source count', async () => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const clip = assets
      .create({
        kind: 'audio',
        sourceKey: 'same-file',
        mediaType: 'audio/ogg',
        bytes: Uint8Array.of(1),
      })
      .unwrap();
    const engine = new WebAudioEngine();
    const completions: (() => void)[] = [];
    const decode = vi.spyOn(engine, 'decode').mockImplementation(
      (bytes) =>
        new Promise((resolve) => {
          completions.push(() =>
            resolve({
              sample: bytes[0],
              length: 1,
              numberOfChannels: 1,
            } as unknown as AudioBuffer),
          );
        }),
    );
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const stop = vi.spyOn(engine, 'stop');
    const consumer = createHostAudioConsumer(engine, { maxCachedSources: 1, maxCachedBytes: 32 });
    const intents: AudioIntent[] = [];
    const backend = createAudioIntentBackend({
      emit: (intent) => {
        intents.push(intent);
        consumer.consume(structuredClone(intent));
      },
    });
    const options = { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' };
    const read = vi.spyOn(assets, 'read').mockImplementation(() => {
      throw new Error('play must not copy public asset bytes per entity');
    });
    try {
      backend.play(1, assets, clip, options);
      assets.update(clip, { bytes: Uint8Array.of(2) }).unwrap();
      backend.play(2, assets, clip, options);
      expect(consumer.state().cache).toMatchObject({
        sources: 1,
        encodedBytes: 2,
        pendingPlays: 2,
      });
      completions.shift()?.();
      completions.shift()?.();
      await flush();
      expect(play).toHaveBeenCalledWith(1, expect.objectContaining({ sample: 1 }), options);
      expect(play).toHaveBeenCalledWith(2, expect.objectContaining({ sample: 2 }), options);
      expect(consumer.state().cache).toMatchObject({
        sources: 1,
        encodedBytes: 1,
        decodedBytes: 4,
        pendingPlays: 0,
      });
      const repeated = 100;
      for (let i = 0; i < repeated; i++) backend.play(3 + i, assets, clip, options);
      await flush();
      expect(decode).toHaveBeenCalledTimes(2);
      expect(
        intents.slice(2).every((intent) => intent.kind === 'play' && intent.bytes === undefined),
      ).toBe(true);
      expect(read).not.toHaveBeenCalled();
      expect(stop.mock.calls.map(([entity]) => entity)).toEqual(
        Array.from({ length: repeated + 2 }, (_, i) => i + 1),
      );
      for (let sample = 3; sample < 12; sample++) {
        assets.update(clip, { bytes: Uint8Array.of(sample) }).unwrap();
        backend.play(1000 + sample, assets, clip, options);
        completions.shift()?.();
        await flush();
        expect(consumer.state().cache).toMatchObject({
          sources: 1,
          encodedBytes: 1,
          decodedBytes: 4,
        });
      }
    } finally {
      read.mockRestore();
      consumer.dispose();
      assets.dispose();
    }
  });

  it('captures queued publication bytes before returning and fences entity replacement and disposal', async () => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const clip = assets
      .create({
        kind: 'audio',
        sourceKey: 'queued',
        mediaType: 'audio/ogg',
        bytes: Uint8Array.of(1),
      })
      .unwrap();
    const intents: AudioIntent[] = [];
    const backend = createAudioIntentBackend({
      emit: (intent) => {
        intents.push(intent);
      },
    });
    const options = { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' };
    backend.play(1, assets, clip, options);
    assets.update(clip, { bytes: Uint8Array.of(2) }).unwrap();
    backend.play(1, assets, clip, options);
    expect(intents[0]).toMatchObject({ bytes: Uint8Array.of(1) });
    const engine = new WebAudioEngine();
    const pending: (() => void)[] = [];
    vi.spyOn(engine, 'decode').mockImplementation(
      (bytes) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({ sample: bytes[0], length: 1, numberOfChannels: 1 } as unknown as AudioBuffer),
          );
        }),
    );
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);
    for (const intent of intents) consumer.consume(structuredClone(intent));
    pending.shift()?.();
    await flush();
    expect(play).not.toHaveBeenCalled();
    consumer.dispose();
    pending.shift()?.();
    await flush();
    expect(play).not.toHaveBeenCalled();
    expect(consumer.state().cache).toMatchObject({ sources: 0, encodedBytes: 0, decodedBytes: 0 });
    assets.dispose();
  });

  it('plays independent edited copies from the same source through ECS and Host decoding', async () => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const world = new World({ assets });
    const original = assets
      .create({
        kind: 'audio',
        sourceKey: 'same-file',
        mediaType: 'audio/ogg',
        bytes: Uint8Array.of(1),
      })
      .unwrap();
    const copy = assets.copy(original).unwrap();
    assets.update(copy, { bytes: Uint8Array.of(2) }).unwrap();
    const a = world
      .spawn({ component: AudioSource, data: { clip: original, playing: true } })
      .unwrap();
    const b = world.spawn({ component: AudioSource, data: { clip: copy, playing: true } }).unwrap();
    const engine = new WebAudioEngine();
    const decode = vi
      .spyOn(engine, 'decode')
      .mockImplementation(
        async (bytes) =>
          ({ sample: bytes[0], length: 1, numberOfChannels: 1 }) as unknown as AudioBuffer,
      );
    const play = vi.spyOn(engine, 'play').mockImplementation(() => {});
    const consumer = createHostAudioConsumer(engine);
    const backend = createAudioIntentBackend({
      emit: (intent) => consumer.consume(structuredClone(intent)),
    });
    try {
      audioTickSystem(world, backend);
      await flush();
      expect(decode).toHaveBeenCalledTimes(2);
      expect(play).toHaveBeenCalledWith(
        a,
        expect.objectContaining({ sample: 1 }),
        expect.anything(),
      );
      expect(play).toHaveBeenCalledWith(
        b,
        expect.objectContaining({ sample: 2 }),
        expect.anything(),
      );
      audioTickSystem(world, backend);
      await flush();
      expect(play).toHaveBeenCalledTimes(2);
    } finally {
      consumer.dispose();
      world.despawn(a).unwrap();
      world.despawn(b).unwrap();
      assets.dispose();
    }
  });
});
