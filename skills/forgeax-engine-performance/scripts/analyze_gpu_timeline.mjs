#!/usr/bin/env node
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { canonical, digest, loadJson, pointer, requireFact, runCli, statistics } from './lib.mjs';
import { measuredIntervals, summarizeGpuTiming } from './summarize_gpu_timing.mjs';

const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const stats = (values) => (values.length ? statistics(values) : null);
const semantic = (p) => ({
  viewId: p.viewId ?? null,
  passName: p.passName,
  passKind: p.passKind,
  measurementSource: p.measurementSource,
});
const sourceKey = (context, frame) => canonical([context, frame]);
const receiptKey = (context, device, frame) => canonical([context, device, frame]);
const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

/** Interval arithmetic remains in the device tick domain until bounded differences. */
export function gpuTimelineFrame(frame) {
  const measured = measuredIntervals(frame),
    intervals = measured.intervals;
  if (!intervals.length)
    return { timed: false, reason: 'no-measured-pass-boundary', wholeFrameGpuDurationMs: null };
  const first = intervals.reduce((a, b) => (a < b.start ? a : b.start), intervals[0].start);
  const last = intervals.reduce((a, b) => (a > b.end ? a : b.end), first);
  requireFact(last - first <= maxSafe, 'GPU envelope exceeds exact bounded tick conversion');
  const ms = (t) => {
    requireFact(t >= 0n && t <= maxSafe, 'GPU coverage exceeds exact bounded tick conversion');
    const value = (Number(t) * frame.timestampPeriodNanoseconds) / 1e6;
    requireFact(Number.isFinite(value), 'Nonfinite GPU coverage');
    return value;
  };
  const events = new Map(),
    semantics = new Map(),
    durationBySemantic = new Map();
  let repeated = 0n,
    equalTicks = 0;
  for (const { start, end, pass } of intervals) {
    requireFact(end - start <= maxSafe, 'GPU pass exceeds exact bounded tick conversion');
    repeated += end - start;
    if (start === end) equalTicks++;
    const identity = semantic(pass),
      key = canonical(identity);
    semantics.set(key, identity);
    durationBySemantic.set(key, (durationBySemantic.get(key) ?? 0n) + (end - start));
    if (start === end) continue;
    for (const [tick, adding] of [
      [start, true],
      [end, false],
    ]) {
      const row = events.get(tick) ?? [];
      row.push({ adding, key, index: pass.executionIndex });
      events.set(tick, row);
    }
  }
  const active = new Map(),
    coverage = new Map(),
    sole = new Map(),
    pairs = new Map(),
    histogram = new Map();
  let cursor = first,
    union = 0n,
    maxPassDepth = 0,
    maxSemanticDepth = 0;
  const segment = (end) => {
    const ticks = end - cursor;
    requireFact(ticks >= 0n, 'GPU sweep reversed');
    if (!ticks) return;
    histogram.set(active.size, (histogram.get(active.size) ?? 0n) + ticks);
    if (active.size) {
      union += ticks;
      const keys = [...new Set(active.values())].sort();
      maxPassDepth = Math.max(maxPassDepth, active.size);
      maxSemanticDepth = Math.max(maxSemanticDepth, keys.length);
      for (const key of keys) coverage.set(key, (coverage.get(key) ?? 0n) + ticks);
      if (keys.length === 1) sole.set(keys[0], (sole.get(keys[0]) ?? 0n) + ticks);
      for (let i = 0; i < keys.length; i++)
        for (let j = i + 1; j < keys.length; j++) {
          const key = canonical([keys[i], keys[j]]);
          const row = pairs.get(key) ?? { left: keys[i], right: keys[j], ticks: 0n };
          row.ticks += ticks;
          pairs.set(key, row);
        }
    }
    cursor = end;
  };
  for (const [tick, rows] of [...events].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    segment(tick);
    for (const e of rows.filter((e) => !e.adding)) {
      requireFact(active.get(e.index) === e.key, 'GPU active roster mismatch');
      active.delete(e.index);
    }
    for (const e of rows.filter((e) => e.adding)) {
      requireFact(!active.has(e.index), 'GPU execution overlap with itself');
      active.set(e.index, e.key);
    }
  }
  segment(last);
  requireFact(active.size === 0, 'Unclosed GPU interval sweep');
  requireFact(
    [...histogram.values()].reduce((a, b) => a + b, 0n) === last - first,
    'GPU envelope partition differs',
  );
  requireFact(
    Math.abs(ms(union) - measured.intervalUnionMs) <=
      Math.max(1e-9, measured.intervalUnionMs * 1e-9),
    'GPU union differs from existing parser',
  );
  return {
    timed: true,
    firstMeasuredTick: first.toString(),
    lastMeasuredTick: last.toString(),
    measuredTimestampEnvelopeMs: ms(last - first),
    measuredIntervalUnionMs: ms(union),
    repeatedCoverageMs: ms(repeated),
    repeatedCoverageBeyondUnionMs: ms(repeated - union),
    uncoveredInsideEnvelopeMs: ms(last - first - union),
    wholeFrameGpuDurationMs: null,
    equalTickExecutions: equalTicks,
    maxMeasuredPassDepth: maxPassDepth,
    maxMeasuredSemanticDepth: maxSemanticDepth,
    coverageByExecutionDepth: [...histogram].map(([depth, ticks]) => ({
      depth,
      coverageMs: ms(ticks),
    })),
    semanticCoverage: [...semantics].map(([key, identity]) => ({
      ...identity,
      repeatedDurationMs: ms(durationBySemantic.get(key) ?? 0n),
      intervalUnionMs: ms(coverage.get(key) ?? 0n),
      soleMeasuredSemanticCoverageMs: ms(sole.get(key) ?? 0n),
      sharedMeasuredSemanticCoverageMs: ms((coverage.get(key) ?? 0n) - (sole.get(key) ?? 0n)),
    })),
    overlaps: [...pairs.values()]
      .map((p) => ({
        left: semantics.get(p.left),
        right: semantics.get(p.right),
        overlapMs: ms(p.ticks),
      }))
      .sort((a, b) => b.overlapMs - a.overlapMs),
    executions: intervals.map(({ start, end, pass }) => ({
      ...semantic(pass),
      executionIndex: pass.executionIndex,
      beginningTick: start.toString(),
      endTick: end.toString(),
      durationMs: pass.durationNanoseconds / 1e6,
      beginRelativeToFirstMeasuredMs: ms(start - first),
      endRelativeToFirstMeasuredMs: ms(end - first),
      equalTicks: start === end,
    })),
  };
}

