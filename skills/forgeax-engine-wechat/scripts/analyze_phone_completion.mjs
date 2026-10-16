import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { FRAME_CLOCK } from './gameplay_frame_timing.mjs';
import { COMPLETION_CLOCK } from './phone_completion_timing.mjs';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const completionKinds = new Set([
  'request-start',
  'request-return',
  'poll-enter',
  'poll-return',
  'free',
  'driver-resolved',
  'driver-rejected',
  'timer-schedule',
  'timer-fire',
  'timer-return',
  'sync-query-enter',
  'sync-query-return',
  'client-wait-enter',
  'client-wait-return',
  'native-throw',
]);
const frameKinds = new Set([
  'request',
  'callback-enter',
  'callback-exit',
  'cancel',
  'request-error',
]);
const resultScope =
  'CPU-observed scheduling and delivery intervals. Native pending and GL status are not GPU elapsed time; gaps are not idle CPU time. No FPS acceptance.';

function invalid(errors) {
  return {
    status: 'invalid',
    diagnosticOnly: true,
    completeCoverage: false,
    errors,
    summary: null,
    tickets: [],
  };
}
function validateEvents(capture, schema, kinds, maxCapacity = 262144) {
  if (
    capture?.schemaVersion !== schema ||
    !finite(capture.startMs) ||
    !finite(capture.endMs) ||
    capture.endMs <= capture.startMs ||
    capture.endMs - capture.startMs > 120000 ||
    !integer(capture.capacity) ||
    capture.capacity < 1 ||
    capture.capacity > maxCapacity ||
    !Array.isArray(capture.events) ||
    !capture.events.length ||
    capture.events.length > capture.capacity ||
    (capture.count !== undefined && capture.count !== capture.events.length)
  )
    return 'invalid-capture-envelope';
  let previous = capture.startMs;
  for (const event of capture.events) {
    if (
      !kinds.has(event?.kind) ||
      !finite(event.atMs) ||
      event.atMs < previous ||
      event.atMs < capture.startMs ||
      event.atMs >= capture.endMs
    )
      return 'invalid-event-order-or-window';
    previous = event.atMs;
  }
  return null;
}
function stats(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return {
    samples: sorted.length,
    meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}
function groups(events, field) {
  const result = new Map();
  for (const event of events) {
    const id = event[field];
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(event);
  }
  return result;
}
// Pair by event order, not timestamp search: distinct calls may share one clock tick.
function pairs(rows, enterKind, returnKind) {
  const result = [];
  let pending = null,
    malformed = false;
  for (const row of rows) {
    if (row.kind === enterKind) {
      if (pending) malformed = true;
      pending = row;
    } else if (row.kind === returnKind) {
      if (pending) result.push({ enter: pending, returned: row });
      else malformed = true;
      pending = null;
    }
  }
  return { result, incomplete: malformed || pending !== null };
}

export function analyzeCompletionTiming(capture, { lateMs = 2 } = {}) {
  if (!finite(lateMs) || lateMs < 0) return invalid(['invalid-lateness-threshold']);
  const error = validateEvents(
    capture,
    'forgeax-phone-completion-timing/1',
    completionKinds,
    65536,
  );
  if (error) return invalid([error]);
  for (const row of capture.events) {
    if (
      !integer(row.ticket) ||
      !integer(row.timer) ||
      !(row.value === null || finite(row.value)) ||
      !(row.scheduledAtMs === null || finite(row.scheduledAtMs))
    )
      return invalid(['invalid-completion-event']);
  }
  const c = capture.coverage,
    o = capture.overflow;
  const errors = [];
  if (
    !c ||
    !o ||
    o.dropped !== 0 ||
    c.clockErrors !== 0 ||
    c.observationErrors !== 0 ||
    c.unpairedSchedules !== 0 ||
    c.nativeHosts !== 1 ||
    !integer(c.syncImports) ||
    c.syncImports < 1 ||
    !integer(c.driverCalls) ||
    c.driverCalls < 1 ||
    c.clientWaitUnavailable !== 0 ||
    c.restoreConflicts !== 0 ||
    c.restored !== true ||
    c.armed !== true ||
    (c.abiErrors ?? 0) !== 0
  )
    errors.push('incomplete-observation-coverage');
  const tickets = [];
  for (const [ticket, rows] of groups(
    capture.events.filter((row) => row.ticket > 0),
    'ticket',
  )) {
    const starts = rows.filter((row) => row.kind === 'request-start');
    const returns = rows.filter((row) => row.kind === 'request-return');
    const pollPairs = pairs(rows, 'poll-enter', 'poll-return');
    const polls = rows.filter((row) => row.kind === 'poll-return');
    const ready = polls.find((row) => row.value === 1);
    const resolved = rows.filter((row) => row.kind === 'driver-resolved');
    const free = rows.filter((row) => row.kind === 'free');
    const timers = [];
    for (const [timer, timerRows] of groups(
      rows.filter((row) => row.kind.startsWith('timer-')),
      'timer',
    )) {
      const schedule = timerRows.filter((row) => row.kind === 'timer-schedule');
      const fire = timerRows.filter((row) => row.kind === 'timer-fire');
      const returned = timerRows.filter((row) => row.kind === 'timer-return');
      const complete =
        timer > 0 &&
        schedule.length === 1 &&
        fire.length === 1 &&
        returned.length === 1 &&
        [0, 1].includes(schedule[0].value) &&
        fire[0].value === schedule[0].value &&
        fire[0].scheduledAtMs === schedule[0].atMs &&
        schedule[0].atMs <= fire[0].atMs &&
        fire[0].atMs <= returned[0].atMs;
      timers.push({
        timer,
        boundaryIncomplete: !complete,
        actualDelayMs: complete ? fire[0].atMs - schedule[0].atMs : null,
        excessDelayMs: complete ? fire[0].atMs - schedule[0].atMs - schedule[0].value : null,
      });
    }
    const unknownPollCount = polls.filter((row) => row.value !== 0 && row.value !== 1).length;
    const rejected = rows.some(
      (row) => row.kind === 'driver-rejected' || row.kind === 'native-throw',
    );
    const boundaryIncomplete =
      starts.length !== 1 ||
      returns.length !== 1 ||
      !ready ||
      resolved.length !== 1 ||
      free.length !== 1 ||
      pollPairs.incomplete ||
      !timers.length ||
      timers.some((row) => row.boundaryIncomplete) ||
      (starts.length === 1 && returns.length === 1 && starts[0].atMs > returns[0].atMs) ||
      (ready && resolved.length === 1 && ready.atMs > resolved[0].atMs);
    const lateTimers = timers.filter(
      (row) => row.excessDelayMs !== null && row.excessDelayMs > lateMs,
    );
    const clientWait = pairs(rows, 'client-wait-enter', 'client-wait-return');
    tickets.push({
      ticket,
      boundaryIncomplete,
      unknownPollCount,
      rejected,
      incompleteTimerIds: timers.filter((row) => row.boundaryIncomplete).map((row) => row.timer),
      falsePollCount: polls.filter((row) => row.value === 0).length,
      pollCount: polls.length,
      lateTimerCount: lateTimers.length,
      maxTimerExcessMs: Math.max(0, ...lateTimers.map((row) => row.excessDelayMs)),
      readyToDriverResolvedMs:
        ready && resolved.length === 1 && ready.atMs <= resolved[0].atMs
          ? resolved[0].atMs - ready.atMs
          : null,
      rawSyncImportReturnValues: rows
        .filter((row) => row.kind === 'sync-query-return')
        .map((row) => row.value),
      rawSyncImportQualification:
        'Uninterpreted import returns; wasm-bindgen may return externref indices.',
      zeroTimeoutWaitsTimedOut: clientWait.result.filter(
        (row) => row.enter.value === 0 && row.returned.value === 0x911b,
      ).length,
      signals: {
        timerLate: lateTimers.length > 0,
        nativePendingObserved: polls.some((row) => row.value === 0),
        orderedDeliveryDelayed:
          !!ready && resolved.length === 1 && resolved[0].atMs - ready.atMs > lateMs,
        rejected,
      },
      polls: pollPairs.result.map((row) => ({
        result: row.returned.value,
        elapsedMs: row.returned.atMs - row.enter.atMs,
      })),
      timers,
    });
  }
  if (!tickets.length) errors.push('no-observed-driver-tickets');
  if (tickets.some((row) => row.unknownPollCount)) errors.push('unknown-native-poll-abi');
  if (tickets.some((row) => row.rejected)) errors.push('native-driver-failed');
  const completeCoverage = errors.length === 0;
  const complete = tickets.filter(
    (row) => !row.boundaryIncomplete && !row.unknownPollCount && !row.rejected,
  );
  return {
    schemaVersion: 'forgeax-phone-completion-timing-analysis/1',
    status: completeCoverage && complete.length === tickets.length ? 'complete' : 'partial',
    diagnosticOnly: true,
    scope: resultScope,
    completeCoverage,
    errors,
    thresholds: { lateMs },
    coverage: c,
    droppedEvents: o?.dropped ?? null,
    tickets,
    summary: completeCoverage
      ? {
          tickets: tickets.length,
          completeTickets: complete.length,
          boundaryTickets: tickets.length - complete.length,
          timerLate: complete.filter((row) => row.signals.timerLate).length,
          nativePending: complete.filter((row) => row.signals.nativePendingObserved).length,
          orderedDeliveryDelayed: complete.filter((row) => row.signals.orderedDeliveryDelayed)
            .length,
          nativePoll: stats(complete.flatMap((row) => row.polls.map((poll) => poll.elapsedMs))),
          timerExcess: stats(
            complete.flatMap((row) => row.timers.map((timer) => timer.excessDelayMs)),
          ),
          readyToDriverResolved: stats(complete.map((row) => row.readyToDriverResolvedMs)),
        }
      : null,
  };
}

function validateFrameCapture(capture) {
  const ft = capture.frameTiming;
  const errors = [];
  const error = validateEvents(ft, 'forgeax-gameplay-platform-frame-timing/1', frameKinds);
  if (error) errors.push(error);
  if (
    ft?.startMs !== capture.startMs ||
    ft?.endMs !== capture.endMs ||
    capture.completionTiming?.startMs !== capture.startMs ||
    capture.completionTiming?.endMs !== capture.endMs
  )
    errors.push('clock-windows-do-not-match');
  if (
    !ft?.coverage ||
    ft.coverage.clockErrors !== 0 ||
    ft.coverage.observationErrors !== 0 ||
    ft.coverage.cancelWrappingFailures !== 0 ||
    ft.coverage.restored !== true ||
    ft.overflow?.dropped !== 0
  )
    errors.push('incomplete-frame-observation');
  if (capture.completionTiming?.clock !== COMPLETION_CLOCK || ft?.clock !== FRAME_CLOCK)
    errors.push('unknown-clock-contract');
  if (
    !errors.length &&
    ft.events.some(
      (row) => !integer(row.requestId) || row.requestId < 1 || !finite(row.scheduledAtMs),
    )
  )
    errors.push('invalid-frame-event');
  return errors;
}

function receiptStream(capture) {
  const errors = [];
  const submitted = capture.events.filter((row) => row.kind === 'submitted');
  const completed = capture.events.filter((row) => row.kind === 'completed');
  for (const rows of [submitted, completed]) {
    if (
      !rows.length ||
      rows.some(
        (row, i) => !integer(row.frameId) || (i > 0 && row.frameId !== rows[i - 1].frameId + 1),
      )
    )
      errors.push('noncontiguous-frame-identities');
  }
  const initial = submitted[0]?.frameId - completed[0]?.frameId;
  if (!integer(initial)) errors.push('initial-credit-state-unavailable');
  let outstanding = initial;
  let highWater = initial;
  for (const row of capture.events) {
    outstanding += row.kind === 'submitted' ? 1 : -1;
    highWater = Math.max(highWater, outstanding);
    if (outstanding < 0) errors.push('inconsistent-credit-state');
  }
  return { submitted, completed, initial, highWater, errors: [...new Set(errors)] };
}

function jointTiming(capture, creditCap, receipts) {
  const ft = capture.frameTiming,
    errors = [];
  const { submitted, completed, initial, highWater } = receipts;
  if (initial > creditCap) errors.push('initial-credit-state-unavailable');
  if (highWater > creditCap) errors.push('inconsistent-credit-state');
  if (errors.length) return { status: 'invalid', errors: [...new Set(errors)], summary: null };
  const callbacks = [],
    boundaryCallbacks = [],
    incompleteCallbacks = [];
  for (const [requestId, rows] of groups(ft.events, 'requestId')) {
    const enters = rows.filter((row) => row.kind === 'callback-enter');
    const exits = rows.filter((row) => row.kind === 'callback-exit');
    const requests = rows.filter((row) => row.kind === 'request');
    if (enters.length !== 1 || exits.length !== 1) {
      boundaryCallbacks.push(requestId);
      if (enters.length > 1 || exits.length > 1) errors.push('invalid-callback-identity');
      // A pending request with no callback endpoint does not imply missing execution.
      if (enters.length || exits.length)
        incompleteCallbacks.push({
          requestId,
          enterOffsetMs: enters.length === 1 ? enters[0].atMs - capture.startMs : null,
          exitOffsetMs: exits.length === 1 ? exits[0].atMs - capture.startMs : null,
        });
      continue;
    }
    const enter = enters[0],
      exit = exits[0];
    if (exit.atMs < enter.atMs || requests.length > 1) {
      errors.push('invalid-callback-order');
      continue;
    }
    const ambiguous = capture.events.some(
      (row) => row.atMs === enter.atMs || row.atMs === exit.atMs,
    );
    const count = capture.events
      .filter((row) => row.atMs < enter.atMs)
      .reduce((depth, row) => depth + (row.kind === 'submitted' ? 1 : -1), initial);
    callbacks.push({
      requestId,
      enterOffsetMs: enter.atMs - capture.startMs,
      exitOffsetMs: exit.atMs - capture.startMs,
      boundaryIncomplete: requests.length !== 1,
      ambiguousBoundary: ambiguous,
      workMs: exit.atMs - enter.atMs,
      requestToEnterMs: requests.length === 1 ? enter.atMs - requests[0].atMs : null,
      outstandingAtEntry: ambiguous ? null : count,
      submittedCount: submitted.filter((row) => enter.atMs < row.atMs && row.atMs < exit.atMs)
        .length,
    });
  }
  callbacks.sort((a, b) => a.enterOffsetMs - b.enterOffsetMs);
  const admitted = callbacks.filter((row) => row.submittedCount === 1 && !row.ambiguousBoundary);
  const blocked = callbacks.filter(
    (row) => row.submittedCount === 0 && row.outstandingAtEntry === creditCap,
  );
  const handoffs = [];
  for (const callback of blocked) {
    const completion = completed.find((row) => row.atMs - capture.startMs > callback.exitOffsetMs);
    const next =
      completion && admitted.find((row) => row.enterOffsetMs > completion.atMs - capture.startMs);
    if (!completion || !next) continue;
    handoffs.push({
      blockedRequestId: callback.requestId,
      completedFrameId: completion.frameId,
      nextSubmittingRequestId: next.requestId,
      callbackToCompletionMs: completion.atMs - capture.startMs - callback.enterOffsetMs,
      creditToNextSubmittingCallbackMs: next.enterOffsetMs - (completion.atMs - capture.startMs),
    });
  }
  const submissions = submitted.map((row) => {
    const offsetMs = row.atMs - capture.startMs;
    const enclosing = callbacks.filter(
      (callback) => callback.enterOffsetMs < offsetMs && offsetMs < callback.exitOffsetMs,
    );
    const incompleteCoverage = incompleteCallbacks.some(
      (callback) =>
        (callback.enterOffsetMs === null || callback.enterOffsetMs <= offsetMs) &&
        (callback.exitOffsetMs === null || offsetMs <= callback.exitOffsetMs),
    );
    const onBoundary = callbacks.some(
      (callback) => callback.enterOffsetMs === offsetMs || callback.exitOffsetMs === offsetMs,
    );
    // Equal timestamps cannot order callbacks and submissions from separate recorders.
    const location = incompleteCoverage
      ? 'incomplete-callback-coverage'
      : onBoundary || enclosing.length > 1
        ? 'boundary-ambiguous'
        : enclosing.length === 1
          ? 'inside-complete-callback'
          : 'outside-complete-callback';
    const priorCompletion = completed.filter((completion) => completion.atMs < row.atMs).at(-1);
    return {
      frameId: row.frameId,
      offsetMs,
      callbackRequestId: location === 'inside-complete-callback' ? enclosing[0].requestId : null,
      location,
      cause: 'not-observed',
      priorCompletionToSubmissionMs: priorCompletion ? row.atMs - priorCompletion.atMs : null,
    };
  });
  const unique = [
    ...new Map(
      handoffs.map((row) => [`${row.completedFrameId}:${row.nextSubmittingRequestId}`, row]),
    ).values(),
  ];
  return {
    status: errors.length || boundaryCallbacks.length ? 'partial' : 'complete',
    errors,
    scope:
      'Same normalized Platform clock. Credit state requires contiguous submitted/completed identities and the explicitly supplied App credit cap. A callback with no submission at the cap is observed, not a private branch probe.',
    creditCap,
    initialOutstanding: initial,
    boundaryCallbacks,
    incompleteCallbacks,
    callbacks,
    handoffs,
    submissions,
    summary: errors.length
      ? null
      : {
          totalSubmissions: submitted.length,
          submissionsInsideCompleteCallback: submissions.filter(
            (row) => row.location === 'inside-complete-callback',
          ).length,
          submissionsAtCallbackBoundary: submissions.filter(
            (row) => row.location === 'boundary-ambiguous',
          ).length,
          submissionsOutsideCompleteCallback: submissions.filter(
            (row) => row.location === 'outside-complete-callback',
          ).length,
          submissionsWithIncompleteCallbackCoverage: submissions.filter(
            (row) => row.location === 'incomplete-callback-coverage',
          ).length,
          completeCallbackPairs: callbacks.length,
          callbacksWithStrictInsideSubmission: new Set(
            submissions
              .filter((row) => row.location === 'inside-complete-callback')
              .map((row) => row.callbackRequestId),
          ).size,
          creditQualifiedSubmittingCallbacks: admitted.length,
          callbacksWithoutSubmissionAtCap: blocked.length,
          callbackWork: stats(callbacks.map((row) => row.workMs)),
          requestToCallback: stats(callbacks.map((row) => row.requestToEnterMs)),
          blockedCallbackHandoffs: handoffs.length,
          distinctCreditHandoffs: unique.length,
          creditToSubmittingCallbackByBlockedCallback: stats(
            handoffs.map((row) => row.creditToNextSubmittingCallbackMs),
          ),
          creditToSubmittingCallbackDistinct: stats(
            unique.map((row) => row.creditToNextSubmittingCallbackMs),
          ),
        },
  };
}

function cpuFrameTiming(report, eligible, receipts) {
  const scope =
    'Temporal adjacency, not causality: CPU frame gaps are neither idle CPU nor GPU duration. ' +
    'Profiler frame IDs are capture-local; submission IDs are matched only by unique strict time containment. ' +
    'All comparisons use floor(Platform milliseconds * 1000); equal integer microseconds have unknown order. ' +
    'Integer encoding does not establish the underlying clock resolution. Interval differences are quantized, not exact wake latency.';
  const unavailable = (unavailableReason) => ({
    status: 'unavailable',
    scope,
    unavailableReason,
    frames: [],
    gaps: [],
    summary: null,
  });
  if (!eligible) return unavailable('report-ineligible');
  const cpu = report.cpu,
    capture = report.capture;
  if (!cpu) return unavailable('cpu-not-captured');
  if (
    cpu.schemaVersion !== 'forgeax-phone-gameplay-cpu/1' ||
    cpu.clock !== 'platform.now milliseconds -> microseconds' ||
    cpu.diagnosticOnly !== true ||
    cpu.cleanFpsEvidence !== false ||
    cpu.capture.schemaVersion !== '1.0'
  )
    return unavailable('cpu-producer-clock-contract-unqualified');
  const records = cpu.capture.records;
  if (!records.length) return unavailable('cpu-frame-records-missing');
  if (records.some((row) => !integer(row.frameId) || row.frameId < 1))
    return unavailable('invalid-cpu-frame-identity');
  const { submitted, completed } = receipts;
  const micros = (atMs) => Math.floor(atMs * 1000);
  const start = micros(capture.startMs),
    end = micros(capture.endMs);
  if (![start, end, ...capture.events.map((row) => micros(row.atMs))].every(integer))
    return unavailable('unsafe-clock-microseconds');
  const offset = (value) => (value - start) / 1000;
  const entries = [...groups(records, 'frameId')]
    .sort(([a], [b]) => a - b)
    .map(([cpuFrameId, rows]) => {
      const roots = rows.filter(
        (row) =>
          row.kind === 'phase' &&
          row.source === 'app' &&
          row.phase === 'frame-total' &&
          row.parentSource === undefined &&
          row.parentPhase === undefined,
      );
      const root = roots.length === 1 ? roots[0] : null;
      let unknownReason =
        roots.length === 0
          ? 'missing-cpu-frame-total'
          : roots.length > 1
            ? 'duplicate-cpu-frame-total'
            : null;
      if (root) {
        if (
          !integer(root.durationMicros) ||
          root.durationMicros !== root.endMicros - root.startMicros
        )
          unknownReason = 'invalid-cpu-frame-duration';
        else if (root.startMicros <= start || root.endMicros >= end)
          unknownReason = 'cpu-frame-at-window-boundary';
      }
      return { cpuFrameId, root, unknownReason };
    });
  // A missing/duplicate root has no trustworthy interval. Discarding it would
  // make another frame appear uniquely enclosing and gaps falsely adjacent.
  const incompleteRoots = entries.some((entry) => entry.root === null);
  for (const entry of entries) {
    if (!entry.root || entry.unknownReason) continue;
    if (incompleteRoots) {
      entry.unknownReason = 'incomplete-cpu-frame-coverage';
      continue;
    }
    if (
      entries.some(
        (other) =>
          other !== entry &&
          other.root &&
          entry.root.startMicros < other.root.endMicros &&
          other.root.startMicros < entry.root.endMicros,
      )
    )
      entry.unknownReason = 'overlapping-cpu-frames';
  }
  const frames = entries.map(({ cpuFrameId, root, unknownReason }) => {
    // onSubmitted executes synchronously inside App's profiled renderer-draw.
    // IDs alone cannot join these streams: App resets profiler IDs per capture.
    const candidates =
      root && !unknownReason
        ? submitted.filter(
            (row) => root.startMicros <= micros(row.atMs) && micros(row.atMs) <= root.endMicros,
          )
        : [];
    let submissionUnknownReason = unknownReason;
    if (!submissionUnknownReason) {
      if (candidates.some((row) => [root.startMicros, root.endMicros].includes(micros(row.atMs))))
        submissionUnknownReason = 'submission-at-cpu-boundary';
      else if (candidates.length !== 1)
        submissionUnknownReason = candidates.length
          ? 'multiple-submissions-in-cpu-frame'
          : 'no-submission-in-cpu-frame';
    }
    return {
      cpuFrameId,
      unknownReason,
      startOffsetMs: root ? offset(root.startMicros) : null,
      endOffsetMs: root ? offset(root.endMicros) : null,
      submittedFrameId: submissionUnknownReason ? null : candidates[0].frameId,
      submissionUnknownReason,
    };
  });
  const matched = new Map(
    frames
      .filter((row) => row.submittedFrameId !== null)
      .map((row) => [row.submittedFrameId, row.cpuFrameId]),
  );
  const gaps = [];
  for (let i = 1; i < entries.length; i++) {
    const previous = entries[i - 1],
      next = entries[i];
    let unknownReason = previous.unknownReason || next.unknownReason;
    if (!unknownReason && next.cpuFrameId !== previous.cpuFrameId + 1)
      unknownReason = 'nonconsecutive-cpu-frames';
    if (!unknownReason && previous.root.endMicros >= next.root.startMicros)
      unknownReason = 'unordered-cpu-frame-boundaries';
    const elapsedMs = unknownReason
      ? null
      : (next.root.startMicros - previous.root.endMicros) / 1000;
    const receipts = unknownReason
      ? []
      : completed.filter(
          (row) =>
            previous.root.endMicros <= micros(row.atMs) &&
            micros(row.atMs) <= next.root.startMicros,
        );
    if (!unknownReason) {
      if (
        receipts.some((row) =>
          [previous.root.endMicros, next.root.startMicros].includes(micros(row.atMs)),
        )
      )
        unknownReason = 'receipt-at-cpu-boundary';
      else if (receipts.length !== 1)
        unknownReason = receipts.length ? 'multiple-receipts-in-gap' : 'no-receipt-in-gap';
    }
    // A cap of two permits an older frame's receipt here, or the previous
    // frame's receipt after the next CPU frame. Do not force either association.
    const receipt = unknownReason ? null : receipts[0];
    gaps.push({
      previousCpuFrameId: previous.cpuFrameId,
      nextCpuFrameId: next.cpuFrameId,
      unknownReason,
      elapsedMs,
      receiptFrameIds: receipts.map((row) => row.frameId),
      completedFrameId: receipt?.frameId ?? null,
      completedCpuFrameId: receipt ? (matched.get(receipt.frameId) ?? null) : null,
      previousCpuEndToCompletionMs: receipt
        ? (micros(receipt.atMs) - previous.root.endMicros) / 1000
        : null,
      completionToNextCpuStartMs: receipt
        ? (next.root.startMicros - micros(receipt.atMs)) / 1000
        : null,
    });
  }
  const countReasons = (rows, field) => {
    const counts = {};
    for (const row of rows) if (row[field]) counts[row[field]] = (counts[row[field]] ?? 0) + 1;
    return counts;
  };
  const warnings = [];
  if (
    entries.length !== cpu.coverage.completedAppFrames ||
    entries.length !== cpu.capture.frameLimit ||
    entries[0]?.cpuFrameId !== 1 ||
    entries.at(-1)?.cpuFrameId !== cpu.capture.frameLimit
  )
    warnings.push('cpu-frame-count-or-range-mismatch');
  const summary = {
    cpuFrames: frames.length,
    uniquelyMatchedSubmissions: matched.size,
    submissionUnknownReasons: countReasons(frames, 'submissionUnknownReason'),
    consecutiveGaps: gaps.filter((row) => row.elapsedMs !== null).length,
    singleReceiptGaps: gaps.filter((row) => row.unknownReason === null).length,
    unknownGapReasons: countReasons(gaps, 'unknownReason'),
    elapsedBetweenCpuFrames: stats(gaps.map((row) => row.elapsedMs)),
    previousCpuEndToCompletion: stats(gaps.map((row) => row.previousCpuEndToCompletionMs)),
    completionToNextCpuStart: stats(gaps.map((row) => row.completionToNextCpuStartMs)),
  };
  return {
    status:
      warnings.length ||
      frames.some((row) => row.submissionUnknownReason) ||
      gaps.some((row) => row.unknownReason)
        ? 'partial'
        : 'complete',
    scope,
    unavailableReason: null,
    warnings,
    frames,
    gaps,
    summary,
  };
}

export function analyzeCompletionReport(report, { creditCap, lateMs = 2 } = {}) {
  const errors = [];
  const capture = report?.capture;
  if (
    report?.kind !== 'forgeax-phone-gameplay' ||
    report.cleanFpsEvidence !== false ||
    !/^[a-f0-9]{40}$/.test(report.source?.engineCommit ?? '') ||
    !/^[a-f0-9]{64}$/.test(report.source?.manifestSha256 ?? '')
  )
    return invalid(['invalid-report-source-or-kind']);
  const error = validateEvents(
    capture,
    'forgeax-gameplay-capture/1',
    new Set(['submitted', 'completed']),
  );
  if (error) return invalid([error]);
  const completion = analyzeCompletionTiming(capture.completionTiming, { lateMs });
  if (
    report.status !== 'complete' ||
    report.failure != null ||
    capture.status !== 'complete' ||
    capture.failure != null ||
    capture.drain?.success !== true
  )
    errors.push('original-report-incomplete');
  if (report.mode === 'cpu' || report.cpu) {
    const cpu = report.cpu;
    if (
      cpu?.status !== 'complete' ||
      cpu.validation?.ok !== true ||
      cpu.coverage?.ownerCoverageComplete !== true ||
      cpu.capture?.timeUnit !== 'microseconds' ||
      cpu.capture?.completeness?.status !== 'complete' ||
      cpu.capture?.completeness?.droppedEventCount !== 0 ||
      !Array.isArray(cpu.capture?.records) ||
      cpu.capture.completeness.retainedEventCount !== cpu.capture.records.length ||
      cpu.capture.records.some(
        (row) =>
          row.kind === 'phase' &&
          (!integer(row.startMicros) || !integer(row.endMicros) || row.endMicros < row.startMicros),
      )
    )
      errors.push('cpu-owner-coverage-incomplete');
  }
  const receipts = receiptStream(capture);
  errors.push(...completion.errors, ...validateFrameCapture(capture), ...receipts.errors);
  if (creditCap !== undefined && (!integer(creditCap) || creditCap < 1 || creditCap > 16))
    errors.push('invalid-explicit-credit-cap');
  const joint =
    !errors.length && creditCap !== undefined ? jointTiming(capture, creditCap, receipts) : null;
  if (joint) errors.push(...joint.errors);
  const cpuFrames = cpuFrameTiming(report, errors.length === 0, receipts);
  return {
    schemaVersion: 'forgeax-phone-completion-report-analysis/1',
    diagnosticOnly: true,
    cleanFpsEvidence: false,
    status:
      errors.length || completion.status === 'partial' || joint?.status === 'partial'
        ? 'partial'
        : 'complete',
    completeCoverage: errors.length === 0,
    errors: [...new Set(errors)],
    scope: resultScope,
    reportStatus: report.status,
    cpuStatus: report.cpu?.status ?? null,
    source: {
      engineCommit: report.source.engineCommit,
      manifestSha256: report.source.manifestSha256,
    },
    completion: errors.length ? { ...completion, summary: null } : completion,
    joint,
    cpuFrameTiming: cpuFrames,
    summary: errors.length
      ? null
      : {
          completion: completion.summary,
          joint: joint?.summary ?? null,
          cpuFrameTiming: cpuFrames.summary,
        },
    missingCreditAnalysis:
      creditCap === undefined ? 'Supply the actual App credit cap explicitly.' : null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, creditText] = process.argv.slice(2);
  if (!input || !output || process.argv.length > 5)
    throw new Error(
      'Usage: node analyze_phone_completion.mjs PRIVATE_REPORT NEW_OUTPUT_JSON [ACTUAL_APP_CREDIT_CAP]',
    );
  const size = (await stat(input)).size;
  if (size < 1 || size > 24 * 1024 * 1024) throw new Error('Report must contain 1..24 MiB');
  const bytes = await readFile(input);
  if (bytes.length !== size) throw new Error('Report changed during read');
  const result = analyzeCompletionReport(JSON.parse(bytes), {
    creditCap: creditText === undefined ? undefined : Number(creditText),
  });
  result.reportSha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      status: result.status,
      completeCoverage: result.completeCoverage,
      errors: result.errors,
      summary: result.summary,
    }),
  );
  if (!result.completeCoverage) process.exitCode = 1;
}
