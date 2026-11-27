import assert from 'node:assert/strict';
import test from 'node:test';
import { createThreeFrameCapture } from '../three_frame_capture.mjs';

function setup(frameLimit) {
  let frameId = 0;
  let ends = 0;
  let receipt;
  const observations = [];
  const ok = (value) => ({ ok: true, value });
  const cpu = { captureId: 'capture-example' };
  const profiler = {
    startCapture: () =>
      ok({
        beginFrame: () => ok({ captureId: cpu.captureId, frameId: ++frameId }),
        endFrame: () => {
          ends++;
          return ok(undefined);
        },
        finish: () => ok(cpu),
      }),
  };
  let time = 0;
  const capture = createThreeFrameCapture({
    profiler,
    frameLimit,
    now: () => time++,
    readFrame: () => receipt && {
      receipt,
      observe: async (request) => {
        observations.push(request);
        return ok({ timings: { status: 'complete', frame: { frameId: receipt.frameId } } });
      },
    },
  });
  return {
    capture,
    observations,
    ended: () => ends,
    submit(presentation = 'ready', completed = Promise.resolve(ok(undefined))) {
      receipt = {
        frameId: frameId + 40,
        deviceGeneration: 1,
        profileFrame: { captureId: cpu.captureId, frameId },
        presentation,
        completed,
      };
      return receipt;
    },
  };
}

test('joins only the receipt from the recorded callback and preserves missing submissions', async () => {
  const f = setup(2);
  assert.equal(f.capture.recordFrame((measure) => measure('render', () => f.submit().frameId)), 41);
  f.capture.recordFrame(() => undefined);
  const result = await f.capture.finish();
  assert.equal(f.ended(), 2);
  assert.equal(result.observationComplete, true);
  assert.equal(result.frames[0].submission.completion.status, 'complete');
  assert.equal(result.frames[0].submission.observation.timings.frame.frameId, 41);
  assert.deepEqual(result.frames[0].phases, [{ phase: 'render', startMs: 1, endMs: 2 }]);
  assert.equal(result.frames[1].submission, null);
  assert.deepEqual(f.observations, [{ include: ['timings'] }]);
});

test('carries pending presentation and snapshots an unfinished receipt at the observation deadline', async () => {
  const f = setup(2);
  f.capture.recordFrame(() => f.submit('pending'));
  let complete;
  f.capture.recordFrame(() => f.submit('ready', new Promise((resolve) => { complete = resolve; })));
  const result = await f.capture.finish({ timeoutMs: 10 });
  assert.equal(result.observationComplete, false);
  assert.equal(result.frames[0].submission.observation.status, 'presentation-pending');
  assert.equal(result.frames[1].submission.completion.status, 'unsettled');
  complete({ ok: true, value: undefined });
  await Promise.resolve();
  assert.equal(result.frames[1].submission.completion.status, 'unsettled');
});

test('ends the profiler scope on a callback error and finishes once', async () => {
  const f = setup(1);
  assert.throws(() => f.capture.recordFrame(() => { throw new Error('game callback failed'); }));
  assert.equal(f.ended(), 1);
  const first = f.capture.finish();
  assert.equal(f.capture.finish(), first);
  const result = await first;
  assert.equal(result.frames[0].callbackError.message, 'game callback failed');
  assert.equal(result.frames[0].submission, null);
});
