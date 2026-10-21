import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  AudioSource,
  audioContribution,
  audioTickSystem,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { type EntityHandle, World } from '@forgeax/engine-ecs';

const assets = new AssetRegistry();
assets.installDecoder(audioContribution.kind, audioContribution.decoder);
const world = new World({ assets });
const backend = createAudioIntentBackend({ emit: (intent) => self.postMessage(intent) });
let entity: EntityHandle | undefined;
self.onmessage = (event) => {
  const data = event.data;
  if (data.kind === 'start') {
    const clip = assets
      .create({
        kind: 'audio',
        sourceKey: 'worker-tone',
        mediaType: 'audio/wav',
        bytes: data.bytes,
      })
      .unwrap();
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
