import { type AudioPlayOptions, createAudioIntentBackend } from '@forgeax/engine/audio';
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
    'Decode is asynchronous. Entity play epochs and asset revisions fence stale completions, so stop, a newer play, or an asset edit wins over older in-flight decoding.',
  expect:
    'All checks pass: play-then-stop before decode resolves never starts a node, a second play for the same entity with a different clip plays only the newer clip, and republished bytes under one key play only the new content.',
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
    const clip = (sourceKey: string, duration: number) =>
      assets
        .create({
          kind: 'audio',
          sourceKey,
          mediaType: 'audio/wav',
          bytes: makeWav(300, duration),
        })
        .unwrap();
    const a = clip('a', 0.1);
    const b = clip('b', 0.3);
    const c = clip('c', 0.6);
    const d = clip('d', 0.2);
    try {
      backend.play(1, assets, a, options);
      backend.stop(1);
      await waitFor(() => trace.decodes === 1);
      await sleep(150);
      checks.equal('stop before decode completes starts nothing', trace.started.length, 0);
      checks.equal('no active source after fenced play', consumer.state().activeSourceCount, 0);

      backend.play(2, assets, b, options);
      backend.play(2, assets, c, options);
      await sleep(150);
      checks.equal(
        'newer play for the same entity wins',
        trace.started.map((node) => Math.round((node.buffer?.duration ?? 0) * 10)),
        [6],
      );

      backend.play(3, assets, d, options);
      assets.update(d, { bytes: makeWav(300, 0.4) }).unwrap();
      backend.play(3, assets, d, options);
      await waitFor(() => trace.started.length >= 2);
      await sleep(150);
      checks.equal(
        'republished bytes under one key play only the new content',
        trace.started.slice(1).map((node) => Math.round((node.buffer?.duration ?? 0) * 10)),
        [4],
      );
      checks.equal('two live sources remain', consumer.state().activeSourceCount, 2);
    } finally {
      backend.destroy();
      consumer.dispose();
      trace.restore();
      for (const handle of [a, b, c, d]) assets.release(handle).unwrap();
    }
    return { checks: () => checks.items };
  },
});
