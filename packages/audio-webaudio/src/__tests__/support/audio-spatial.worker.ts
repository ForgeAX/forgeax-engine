import {
  AudioSource,
  audioBackendPlugin,
  audioPlugin,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';

const world = new World();
const backend = createAudioIntentBackend({ emit: (intent) => self.postMessage(intent) });
const ctx = await createWorldContext(world, [
  audioBackendPlugin(backend),
  audioPlugin(),
  scenePlugin(),
]);
let parent: EntityHandle | undefined;
let source: EntityHandle | undefined;
self.onmessage = async (event) => {
  const data = event.data;
  if (data.kind === 'start') {
    const clip = world.allocSharedRef('AudioClipAsset', {
      kind: 'audio',
      sourceKey: 'worker-spatial',
      bytes: data.bytes,
    });
    parent = world.spawn({ component: Transform, data: { pos: [-2, 0, 0] } }).unwrap();
    source = world
      .spawn(
        { component: Transform, data: { pos: [1, 0, 0] } },
        { component: ChildOf, data: { parent } },
        { component: AudioSource, data: { clip, playing: true, loop: true, spatialBlend: 1 } },
      )
      .unwrap();
  } else if (data.kind === 'move' && parent !== undefined) {
    world.set(parent, Transform, { pos: [0, 0, 0] }).unwrap();
  } else if (data.kind === 'dispose') {
    if (source !== undefined) world.despawn(source).unwrap();
    world.update(1 / 60).unwrap();
    await ctx.fiber.dispose();
    self.postMessage({ kind: 'disposed' });
    return;
  }
  world.update(1 / 60).unwrap();
};
self.postMessage({ kind: 'ready' });
