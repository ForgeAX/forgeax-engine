import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { analyzeCompletionReport, analyzeCompletionTiming } from '../analyze_phone_completion.mjs';
import { FRAME_CLOCK } from '../gameplay_frame_timing.mjs';
import { COMPLETION_CLOCK } from '../phone_completion_timing.mjs';

function native() {
  const events = [
    ['request-start', 0],
    ['request-return', 0],
    ['timer-schedule', 0, 0, 1, 0],
    ['timer-fire', 1, 0, 1, 0],
    ['timer-return', 1, 0, 1, 0],
    ['poll-enter', 1],
    ['poll-return', 1, 1],
    ['free', 1],
    ['driver-resolved', 1],
  ].map(([kind, atMs, value = null, timer = 0, scheduledAtMs = null]) => ({
    kind,
    atMs,
    value,
    timer,
    scheduledAtMs,
    ticket: 1,
  }));
  return {
    schemaVersion: 'forgeax-phone-completion-timing/1',
    clock: COMPLETION_CLOCK,
    startMs: 0,
    endMs: 10,
    capacity: 64,
    count: events.length,
    events,
    overflow: { dropped: 0 },
    coverage: {
      armed: true,
      restored: true,
      clockErrors: 0,
      observationErrors: 0,
      abiErrors: 0,
      unpairedSchedules: 0,
      nativeHosts: 1,
      syncImports: 1,
      driverCalls: 1,
      clientWaitUnavailable: 0,
      restoreConflicts: 0,
    },
  };
}
function report() {
  const frameEvents = [
    ['request', 0.5, 1, 0.5],
    ['callback-enter', 1, 1, 0.5],
    ['callback-exit', 3, 1, 0.5],
    ['request', 3.5, 2, 3.5],
    ['callback-enter', 4, 2, 3.5],
    ['callback-exit', 4.1, 2, 3.5],
    ['request', 6.5, 3, 6.5],
    ['callback-enter', 7, 3, 6.5],
    ['callback-exit', 9, 3, 6.5],
  ].map(([kind, atMs, requestId, scheduledAtMs]) => ({ kind, atMs, requestId, scheduledAtMs }));
  return {
    kind: 'forgeax-phone-gameplay',
    status: 'complete',
    failure: null,
    mode: 'timed',
    cleanFpsEvidence: false,
    source: {
      engineCommit: 'a'.repeat(40),
      manifestSha256: 'b'.repeat(64),
      privateIdentifier: 'must-not-export',
    },
    capture: {
      schemaVersion: 'forgeax-gameplay-capture/1',
      status: 'complete',
      failure: null,
      startMs: 0,
      endMs: 10,
      capacity: 16,
      drain: { success: true },
      events: [
        { kind: 'submitted', atMs: 2, frameId: 1 },
        { kind: 'completed', atMs: 6, frameId: 1 },
        { kind: 'submitted', atMs: 8, frameId: 2 },
        { kind: 'completed', atMs: 9.5, frameId: 2 },
      ],
      completionTiming: native(),
      frameTiming: {
        schemaVersion: 'forgeax-gameplay-platform-frame-timing/1',
        clock: FRAME_CLOCK,
        startMs: 0,
        endMs: 10,
        capacity: 16,
        count: frameEvents.length,
        events: frameEvents,
        coverage: {
          clockErrors: 0,
          observationErrors: 0,
          cancelWrappingFailures: 0,
          restored: true,
        },
        overflow: { dropped: 0 },
      },
    },
  };
}

test('admitted observation joins credit return to callbacks without copying private source fields', () => {
  const result = analyzeCompletionReport(report(), { creditCap: 1 });
  assert.equal(result.completeCoverage, true);
  assert.equal(result.joint.summary.callbacksWithoutSubmissionAtCap, 1);
  assert.equal(result.joint.summary.creditToSubmittingCallbackDistinct.meanMs, 1);
  assert.equal(result.joint.summary.totalSubmissions, 2);
  assert.equal(JSON.stringify(result).includes('must-not-export'), false);
  assert.equal(
    analyzeCompletionReport(report()).joint,
    null,
    'Credit cap is explicit, not guessed',
  );
});

