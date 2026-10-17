import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeGpuTimeline,
  completedGpuSelection,
  gpuTimelineFrame,
  qualifyGameGpuCapture,
} from '../analyze_gpu_timeline.mjs';

const base = 9007199254740993000n;
function frame(
  intervals = [
    ['A', 0, 10],
    ['B', 5, 15],
    ['C', 7, 8],
  ],
  frameId = 10,
) {
  const passes = intervals.map(([passName, start, end], executionIndex) => ({
    passName,
    passKind: 'raster',
    executionIndex,
    status: 'measured',
    measurementSource: 'pass-boundary',
    beginningTick: String(base + BigInt(start * 1e6)),
    endTick: String(base + BigInt(end * 1e6)),
    durationNanoseconds: (end - start) * 1e6,
  }));
  return {
    schemaVersion: '1.0',
    frameId,
    deviceGeneration: 0,
    graphGeneration: 1,
    backendKind: 'webgpu',
    timestampPeriodNanoseconds: 1,
    passCapacity: 32,
    executedPassCount: passes.length,
    measuredPassCount: passes.length,
    droppedPassCount: 0,
    measuredPassNanoseconds: passes.reduce((n, p) => n + p.durationNanoseconds, 0),
    passes,
  };
}
const row = (source = 100, renderer = 10) => ({
  worldIdentity: 'world-1',
  frameId: source,
  observation: { status: 'complete', frame: frame(undefined, renderer) },
});
const options = {
  contextPointer: '/worldIdentity',
  sourceFramePointer: '/frameId',
  observationPointer: '/observation',
};
const receipt = (frameId, at) => ({ worldIdentity: 'world-1', frameId, deviceGeneration: 0, at });
const window = () => ({
  timeOrigin: 10000,
  start: 0,
  end: 300,
  firstLiveAt: 100,
  frames: [receipt(99, 0), receipt(100, 100), receipt(101, 200)],
  closingFrame: receipt(102, 300),
});
function report(rows = [row(), row(102, 12)]) {
  return {
    ok: true,
    errors: [],
    lastObserved: { observedAt: { timeOriginMs: 10000 } },
    windows: {
      ordinary: { frames: 'ordinary-frames.json', timing: { completedIntervals: 3, seconds: 0.3 } },
    },
    gpu: {
      diagnostic: 'gpu-pass-timing',
      sampling: 'latest-completed-receipt-poll',
      status: 'sampled',
      samples: rows,
      counts: { polls: 2, duplicates: 0, noCompletedTiming: 0, readFailures: 0, droppedSamples: 0 },
      diagnostics: [],
      completedWindow: { matchedSourceFrames: 2, unobservedSourceFrames: 2, boundarySamples: 0 },
    },
  };
}
test('overlapping intervals partition the measured envelope without summing into latency', () => {
  const a = gpuTimelineFrame(frame());
  assert.equal(a.repeatedCoverageMs, 21);
  assert.equal(a.measuredIntervalUnionMs, 15);
  assert.equal(a.measuredTimestampEnvelopeMs, 15);
  assert.equal(a.wholeFrameGpuDurationMs, null);
  assert.equal(a.repeatedCoverageBeyondUnionMs, 6);
  assert.equal(a.uncoveredInsideEnvelopeMs, 0);
  assert.equal(a.maxMeasuredPassDepth, 3);
  assert.deepEqual(
    Object.fromEntries(a.coverageByExecutionDepth.map((x) => [x.depth, x.coverageMs])),
    { 1: 10, 2: 4, 3: 1 },
  );
  assert.deepEqual(
    a.semanticCoverage.map((p) => [
      p.passName,
      p.intervalUnionMs,
      p.soleMeasuredSemanticCoverageMs,
      p.sharedMeasuredSemanticCoverageMs,
    ]),
    [
      ['A', 10, 5, 5],
      ['B', 10, 5, 5],
      ['C', 1, 0, 1],
    ],
  );
  assert.deepEqual(
    a.overlaps.map((p) => [p.left.passName, p.right.passName, p.overlapMs]),
    [
      ['A', 'B', 5],
      ['A', 'C', 1],
      ['B', 'C', 1],
    ],
  );
  assert.equal(a.firstMeasuredTick, String(base));
  assert.equal(a.executions[2].beginRelativeToFirstMeasuredMs, 7);
});
test('internal gaps remain uncovered measured time, never proof of GPU idle', () => {
  const a = gpuTimelineFrame(
    frame([
      ['A', 0, 2],
      ['B', 5, 8],
    ]),
  );
  assert.equal(a.measuredTimestampEnvelopeMs, 8);
  assert.equal(a.measuredIntervalUnionMs, 5);
  assert.equal(a.uncoveredInsideEnvelopeMs, 3);
});
test('same semantic repeated executions merge coverage while retaining repeated duration', () => {
  const a = gpuTimelineFrame(
    frame([
      ['A', 0, 10],
      ['A', 5, 15],
    ]),
  );
  assert.equal(a.semanticCoverage.length, 1);
  assert.equal(a.semanticCoverage[0].repeatedDurationMs, 20);
  assert.equal(a.semanticCoverage[0].intervalUnionMs, 15);
  assert.equal(a.semanticCoverage[0].soleMeasuredSemanticCoverageMs, 15);
  assert.equal(a.overlaps.length, 0);
  assert.equal(a.maxMeasuredPassDepth, 2);
  assert.equal(a.maxMeasuredSemanticDepth, 1);
});
test('equal ticks and empty complete rosters retain quantization and unknown whole frame duration', () => {
  const a = gpuTimelineFrame(frame([['A', 0, 0]]));
  assert.equal(a.equalTickExecutions, 1);
  assert.equal(a.measuredTimestampEnvelopeMs, 0);
  assert.equal(a.semanticCoverage[0].intervalUnionMs, 0);
  assert.equal(a.wholeFrameGpuDurationMs, null);
  assert.deepEqual(gpuTimelineFrame(frame([])), {
    timed: false,
    reason: 'no-measured-pass-boundary',
    wholeFrameGpuDurationMs: null,
  });
});
test('view, kind, copy envelope and timestamp period retain separate semantics', () => {
  const f = frame([
    ['A', 0, 10],
    ['A', 5, 15],
    ['A', 7, 8],
  ]);
  f.timestampPeriodNanoseconds = 0.5;
  f.passes[0].viewId = 0;
  f.passes[1].viewId = 1;
  f.passes[2].passKind = 'copy';
  f.passes[2].measurementSource = 'copy-boundary-envelope';
  for (const p of f.passes) p.durationNanoseconds *= 0.5;
  f.measuredPassNanoseconds *= 0.5;
  const a = gpuTimelineFrame(f);
  assert.equal(a.measuredTimestampEnvelopeMs, 7.5);
  assert.equal(a.semanticCoverage.length, 3);
  assert.equal(a.semanticCoverage[2].measurementSource, 'copy-boundary-envelope');
  assert.equal(a.overlaps[0].overlapMs, 2.5);
});

