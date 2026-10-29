import { type Component, Update, type World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { GlobalTransform, PROPAGATE_TRANSFORMS_SYSTEM } from '@forgeax/engine-scene';
import { AcousticRegion, createAcousticRegionSystem } from './acoustic-regions';
import { AUDIO_ENGINE_RESOURCE_KEY } from './audio-backend';
import { audioTickSystem, listenerPoseFromWorldMatrix } from './audio-tick-system';
import { AudioListener, AudioSource } from './components';

export const AUDIO_TICK_SYSTEM_NAME = 'audio-tick' as const;

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
        world
          .addSystem(Update, {
            name: AUDIO_TICK_SYSTEM_NAME,
            after: [PROPAGATE_TRANSFORMS_SYSTEM],
            queries: [],
            fn: () => {
              audioTickSystem(world, backend);
              const result = acoustics.update(world, backend);
              if (!result.ok) backend.reportError(result.error);
            },
          })
          .unwrap();
        return () => {
          world.removeSystem(Update, AUDIO_TICK_SYSTEM_NAME);
          acoustics.reset(backend);
        };
      }, 'audio/tick');
      ctx.effect(() => {
        world
          .addSystem(Update, {
            name: 'audio-listener-sync',
            after: [PROPAGATE_TRANSFORMS_SYSTEM],
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
          })
          .unwrap();
        return () => world.removeSystem(Update, 'audio-listener-sync');
      }, 'audio/listener-sync');
    },
  };
}