test('empty, malformed, backwards and unknown ABI events cannot produce qualified conclusions', () => {
  for (const mutate of [
    (c) => {
      c.events = [];
      c.count = 0;
    },
    (c) => {
      c.events.at(-1).atMs = 0.5;
    },
    (c) => {
      c.events.find((row) => row.kind === 'poll-return').value = null;
    },
    (c) => {
      c.coverage.driverCalls = 0;
    },
    (c) => {
      c.coverage.abiErrors = 1;
    },
    (c) => {
      c.overflow.dropped = 1;
    },
    (c) => {
      c.count++;
    },
    (c) => {
      c.events[0].ticket = -1;
    },
  ]) {
    const value = native();
    mutate(value);
    const result = analyzeCompletionTiming(value);
    assert.equal(result.completeCoverage, false);
    assert.equal(result.summary, null);
    assert.ok(result.errors.length);
  }
});

test('same-clock-tick polls are paired by call order and preserve false and true separately', () => {
  const value = native();
  value.events.find((row) => row.kind === 'poll-return').value = 0;
  value.events.splice(
    7,
    0,
    { kind: 'poll-enter', atMs: 1, value: null, timer: 0, scheduledAtMs: null, ticket: 1 },
    { kind: 'poll-return', atMs: 1, value: 1, timer: 0, scheduledAtMs: null, ticket: 1 },
  );
  value.count = value.events.length;
  const ticket = analyzeCompletionTiming(value).tickets[0];
  assert.deepEqual(
    ticket.polls.map((row) => row.result),
    [0, 1],
  );
  assert.equal(ticket.falsePollCount, 1);
});

test('report, CPU and joint clock failures retain an explicit ineligible verdict', () => {
  for (const mutate of [
    (r) => {
      r.status = 'partial';
      r.failure = 'original';
    },
    (r) => {
      r.source = {};
    },
    (r) => {
      r.cpu = { status: 'failed' };
    },
    (r) => {
      r.capture.drain.success = false;
    },
    (r) => {
      r.capture.frameTiming.startMs = 1000;
      r.capture.frameTiming.endMs = 1010;
    },
    (r) => {
      r.capture.frameTiming.overflow.dropped = 1;
    },
    (r) => {
      r.capture.completionTiming.startMs = -0.001;
    },
    (r) => {
      r.capture.events[2].frameId = 5;
    },
    (r) => {
      r.capture.frameTiming.clock = 'unrelated clock';
    },
  ]) {
    const value = report();
    mutate(value);
    const result = analyzeCompletionReport(value, { creditCap: 1 });
    assert.equal(result.completeCoverage, false);
    assert.equal(result.summary, null);
    assert.ok(result.errors.length);
  }
});

test('partial tickets preserve missing endpoints instead of manufacturing elapsed intervals', () => {
  const value = native();
  value.events.pop();
  value.count--;
  const result = analyzeCompletionTiming(value);
  assert.equal(result.status, 'partial');
  assert.equal(result.tickets[0].boundaryIncomplete, true);
  assert.equal(result.tickets[0].readyToDriverResolvedMs, null);
  assert.equal(result.summary.completeTickets, 0);
});

test('submissions outside Platform callbacks remain counted without assuming a credit-wake cause', () => {
  const value = report();
  value.capture.events[2].atMs = 6.25;
  const result = analyzeCompletionReport(value, { creditCap: 1 });
  assert.equal(result.completeCoverage, true);
  assert.equal(result.joint.summary.totalSubmissions, 2);
  assert.equal(result.joint.summary.submissionsInsideCompleteCallback, 1);
  assert.equal(result.joint.summary.submissionsOutsideCompleteCallback, 1);
  assert.equal(result.joint.submissions[1].cause, 'not-observed');
  assert.equal(result.joint.submissions[1].priorCompletionToSubmissionMs, 0.25);
});

