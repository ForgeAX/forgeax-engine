import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  AudioError,
  AudioSource,
  audioContribution,
  audioTickSystem,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import { AudioIntentQueue } from '../execution/audio-intent-queue';

it('charges every queued fixed version and allows rejected versions to be retried after drain', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const clip = assets
    .create({
      kind: 'audio',
      sourceKey: 'queue',
      mediaType: 'audio/wav',
      bytes: new Uint8Array(1024),
    })
    .unwrap();
  const queue = new AudioIntentQueue(4096, 16);
  const backend = createAudioIntentBackend({
    emit: (intent) => queue.push(intent),
    maxPublishedBytes: 1024,
    maxPublishedSources: 1,
  });
  const options = { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' };
  for (let i = 1; i <= 8; i++) {
    assets.update(clip, { bytes: new Uint8Array(1024).fill(i) }).unwrap();
    try {
      backend.play(i, assets, clip, options);
    } catch (cause) {
      expect(cause).toBeInstanceOf(AudioError);
    }
  }
  expect(backend.getState().lastError?.detail).toMatchObject({
    reason: 'audio frame publication queue capacity exceeded',
  });
  const sent = queue.drain();
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.length).toBeLessThan(4);
  expect(
    sent.filter((intent) => intent.kind === 'play').map((intent) => intent.bytes?.[0]),
  ).toEqual(Array.from({ length: sent.length }, (_, i) => i + 1));
  backend.play(9, assets, clip, options);
  expect(queue.drain()).toMatchObject([{ kind: 'play', bytes: new Uint8Array(1024).fill(8) }]);
  assets.dispose();
});

it.each([
  'stop',
  'despawn',
] as const)('retains a rejected %s edge until the Host can receive it', (action) => {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const world = new World({ assets });
  const clip = assets
    .create({ kind: 'audio', sourceKey: 'loop', mediaType: 'audio/wav', bytes: Uint8Array.of(1) })
    .unwrap();
  const entity = world
    .spawn({ component: AudioSource, data: { clip, playing: true, loop: true } })
    .unwrap();
  const queue = new AudioIntentQueue(4096, 1);
  const backend = createAudioIntentBackend({ emit: (intent) => queue.push(intent) });
  audioTickSystem(world, backend);
  expect(queue.drain()).toMatchObject([{ kind: 'play', entityId: entity }]);
  backend.setBusVolume('sfx', 0.5);
  if (action === 'stop') world.set(entity, AudioSource, { playing: false }).unwrap();
  else world.despawn(entity).unwrap();
  audioTickSystem(world, backend);
  expect(queue.drain()).toMatchObject([{ kind: 'set-bus-volume' }]);
  audioTickSystem(world, backend);
  expect(queue.drain()).toMatchObject([{ kind: 'stop', entityId: entity }]);
  audioTickSystem(world, backend);
  expect(queue.drain()).toEqual([]);
  if (action === 'stop') world.despawn(entity).unwrap();
  backend.destroy();
  assets.dispose();
});

it('retains only unaccepted source controls across frame capacity limits', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(audioContribution.kind, audioContribution.decoder);
  const world = new World({ assets });
  const clip = assets
    .create({
      kind: 'audio',
      sourceKey: 'controls',
      mediaType: 'audio/wav',
      bytes: Uint8Array.of(1),
    })
    .unwrap();
  const entity = world.spawn({ component: AudioSource, data: { clip, playing: true } }).unwrap();
  const queue = new AudioIntentQueue(4096, 1);
  const backend = createAudioIntentBackend({ emit: (intent) => queue.push(intent) });
  backend.setBusVolume('sfx', 0.5);
  audioTickSystem(world, backend);
  expect(queue.drain()).toMatchObject([{ kind: 'set-bus-volume' }]);
  audioTickSystem(world, backend);
  expect(queue.drain()).toMatchObject([{ kind: 'play', bytes: Uint8Array.of(1) }]);
  world
    .set(entity, AudioSource, { volume: 0.25, playbackRate: 2, paused: true, fromPosition: 3 })
    .unwrap();
  for (const kind of ['set-volume', 'set-playback-rate', 'set-paused', 'seek']) {
    audioTickSystem(world, backend);
    expect(queue.drain()).toMatchObject([{ kind }]);
  }
  audioTickSystem(world, backend);
  expect(queue.drain()).toEqual([]);
  world.despawn(entity).unwrap();
  backend.destroy();
  assets.dispose();
});
