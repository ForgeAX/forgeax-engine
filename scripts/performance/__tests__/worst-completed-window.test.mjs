import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateWorstRollingWindow } from '../worst-completed-window.mjs';

const fixture = (times) => ({
  error: null,
  start: times[0],
  end: times.at(-1),
  frames: times
    .slice(0, -1)
    .map((at, frameId) => ({ at, worldIdentity: 'world', deviceGeneration: 0, frameId })),
  closingFrame: {
    at: times.at(-1),
    worldIdentity: 'world',
    deviceGeneration: 0,
    frameId: times.length - 1,
  },
  samples: [],
});

test('closing receipt is one endpoint, not another counted frame', () => {
  const raw = fixture([0, 400, 800, 1200]);
  const result = locateWorstRollingWindow(raw, {
    rollingOneSecondMinFps: 2.5,
    rollingOneSecondWindows: 1,
  });
  assert.equal(result.worst.completedIntervals, 3);
  assert.equal(result.worst.endpointReceipts, 4);
  assert.equal(result.worst.includesClosingFrame, true);
  assert.equal(result.worst.last.frameId, 3);
  raw.frames.push(raw.closingFrame);
  assert.throws(() => locateWorstRollingWindow(raw, {}), /closingFrame/);
});
test('no complete second stays unobserved', () => {
  assert.equal(
    locateWorstRollingWindow(fixture(Array.from({ length: 62 }, (_, i) => i * 10)), {
      rollingOneSecondMinFps: null,
      rollingOneSecondWindows: 0,
    }).status,
    'notObserved',
  );
});
test('world/device discontinuity and backwards receipt fail; numeric holes are not pictures', () => {
  for (const change of [
    (r) => (r.frames[1].worldIdentity = 'other'),
    (r) => (r.frames[1].deviceGeneration = 1),
    (r) => (r.closingFrame.frameId = 0),
  ]) {
    const raw = fixture([0, 400, 800, 1200]);
    change(raw);
    assert.throws(() => locateWorstRollingWindow(raw, {}));
  }
  const raw = fixture([0, 400, 800, 1200]);
  raw.frames[2].frameId = 5;
  raw.closingFrame.frameId = 7;
  assert.equal(
    locateWorstRollingWindow(raw, { rollingOneSecondMinFps: 2.5, rollingOneSecondWindows: 1 }).worst
      .completedIntervals,
    3,
  );
});
test('strictly earliest endpoint at one second and first tie match summary semantics', () => {
  const raw = fixture([0, 250, 500, 750, 1000, 1250]);
  const result = locateWorstRollingWindow(raw, {
    rollingOneSecondMinFps: 4,
    rollingOneSecondWindows: 2,
  });
  assert.equal(result.worst.first.frameId, 0);
  assert.equal(result.worst.last.frameId, 4);
});
test('HUD brackets are clock correlations, without a synthetic receipt identity', () => {
  const raw = fixture([0, 400, 800, 1200]);
  raw.samples = [
    { at: -10, phase: 'buy' },
    { at: 10, phase: 'live' },
    { at: 1100, phase: 'live' },
    { at: 1210, phase: 'live' },
  ];
  const result = locateWorstRollingWindow(raw, {
    rollingOneSecondMinFps: 2.5,
    rollingOneSecondWindows: 1,
  });
  assert.equal(result.worst.hudAtStart.before.observedAtMs, -10);
  assert.equal(result.worst.hudAtStart.after.observedAtMs, 10);
  assert.equal(result.worst.hudAtEnd.before.observedAtMs, 1100);
  assert.equal(result.worst.hudAtEnd.after.observedAtMs, 1210);
  assert.equal(result.worst.hudAtStart.before.worldIdentity, undefined);
});