test('frame/window/clock admission is required even without credit inference', () => {
  for (const mutate of [
    (r) => {
      delete r.capture.frameTiming;
    },
    (r) => {
      r.capture.frameTiming.overflow.dropped = 1;
    },
    (r) => {
      r.capture.frameTiming.clock = 'Date.now';
    },
    (r) => {
      r.capture.completionTiming.startMs = -0.001;
    },
  ]) {
    const value = report();
    mutate(value);
    const result = analyzeCompletionReport(value);
    assert.equal(result.completeCoverage, false);
    assert.equal(result.summary, null);
  }
});

test('analysis and fixture modules import from stdin without running their CLI', () => {
  const urls = ['../analyze_phone_completion.mjs', '../build_completion_timing_fixture.mjs'].map(
    (path) => new URL(path, import.meta.url).href,
  );
  assert.equal(
    execFileSync(process.execPath, ['--input-type=module', '-'], {
      input: urls.map((url) => `await import(${JSON.stringify(url)});`).join('\n'),
      encoding: 'utf8',
    }),
    '',
  );
});

function assertSubmissionLocations(result, expected) {
  const summary = result.joint.summary;
  const actual = [
    summary.submissionsInsideCompleteCallback,
    summary.submissionsAtCallbackBoundary,
    summary.submissionsOutsideCompleteCallback,
    summary.submissionsWithIncompleteCallbackCoverage,
  ];
  assert.deepEqual(actual, expected);
  assert.equal(
    actual.reduce((sum, count) => sum + count, 0),
    summary.totalSubmissions,
  );
  for (const row of result.joint.submissions) assert.equal(row.cause, 'not-observed');
}

test('equal callback enter or exit timestamps stay boundary ambiguous, never outside', () => {
  for (const atMs of [1, 3]) {
    const value = report();
    value.capture.events[0].atMs = atMs;
    const result = analyzeCompletionReport(value, { creditCap: 1 });
    assert.equal(result.completeCoverage, true);
    assertSubmissionLocations(result, [1, 1, 0, 0]);
    assert.equal(result.joint.submissions[0].location, 'boundary-ambiguous');
    assert.equal(result.joint.submissions[0].callbackRequestId, null);
  }
});

test('one missing callback endpoint retains unknown coverage rather than outside', () => {
  for (const missing of ['enter', 'exit']) {
    const value = report(),
      ft = value.capture.frameTiming;
    if (missing === 'enter') {
      ft.events = ft.events.filter((row) => row.requestId !== 1 || row.kind === 'callback-exit');
      ft.events.find((row) => row.requestId === 1).scheduledAtMs = -1;
    } else {
      ft.events = ft.events.filter((row) => row.requestId !== 3 || row.kind !== 'callback-exit');
    }
    ft.count = ft.events.length;
    const result = analyzeCompletionReport(value, { creditCap: 1 });
    assert.equal(result.completeCoverage, true);
    assertSubmissionLocations(result, [1, 0, 0, 1]);
    const row = result.joint.submissions[missing === 'enter' ? 0 : 1];
    assert.equal(row.location, 'incomplete-callback-coverage');
    assert.equal(row.callbackRequestId, null);
  }
});

test('pending request without callback endpoints does not invent incomplete execution', () => {
  const value = report(),
    ft = value.capture.frameTiming;
  value.capture.events[2].atMs = 6.25;
  ft.events.push({ kind: 'request', atMs: 9.75, requestId: 4, scheduledAtMs: 9.75 });
  ft.count++;
  const result = analyzeCompletionReport(value, { creditCap: 1 });
  assert.equal(result.completeCoverage, true);
  assertSubmissionLocations(result, [1, 0, 1, 0]);
  assert.equal(result.joint.submissions[1].location, 'outside-complete-callback');
});

