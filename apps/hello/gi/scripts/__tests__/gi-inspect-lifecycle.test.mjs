import assert from 'node:assert/strict';
import test from 'node:test';
import { err, ok } from '@forgeax/engine-types';
import { withReplaySession } from '../gi-inspect-records.mjs';

function replayDevice(events) {
  // Match the public RhiDevice boundary: only the native GPUDevice owns destroy.
  return { nativeDevice() { return ok({ destroy() { events.push('destroy'); } }); } };
}

test('the CLI destroys its device when opening the replay session fails', async () => {
  const events = [];
  const failure = { code: 'replay-backend-unavailable' };
  await assert.rejects(() => withReplaySession(replayDevice(events),
    async () => { events.push('open'); return err(failure); },
    async () => { events.push('inspect'); }), (error) => error === failure);
  assert.deepEqual(events, ['open', 'destroy']);
});

test('the CLI still destroys its device when disposing the session fails', async () => {
  const events = [];
  const failure = { code: 'replay-dispose-failed' };
  await assert.rejects(() => withReplaySession(replayDevice(events),
    async () => { events.push('open'); return ok({
      async dispose() { events.push('dispose'); return err(failure); },
    }); },
    async () => { events.push('inspect'); return 7; }), (error) => error === failure);
  assert.deepEqual(events, ['open', 'inspect', 'dispose', 'destroy']);
});

test('the CLI disposes its session before destroying the native device on success', async () => {
  const events = [];
  const result = await withReplaySession(replayDevice(events),
    async () => { events.push('open'); return ok({
      async dispose() { events.push('dispose'); return ok(undefined); },
    }); },
    async () => { events.push('inspect'); return 7; });
  assert.equal(result, 7);
  assert.deepEqual(events, ['open', 'inspect', 'dispose', 'destroy']);
});

test('the CLI releases the session and native device when inspection throws', async () => {
  const events = [];
  const failure = new Error('read failed');
  await assert.rejects(() => withReplaySession(replayDevice(events),
    async () => { events.push('open'); return ok({
      async dispose() { events.push('dispose'); return ok(undefined); },
    }); },
    async () => { events.push('inspect'); throw failure; }), (error) => error === failure);
  assert.deepEqual(events, ['open', 'inspect', 'dispose', 'destroy']);
});
