import type { AudioBackend } from '@forgeax/engine/audio';
import { AUDIO_ENGINE_RESOURCE_KEY, AudioSource, audioPlugin } from '@forgeax/engine/audio';
import { webAudioPlugin } from '@forgeax/engine/audio-webaudio';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { scenePlugin } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import { busTopology, makeWav, traceAudioGraph, waitFor } from './support/webaudio';

export default defineFeature({
  title: 'Audio cleanup',
  catalog: 'Audio cleanup',
  kind: 'probe',
  summary:
    'Despawning a playing AudioSource stops and disconnects its Web Audio nodes; disposing the plugin context destroys the backend, disconnects the bus topology and closes the AudioContext.',
  expect:
    'All checks pass: despawn drops the active count to 0 and disconnects the node, context disposal closes the AudioContext and disconnects master/bus gains, and the backend then reports closed.',
  async setup({ world: appWorld }) {
    const checks = new CheckList();
    spawnCamera(appWorld);
    const trace = traceAudioGraph();
    const world = new World();
    const ctx = await createWorldContext(world, [scenePlugin(), webAudioPlugin(), audioPlugin()]);
    try {
      const backend = world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY);
      if (backend === undefined) {
        checks.ok('AudioEngine resource present', false);
        return { checks: () => checks.items };
      }
      const clip = world.allocSharedRef('AudioClipAsset', {
        kind: 'audio',
        sourceKey: 'cleanup',
        bytes: makeWav(400, 0.5),
      });
      const entity = world
        .spawn({ component: AudioSource, data: { clip, playing: true, loop: true, volume: 0.02 } })
        .unwrap();
      world.update(1 / 60);
      checks.ok(
        'looping source becomes active',
        await waitFor(() => backend.getActiveSourceCount() === 1),
      );
      const node = trace.started[0];
      world.despawn(entity).unwrap();
      world.update(1 / 60);
      checks.equal('despawn stops the source', backend.getActiveSourceCount(), 0);
      checks.ok(
        'despawn disconnects the source node',
        node !== undefined && trace.disconnected.has(node),
      );
      world
        .spawn({ component: AudioSource, data: { clip, playing: true, loop: true, volume: 0.02 } })
        .unwrap();
      world.update(1 / 60);
      await waitFor(() => backend.getActiveSourceCount() === 1);
      const topology = busTopology(trace);
      await ctx.fiber.dispose();
      checks.ok(
        'context disposal closes the AudioContext',
        topology !== undefined && trace.closed.has(topology.context),
      );
      checks.ok(
        'master and bus gains are disconnected',
        topology !== undefined &&
          trace.disconnected.has(topology.master) &&
          topology.buses.every((bus) => trace.disconnected.has(bus)),
      );
      checks.equal('backend reports closed', backend.getState().contextState, 'closed');
      checks.equal('no active source after destroy', backend.getActiveSourceCount(), 0);
      checks.ok('AudioEngine resource removed', !world.hasResource(AUDIO_ENGINE_RESOURCE_KEY));
    } finally {
      trace.restore();
    }
    return { checks: () => checks.items };
  },
});
