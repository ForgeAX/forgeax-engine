import { World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import { type AudioIntent, AudioSource, audioTickSystem, createAudioIntentBackend } from '../index';

it('publishes the start position and emits seek only on ECS edits, with explicit repeated seek supported', () => {
  const world = new World();
  const intents: AudioIntent[] = [];
  const backend = createAudioIntentBackend({ emit: (intent) => intents.push(intent) });
  const clip = world.allocSharedRef('AudioClipAsset', {
    kind: 'audio',
    sourceKey: 'seek',
    bytes: Uint8Array.of(1),
  });
  const entity = world
    .spawn({
      component: AudioSource,
      data: {
        clip,
        playing: true,
        paused: true,
        fromPosition: 2,
      },
    })
    .unwrap();
  audioTickSystem(world, backend);
  audioTickSystem(world, backend);
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({ kind: 'play', options: { fromPosition: 2 } });
  world.set(entity, AudioSource, { fromPosition: 3 }).unwrap();
  audioTickSystem(world, backend);
  audioTickSystem(world, backend);
  backend.seek(entity as number, 3);
  backend.seek(entity as number, 3);
  expect(intents.slice(1)).toEqual(
    Array.from({ length: 3 }, () => ({
      kind: 'seek',
      entityId: entity as number,
      position: 3,
    })),
  );
  world.set(entity, AudioSource, { playing: false, fromPosition: 1 }).unwrap();
  audioTickSystem(world, backend);
  world.set(entity, AudioSource, { playing: true }).unwrap();
  audioTickSystem(world, backend);
  expect(intents.at(-1)).toMatchObject({ kind: 'play', options: { fromPosition: 1 } });
  world.despawn(entity).unwrap();
  audioTickSystem(world, backend);
  expect(intents.at(-1)).toMatchObject({ kind: 'stop' });
  backend.destroy();
  backend.seek(entity as number, 0);
  expect(intents.at(-1)).toEqual({ kind: 'destroy' });
});
