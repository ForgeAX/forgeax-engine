import { type AudioPlayOptions, createAudioIntentBackend } from '@forgeax/engine/audio';
import { createHostAudioConsumer, WebAudioEngine } from '@forgeax/engine/audio-webaudio';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera } from '../../lab/stage';
import { makeWav, sleep, traceAudioGraph, waitFor } from './support/webaudio';

const options: AudioPlayOptions = { loop: false, volume: 0.02, spatialBlend: 0, bus: 'sfx' };

export default defineFeature({
  title: 'Audio decode cache',
  catalog: 'Audio decode cache',
  kind: 'probe',
  summary:
    'The Host decodes once per managed asset revision and reuses its AudioBuffer for later plays. Asset edits publish a new revision automatically; missing publications, invalid bytes and cache budgets yield structured failures.',
  expect:
    'All checks pass: three plays of one clip trigger one decodeAudioData, new bytes under the same key trigger a second decode, an unpublished key and garbage bytes report decode-failed, and a tiny budget rejects a large clip.',
  async setup({ app, world, frames }) {
    const checks = new CheckList();
    const assets = app.assets;
    if (assets === undefined) throw new Error('App asset service is unavailable');
    spawnCamera(world);
    // The audio tick runs inside the App frame, so start it before polling the backend.
    await frames(1);
    const trace = traceAudioGraph();
    const consumer = createHostAudioConsumer(new WebAudioEngine());
    const small = createHostAudioConsumer(new WebAudioEngine(), { maxCachedBytes: 256 });
    const backend = createAudioIntentBackend({
      emit(intent) {
        // Simulate a missing transport publication while preserving the real
        // asset owner identity produced by the engine.
        if (intent.kind === 'play' && intent.entityId === 5) {
          const { bytes: _bytes, ...missingPublication } = intent;
          return consumer.consume(missingPublication);
        }
        return consumer.consume(intent);
      },
    });
    const smallBackend = createAudioIntentBackend({ emit: (intent) => small.consume(intent) });
    const clip = (sourceKey: string, bytes: Uint8Array) =>
      assets
        .create({
          kind: 'audio',
          sourceKey,
          mediaType: 'audio/wav',
          bytes,
        })
        .unwrap();
    const tone = clip('tone', makeWav(330, 0.1));
    const missingClip = clip('never-published', makeWav(440, 0.1));
    const junkClip = clip('junk', Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    const big = clip('big', makeWav(220, 1));
    try {
      backend.play(1, assets, tone, options);
      backend.play(2, assets, tone, options);
      backend.play(3, assets, tone, options);
      checks.ok(
        'three plays start',
        await waitFor(() => trace.started.length === 3),
        `started=${trace.started.length}`,
      );
      checks.equal('one decode for one published source', trace.decodes, 1);
      assets.update(tone, { bytes: makeWav(660, 0.2) }).unwrap();
      backend.play(4, assets, tone, options);
      checks.ok('changed bytes start', await waitFor(() => trace.started.length === 4));
      checks.equal('changed bytes under the same key re-decode', trace.decodes, 2);
      checks.ok(
        'replacement buffer is the new clip',
        Math.abs((trace.started[3]?.buffer?.duration ?? 0) - 0.2) < 0.01,
        String(trace.started[3]?.buffer?.duration),
      );

      backend.play(5, assets, missingClip, options);
      const missing = consumer.state().lastError;
      checks.ok(
        'unpublished key is decode-failed',
        missing?.code === 'decode-failed',
        missing?.code ?? 'none',
      );
      backend.play(6, assets, junkClip, options);
      const junk = await waitFor(
        () => consumer.state().lastError?.code === 'decode-failed' && trace.decodes === 3,
      );
      checks.ok('garbage bytes are decode-failed', junk, `decodes=${trace.decodes}`);
      await sleep(20);
      checks.equal('failed decodes start nothing', trace.started.length, 4);

      smallBackend.play(1, assets, big, options);
      const budget = small.state().lastError;
      checks.ok(
        'cache budget rejects oversize clip',
        budget?.code === 'decode-failed' && JSON.stringify(budget.detail ?? {}).includes('budget'),
        JSON.stringify(budget?.detail),
      );
    } finally {
      backend.destroy();
      smallBackend.destroy();
      consumer.dispose();
      small.dispose();
      trace.restore();
      for (const handle of [tone, missingClip, junkClip, big]) assets.release(handle).unwrap();
    }
    return { checks: () => checks.items };
  },
});
