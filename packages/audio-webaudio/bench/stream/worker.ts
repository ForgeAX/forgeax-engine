import { AudioSource, audioTickSystem, createAudioIntentBackend } from '@forgeax/engine-audio';
import { World } from '@forgeax/engine-ecs';
const world = new World();
const backend = createAudioIntentBackend({ emit: intent => self.postMessage(intent) });
const entities: any[] = [];
self.onmessage = event => {
  if (event.data.kind === 'start') {
    const clip = world.allocSharedRef('AudioClipAsset', event.data.clip);
    for (let i = 0; i < event.data.count; i++) entities.push(world.spawn({ component: AudioSource,
      data: { clip, playing: true, loop: true, volume: 0.25 / event.data.count, bus: 'music' } }).unwrap());
    self.postMessage({ kind: 'entity', entity: entities[entities.length - 1] });
  } else for (const entity of entities) world.set(entity, AudioSource, event.data.controls).unwrap();
  audioTickSystem(world, backend);
};
