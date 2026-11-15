import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readReadyCompletedFrame } from '../../test/app/acceptance.mjs';

test('preparation completions do not admit scene capture even after sixty frames', () => {
  const identity = { worldIdentity: 'current-scene', deviceGeneration: 1 };
  const canvas = { forgeaxFrameProgress: {
    submitted: { frameId: 289, ...identity },
    completed: { frameId: 288, ...identity, presentation: 'pending' },
  } };
  assert.equal(readReadyCompletedFrame(canvas), 0);
  canvas.forgeaxFrameProgress.completed = { frameId: 289, ...identity, presentation: 'ready' };
  assert.equal(readReadyCompletedFrame(canvas), 289);
});

test('missing completions remain unready and ready completions retain their actual frame count', () => {
  assert.equal(readReadyCompletedFrame({}), 0);
  assert.equal(readReadyCompletedFrame({ forgeaxFrameProgress: {} }), 0);
  assert.equal(readReadyCompletedFrame({ forgeaxFrameProgress: {
    completed: { frameId: 60, presentation: 'ready' },
  } }), 0);
  for (const frameId of [1, 59, 60]) {
    assert.equal(readReadyCompletedFrame({ forgeaxFrameProgress: {
      submitted: { frameId, worldIdentity: 'current-scene', deviceGeneration: 1 },
      completed: { frameId, worldIdentity: 'current-scene', deviceGeneration: 1, presentation: 'ready' },
    } }), frameId);
  }
});
