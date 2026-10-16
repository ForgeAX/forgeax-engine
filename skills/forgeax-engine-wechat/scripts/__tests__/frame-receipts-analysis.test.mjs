import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFrameReceipts } from '../analyze_frame_receipts.mjs';

function fixture(enabled = true) {
  const submitted = Array.from({ length: 61 }, (_, index) => ({ frameId: index + 64, deviceGeneration: 0, worldIdentity: 'world-a', atMs: 101 + index * 16 }));
  const completed = submitted.map(row => ({ ...row, presentation: 'ready', atMs: row.atMs + 28 }));
  return {
    startedAtMs: 100, observedAtMs: completed[59].atMs + 0.1,
    frames: completed.slice(0, 60), drained: completed.slice(60),
    receiptObservation: {
      enabled, clock: 'performance.now', endedAtMs: completed[60].atMs + 1,
      before: { submitted: 63, completed: 63, inFlight: 0, highWater: 1, throttledTicks: 5 },
      atStop: { submitted: 124, completed: 123, inFlight: 1, highWater: 2, throttledTicks: 25 },
      after: { submitted: 124, completed: 124, inFlight: 0, highWater: 2, throttledTicks: 25 },
      submitted: enabled ? submitted : [],
    },
  };
}

test('generation/frame/World identities match drained receipts without blending them into the measurement', () => {
  const result = analyzeFrameReceipts(fixture());
  assert.equal(result.matchedIdentities, 61);
  assert.equal(result.measuredCompletions, 60);
  assert.equal(result.drainedCompletions, 1);
  assert.equal(result.submissionToCompletionCallbackMs.count, 60);
  assert.equal(result.submissionToCompletionCallbackMs.median, 28);
  assert.equal(result.interSubmissionMs.median, 16);
  assert.equal(result.counters.delta.throttledTicks, 20);
});

test('counter disagreement and unobserved pending work reject the window', () => {
  const phase = fixture(); phase.receiptObservation.after.submitted++;
  assert.throws(() => analyzeFrameReceipts(phase), /In-flight counter/);
  const pending = fixture(); pending.receiptObservation.before.submitted++; pending.receiptObservation.before.inFlight++;
  assert.throws(() => analyzeFrameReceipts(pending), /begin drained/);
});

test('missing, stale, duplicate or time-reversed callback facts cannot produce latency', () => {
  const missing = fixture(); missing.receiptObservation.submitted.pop();
  assert.throws(() => analyzeFrameReceipts(missing), /cardinality/);
  const stale = fixture(); stale.receiptObservation.submitted[0].deviceGeneration++;
  assert.throws(() => analyzeFrameReceipts(stale), /identity mismatch/);
  const duplicate = fixture(); duplicate.receiptObservation.submitted[1] = duplicate.receiptObservation.submitted[0];
  assert.throws(() => analyzeFrameReceipts(duplicate), /Duplicate submission/);
  const reversed = fixture(); reversed.receiptObservation.submitted[0].atMs = reversed.frames[0].atMs + 1;
  assert.throws(() => analyzeFrameReceipts(reversed), /preceded submission/);
});

test('disabled control has no submission capture and tool verification exposes no duration statistics', () => {
  const control = analyzeFrameReceipts(fixture(false));
  assert.equal(control.enabled, false);
  assert.equal(control.submissionToCompletionCallbackMs, undefined);
  const result = analyzeFrameReceipts(fixture(), { toolVerification: true });
  assert.equal(result.matchedIdentities, 61);
  assert.equal(result.submissionToCompletionCallbackMs, undefined);
  assert.equal(result.interSubmissionMs, undefined);
  assert.equal(result.timingAcceptance, 'not-measured-tool-verification');
  const leaked = fixture(); leaked.receiptObservation.enabled = false;
  assert.throws(() => analyzeFrameReceipts(leaked), /Disabled control/);
});
