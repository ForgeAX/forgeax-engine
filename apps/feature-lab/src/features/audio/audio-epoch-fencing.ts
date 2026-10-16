import type { AudioPlayOptions } from '@forgeax/engine/audio';
import { createHostAudioConsumer, WebAudioEngine } from '@forgeax/engine/audio-webaudio';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import { makeWav, sleep, traceAudioGraph, waitFor } from './support/webaudio';

const options: AudioPlayOptions = { loop: true, volume: 0.02, spatialBlend: 0, bus: 'sfx' };

export default defineFeature({
  title: 'Audio entity epoch fencing',
  catalog: 'Audio entity epoch fencing',
  kind: 'probe',
  summary:
    'Decode is asynchronous. A stale decode completion is fenced by the entity play epoch and the current source-key content, so stop, a newer play, or republished bytes win over an older in-flight decode.',
  expect:
    'All checks pass: play-then-stop before decode resolves never starts a node, a second play for the same entity with a different clip plays only the newer clip, and republished bytes under one key play only the new content.',
  async setup({ world, frames }) {
    const checks = new CheckList();
    spawnCamera(world);
    // The audio tick runs inside the App frame, so start it before polling the backend.
    await frames(1);
    const trace = traceAudioGraph();
    const consumer = createHostAudioConsumer(new WebAudioEngine());
    try {
      consumer.consume({
        kind: 'play',
        entityId: 1,
        sourceKey: 'a',
        bytes: makeWav(300, 0.1),
        options,
      });
      consumer.consume({ kind: 'stop', entityId: 1 });
      await waitFor(() => trace.decodes === 1);
      await sleep(150);
      checks.equal('stop before decode completes starts nothing', trace.started.length, 0);
      checks.equal('no active source after fenced play', consumer.state().activeSourceCount, 0);

      consumer.consume({
        kind: 'play',
        entityId: 2,
        sourceKey: 'b',
        bytes: makeWav(300, 0.3),
        options,
      });
      consumer.consume({
        kind: 'play',
        entityId: 2,
        sourceKey: 'c',
        bytes: makeWav(300, 0.6),
        options,
      });
      await sleep(150);
      checks.equal(
        'newer play for the same entity wins',
        trace.started.map((node) => Math.round((node.buffer?.duration ?? 0) * 10)),
        [6],
      );

      consumer.consume({
        kind: 'play',
        entityId: 3,
        sourceKey: 'd',
        bytes: makeWav(300, 0.2),
        options,
      });
      consumer.consume({
        kind: 'play',
        entityId: 3,
        sourceKey: 'd',
        bytes: makeWav(300, 0.4),
        options,
      });
      await waitFor(() => trace.started.length >= 2);
      await sleep(150);
      checks.equal(
        'republished bytes under one key play only the new content',
        trace.started.slice(1).map((node) => Math.round((node.buffer?.duration ?? 0) * 10)),
        [4],
      );
      checks.equal('two live sources remain', consumer.state().activeSourceCount, 2);
    } finally {
      consumer.dispose();
      trace.restore();
    }
    return { checks: () => checks.items };
  },
});