/** Select source receipts only. No GPU-to-Host clock conversion or neighbor filling. */
export function completedGpuSelection(
  rows,
  window,
  {
    contextPointer = '/worldIdentity',
    sourceFramePointer = '/frameId',
    observationPointer = '/observation',
    phase = 'live',
  } = {},
) {
  requireFact(['live', 'all'].includes(phase), 'Use live or all completed receipts');
  requireFact(
    Array.isArray(window?.frames) &&
      Number.isFinite(window.start) &&
      Number.isFinite(window.end) &&
      window.start < window.end,
    'Invalid completed window',
  );
  const from = phase === 'live' ? window.firstLiveAt : window.start;
  requireFact(Number.isFinite(from) && from <= window.end, 'Missing selected completion boundary');
  const roster = new Map(),
    worldSource = new Map();
  let last = -Infinity;
  for (const receipt of [...window.frames, ...(window.closingFrame ? [window.closingFrame] : [])]) {
    requireFact(
      Number.isFinite(receipt.at) &&
        typeof receipt.worldIdentity === 'string' &&
        receipt.worldIdentity.length > 0 &&
        integer(receipt.deviceGeneration) &&
        integer(receipt.frameId),
      'Invalid completed receipt',
    );
    requireFact(receipt.at >= last, 'Descending completed receipt time');
    last = receipt.at;
    if (receipt.at < from || receipt.at > window.end) continue;
    const key = receiptKey(receipt.worldIdentity, receipt.deviceGeneration, receipt.frameId),
      old = roster.get(key);
    requireFact(
      !old || canonical(old) === canonical(receipt),
      'Conflicting duplicate completed receipt',
    );
    roster.set(key, receipt);
    const source = sourceKey(receipt.worldIdentity, receipt.frameId);
    requireFact(
      !worldSource.has(source) || worldSource.get(source) === key,
      'Source receipt reused across device epochs',
    );
    worldSource.set(source, key);
  }
  requireFact(roster.size > 0, 'No selected completed receipts');
  const selected = [],
    boundary = [],
    seen = new Set();
  for (const row of rows) {
    const context = pointer(row, contextPointer),
      source = pointer(row, sourceFramePointer),
      observation = pointer(row, observationPointer);
    requireFact(
      typeof context === 'string' && context.length > 0 && integer(source),
      'Exact source World/frame required',
    );
    let key;
    if (['complete', 'partial'].includes(observation?.status))
      key = receiptKey(context, observation.frame.deviceGeneration, source);
    else key = worldSource.get(sourceKey(context, source)); // Negative status retains only source membership; never GPU/device facts.
    const receipt = roster.get(key);
    if (!receipt) {
      boundary.push({ worldIdentity: context, sourceFrameId: source, status: observation?.status });
      continue;
    }
    seen.add(key);
    selected.push(row);
  }
  return {
    rows: selected,
    receipts: roster,
    fromMs: from,
    toMs: window.end,
    sourceCoverage: {
      selectedCompletedReceipts: roster.size,
      observedSourceReceipts: seen.size,
      unobservedSourceReceipts: roster.size - seen.size,
      boundarySamples: boundary.length,
      boundary,
      phase,
      scope:
        'Exact outer source World/device/frame for measured rows. Negative observations retain source membership only; missing polled receipts have unknown GPU cost.',
    },
  };
}

