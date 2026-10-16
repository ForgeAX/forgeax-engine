import { AudioSource } from '@forgeax/engine/audio';
import { defineFeature } from '../../lab/feature';
import { createIntentWorld } from './support/intents';

export default defineFeature({
  title: 'Clip start and seek',
  catalog: 'Clip start and seek',
  kind: 'headless',
  summary:
    'AudioSource.fromPosition and repeated AudioBackend.seek requests use the existing realm-neutral intent transport.',
  expect:
    'Starting paused at 2 s publishes that position once, changing it emits one seek, and two explicit seeks to the same position remain two ordered requests.',
  async run(checks) {
    const lab = await createIntentWorld();
    try {
      const clip = lab.world.allocSharedRef('AudioClipAsset', {
        kind: 'audio',
        sourceKey: 'lab-seek',
        bytes: Uint8Array.of(1),
      });
      const player = lab.world
        .spawn({
          component: AudioSource,
          data: { clip, playing: true, paused: true, fromPosition: 2 },
        })
        .unwrap();
      const start = lab.step();
      checks.ok(
        'start publishes paused position',
        start[0]?.kind === 'play' &&
          start[0].options.fromPosition === 2 &&
          start[0].options.paused === true,
      );
      checks.equal('steady frame emits nothing', lab.step(), []);
      lab.world.set(player, AudioSource, { fromPosition: 3 }).unwrap();
      const expected = { kind: 'seek', entityId: player as number, position: 3 };
      checks.equal('edit emits a seek', lab.step(), [expected]);
      checks.equal('steady position emits nothing', lab.step(), []);
      lab.backend.seek(player as number, 3);
      lab.backend.seek(player as number, 3);
      checks.equal('repeated explicit requests stay ordered', lab.drain(), [expected, expected]);
    } finally {
      await lab.dispose();
    }
  },
});
