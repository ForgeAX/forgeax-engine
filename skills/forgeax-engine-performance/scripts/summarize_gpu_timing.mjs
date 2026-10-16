#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  canonical,
  digest,
  emitJson,
  loadJson,
  pointer,
  requireFact,
  runCli,
  statistics,
} from './lib.mjs';

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function measuredIntervals(frame) {
  requireFact(
    frame?.schemaVersion === '1.0' &&
      integer(frame.frameId) &&
      integer(frame.deviceGeneration) &&
      integer(frame.graphGeneration) &&
      typeof frame.backendKind === 'string',
    'Invalid GPU frame identity',
  );
  requireFact(
    finite(frame.timestampPeriodNanoseconds) &&
      frame.timestampPeriodNanoseconds > 0 &&
      Array.isArray(frame.passes),
    'Invalid timestamp period or passes',
  );
  const intervals = [];
  const indexes = new Set();
  for (const pass of frame.passes) {
    requireFact(
      typeof pass.passName === 'string' &&
        ['raster', 'compute', 'copy'].includes(pass.passKind) &&
        integer(pass.executionIndex) &&
        !indexes.has(pass.executionIndex),
      'Invalid or duplicate pass identity',
    );
    requireFact(pass.viewId === undefined || integer(pass.viewId), 'Invalid view id');
    indexes.add(pass.executionIndex);
    if (pass.status === 'unmeasured') {
      requireFact(
        pass.reason && typeof pass.reason === 'object',
        'Unmeasured entry needs its reason',
      );
      continue;
    }
    requireFact(
      pass.status === 'measured' &&
        ['pass-boundary', 'copy-boundary-envelope'].includes(pass.measurementSource) &&
        finite(pass.durationNanoseconds),
      'Invalid measured entry',
    );
    requireFact(
      /^\d+$/u.test(pass.beginningTick) && /^\d+$/u.test(pass.endTick),
      'Ticks must be unsigned integer strings',
    );
    const start = BigInt(pass.beginningTick);
    const end = BigInt(pass.endTick);
    requireFact(end >= start, 'Reversed GPU interval');
    const expected = Number(end - start) * frame.timestampPeriodNanoseconds;
    requireFact(
      Number.isFinite(expected) &&
        Math.abs(expected - pass.durationNanoseconds) <= Math.max(1e-6, expected * 1e-9),
      'Duration disagrees with raw GPU ticks',
    );
    intervals.push({ start, end, pass });
  }
  requireFact(
    integer(frame.executedPassCount) &&
      integer(frame.measuredPassCount) &&
      integer(frame.droppedPassCount) &&
      integer(frame.passCapacity) &&
      frame.passCapacity > 0 &&
      frame.passes.length <= frame.passCapacity,
    'Invalid GPU pass counts',
  );
  requireFact(
    frame.measuredPassCount === intervals.length &&
      frame.executedPassCount === frame.passes.length + frame.droppedPassCount,
    'Pass counts disagree with entries',
  );
  const sum = intervals.reduce((total, row) => total + row.pass.durationNanoseconds, 0);
  requireFact(
    finite(frame.measuredPassNanoseconds) &&
      Math.abs(sum - frame.measuredPassNanoseconds) <= Math.max(1e-6, sum * 1e-9),
    'Measured sum disagrees with entries',
  );
  const ordered = intervals
    .slice()
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let coverage = 0n;
  let left;
  let right;
  for (const row of ordered) {
    if (left === undefined) {
      left = row.start;
      right = row.end;
    } else if (row.start <= right) {
      if (row.end > right) right = row.end;
    } else {
      coverage += right - left;
      left = row.start;
      right = row.end;
    }
  }
  if (left !== undefined) coverage += right - left;
  const first = ordered[0]?.start ?? 0n;
  const last = ordered.reduce((end, row) => (row.end > end ? row.end : end), first);
  return {
    intervals,
    repeatedCoverageMs: sum / 1e6,
    intervalUnionMs: (Number(coverage) * frame.timestampPeriodNanoseconds) / 1e6,
    timestampEnvelopeMs: (Number(last - first) * frame.timestampPeriodNanoseconds) / 1e6,
  };
}