test('unsafe tick range or aggregate conversion rejects instead of rounding', () => {
  const f = frame([
    ['A', 0, 1],
    ['B', 2, 3],
  ]);
  f.passes[1].beginningTick = String(base + BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  f.passes[1].endTick = String(base + BigInt(Number.MAX_SAFE_INTEGER) + 1000001n);
  assert.throws(() => gpuTimelineFrame(f), /exact bounded tick conversion/);
  const g = frame([
    ['A', 0, 1],
    ['B', 0, 1],
  ]);
  for (const p of g.passes) {
    p.endTick = String(base + BigInt(Number.MAX_SAFE_INTEGER));
    p.durationNanoseconds = Number.MAX_SAFE_INTEGER;
  }
  g.measuredPassNanoseconds = Number.MAX_SAFE_INTEGER * 2;
  assert.throws(() => gpuTimelineFrame(g), /coverage exceeds exact bounded/);
});
test('existing producer parser remains the authority for pass counts, ticks and durations', () => {
  for (const mutate of [
    (f) => f.measuredPassCount++,
    (f) => f.passes[0].durationNanoseconds++,
    (f) => (f.passes[1].executionIndex = 0),
    (f) => (f.passes[0].endTick = '1'),
    (f) => (f.timestampPeriodNanoseconds = 0),
  ]) {
    const f = frame();
    mutate(f);
    assert.throws(() => gpuTimelineFrame(f));
  }
});
test('negative, partial, dropped and empty observations never enter timed distributions', () => {
  const partial = row(101, 11);
  partial.observation.status = 'partial';
  const dropped = row(102, 12);
  dropped.observation.frame.droppedPassCount = 1;
  dropped.observation.frame.executedPassCount++;
  const empty = row(105, 15);
  empty.observation.frame = frame([], 15);
  const a = analyzeGpuTimeline(
    [
      row(),
      partial,
      dropped,
      {
        worldIdentity: 'world-1',
        frameId: 103,
        observation: { status: 'failed', error: 'read failed' },
      },
      {
        worldIdentity: 'world-1',
        frameId: 104,
        observation: { status: 'unavailable', reason: { code: 'unsupported' } },
      },
      empty,
    ],
    options,
  );
  assert.equal(a.timedCompleteFrames, 1);
  assert.equal(a.completeFramesWithoutMeasuredBoundary, 1);
  assert.equal(a.negativeObservations.length, 4);
  assert.equal(a.selectedCounts.partialFrames, 2);
  assert.equal(a.selectedCounts.failed, 1);
  assert.equal(a.selectedCounts.unavailable, 1);
  assert.equal(a.groups[0].metrics.measuredTimestampEnvelopeMs.count, 1);
});
test('identical duplicate receipts deduplicate and conflicting observations or source mappings reject', () => {
  const a = row();
  assert.equal(analyzeGpuTimeline([a, structuredClone(a)], options).timedCompleteFrames, 1);
  assert.equal(analyzeGpuTimeline([a, structuredClone(a)], options).duplicateSourceRows, 1);
  const b = structuredClone(a);
  b.observation.frame.graphGeneration = 2;
  assert.throws(() => analyzeGpuTimeline([a, b], options), /Conflicting observations/);
  assert.throws(() => analyzeGpuTimeline([row(), row(101, 10)], options), /multiple source/);
  assert.throws(
    () => analyzeGpuTimeline([row(), row(100, 11)], options),
    /Conflicting observation for source/,
  );
});
test('source and renderer are separate monotonic identities and resets require an explicit epoch', () => {
  const a = analyzeGpuTimeline([row(), row(101, 11)], options);
  assert.equal(a.frames[0].sourceFrameId, 100);
  assert.equal(a.frames[0].rendererFrameId, 10);
  assert.throws(() => analyzeGpuTimeline([row(), row(101, 9)], options), /order reset/);
  const b = row(101, 1);
  b.observation.frame.deviceGeneration = 1;
  assert.equal(analyzeGpuTimeline([row(), b], options).groups.length, 2);
  const c = row(1, 1);
  c.worldIdentity = 'world-2';
  assert.equal(analyzeGpuTimeline([row(), c], options).groups.length, 2);
});
test('exact LIVE completion selection includes closing receipts and preserves missing and boundary sources', () => {
  const a = analyzeGpuTimeline([row(99, 9), row(), row(102, 12), row(103, 13)], {
    ...options,
    completedWindow: window(),
  });
  assert.equal(a.sourceCoverage.selectedCompletedReceipts, 3);
  assert.equal(a.sourceCoverage.observedSourceReceipts, 2);
  assert.equal(a.sourceCoverage.unobservedSourceReceipts, 1);
  assert.equal(a.sourceCoverage.boundarySamples, 2);
  assert.deepEqual(
    a.frames.map((f) => f.sourceFrameId),
    [100, 102],
  );
  assert.equal(a.frames[1].relativeToSelectedSeconds, 0.2);
  assert.equal(a.sourceCoverage.captureIdentity, 'caller-supplied-unverified');
  const wrong = row();
  wrong.observation.frame.deviceGeneration = 1;
  assert.equal(completedGpuSelection([wrong], window(), options).rows.length, 0);
  const other = row();
  other.worldIdentity = 'other-world';
  assert.equal(completedGpuSelection([other], window(), options).rows.length, 0);
});
test('bad completed order, cross-device source reuse and conflicting duplicates fail closed', () => {
  const a = window();
  a.frames[1].at = -1;
  assert.throws(() => completedGpuSelection([row()], a, options), /Descending/);
  const b = window();
  b.frames.push({ ...receipt(101, 200), deviceGeneration: 1 });
  assert.throws(() => completedGpuSelection([row()], b, options), /reused across device/);
  const c = window();
  c.frames.push({ ...receipt(101, 200), other: 1 });
  assert.throws(() => completedGpuSelection([row()], c, options), /Conflicting duplicate/);
});
test('semantic absence is not a zero duration observation', () => {
  const next = row(101, 11);
  next.observation.frame = frame([['A', 0, 2]], 11);
  const a = analyzeGpuTimeline([row(), next], options);
  const b = a.groups[0].semanticCoverage.find((p) => p.passName === 'B');
  assert.equal(b.observedFrames, 1);
  assert.equal(b.absentTimedCompleteFrames, 1);
  assert.equal(b.intervalUnionMs.mean, 10);
  assert.equal(b.intervalUnionMs.count, 1);
});
test('report-owned file, clock, full roster and collector failures are independently qualified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpu-qualification-'));
  try {
    const inputPath = join(dir, 'report.json'),
      windowPath = join(dir, 'ordinary-frames.json');
    await writeFile(inputPath, '{}');
    await writeFile(windowPath, '{}');
    const facts = await qualifyGameGpuCapture(report(), window(), { inputPath, windowPath });
    assert.equal(facts.requiresAttention, false);
    assert.equal(facts.fullWindowSourceCoverage.unobservedSourceReceipts, 2);
    const broken = report();
    broken.gpu.counts.readFailures = 1;
    assert.equal(
      (await qualifyGameGpuCapture(broken, window(), { inputPath, windowPath })).requiresAttention,
      true,
    );
    const other = join(dir, 'other.json');
    await writeFile(other, '{}');
    await assert.rejects(
      qualifyGameGpuCapture(report(), window(), { inputPath, windowPath: other }),
      /differs from report reference/,
    );
    const badClock = window();
    badClock.timeOrigin++;
    await assert.rejects(
      qualifyGameGpuCapture(report(), badClock, { inputPath, windowPath }),
      /clock identities/,
    );
    const badRoster = report();
    badRoster.gpu.completedWindow.matchedSourceFrames++;
    await assert.rejects(
      qualifyGameGpuCapture(badRoster, window(), { inputPath, windowPath }),
      /membership differs/,
    );
    const badIntervals = report();
    badIntervals.windows.ordinary.timing.completedIntervals++;
    await assert.rejects(
      qualifyGameGpuCapture(badIntervals, window(), { inputPath, windowPath }),
      /populations differ/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('CLI hashes originals, creates output exclusively and retains partial collector exit status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpu-cli-'));
  try {
    const inputPath = join(dir, 'report.json'),
      windowPath = join(dir, 'ordinary-frames.json'),
      output = join(dir, 'timeline.json');
    await writeFile(inputPath, JSON.stringify(report()));
    await writeFile(windowPath, JSON.stringify(window()));
    const original = await readFile(inputPath, 'utf8');
    const script = fileURLToPath(new URL('../analyze_gpu_timeline.mjs', import.meta.url));
    const args = [
      script,
      inputPath,
      '--rows-pointer',
      '/gpu/samples',
      '--observation-pointer',
      '/observation',
      '--context-pointer',
      '/worldIdentity',
      '--source-frame-pointer',
      '/frameId',
      '--completed-window',
      windowPath,
      '--output',
      output,
    ];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const parsed = JSON.parse(await readFile(output, 'utf8'));
    assert.match(parsed.input.sha256, /^[a-f0-9]{64}$/);
    assert.match(parsed.analyzerSha256, /^[a-f0-9]{64}$/);
    assert.match(parsed.producerParserSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      parsed.sourceCoverage.captureIdentity,
      'report-owned-file-reference-clock-and-full-roster',
    );
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /EEXIST/);
    assert.equal(await readFile(inputPath, 'utf8'), original);
    const bad = report();
    bad.gpu.status = 'partial';
    bad.gpu.counts.droppedSamples = 1;
    await writeFile(inputPath, JSON.stringify(bad));
    const partial = spawnSync(
      process.execPath,
      [...args.slice(0, -2), '--output', join(dir, 'partial.json')],
      { encoding: 'utf8' },
    );
    assert.equal(partial.status, 2, partial.stderr);
    assert.equal(
      JSON.parse(await readFile(join(dir, 'partial.json'), 'utf8')).captureQualification
        .collectorCounts.droppedSamples,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
