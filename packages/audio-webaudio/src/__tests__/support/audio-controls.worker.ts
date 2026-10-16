import { AudioSource, audioTickSystem, createAudioIntentBackend } from '@forgeax/engine-audio';
import { type EntityHandle, World } from '@forgeax/engine-ecs';

const world = new World();
const backend = createAudioIntentBackend({ emit: (intent) => self.postMessage(intent) });
let entity: EntityHandle | undefined;
self.onmessage = (event) => {
  const data = event.data;
  if (data.kind === 'start') {
    const clip = world.allocSharedRef('AudioClipAsset', {
      kind: 'audio',
      sourceKey: 'worker-tone',
      bytes: data.bytes,
    });
    entity = world
      .spawn({
        component: AudioSource,
        data: { clip, playing: true, loop: true, volume: 0.01, ...data.controls },
      })
      .unwrap();
  } else if (entity !== undefined) {
    world.set(entity, AudioSource, data.controls).unwrap();
  }
  audioTickSystem(world, backend);
};

self.postMessage({ kind: 'ready' });