test('strict submitting callbacks remain separate from credit-qualified callbacks', () => {
  const value = report();
  value.capture.events[1].atMs = 7;
  const result = analyzeCompletionReport(value, { creditCap: 1 });
  assert.equal(result.completeCoverage, true);
  assert.equal(result.joint.summary.callbacksWithStrictInsideSubmission, 2);
  assert.equal(result.joint.summary.creditQualifiedSubmittingCallbacks, 1);
  assert.equal('submittingCallbacks' in result.joint.summary, false);
});

function cpuReport() {
  const value = report();
  value.mode = 'cpu';
  const records = [
    [1, 1100, 2100],
    [2, 7100, 8100],
  ].map(([frameId, startMicros, endMicros]) => ({
    kind: 'phase',
    source: 'app',
    phase: 'frame-total',
    frameId,
    startMicros,
    endMicros,
    durationMicros: endMicros - startMicros,
  }));
  value.cpu = {
    schemaVersion: 'forgeax-phone-gameplay-cpu/1',
    clock: 'platform.now milliseconds -> microseconds',
    diagnosticOnly: true,
    cleanFpsEvidence: false,
    status: 'complete',
    validation: { ok: true },
    coverage: { ownerCoverageComplete: true, completedAppFrames: 2, rendererFrames: 2 },
    capture: {
      schemaVersion: '1.0',
      timeUnit: 'microseconds',
      frameLimit: 2,
      records,
      completeness: { status: 'complete', droppedEventCount: 0, retainedEventCount: 2 },
    },
  };
  // CPU IDs are capture-local. Receipt IDs belong to the Renderer.
  for (const event of value.capture.events) event.frameId += 100;
  return value;
}

test('CPU gaps use local frame continuity and unique temporal receipt adjacency without guessing IDs', () => {
  const result = analyzeCompletionReport(cpuReport());
  assert.equal(result.joint, null, 'CPU timing does not require a credit cap');
  const timing = result.cpuFrameTiming;
  assert.equal(timing.status, 'complete');
  assert.deepEqual(
    timing.frames.map((row) => row.submittedFrameId),
    [101, 102],
  );
  assert.equal(timing.gaps[0].completedFrameId, 101);
  assert.equal(timing.gaps[0].completedCpuFrameId, 1);
  assert.equal(timing.gaps[0].elapsedMs, 5);
  assert.equal(timing.gaps[0].previousCpuEndToCompletionMs, 3.9);
  assert.equal(timing.gaps[0].completionToNextCpuStartMs, 1.1);
  assert.equal(timing.summary.singleReceiptGaps, 1);
  assert.equal(result.summary.cpuFrameTiming, timing.summary);
});

test('a resumed CPU frame outside callbacks uses the same gap metric, not the later Host callback', () => {
  const value = cpuReport();
  value.capture.events[2].atMs = 6.25;
  Object.assign(value.cpu.capture.records[1], {
    startMicros: 6010,
    endMicros: 6300,
    durationMicros: 290,
  });
  const result = analyzeCompletionReport(value, { creditCap: 1 });
  assert.equal(result.joint.submissions[1].location, 'outside-complete-callback');
  assert.equal(result.cpuFrameTiming.gaps[0].completionToNextCpuStartMs, 0.01);
  assert.equal(result.cpuFrameTiming.frames[1].submittedFrameId, 102);
  assert.match(result.cpuFrameTiming.scope, /not causality/);
});

test('CPU submission endpoint ambiguity does not erase independently observed gap intervals', () => {
  const value = cpuReport();
  value.capture.events[0].atMs = 2.10000001;
  const result = analyzeCompletionReport(value, { creditCap: 1 });
  const timing = result.cpuFrameTiming;
  assert.equal(timing.frames[0].submittedFrameId, null);
  assert.equal(timing.frames[0].submissionUnknownReason, 'submission-at-cpu-boundary');
  assert.equal(timing.gaps[0].completedFrameId, 101);
  assert.equal(timing.gaps[0].completedCpuFrameId, null);
  assert.equal(timing.gaps[0].completionToNextCpuStartMs, 1.1);
  assert.equal(timing.summary.uniquelyMatchedSubmissions, 1);
});