export function analyzeGpuTimeline(
  rows,
  {
    observationPointer = '',
    contextPointer,
    sourceFramePointer,
    completedWindow,
    phase = 'live',
    top = 5,
  } = {},
) {
  requireFact(integer(top) && top > 0 && top <= 30, 'top must be1..30');
  // Reuse the producer-maintained parser: counts, ticks, duration, period,
  // execution IDs, conflicts and complete-only admission stay in one authority.
  const all = summarizeGpuTiming(rows, { observationPointer, contextPointer });
  const sourceFacts = new Map(),
    rendererSources = new Map(),
    unique = [],
    seenRenderer = new Set();
  let duplicateSources = 0;
  for (const row of rows) {
    const observation = pointer(row, observationPointer),
      context = contextPointer === undefined ? 'single-renderer' : pointer(row, contextPointer);
    requireFact(
      (typeof context === 'string' && context.length > 0) ||
        (typeof context === 'number' && Number.isFinite(context)),
      'Exact GPU context required',
    );
    let source;
    if (sourceFramePointer !== undefined) {
      source = pointer(row, sourceFramePointer);
      requireFact(integer(source), 'Invalid source frame ID');
      const key = sourceKey(context, source),
        fact = canonical(observation);
      if (sourceFacts.has(key)) {
        requireFact(sourceFacts.get(key) === fact, 'Conflicting observation for source frame');
        duplicateSources++;
        continue;
      }
      sourceFacts.set(key, fact);
      if (['complete', 'partial'].includes(observation.status)) {
        const renderer = receiptKey(
          context,
          observation.frame.deviceGeneration,
          observation.frame.frameId,
        );
        requireFact(
          !rendererSources.has(renderer) || rendererSources.get(renderer) === source,
          'One Renderer receipt assigned to multiple source frames',
        );
        rendererSources.set(renderer, source);
      }
    }
    if (['complete', 'partial'].includes(observation.status)) {
      const key = receiptKey(
        context,
        observation.frame.deviceGeneration,
        observation.frame.frameId,
      );
      if (seenRenderer.has(key)) continue;
      seenRenderer.add(key);
    }
    unique.push(row);
  }
  let selection;
  if (completedWindow !== undefined) {
    requireFact(
      contextPointer !== undefined && sourceFramePointer !== undefined,
      'Completed selection needs exact source pointers',
    );
    selection = completedGpuSelection(unique, completedWindow, {
      contextPointer,
      sourceFramePointer,
      observationPointer,
      phase,
    });
  }
  const selected = selection?.rows ?? unique;
  const summary = selected.length
    ? summarizeGpuTiming(selected, { observationPointer, contextPointer })
    : {
        counts: { rows: 0, completeFrames: 0, partialFrames: 0, failed: 0, unavailable: 0 },
        groups: [],
        passes: [],
      };
  const groups = new Map(),
    frames = [],
    negative = [],
    seenSourceOrder = new Map();
  for (const row of selected) {
    const observation = pointer(row, observationPointer),
      context = contextPointer === undefined ? 'single-renderer' : pointer(row, contextPointer),
      source = sourceFramePointer === undefined ? null : pointer(row, sourceFramePointer);
    if (!['complete', 'partial'].includes(observation.status)) {
      negative.push({
        context,
        sourceFrameId: source,
        status: observation.status,
        reason: observation.reason ?? observation.error,
      });
      continue;
    }
    const f = observation.frame,
      gpuKey = canonical([
        context,
        f.backendKind,
        f.deviceGeneration,
        f.timestampPeriodNanoseconds,
      ]);
    if (source !== null) {
      const old = seenSourceOrder.get(gpuKey);
      requireFact(
        !old || (source > old.source && f.frameId > old.renderer),
        'Source/Renderer order reset inside one GPU context; need a new explicit context identity',
      );
      seenSourceOrder.set(gpuKey, { source, renderer: f.frameId });
    }
    const complete =
      observation.status === 'complete' &&
      f.droppedPassCount === 0 &&
      f.measuredPassCount === f.passes.length;
    if (!complete) {
      negative.push({
        context,
        sourceFrameId: source,
        rendererFrameId: f.frameId,
        deviceGeneration: f.deviceGeneration,
        status: 'partial',
        reason: observation.reason ?? 'incomplete-pass-roster',
      });
      continue;
    }
    const timing = gpuTimelineFrame(f),
      receipt = selection?.receipts.get(receiptKey(context, f.deviceGeneration, source));
    const record = {
      context,
      sourceFrameId: source,
      rendererFrameId: f.frameId,
      deviceGeneration: f.deviceGeneration,
      graphGeneration: f.graphGeneration,
      backendKind: f.backendKind,
      timestampPeriodNanoseconds: f.timestampPeriodNanoseconds,
      completedAtMs: receipt?.at ?? null,
      relativeToSelectedSeconds: receipt ? (receipt.at - selection.fromMs) / 1000 : null,
      ...timing,
    };
    frames.push(record);
    if (!timing.timed) continue;
    const group = groups.get(gpuKey) ?? {
      context,
      backendKind: f.backendKind,
      deviceGeneration: f.deviceGeneration,
      timestampPeriodNanoseconds: f.timestampPeriodNanoseconds,
      frames: [],
      semantics: new Map(),
      overlaps: new Map(),
    };
    group.frames.push(record);
    groups.set(gpuKey, group);
    for (const pass of timing.semanticCoverage) {
      const key = canonical(semantic(pass)),
        entry = group.semantics.get(key) ?? { identity: semantic(pass), frames: [] };
      entry.frames.push(pass);
      group.semantics.set(key, entry);
    }
    for (const overlap of timing.overlaps) {
      const key = canonical([overlap.left, overlap.right]),
        entry = group.overlaps.get(key) ?? { left: overlap.left, right: overlap.right, values: [] };
      entry.values.push(overlap.overlapMs);
      group.overlaps.set(key, entry);
    }
  }
  return {
    schemaVersion: 1,
    kind: 'gpu-timestamp-timeline',
    diagnosticOnly: true,
    ordinaryFpsAcceptance: false,
    wholeFrameGpuDurationMs: null,
    completeCaptureRows: all.counts,
    selectedCounts: summary.counts,
    duplicateSourceRows: duplicateSources,
    sourceCoverage: selection
      ? { ...selection.sourceCoverage, captureIdentity: 'caller-supplied-unverified' }
      : null,
    timedCompleteFrames: frames.filter((f) => f.timed).length,
    completeFramesWithoutMeasuredBoundary: frames.filter((f) => !f.timed).length,
    negativeObservations: negative,
    producerPassSummary: summary,
    groups: [...groups.values()].map((g) => ({
      context: g.context,
      backendKind: g.backendKind,
      deviceGeneration: g.deviceGeneration,
      timestampPeriodNanoseconds: g.timestampPeriodNanoseconds,
      timedCompleteFrames: g.frames.length,
      metrics: Object.fromEntries(
        [
          'measuredTimestampEnvelopeMs',
          'measuredIntervalUnionMs',
          'repeatedCoverageMs',
          'repeatedCoverageBeyondUnionMs',
          'uncoveredInsideEnvelopeMs',
          'equalTickExecutions',
          'maxMeasuredPassDepth',
        ].map((k) => [k, stats(g.frames.map((f) => f[k]))]),
      ),
      semanticCoverage: [...g.semantics.values()]
        .map((s) => ({
          ...s.identity,
          observedFrames: s.frames.length,
          absentTimedCompleteFrames: g.frames.length - s.frames.length,
          ...Object.fromEntries(
            [
              'repeatedDurationMs',
              'intervalUnionMs',
              'soleMeasuredSemanticCoverageMs',
              'sharedMeasuredSemanticCoverageMs',
            ].map((k) => [k, stats(s.frames.map((p) => p[k]))]),
          ),
        }))
        .sort((a, b) => b.intervalUnionMs.mean - a.intervalUnionMs.mean),
      measuredOverlapPairs: [...g.overlaps.values()]
        .map((p) => ({
          left: p.left,
          right: p.right,
          observedFrames: p.values.length,
          absentTimedCompleteFrames: g.frames.length - p.values.length,
          overlapMs: stats(p.values),
        }))
        .sort((a, b) => b.overlapMs.mean - a.overlapMs.mean),
      longestMeasuredEnvelopes: [...g.frames]
        .sort((a, b) => b.measuredTimestampEnvelopeMs - a.measuredTimestampEnvelopeMs)
        .slice(0, top),
    })),
    frames: frames.map(({ executions, semanticCoverage, overlaps, ...frame }) => frame),
    interpretation: [
      'Statistics cover unique complete polled observations only. Missing source receipts, partial/failed/unavailable timings and empty boundary rosters remain unknown, never zero or a neighbor substitute.',
      'The timestamp envelope spans first measured pass beginning to last measured pass end. There is no dedicated whole-frame start/end timestamp in this contract: it omits unmeasured uploads, preparation, queue waiting, compositor and other outside work. wholeFrameGpuDurationMs remains null.',
      'Repeated coverage adds pass executions; interval union merges their timestamp ranges; envelope includes internal gaps. Sole/shared semantic coverage and pairwise overlap describe measured intervals only, not exclusive GPU utilization or hardware concurrency. Pairwise/triple overlaps are not additive.',
      'BigInt tick arithmetic precedes bounded duration conversion. Equal ticks are quantized observations, not proof of free GPU work. Copy measurements are boundary envelopes. No GPU tick is aligned to Host/CPU clocks.',
      'Outer source frame and inner Renderer frame are distinct identities. A context/device/period/order reset cannot silently reuse old receipts. LIVE source membership is selected from its own completed roster, never a different ordinary run or its minimum-second window.',
    ],
  };
}

