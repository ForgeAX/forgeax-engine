import { err, ok, type Result } from '@forgeax/engine-types';
import {
  GPU_PASS_TIMING_ARTIFACT_SCHEMA_VERSION,
  GPU_PASS_TIMING_BENCHMARK,
  freezeGpuPassTimingBenchmarkReport,
  type GpuPassTimingBackendIdentity,
  type GpuPassTimingBenchmarkReport,
  type GpuPassTimingCompleteness,
  type GpuPassTimingFrameFact,
  type GpuPassTimingOffPath,
  type GpuPassTimingRunnerIdentity,
  type GpuPassTimingSourceIdentity,
  type GpuPassTimingWorkloadIdentity,
} from './schema.js';
import {
  calculatePairedOverhead,
  GPU_PASS_TIMING_SAMPLING,
  joinGpuPassTimingWindows,
  type GpuPassTimingSampleWindow,
  type GpuPassTimingWindowPair,
} from './statistics.js';

export type CpuOverheadVerdict = 'accepted' | 'refused';

export interface CpuOverheadEvaluation {
  verdict: CpuOverheadVerdict;
  thresholdPercent: 20;
  overheadPercent: number;
  gpuVerdict?: 'accepted' | 'refused' | undefined;
}

export function evaluateCpuOverhead(
  overheadPercent: number,
  options: { gpuOverheadPercent?: number } = {},
): CpuOverheadEvaluation {
  const gpuVerdict =
    options.gpuOverheadPercent === undefined
      ? undefined
      : options.gpuOverheadPercent <= 10
        ? 'accepted'
        : 'refused';
  return {
    verdict: Number.isFinite(overheadPercent) && overheadPercent <= 20 ? 'accepted' : 'refused',
    thresholdPercent: 20,
    overheadPercent,
    ...(gpuVerdict === undefined ? {} : { gpuVerdict }),
  };
}

export interface GpuPassTimingReportInput {
  source: GpuPassTimingSourceIdentity;
  runner: GpuPassTimingRunnerIdentity;
  backend: GpuPassTimingBackendIdentity;
  workload: GpuPassTimingWorkloadIdentity;
  groups: readonly GpuPassTimingWindowPair[];
  frameFacts: readonly GpuPassTimingFrameFact[];
  timingCompleteness: GpuPassTimingCompleteness;
  offPath: GpuPassTimingOffPath;
  cpuOverheadPercent: number;
}

export interface GpuPassTimingReportBuildError {
  code: 'report-build-failed';
  expected: string;
  hint: string;
  detail: { cause: string };
}

function reportError(cause: unknown): Result<never, GpuPassTimingReportBuildError> {
  return err({
    code: 'report-build-failed',
    expected: 'five complete, identity-matched, finite paired timing windows',
    hint: 'recapture the same workload with all receipt observations complete',
    detail: { cause: cause instanceof Error ? cause.message : String(cause) },
  });
}

function rawGroup(pair: GpuPassTimingWindowPair, group: number) {
  return {
    group,
    frames: GPU_PASS_TIMING_SAMPLING.framesPerGroup,
    off: {
      frameDurationsMicroseconds: pair.off.frameDurationsMicroseconds,
      p95FrameDurationMicroseconds: 0,
    },
    on: {
      frameDurationsMicroseconds: pair.on.frameDurationsMicroseconds,
      p95FrameDurationMicroseconds: 0,
    },
  };
}

function windowP95(sample: GpuPassTimingSampleWindow): number {
  const sorted = [...sample.frameDurationsMicroseconds].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN;
}

export function createGpuPassTimingReport(
  input: GpuPassTimingReportInput,
): Result<GpuPassTimingBenchmarkReport, GpuPassTimingReportBuildError> {
  if (input.groups.length !== GPU_PASS_TIMING_SAMPLING.groups) return reportError('five groups required');
  for (const pair of input.groups) {
    const joined = joinGpuPassTimingWindows(pair.off, pair.on);
    if (!joined.ok) return reportError(joined.error.hint);
  }
  let overhead;
  try {
    overhead = calculatePairedOverhead(input.groups);
  } catch (cause) {
    return reportError(cause);
  }
  const cpu = evaluateCpuOverhead(input.cpuOverheadPercent);
  const groups = input.groups.map((pair, group) => {
    const raw = rawGroup(pair, group);
    raw.off.p95FrameDurationMicroseconds = windowP95(pair.off);
    raw.on.p95FrameDurationMicroseconds = windowP95(pair.on);
    return raw;
  });
  const report: GpuPassTimingBenchmarkReport = {
    schemaVersion: GPU_PASS_TIMING_ARTIFACT_SCHEMA_VERSION,
    benchmark: GPU_PASS_TIMING_BENCHMARK,
    source: input.source,
    runner: input.runner,
    backend: input.backend,
    workload: input.workload,
    sampling: { ...GPU_PASS_TIMING_SAMPLING, quantile: 'nearest-rank-p95' },
    windows: { groups },
    frameFacts: [...input.frameFacts],
    timingCompleteness: input.timingCompleteness,
    offPath: input.offPath,
    overhead: {
      pairedGroups: overhead.groupOverheadPercent.map((overheadPercent, group) => ({
        group,
        offP95FrameDurationMicroseconds: groups[group]?.off.p95FrameDurationMicroseconds ?? Number.NaN,
        onP95FrameDurationMicroseconds: groups[group]?.on.p95FrameDurationMicroseconds ?? Number.NaN,
        overheadPercent,
      })),
      reportedOverheadPercent: overhead.reportedOverheadPercent,
      thresholdPercent: 10,
      verdict: overhead.reportedOverheadPercent <= 10 ? 'accepted' : 'refused',
    },
    cpu,
    verdict: cpu.verdict === 'accepted' ? 'accepted' : 'refused',
    reason: 'GPU pass timing artifact is complete and paired within the independent owner gates',
    hint: 'Keep source, runner, backend, workload, and frame-generation identity stable',
  };
  return ok(freezeGpuPassTimingBenchmarkReport(report));
}