test('equal quantized CPU/receipt boundaries retain unknown ordering instead of manufactured zero latency', () => {
  for (const atMs of [2.10000001, 7.10000001]) {
    const value = cpuReport();
    value.capture.events[1].atMs = atMs;
    const timing = analyzeCompletionReport(value).cpuFrameTiming;
    assert.equal(timing.gaps[0].unknownReason, 'receipt-at-cpu-boundary');
    assert.equal(timing.gaps[0].completionToNextCpuStartMs, null);
    assert.equal(timing.summary.completionToNextCpuStart, null);
    assert.equal(timing.gaps[0].elapsedMs, 5);
  }
});

test('cap-two overlap never forces the previous CPU frame receipt into a negative interval', () => {
  const value = cpuReport();
  value.capture.events = [
    { kind: 'completed', atMs: 0.9, frameId: 99 },
    { kind: 'submitted', atMs: 2, frameId: 101 },
    { kind: 'completed', atMs: 6, frameId: 100 },
    { kind: 'submitted', atMs: 8, frameId: 102 },
    { kind: 'completed', atMs: 8.5, frameId: 101 },
    { kind: 'completed', atMs: 9.5, frameId: 102 },
  ];
  const timing = analyzeCompletionReport(value).cpuFrameTiming;
  assert.equal(timing.gaps[0].completedFrameId, 100);
  assert.equal(
    timing.gaps[0].completedCpuFrameId,
    null,
    'older CPU frame is outside profiler capture',
  );
  assert.equal(timing.frames[0].submittedFrameId, 101);
  assert.equal(timing.gaps[0].completionToNextCpuStartMs, 1.1);
});

test('no receipt and multiple receipts keep their identities but no selected split', () => {
  for (const count of [0, 2]) {
    const value = cpuReport();
    if (count === 0) {
      value.capture.events[1].atMs = 8.5;
      value.capture.events.sort((a, b) => a.atMs - b.atMs);
    } else {
      value.capture.events.unshift({ kind: 'completed', atMs: 4, frameId: 100 });
      value.capture.events.sort((a, b) => a.atMs - b.atMs);
    }
    const timing = analyzeCompletionReport(value).cpuFrameTiming;
    assert.equal(
      timing.gaps[0].unknownReason,
      count ? 'multiple-receipts-in-gap' : 'no-receipt-in-gap',
    );
    assert.equal(timing.gaps[0].completedFrameId, null);
    assert.equal(timing.gaps[0].completionToNextCpuStartMs, null);
    assert.equal(timing.gaps[0].receiptFrameIds.length, count);
  }
});

test('missing local CPU frames cannot be bridged into a claimed adjacent gap', () => {
  const value = cpuReport();
  value.cpu.capture.records[1].frameId = 3;
  const timing = analyzeCompletionReport(value).cpuFrameTiming;
  assert.equal(timing.gaps[0].unknownReason, 'nonconsecutive-cpu-frames');
  assert.equal(timing.gaps[0].elapsedMs, null);
  assert.equal(timing.summary.elapsedBetweenCpuFrames, null);
});

