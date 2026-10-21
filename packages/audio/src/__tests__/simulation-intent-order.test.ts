import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { audioContribution } from '../assets/audio-decoder';
import { type AudioIntent, AudioSource, audioTickSystem, createAudioIntentBackend } from '../index';

describe('Audio semantic intent order', () => {
  it('emits one play, one stop, and one disappearance cleanup', () => {
    const assets = new AssetRegistry();
    assets.installDecoder(audioContribution.kind, audioContribution.decoder);
    const world = new World({ assets });
    const handle = assets
      .create({
        kind: 'audio',
        mediaType: 'audio/wav',
        sourceKey: 'order-tone',
        bytes: Uint8Array.of(1),
      })
      .unwrap();
    const entity = world
      .spawn({
        component: AudioSource,
        data: {
          clip: handle,
          playing: false,
          loop: true,
          volume: 1,
          spatialBlend: 0,
          bus: 'sfx',
        },
      })
      .unwrap();
    const intents: AudioIntent[] = [];
    const backend = createAudioIntentBackend({
      emit: (intent) => {
        intents.push(intent);
      },
    });

    audioTickSystem(world, backend);
    world.set(entity, AudioSource, { playing: true }).unwrap();
    audioTickSystem(world, backend);
    audioTickSystem(world, backend);
    world.set(entity, AudioSource, { playing: false }).unwrap();
    audioTickSystem(world, backend);
    world.despawn(entity).unwrap();
    audioTickSystem(world, backend);

    expect(intents.map((intent) => intent.kind)).toEqual(['play', 'stop']);
    expect(intents.filter((intent) => intent.kind === 'stop')).toHaveLength(1);
  });
});
