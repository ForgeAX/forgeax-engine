import assert from 'node:assert/strict';

const identity = row => JSON.stringify([row.deviceGeneration, row.frameId, row.worldIdentity]);
const statistics = values => {
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(sorted.length && sorted.every(value => Number.isFinite(value) && value >= 0));
  return { count: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length };
};

/** CPU-clock callback evidence. Neither a native GPU interval nor presentation time. */
export function analyzeFrameReceipts(phase, { toolVerification = false } = {}) {
  const observation = phase.receiptObservation;
  assert.ok(observation && typeof observation.enabled === 'boolean', 'Receipt observation absent');
  assert.equal(observation.clock, 'performance.now');
  assert.ok(Number.isFinite(phase.startedAtMs) && Number.isFinite(phase.observedAtMs) && Number.isFinite(observation.endedAtMs));
  assert.ok(phase.startedAtMs <= phase.observedAtMs && phase.observedAtMs <= observation.endedAtMs);
  const counters = ['submitted', 'completed', 'inFlight', 'highWater', 'throttledTicks'];
  for (const point of [observation.before, observation.atStop, observation.after]) {
    for (const key of counters) assert.ok(Number.isSafeInteger(point[key]) && point[key] >= 0, `Invalid frame counter ${key}`);
    assert.equal(point.inFlight, point.submitted - point.completed, 'In-flight counter disagrees with submission/completion');
    assert.ok(point.highWater >= point.inFlight);
  }
  for (const key of ['submitted', 'completed', 'highWater', 'throttledTicks']) {
    assert.ok(observation.before[key] <= observation.atStop[key] && observation.atStop[key] <= observation.after[key], `Counter regressed: ${key}`);
  }
  assert.equal(observation.before.inFlight, 0, 'Window must begin drained');
  assert.equal(observation.after.inFlight, 0, 'Window must finish drained');
  const completed = [...phase.frames, ...phase.drained];
  const delta = Object.fromEntries(['submitted', 'completed', 'throttledTicks'].map(key => [key, observation.after[key] - observation.before[key]]));
  assert.equal(delta.submitted, completed.length, 'Submitted counter disagrees with retained completions');
  assert.equal(delta.completed, completed.length, 'Completed counter disagrees with retained completions');
  const seen = new Set();
  for (let index = 0; index < completed.length; index++) {
    const row = completed[index], key = identity(row);
    assert.ok(Number.isSafeInteger(row.frameId) && row.frameId > 0 && Number.isSafeInteger(row.deviceGeneration) && row.deviceGeneration >= 0);
    assert.equal(row.presentation, 'ready');
    assert.equal(row.deviceGeneration, completed[0].deviceGeneration, 'Device generation changed in window');
    assert.equal(row.worldIdentity, completed[0].worldIdentity, 'World changed in window');
    assert.ok(!seen.has(key), 'Duplicate completion identity'); seen.add(key);
    assert.ok(Number.isFinite(row.atMs) && row.atMs >= phase.startedAtMs && row.atMs <= observation.endedAtMs, 'Completion clock outside window');
    if (index) assert.ok(row.frameId > completed[index - 1].frameId && row.atMs >= completed[index - 1].atMs, 'Completion order regressed');
  }
  const output = { enabled: observation.enabled, clock: observation.clock, counters: { before: observation.before, atStop: observation.atStop, after: observation.after, delta }, measuredCompletions: phase.frames.length, drainedCompletions: phase.drained.length, scope: 'CPU callback timestamps and App counters; not GPU time, scanout time or a fence poll count.' };
  if (!observation.enabled) {
    assert.deepEqual(observation.submitted, [], 'Disabled control retained submissions');
    return output;
  }
  assert.equal(observation.submitted.length, completed.length, 'Submission/completion cardinality mismatch');
  const submittedByKey = new Map();
  for (let index = 0; index < observation.submitted.length; index++) {
    const row = observation.submitted[index], key = identity(row);
    assert.ok(!submittedByKey.has(key), 'Duplicate submission identity'); submittedByKey.set(key, row);
    assert.ok(Number.isFinite(row.atMs) && row.atMs >= phase.startedAtMs && row.atMs <= observation.endedAtMs, 'Submission clock outside window');
    assert.equal(key, identity(completed[index]), 'Submission/completion order or identity mismatch');
    assert.ok(row.atMs <= completed[index].atMs, 'Completion preceded submission callback');
    if (index) assert.ok(row.atMs >= observation.submitted[index - 1].atMs, 'Submission clock regressed');
  }
  output.matchedIdentities = completed.length;
  if (!toolVerification) {
    const measured = phase.frames.map(row => ({ submitted: submittedByKey.get(identity(row)), completed: row }));
    output.submissionToCompletionCallbackMs = statistics(measured.map(row => row.completed.atMs - row.submitted.atMs));
    if (measured.length > 1) output.interSubmissionMs = statistics(measured.slice(1).map((row, index) => row.submitted.atMs - measured[index].submitted.atMs));
  } else output.timingAcceptance = 'not-measured-tool-verification';
  return output;
}