test('missing, duplicate, overlapping and out-of-window CPU frame roots stay explicit', () => {
  for (const [expected, mutate] of [
    [
      'missing-cpu-frame-total',
      (r) => {
        r[0].phase = 'renderer-draw';
      },
    ],
    [
      'duplicate-cpu-frame-total',
      (r) => {
        r.push({ ...r[0] });
      },
    ],
    [
      'overlapping-cpu-frames',
      (r) => {
        Object.assign(r[0], { endMicros: 7500, durationMicros: 6400 });
      },
    ],
    [
      'cpu-frame-at-window-boundary',
      (r) => {
        Object.assign(r[0], { startMicros: 0, durationMicros: 2100 });
      },
    ],
  ]) {
    const value = cpuReport();
    mutate(value.cpu.capture.records);
    value.cpu.capture.completeness.retainedEventCount = value.cpu.capture.records.length;
    const timing = analyzeCompletionReport(value).cpuFrameTiming;
    assert.equal(timing.frames[0].unknownReason, expected);
    assert.equal(timing.frames[0].submittedFrameId, null);
    assert.equal(timing.gaps[0].elapsedMs, null);
  }
});

test('CPU association needs its qualified producer and clock; missing CPU is a supported unavailable result', () => {
  assert.equal(
    analyzeCompletionReport(report()).cpuFrameTiming.unavailableReason,
    'cpu-not-captured',
  );
  for (const mutate of [
    (cpu) => {
      cpu.clock = 'Date.now';
    },
    (cpu) => {
      cpu.schemaVersion = 'unknown';
    },
    (cpu) => {
      cpu.capture.schemaVersion = 'unknown';
    },
  ]) {
    const value = cpuReport();
    mutate(value.cpu);
    const result = analyzeCompletionReport(value);
    assert.equal(
      result.cpuFrameTiming.unavailableReason,
      'cpu-producer-clock-contract-unqualified',
    );
    assert.equal(result.cpuFrameTiming.summary, null);
  }
  const value = cpuReport();
  value.cpu.coverage.ownerCoverageComplete = false;
  const result = analyzeCompletionReport(value);
  assert.equal(result.completeCoverage, false, 'original CPU coverage gate is preserved');
  assert.equal(result.summary, null);
  assert.equal(result.cpuFrameTiming.summary, null);
});

test('large Platform epochs retain integer-microsecond ordering without a guessed clock offset', () => {
  const value = cpuReport();
  const epoch = 1_791_907_900_000;
  for (const capture of [
    value.capture,
    value.capture.frameTiming,
    value.capture.completionTiming,
  ]) {
    capture.startMs += epoch;
    capture.endMs += epoch;
    for (const row of capture.events) {
      row.atMs += epoch;
      if (typeof row.scheduledAtMs === 'number') row.scheduledAtMs += epoch;
    }
  }
  for (const row of value.cpu.capture.records) {
    row.startMicros = Math.floor((row.startMicros / 1000 + epoch) * 1000);
    row.endMicros = Math.floor((row.endMicros / 1000 + epoch) * 1000);
    row.durationMicros = row.endMicros - row.startMicros;
  }
  const result = analyzeCompletionReport(value, { creditCap: 1 });
  assert.equal(result.completeCoverage, true);
  const gap = result.cpuFrameTiming.gaps[0];
  assert.equal(gap.unknownReason, null);
  assert.ok(Math.abs(gap.previousCpuEndToCompletionMs - 3.9) <= 0.001);
  assert.ok(Math.abs(gap.completionToNextCpuStartMs - 1.1) <= 0.001);
  assert.equal(gap.elapsedMs, gap.previousCpuEndToCompletionMs + gap.completionToNextCpuStartMs);
});

test('an unobserved CPU root and a receipt identity inconsistency cannot be silently joined', () => {
  const value = cpuReport();
  value.cpu.capture.records = [];
  value.cpu.capture.completeness.retainedEventCount = 0;
  assert.equal(
    analyzeCompletionReport(value).cpuFrameTiming.unavailableReason,
    'cpu-frame-records-missing',
  );
  const inconsistent = cpuReport();
  inconsistent.capture.events[1].atMs = 0.9;
  inconsistent.capture.events.sort((a, b) => a.atMs - b.atMs);
  assert.equal(
    analyzeCompletionReport(inconsistent).cpuFrameTiming.unavailableReason,
    'report-ineligible',
  );
});

