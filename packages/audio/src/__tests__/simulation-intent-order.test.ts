import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { type AudioIntent, AudioSource, audioTickSystem, createAudioIntentBackend } from '../index';

describe('Audio semantic intent order', () => {
  it('emits one play, one stop, and one disappearance cleanup', () => {
    const world = new World();
    const handle = world.allocSharedRef('AudioClipAsset', {
      kind: 'audio',
      sourceKey: 'order-tone',
      bytes: Uint8Array.of(1),
    });
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
    const backend = createAudioIntentBackend({ emit: (intent) => intents.push(intent) });

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
