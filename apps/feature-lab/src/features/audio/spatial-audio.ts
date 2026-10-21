import { createAudioIntentBackend } from '@forgeax/engine/audio';
import { createHostAudioConsumer, WebAudioEngine } from '@forgeax/engine/audio-webaudio';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import { busOfSource, busTopology, makeWav, traceAudioGraph, waitFor } from './support/webaudio';

export default defineFeature({
  title: '3D spatial audio',
  catalog: '3D spatial audio',
  kind: 'probe',
  summary:
    'spatialBlend > 0 inserts an equalpower PannerNode between the source gain and its bus; set-listener-pose writes the Web Audio AudioListener position, forward and up. spatialBlend 0 routes straight to the bus.',
  expect:
    'All checks pass: the spatial source has an equalpower PannerNode on its path, the 2D source has none, and the AudioListener reports the posted position (2, 1, -4) and forward (0, 0, -1).',
  async setup({ app, world, frames }) {
    const checks = new CheckList();
    const assets = app.assets;
    if (assets === undefined) throw new Error('App asset service is unavailable');
    spawnCamera(world);
    // The audio tick runs inside the App frame, so start it before polling the backend.
    await frames(1);
    const trace = traceAudioGraph();
    const consumer = createHostAudioConsumer(new WebAudioEngine());
    const backend = createAudioIntentBackend({ emit: (intent) => consumer.consume(intent) });
    const clip = assets
      .create({
        kind: 'audio',
        sourceKey: 'spatial',
        mediaType: 'audio/wav',
        bytes: makeWav(520, 0.5),
      })
      .unwrap();
    try {
      backend.play(1, assets, clip, { loop: true, volume: 0.02, spatialBlend: 1, bus: 'sfx' });
      backend.play(2, assets, clip, { loop: true, volume: 0.02, spatialBlend: 0, bus: 'sfx' });
      checks.ok('both sources start', await waitFor(() => trace.started.length === 2));
      const topology = busTopology(trace);
      const spatialNode = trace.started[0];
      const flatNode = trace.started[1];
      if (topology === undefined || spatialNode === undefined || flatNode === undefined) {
        checks.ok('topology discovered', false);
        return { checks: () => checks.items };
      }
      const spatial = busOfSource(trace, topology, spatialNode);
      const flat = busOfSource(trace, topology, flatNode);
      checks.ok(
        'spatial source reaches a bus through a PannerNode',
        spatial.bus !== undefined && spatial.panner !== undefined,
      );
      checks.equal(
        'panner uses the equalpower model',
        spatial.panner?.panningModel ?? '',
        'equalpower',
      );
      checks.ok('2D source has no panner', flat.bus !== undefined && flat.panner === undefined);
      consumer.consume({
        kind: 'set-listener-pose',
        pose: {
          positionX: 2,
          positionY: 1,
          positionZ: -4,
          forwardX: 0,
          forwardY: 0,
          forwardZ: -1,
          upX: 0,
          upY: 1,
          upZ: 0,
        },
      });
      const listener = topology.context.listener;
      checks.equal(
        'AudioListener position and forward follow the pose',
        [
          listener.positionX.value,
          listener.positionY.value,
          listener.positionZ.value,
          listener.forwardZ.value,
          listener.upY.value,
        ],
        [2, 1, -4, -1, 1],
      );
    } finally {
      backend.destroy();
      consumer.dispose();
      trace.restore();
      assets.release(clip).unwrap();
    }
    return { checks: () => checks.items };
  },
});