/** A Game report's own path, clock and completion roster bind its external receipt file. */
export async function qualifyGameGpuCapture(report, window, { inputPath, windowPath }) {
  const reference = report?.windows?.ordinary?.frames,
    timing = report?.windows?.ordinary?.timing,
    collector = report?.gpu;
  requireFact(
    typeof reference === 'string' && reference.length > 0,
    'Completed-window CLI needs the report-owned ordinary frame reference',
  );
  requireFact(
    (await realpath(resolve(dirname(inputPath), reference))) === (await realpath(windowPath)),
    'Completed file differs from report reference',
  );
  requireFact(
    Number.isFinite(window.timeOrigin) &&
      window.timeOrigin === report.lastObserved?.observedAt?.timeOriginMs,
    'Completed file and report clock identities differ',
  );
  requireFact(
    collector?.diagnostic === 'gpu-pass-timing' &&
      collector.sampling === 'latest-completed-receipt-poll' &&
      Array.isArray(collector.samples),
    'Unknown GPU collector contract',
  );
  const full = completedGpuSelection(collector.samples, window, { phase: 'all' }).sourceCoverage;
  requireFact(
    integer(timing?.completedIntervals) &&
      timing.completedIntervals === full.selectedCompletedReceipts - 1,
    'Report and completed receipt populations differ',
  );
  requireFact(
    Number.isFinite(timing.seconds) &&
      Math.abs(timing.seconds - (window.end - window.start) / 1000) <= 1e-9,
    'Report and completed window durations differ',
  );
  const recorded = collector.completedWindow;
  requireFact(
    recorded &&
      recorded.matchedSourceFrames === full.observedSourceReceipts &&
      recorded.unobservedSourceFrames === full.unobservedSourceReceipts &&
      recorded.boundarySamples === full.boundarySamples,
    'Report GPU membership differs from its completed roster',
  );
  for (const key of ['polls', 'duplicates', 'noCompletedTiming', 'readFailures', 'droppedSamples'])
    requireFact(integer(collector.counts?.[key]), 'Invalid collector counts');
  requireFact(
    ['sampled', 'partial', 'unavailable'].includes(collector.status),
    'Unknown collector status',
  );
  return {
    captureIdentity: 'report-owned-file-reference-clock-and-full-roster',
    reportOk: report.ok ?? null,
    reportErrors: report.errors ?? null,
    collectorStatus: collector.status,
    collectorCounts: collector.counts,
    collectorDiagnostics: collector.diagnostics ?? null,
    fullWindowSourceCoverage: full,
    samplingScope:
      'Latest completed receipt polling is a subset even when collector status is sampled. It does not establish the GPU distribution of unobserved frames.',
    requiresAttention:
      report.ok !== true ||
      collector.status !== 'sampled' ||
      collector.counts.readFailures > 0 ||
      collector.counts.droppedSamples > 0,
  };
}

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'rows-pointer': { type: 'string', default: '' },
      'observation-pointer': { type: 'string', default: '' },
      'context-pointer': { type: 'string' },
      'source-frame-pointer': { type: 'string' },
      'completed-window': { type: 'string' },
      phase: { type: 'string', default: 'live' },
      top: { type: 'string', default: '5' },
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'node analyze_gpu_timeline.mjs INPUT --rows-pointer /gpu/samples --observation-pointer /observation --context-pointer /worldIdentity --source-frame-pointer /frameId --completed-window ordinary-frames.json [--phase live|all] --output NEW.json',
    );
    return;
  }
  requireFact(positionals.length === 1, 'Require one GPU input JSON');
  const input = await loadJson(positionals[0]),
    window = values['completed-window'] ? await loadJson(values['completed-window']) : undefined;
  let qualification = null;
  if (window) {
    requireFact(
      values['rows-pointer'] === '/gpu/samples' &&
        values['observation-pointer'] === '/observation' &&
        values['context-pointer'] === '/worldIdentity' &&
        values['source-frame-pointer'] === '/frameId',
      'Completed-window CLI requires the exact Game collector identity pointers',
    );
    qualification = await qualifyGameGpuCapture(input.value, window.value, {
      inputPath: resolve(positionals[0]),
      windowPath: resolve(values['completed-window']),
    });
  }
  const result = analyzeGpuTimeline(pointer(input.value, values['rows-pointer']), {
    observationPointer: values['observation-pointer'],
    contextPointer: values['context-pointer'],
    sourceFramePointer: values['source-frame-pointer'],
    completedWindow: window?.value,
    phase: values.phase,
    top: Number(values.top),
  });
  if (qualification) result.sourceCoverage.captureIdentity = qualification.captureIdentity;
  const json =
    JSON.stringify(
      {
        input: { path: resolve(positionals[0]), sha256: input.sha256 },
        completedWindow: window
          ? { path: resolve(values['completed-window']), sha256: window.sha256 }
          : null,
        captureQualification: qualification,
        analyzerSha256: digest(await readFile(new URL(import.meta.url))),
        producerParserSha256: digest(
          await readFile(new URL('./summarize_gpu_timing.mjs', import.meta.url)),
        ),
        ...result,
      },
      null,
      2,
    ) + '\n';
  if (values.output) await writeFile(values.output, json, { flag: 'wx' });
  else process.stdout.write(json);
  if (
    !result.timedCompleteFrames ||
    result.selectedCounts.partialFrames +
      result.selectedCounts.failed +
      result.selectedCounts.unavailable >
      0 ||
    qualification?.requiresAttention
  )
    process.exitCode = 2;
});
