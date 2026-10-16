import { AUDIO_ENGINE_RESOURCE_KEY, AudioSource } from '@forgeax/engine/audio';
import { defineFeature } from '../../lab/feature';
import { createIntentWorld, kinds } from './support/intents';

export default defineFeature({
  title: 'Realm-neutral AudioSource',
  catalog: 'Realm-neutral AudioSource',
  kind: 'headless',
  summary:
    'AudioSource is plain ECS data (clip, playing, loop, volume, spatialBlend, bus). audioPlugin edge-detects it every Update and emits POD AudioIntent values through createAudioIntentBackend; no Web Audio object exists on the Engine side.',
  expect:
    'All checks pass: the playing false->true edge emits one play with clip bytes, a second source of the same clip reuses the published bytes, volume edits emit set-volume, playing true->false and despawn emit stop, and a steady frame emits nothing.',
  async run(checks) {
    const lab = await createIntentWorld();
    const { world } = lab;
    checks.ok(
      'AudioEngine resource is inserted',
      world.getResource(AUDIO_ENGINE_RESOURCE_KEY) === lab.backend,
    );
    const clip = world.allocSharedRef('AudioClipAsset', {
      kind: 'audio',
      sourceKey: 'lab-tone',
      bytes: Uint8Array.of(1, 2, 3, 4),
    });
    const first = world
      .spawn({ component: AudioSource, data: { clip, playing: false, bus: 'music', loop: true } })
      .unwrap();
    checks.equal('idle source emits nothing', kinds(lab.step()), []);
    world.set(first, AudioSource, { playing: true }).unwrap();
    const play = lab.step();
    const intent = play[0];
    checks.ok(
      'play edge emits play with bytes and options',
      play.length === 1 &&
        intent?.kind === 'play' &&
        intent.bytes?.length === 4 &&
        intent.options.bus === 'music' &&
        intent.options.loop,
      JSON.stringify(kinds(play)),
    );
    checks.equal('steady playing frame emits nothing', kinds(lab.step()), []);
    const second = world.spawn({ component: AudioSource, data: { clip, playing: true } }).unwrap();
    const reuse = lab.step()[0];
    checks.ok(
      'same sourceKey reuses published bytes',
      reuse?.kind === 'play' && reuse.bytes === undefined && reuse.options.bus === 'sfx',
    );
    world.set(first, AudioSource, { volume: 0.25 }).unwrap();
    const volume = lab.step()[0];
    checks.ok(
      'volume edit emits set-volume',
      volume?.kind === 'set-volume' && Math.abs(volume.volume - 0.25) < 1e-6,
    );
    world.set(first, AudioSource, { playing: false }).unwrap();
    checks.equal('playing true->false emits stop', kinds(lab.step()), ['stop']);
    world.despawn(second).unwrap();
    checks.equal('despawning a playing source emits stop', kinds(lab.step()), ['stop']);
    lab.backend.destroy();
    checks.equal('destroy emits one destroy intent', kinds(lab.drain()), ['destroy']);
    lab.backend.setBusVolume('sfx', 0.5);
    checks.equal('intents after destroy are dropped', kinds(lab.drain()), []);
    checks.equal(
      'disconnected intent backend reports suspended state',
      lab.backend.getState().contextState,
      'suspended',
    );
    await lab.dispose();
  },
});
