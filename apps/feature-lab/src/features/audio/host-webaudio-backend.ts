import type { AudioBackend } from '@forgeax/engine/audio';
import { AUDIO_ENGINE_RESOURCE_KEY, AudioSource, audioPlugin } from '@forgeax/engine/audio';
import { webAudioPlugin } from '@forgeax/engine/audio-webaudio';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import { busOfSource, busTopology, makeWav, traceAudioGraph, waitFor } from './support/webaudio';

export default defineFeature({
  title: 'Host Web Audio backend',
  catalog: 'Host Web Audio backend',
  kind: 'probe',
  appOptions: { plugins: [webAudioPlugin(), audioPlugin()] },
  summary:
    'webAudioPlugin provides the Host-owned backend: intents from the ECS audio tick are consumed by WebAudioEngine, which lazily creates one AudioContext with a fixed master <- sfx + music gain topology.',
  expect:
    'All checks pass: no AudioContext exists before the first play, an AudioSource with playing=true becomes one active Web Audio source routed through a bus gain into master and destination, and playing=false stops it.',
  async setup({ world, frames }) {
    const checks = new CheckList();
    spawnCamera(world);
    // The audio tick runs inside the App frame, so start it before polling the backend.
    await frames(1);
    const trace = traceAudioGraph();
    try {
      const backend = world.getResource<AudioBackend>(AUDIO_ENGINE_RESOURCE_KEY);
      checks.ok('AudioEngine resource comes from webAudioPlugin', backend !== undefined);
      if (backend === undefined) return { checks: () => checks.items };
      checks.equal('no source before the first play', backend.getActiveSourceCount(), 0);
      checks.equal('AudioContext is created lazily', trace.contexts.size, 0);
      const clip = world.allocSharedRef('AudioClipAsset', {
        kind: 'audio',
        sourceKey: 'lab-host-tone',
        bytes: makeWav(440, 0.5),
      });
      const entity = world
        .spawn({
          component: AudioSource,
          data: { clip, playing: true, loop: true, volume: 0.05, bus: 'music' },
        })
        .unwrap();
      const started = await waitFor(() => backend.getActiveSourceCount() === 1);
      checks.ok(
        'playing=true becomes one active Web Audio source',
        started,
        `active=${backend.getActiveSourceCount()}`,
      );
      const state = backend.getState();
      checks.ok(
        'context state is running or suspended (autoplay policy)',
        state.contextState === 'running' || state.contextState === 'suspended',
        state.contextState,
      );
      checks.ok(
        'no lastError after a valid WAV',
        state.lastError === null,
        state.lastError?.code ?? '',
      );
      const topology = busTopology(trace);
      checks.ok('master gain feeds the destination', topology !== undefined);
      checks.equal('two bus gains feed master', topology?.buses.length ?? 0, 2);
      const node = trace.started[0];
      checks.ok(
        'source routes through a bus gain',
        topology !== undefined &&
          node !== undefined &&
          busOfSource(trace, topology, node).bus !== undefined,
      );
      checks.ok('loop flag reaches AudioBufferSourceNode', node?.loop === true);
      world.set(entity, AudioSource, { playing: false }).unwrap();
      checks.ok(
        'playing=false stops the source',
        await waitFor(() => backend.getActiveSourceCount() === 0),
        `active=${backend.getActiveSourceCount()}`,
      );
      world.despawn(entity).unwrap();
    } finally {
      trace.restore();
    }
    return { checks: () => checks.items };
  },
});
