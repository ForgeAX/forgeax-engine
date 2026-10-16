import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';

export function summarizeIntervalSet(intervals) {
  if (intervals.length === 0) {
    return {
      measuredPassCount: 0,
      sumTicks: '0',
      unionTicks: '0',
      outerSpanTicks: '0',
      duplicatedTicks: '0',
      overlapPairCount: 0,
      longestOverlaps: [],
    };
  }
  const coverage = summarizeGpuPassTimingIntervals(intervals.map((interval, executionIndex) => ({
    passName: interval.passName ?? '', passKind: 'compute', executionIndex,
    status: 'measured', measurementSource: 'pass-boundary',
    beginningTick: interval.beginning.toString(), endTick: interval.end.toString(),
    durationNanoseconds: Number(interval.end - interval.beginning),
  })), 1).unwrap();
  const longestOverlaps = [];
  let overlapPairCount = 0;
  for (let leftIndex = 0; leftIndex < intervals.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < intervals.length; rightIndex += 1) {
      const left = intervals[leftIndex];
      const right = intervals[rightIndex];
      const overlapEnd = left.end < right.end ? left.end : right.end;
      const overlapBeginning = left.beginning > right.beginning ? left.beginning : right.beginning;
      if (overlapEnd <= overlapBeginning) continue;
      overlapPairCount += 1;
      longestOverlaps.push({
        left: left.passName,
        right: right.passName,
        overlapTicks: (overlapEnd - overlapBeginning).toString(),
      });
    }
  }
  longestOverlaps.sort((left, right) => {
    const leftTicks = BigInt(left.overlapTicks);
    const rightTicks = BigInt(right.overlapTicks);
    return leftTicks < rightTicks ? 1 : leftTicks > rightTicks ? -1 : 0;
  });
  return {
    measuredPassCount: intervals.length,
    sumTicks: String(coverage.sumNanoseconds),
    unionTicks: String(coverage.unionNanoseconds),
    outerSpanTicks: String(coverage.envelopeNanoseconds),
    duplicatedTicks: String(coverage.overlapNanoseconds),
    overlapPairCount,
    longestOverlaps: longestOverlaps.slice(0, 8),
  };
}

export const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.ceil(fraction * (sorted.length - 1))];
};

// Per-frame coverage and completeness use the same owner as Renderer readback.
export function projectTimingFrame(frame) {
  if (!Array.isArray(frame?.passes)) return { status: 'failed', reason: 'missing pass roster' };
  const period = frame.timestampPeriodNanoseconds;
  const groups = {
    all: frame.passes,
    passBoundary: frame.passes.filter((pass) => pass.passKind !== 'copy'),
    copyEnvelope: frame.passes.filter((pass) => pass.passKind === 'copy'),
    ssr: frame.passes.filter((pass) => /^(ssr-|depth-pyramid-)/.test(pass.passName)),
  };
  const coverage = {};
  for (const [name, passes] of Object.entries(groups)) {
    const result = summarizeGpuPassTimingIntervals(passes, period);
    if (!result.ok) return { status: 'failed', reason: result.error };
    coverage[name] = result.value;
  }
  const mismatched = frame.passes.some((pass) => pass.status === 'measured' &&
    (!Number.isFinite(pass.durationNanoseconds) || Math.abs(
      Number(BigInt(pass.endTick) - BigInt(pass.beginningTick)) * period - pass.durationNanoseconds
    ) > 1e-9));
  if (mismatched) return { status: 'failed', reason: 'raw tick/duration mismatch' };
  const complete = frame.droppedPassCount === 0 &&
    frame.executedPassCount === frame.passes.length &&
    frame.measuredPassCount === frame.passes.length &&
    frame.passes.length > 0 && coverage.all.unmeasuredPassCount === 0;
  return {
    status: complete ? 'complete' : 'partial', coverage,
    nativeOuterQuery: { status: 'unavailable', reason: 'portable RHI exposes pass boundaries, not an enclosing graph query' },
    attribution: 'interval coverage only; feature cost requires paired whole-submission measurements',
  };
}

export function summarizeSamples(samplesMs) {
  return { samplesMs, sampleCount: samplesMs.filter(Number.isFinite).length,
    p50Ms: percentile(samplesMs, 0.5), p95Ms: percentile(samplesMs, 0.95) };
}

export function summarizePerformanceWindow(report, start = 120, count = 60) {
  const frames = report?.performanceTiming?.timingFrames?.slice(start, start + count) ?? [];
  const rows = frames.map((frame, index) => ({
    frameId: frame.frameId, intervals: projectTimingFrame(frame),
    cpuSubmissionMs: report.performanceTiming.cpu.samples[start + index],
    completionWaitMs: report.performanceTiming.cpu.completionWaitSamples?.[start + index] ?? null,
    endToEndMs: report.performanceTiming.cpu.endToEndSamples?.[start + index] ?? null,
  }));
  return {
    startOrdinal: start + 1, endOrdinal: start + count, frames: rows,
    complete: rows.length === count && new Set(rows.map((row) => row.frameId)).size === count &&
      rows.every((row) => row.intervals.status === 'complete' && Number.isFinite(row.cpuSubmissionMs) &&
        Number.isFinite(row.completionWaitMs) && Number.isFinite(row.endToEndMs)),
    cpuSubmission: summarizeSamples(rows.map((row) => row.cpuSubmissionMs)),
    completionWait: summarizeSamples(rows.map((row) => row.completionWaitMs)),
    endToEnd: summarizeSamples(rows.map((row) => row.endToEndMs)),
    gpuEnvelope: summarizeSamples(rows.map((row) => row.intervals.coverage?.all.envelopeNanoseconds / 1e6)),
    gpuUnion: summarizeSamples(rows.map((row) => row.intervals.coverage?.all.unionNanoseconds / 1e6)),
    ssrSumDiagnostic: summarizeSamples(rows.map((row) => row.intervals.coverage?.ssr.sumNanoseconds / 1e6)),
  };
}

export function abbaIncrement(windows, key) {
  const stats = windows.map((window) => window[key]);
  if (stats.length !== 4 || stats.some((stat) => !Number.isFinite(stat?.p50Ms) || !Number.isFinite(stat?.p95Ms))) return null;
  return {
    method: '(median(B1)+median(B2)-median(A1)-median(A2))/2',
    p50Ms: (stats[1].p50Ms + stats[2].p50Ms - stats[0].p50Ms - stats[3].p50Ms) / 2,
    p95Ms: (stats[1].p95Ms + stats[2].p95Ms - stats[0].p95Ms - stats[3].p95Ms) / 2,
    tailMethod: 'ABBA shift of per-run p95; not a percentile of an exclusive-cost distribution',
    // Paired ordinal deltas are diagnostic tail evidence, not independent experiments.
    pairedOrdinalDeltas: summarizeSamples(stats[0].samplesMs.map((_, index) =>
      (stats[1].samplesMs[index] + stats[2].samplesMs[index] - stats[0].samplesMs[index] - stats[3].samplesMs[index]) / 2)),
    runs: stats.map(({ p50Ms, p95Ms }) => ({ p50Ms, p95Ms })),
  };
}