test('zero/multiple contained submissions and touching CPU intervals remain unknown', () => {
  const missing = cpuReport();
  missing.capture.events.shift();
  assert.equal(
    analyzeCompletionReport(missing).cpuFrameTiming.frames[0].submissionUnknownReason,
    'no-submission-in-cpu-frame',
  );
  const multiple = cpuReport();
  multiple.capture.events[2].atMs = 2.05;
  multiple.capture.events.sort((a, b) => a.atMs - b.atMs);
  assert.equal(
    analyzeCompletionReport(multiple).cpuFrameTiming.frames[0].submissionUnknownReason,
    'multiple-submissions-in-cpu-frame',
  );
  const touching = cpuReport();
  Object.assign(touching.cpu.capture.records[1], { startMicros: 2100, durationMicros: 6000 });
  assert.equal(
    analyzeCompletionReport(touching).cpuFrameTiming.gaps[0].unknownReason,
    'unordered-cpu-frame-boundaries',
  );
});

test('malformed integer CPU clocks and dropped CPU samples preserve original report rejection', () => {
  for (const mutate of [
    (cpu) => {
      cpu.capture.records[0].startMicros += 0.1;
    },
    (cpu) => {
      cpu.capture.records[0].endMicros = Number.MAX_SAFE_INTEGER + 1;
    },
    (cpu) => {
      cpu.capture.completeness.droppedEventCount = 1;
    },
  ]) {
    const value = cpuReport();
    mutate(value.cpu);
    const result = analyzeCompletionReport(value);
    assert.equal(result.completeCoverage, false);
    assert.equal(result.summary, null);
    assert.equal(result.cpuFrameTiming.unavailableReason, 'report-ineligible');
  }
});

test('a duplicate root cannot hide its overlap and manufacture another frame or gap association', () => {
  const value = cpuReport();
  value.cpu.capture.frameLimit = 3;
  value.cpu.coverage.completedAppFrames = 3;
  value.cpu.coverage.rendererFrames = 3;
  value.cpu.capture.records.push(
    { ...value.cpu.capture.records[0], endMicros: 9400, durationMicros: 8300 },
    {
      ...value.cpu.capture.records[1],
      frameId: 3,
      startMicros: 9100,
      endMicros: 9300,
      durationMicros: 200,
    },
  );
  value.cpu.capture.records.sort((a, b) => a.frameId - b.frameId);
  value.cpu.capture.completeness.retainedEventCount = 4;
  value.capture.events = [
    { kind: 'submitted', atMs: 2, frameId: 101 },
    { kind: 'submitted', atMs: 8, frameId: 102 },
    { kind: 'completed', atMs: 8.5, frameId: 101 },
    { kind: 'submitted', atMs: 9.2, frameId: 103 },
    { kind: 'completed', atMs: 9.5, frameId: 102 },
    { kind: 'completed', atMs: 9.7, frameId: 103 },
  ];
  const timing = analyzeCompletionReport(value).cpuFrameTiming;
  assert.equal(timing.frames[0].unknownReason, 'duplicate-cpu-frame-total');
  assert.equal(timing.frames[1].unknownReason, 'incomplete-cpu-frame-coverage');
  assert.ok(timing.frames.every((row) => row.submittedFrameId === null));
  assert.ok(timing.gaps.every((row) => row.elapsedMs === null && row.completedFrameId === null));
  assert.equal(timing.summary.elapsedBetweenCpuFrames, null);
});

test('receipt streams cannot complete future unsubmitted frames even when the cap is unknown', () => {
  const value = cpuReport();
  for (const row of value.capture.events) if (row.kind === 'completed') row.frameId += 100;
  const result = analyzeCompletionReport(value);
  assert.equal(result.completeCoverage, false);
  assert.equal(result.summary, null);
  assert.equal(result.cpuFrameTiming.summary, null);
});
