import { type Component, defineSystem, Update, type World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { GlobalTransform, PropagateTransforms } from '@forgeax/engine-scene';
import { AcousticRegion, createAcousticRegionSystem } from './acoustic-regions';
import { AUDIO_ENGINE_RESOURCE_KEY } from './audio-backend';
import { audioTickSystem, listenerPoseFromWorldMatrix } from './audio-tick-system';
import { AudioListener, AudioSource } from './components';
import { AudioTickOrder } from './system-order';

const AUDIO_COMPONENTS: readonly Component[] = [AudioSource, AudioListener, AcousticRegion];

function registerAudioComponents(world: World): () => void {
  const leases = AUDIO_COMPONENTS.map((component) => world.components.register(component).unwrap());
  return () => {
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

export function audioPlugin(): Plugin {
  return {
    name: 'audio',
    inject: ['world', 'audio'],
    apply(ctx) {
      const world = ctx.world;
      const backend = ctx.audio;
      if (backend === undefined) throw new Error('Cordis activated audio without its provider');
      const acoustics = createAcousticRegionSystem();
      ctx.effect(() => registerAudioComponents(world), 'audio/components');
      ctx.effect(() => {
        world.insertResource(AUDIO_ENGINE_RESOURCE_KEY, backend);
        return () => {
          world.removeResource(AUDIO_ENGINE_RESOURCE_KEY);
        };
      }, 'audio/resource');
      ctx.effect(() => {
        const systemToken1 = defineSystem({
          sets: [AudioTickOrder],
          name: 'audio-tick',
          after: [PropagateTransforms],
          queries: [],
          fn: () => {
            audioTickSystem(world, backend);
            const result = acoustics.update(world, backend);
            if (!result.ok) backend.reportError(result.error);
          },
        });
        world.addSystem(Update, systemToken1).unwrap();
        return () => {
          world.removeSystem(Update, systemToken1);
          acoustics.reset(backend);
        };
      }, 'audio/tick');
      ctx.effect(() => {
        const systemToken2 = defineSystem({
          name: 'audio-listener-sync',
          after: [PropagateTransforms],
          queries: [],
          fn: () => {
            const listeners = world.query({ read: [GlobalTransform], with: [AudioListener] });
            if (!listeners.ok) return;
            for (const span of listeners.value.spans().unwrap()) {
              if (span.length === 0) continue;
              const matrix = span.get(GlobalTransform).world.subarray(0, 16);
              const pose = listenerPoseFromWorldMatrix(matrix);
              backend.setListenerPose(pose);
              return;
            }
          },
        });
        world.addSystem(Update, systemToken2).unwrap();
        return () => world.removeSystem(Update, systemToken2);
      }, 'audio/listener-sync');
    },
  };
}
