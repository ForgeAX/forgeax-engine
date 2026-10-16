import type { AudioPlayOptions } from '@forgeax/engine/audio';
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
    'createHostAudioConsumer decodes once per published sourceKey and reuses the AudioBuffer for later plays; changed bytes under the same key are re-decoded, and cache budgets or unknown keys fail as structured decode-failed state.',
  expect:
    'All checks pass: three plays of one clip trigger one decodeAudioData, new bytes under the same key trigger a second decode, an unpublished key and garbage bytes report decode-failed, and a tiny budget rejects a large clip.',
  async setup({ world, frames }) {
    const checks = new CheckList();
    spawnCamera(world);
    // The audio tick runs inside the App frame, so start it before polling the backend.
    await frames(1);
    const trace = traceAudioGraph();
    const consumer = createHostAudioConsumer(new WebAudioEngine());
    const small = createHostAudioConsumer(new WebAudioEngine(), { maxCachedBytes: 256 });
    try {
      const tone = makeWav(330, 0.1);
      consumer.consume({ kind: 'play', entityId: 1, sourceKey: 'tone', bytes: tone, options });
      consumer.consume({ kind: 'play', entityId: 2, sourceKey: 'tone', options });
      consumer.consume({
        kind: 'play',
        entityId: 3,
        sourceKey: 'tone',
        bytes: tone.slice(),
        options,
      });
      checks.ok(
        'three plays start',
        await waitFor(() => trace.started.length === 3),
        `started=${trace.started.length}`,
      );
      checks.equal('one decode for one published source', trace.decodes, 1);
      consumer.consume({
        kind: 'play',
        entityId: 4,
        sourceKey: 'tone',
        bytes: makeWav(660, 0.2),
        options,
      });
      checks.ok('changed bytes start', await waitFor(() => trace.started.length === 4));
      checks.equal('changed bytes under the same key re-decode', trace.decodes, 2);
      checks.ok(
        'replacement buffer is the new clip',
        Math.abs((trace.started[3]?.buffer?.duration ?? 0) - 0.2) < 0.01,
        String(trace.started[3]?.buffer?.duration),
      );

      consumer.consume({ kind: 'play', entityId: 5, sourceKey: 'never-published', options });
      const missing = consumer.state().lastError;
      checks.ok(
        'unpublished key is decode-failed',
        missing?.code === 'decode-failed',
        missing?.code ?? 'none',
      );
      consumer.consume({
        kind: 'play',
        entityId: 6,
        sourceKey: 'junk',
        bytes: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
        options,
      });
      const junk = await waitFor(
        () => consumer.state().lastError?.code === 'decode-failed' && trace.decodes === 3,
      );
      checks.ok('garbage bytes are decode-failed', junk, `decodes=${trace.decodes}`);
      await sleep(20);
      checks.equal('failed decodes start nothing', trace.started.length, 4);

      small.consume({
        kind: 'play',
        entityId: 1,
        sourceKey: 'big',
        bytes: makeWav(220, 1),
        options,
      });
      const budget = small.state().lastError;
      checks.ok(
        'cache budget rejects oversize clip',
        budget?.code === 'decode-failed' && JSON.stringify(budget.detail ?? {}).includes('budget'),
        JSON.stringify(budget?.detail),
      );
    } finally {
      consumer.dispose();
      small.dispose();
      trace.restore();
    }
    return { checks: () => checks.items };
  },
});
