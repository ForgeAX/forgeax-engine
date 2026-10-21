import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  type AudioIntent,
  AudioSource,
  audioContribution,
  audioTickSystem,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';
import { pcmWav } from './support-tone';

it('renders independently edited copies with one source key through native decode and the ECS playback path', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const world = new World({ assets });
  const original = assets
    .create({
      kind: 'audio',
      sourceKey: 'shared-file',
      mediaType: 'audio/wav',
      bytes: pcmWav(new Float32Array(4800).fill(0.1)),
    })
    .unwrap();
  const copy = assets.copy(original).unwrap();
  assets.update(copy, { bytes: pcmWav(new Float32Array(4800).fill(0.4)) }).unwrap();
  const a = world
    .spawn({ component: AudioSource, data: { clip: original, playing: true } })
    .unwrap();
  const b = world.spawn({ component: AudioSource, data: { clip: copy, playing: true } }).unwrap();
  const context = new OfflineAudioContext(1, 4800, 48000);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(structuredClone(intent)),
  });
  try {
    audioTickSystem(world, backend);
    await expect.poll(() => consumer.state().activeSourceCount).toBe(2);
    const samples = (await context.startRendering()).getChannelData(0);
    expect(samples[2048]).toBeCloseTo(0.5, 3);
  } finally {
    consumer.dispose();
    world.despawn(a).unwrap();
    world.despawn(b).unwrap();
    assets.dispose();
  }
});

it('charges prepared musical buffers until retirement, before any musical node exists', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const bytes = pcmWav(new Float32Array(48000).fill(0.1));
  const clip = assets
    .create({ kind: 'audio', sourceKey: 'music-budget', mediaType: 'audio/wav', bytes })
    .unwrap();
  const decodedBytes = 48000 * 4;
  const context = new OfflineAudioContext(1, 48000, 48000);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }), {
    maxCachedBytes: bytes.byteLength + decodedBytes,
  });
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(structuredClone(intent)),
  });
  try {
    consumer.prepareMusic(1, { assets, bpm: 120, beatsPerBar: 4, loopBeats: 1, stems: [{ clip }] });
    await expect.poll(() => consumer.state().music?.phase).toBe('ready');
    expect(consumer.state().music?.nodes).toBe(0);
    assets.update(clip, { bytes: pcmWav(new Float32Array(48000).fill(0.4)) }).unwrap();
    backend.play(1, assets, clip, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
    expect(consumer.state().lastError?.detail).toMatchObject({
      reason: 'audio cache publication budget exceeded',
    });
    expect(consumer.state().cache).toMatchObject({
      sources: 1,
      encodedBytes: bytes.byteLength,
      decodedBytes,
    });
    consumer.prepareMusic(2, { assets, bpm: 120, beatsPerBar: 4, loopBeats: 1, stems: [{ clip }] });
    await expect.poll(() => consumer.state().music?.phase).toBe('ready');
    expect(consumer.state().cache).toMatchObject({
      sources: 1,
      encodedBytes: bytes.byteLength,
      decodedBytes,
    });
    consumer.dispose();
    expect(consumer.state().cache).toMatchObject({ sources: 0, encodedBytes: 0, decodedBytes: 0 });
  } finally {
    consumer.dispose();
    assets.dispose();
  }
});

it('renders old queued and pending voices from their fixed versions after the shared clip is edited', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const world = new World({ assets });
  const clip = assets
    .create({
      kind: 'audio',
      sourceKey: 'same-handle',
      mediaType: 'audio/wav',
      bytes: pcmWav(new Float32Array(4800).fill(0.1)),
    })
    .unwrap();
  const queue: AudioIntent[] = [];
  const context = new OfflineAudioContext(1, 4800, 48000);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const backend = createAudioIntentBackend({
    emit(intent) {
      queue.push(structuredClone(intent));
    },
  });
  const a = world.spawn({ component: AudioSource, data: { clip, playing: true } }).unwrap();
  const entities = [a];
  try {
    audioTickSystem(world, backend);
    // The queued old publication survives a managed edit before Host delivery.
    assets.update(clip, { bytes: pcmWav(new Float32Array(4800).fill(0.4)) }).unwrap();
    expect(queue).toHaveLength(1);
    consumer.consume(queue.splice(0)[0] as AudioIntent);
    // Native decode is pending while the new version is published.
    entities.push(world.spawn({ component: AudioSource, data: { clip, playing: true } }).unwrap());
    audioTickSystem(world, backend);
    expect(queue).toHaveLength(1);
    consumer.consume(queue.splice(0)[0] as AudioIntent);
    for (let frame = 0; frame < 60; frame++) audioTickSystem(world, backend);
    expect(queue).toEqual([]);
    await expect.poll(() => consumer.state().activeSourceCount).toBe(2);
    const samples = (await context.startRendering()).getChannelData(0);
    expect(samples[2048]).toBeCloseTo(0.5, 3);
  } finally {
    consumer.dispose();
    for (const entity of entities) world.despawn(entity).unwrap();
    assets.dispose();
  }
});
