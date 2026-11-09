import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeAllocationWindow } from '../allocation_window.mjs';

const profile = {
  head: { id: 1, selfSize: 900, callFrame: { url: '', functionName: '(root)', lineNumber: -1, columnNumber: -1 }, children: [] },
  samples: [{ nodeId: 1, size: 100 }, { nodeId: 99, size: 50 }],
};
const observation = (now, ready) => ({ now, ready, world: 'world:1', device: 1 });
const window = () => ({ beforeStart: observation(0, 0), afterStart: observation(100, 1), beforeStop: observation(1100, 11), afterStop: observation(1200, 12) });

test('counts orphan bytes once and keeps asynchronous and sampled populations separate', () => {
  const result = summarizeAllocationWindow(profile, window());
  assert.equal(result.sampledBytes, 150);
  assert.equal(result.orphanBytes, 50);
  assert.equal(result.orphanRecords, 1);
  assert.equal(result.treeSelfBytes, 900);
  assert.deepEqual(result.estimatedBytesPerSecondBounds, [125, 150]);
  assert.deepEqual(result.estimatedBytesPerReadyFrameBounds, [12.5, 15]);
});

test('rejects replacement, clock reversal, malformed samples and stalled presentation', () => {
  const replaced = window(); replaced.afterStop.world = 'world:2';
  assert.throws(() => summarizeAllocationWindow(profile, replaced), /replaced/);
  const reversed = window(); reversed.beforeStop.now = 50;
  assert.throws(() => summarizeAllocationWindow(profile, reversed), /monotonic/);
  const stalled = window(); stalled.beforeStop.ready = stalled.afterStart.ready;
  assert.throws(() => summarizeAllocationWindow(profile, stalled), /nonempty/);
  assert.throws(() => summarizeAllocationWindow({ ...profile, samples: [{ nodeId: 99, size: -1 }] }, window()), /Invalid heap sample/);
});