export function summarizeGpuTiming(rows, { observationPointer = '', contextPointer } = {}) {
  requireFact(Array.isArray(rows) && rows.length > 0, 'Require a nonempty observation array');
  const counts = {
    rows: rows.length,
    duplicateRows: 0,
    completeFrames: 0,
    partialFrames: 0,
    unavailable: 0,
    failed: 0,
    equalTickPasses: 0,
  };
  const seen = new Map();
  const groups = new Map();
  const passes = new Map();
  for (const row of rows) {
    const observation = pointer(row, observationPointer);
    requireFact(
      observation && ['complete', 'partial', 'unavailable', 'failed'].includes(observation.status),
      'Unknown GPU observation status',
    );
    if (observation.status === 'unavailable' || observation.status === 'failed') {
      counts[observation.status]++;
      continue;
    }
    const frame = observation.frame;
    const context = contextPointer === undefined ? 'single-renderer' : pointer(row, contextPointer);
    requireFact(
      typeof context === 'string' || (typeof context === 'number' && Number.isFinite(context)),
      'Context identity must be a scalar',
    );
    const contextSha256 = digest(canonical(context));
    const fact = measuredIntervals(frame);
    const groupIdentity = {
      contextSha256,
      backendKind: frame.backendKind,
      deviceGeneration: frame.deviceGeneration,
      timestampPeriodNanoseconds: frame.timestampPeriodNanoseconds,
    };
    const groupKey = canonical(groupIdentity);
    const frameKey = canonical([contextSha256, frame.deviceGeneration, frame.frameId]);
    const fingerprint = canonical(observation);
    if (seen.has(frameKey)) {
      requireFact(
        seen.get(frameKey) === fingerprint,
        'Conflicting observations for one frame; retain and inspect the original capture',
      );
      counts.duplicateRows++;
      continue;
    }
    seen.set(frameKey, fingerprint);
    if (!groups.has(groupKey))
      groups.set(groupKey, {
        ...groupIdentity,
        completeFrames: 0,
        partialFrames: 0,
        graphGenerations: new Set(),
        graphMin: frame.graphGeneration,
        graphMax: frame.graphGeneration,
        repeated: [],
        union: [],
        envelope: [],
      });
    const group = groups.get(groupKey);
    group.graphGenerations.add(frame.graphGeneration);
    group.graphMin = Math.min(group.graphMin, frame.graphGeneration);
    group.graphMax = Math.max(group.graphMax, frame.graphGeneration);
    const complete =
      observation.status === 'complete' &&
      frame.droppedPassCount === 0 &&
      fact.intervals.length === frame.passes.length;
    counts[complete ? 'completeFrames' : 'partialFrames']++;
    group[complete ? 'completeFrames' : 'partialFrames']++;
    if (!complete) continue;
    group.repeated.push(fact.repeatedCoverageMs);
    group.union.push(fact.intervalUnionMs);
    group.envelope.push(fact.timestampEnvelopeMs);
    for (const { start, end, pass } of fact.intervals) {
      if (start === end) counts.equalTickPasses++;
      const identity = {
        ...groupIdentity,
        viewId: pass.viewId ?? null,
        passName: pass.passName,
        passKind: pass.passKind,
        measurementSource: pass.measurementSource,
      };
      const key = canonical(identity);
      if (!passes.has(key))
        passes.set(key, {
          ...identity,
          groupKey,
          values: new Map(),
          executionValues: [],
          executionIndices: new Set(),
        });
      const entry = passes.get(key);
      const milliseconds = pass.durationNanoseconds / 1e6;
      entry.values.set(frame.frameId, (entry.values.get(frame.frameId) ?? 0) + milliseconds);
      entry.executionValues.push(milliseconds);
      entry.executionIndices.add(pass.executionIndex);
    }
  }
  return {
    kind: 'gpu-pass-timing-summary',
    timeUnit: 'ms',
    counts,
    groups: [...groups.values()].map(
      ({ repeated, union, envelope, graphGenerations, graphMin, graphMax, ...identity }) => ({
        ...identity,
        graphGenerations: {
          count: graphGenerations.size,
          min: graphMin,
          max: graphMax,
        },
        repeatedCoverageMs: repeated.length ? statistics(repeated) : null,
        intervalUnionMs: union.length ? statistics(union) : null,
        timestampEnvelopeMs: envelope.length ? statistics(envelope) : null,
      }),
    ),
    passes: [...passes.values()]
      .map(({ values, groupKey, executionValues, executionIndices, ...identity }) => ({
        ...identity,
        executionIndices: [...executionIndices].sort((a, b) => a - b),
        observedCompleteFrames: values.size,
        absentCompleteFrames: groups.get(groupKey).completeFrames - values.size,
        observedExecutions: executionValues.length,
        durationMs: statistics([...values.values()]),
        durationPerExecutionMs: statistics(executionValues),
      }))
      .sort((a, b) => b.durationMs.mean - a.durationMs.mean),
    interpretation:
      'Statistics use unique complete frames only. Semantic pass entries sum their executions per observed frame; per-execution samples and execution indices are retained. Graph generations are inventoried within each context/backend/device/timestamp-period cohort, not treated as different workloads. Absent passes are not padded with zero. Partial, failed and unavailable observations remain counted. Interval union covers measured timestamps; the envelope includes gaps and repeated coverage includes overlaps. None is presentation latency or an exclusive whole-frame GPU cost. Equal ticks are quantized measurements, not proof of free work.',
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
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'node summarize_gpu_timing.mjs INPUT [--rows-pointer /gpu/samples] [--observation-pointer /observation] [--context-pointer /worldIdentity] [--output FILE]',
    );
    return;
  }
  requireFact(positionals.length === 1, 'Require one input JSON file');
  const input = await loadJson(positionals[0]);
  const report = summarizeGpuTiming(pointer(input.value, values['rows-pointer']), {
    observationPointer: values['observation-pointer'],
    contextPointer: values['context-pointer'],
  });
  await emitJson(
    {
      inputSha256: input.sha256,
      rowsPointer: values['rows-pointer'],
      observationPointer: values['observation-pointer'],
      contextPointer: values['context-pointer'] ?? null,
      ...report,
    },
    values.output,
    positionals,
  );
  if (
    report.counts.completeFrames === 0 ||
    report.counts.partialFrames + report.counts.unavailable + report.counts.failed > 0
  )
    process.exitCode = 2;
});
