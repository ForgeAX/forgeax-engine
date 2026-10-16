import { err, ok, type Result } from '@forgeax/engine-types';
import {
  createGpuPassTimingReport,
  type GpuPassTimingReportBuildError,
} from './report.js';
import type { GpuPassTimingFrame } from '../../src/record/gpu-pass-timing/contract.js';
import { validateGpuPassTimingReport } from './validator.js';
import type {
  GpuPassTimingBackendIdentity,
  GpuPassTimingBenchmarkReport,
  GpuPassTimingCompleteness,
  GpuPassTimingFrameFact,
  GpuPassTimingOffPath,
  GpuPassTimingRunnerIdentity,
  GpuPassTimingSourceIdentity,
  GpuPassTimingWorkloadIdentity,
} from './schema.js';
import {
  GPU_PASS_TIMING_SAMPLING,
  calculatePairedOverhead,
  type GpuPassTimingSampleWindow,
  type GpuPassTimingPairedOverhead,
  type GpuPassTimingWindowIdentity,
  type GpuPassTimingWindowPair,
} from './statistics.js';

export type GpuPassTimingObservationStatus = 'complete' | 'partial' | 'failed' | 'unavailable';

export interface GpuPassTimingBenchObservation {
  readonly status: GpuPassTimingObservationStatus;
  readonly frame?: GpuPassTimingFrame | undefined;
}

export interface GpuPassTimingBenchFrame {
  receipt: unknown;
  frameDurationMicroseconds: number;
  identity: GpuPassTimingWindowIdentity;
  offPathExactZero: boolean;
  observe(receipt: unknown): Promise<GpuPassTimingBenchObservation>;
}

export interface GpuPassTimingBenchHost {
  source: GpuPassTimingSourceIdentity;
  runner: GpuPassTimingRunnerIdentity;
  backend: GpuPassTimingBackendIdentity;
  workload: GpuPassTimingWorkloadIdentity;
  draw(timingEnabled: boolean): Promise<GpuPassTimingBenchFrame>;
  offPath: GpuPassTimingOffPath;
  cpuOverheadPercent: number;
}

export interface GpuPassTimingBenchError {
  readonly code: 'gpu-benchmark-blocked';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly cause: string;
    readonly frameFacts?: readonly GpuPassTimingFrameFact[] | undefined;
    readonly timingCompleteness?: GpuPassTimingCompleteness | undefined;
    readonly windows?: readonly GpuPassTimingWindowPair[] | undefined;
    readonly pairedOverhead?: GpuPassTimingPairedOverhead | undefined;
    readonly cpuOverheadPercent?: number | undefined;
  };
}

function blocked(
  cause: string,
  frameFacts: readonly GpuPassTimingFrameFact[] = [],
  timingCompleteness?: GpuPassTimingCompleteness,
  diagnostics: {
    readonly windows?: readonly GpuPassTimingWindowPair[] | undefined;
    readonly pairedOverhead?: GpuPassTimingPairedOverhead | undefined;
    readonly cpuOverheadPercent?: number | undefined;
  } = {},
): Result<never, GpuPassTimingBenchError> {
  return err({
    code: 'gpu-benchmark-blocked',
    expected: 'a real WebGPU host with receipt-bound complete observations',
    hint: 'run the benchmark on a real timestamp-query adapter and preserve all identity fields',
    detail: {
      cause,
      ...(frameFacts.length > 0 ? { frameFacts } : {}),
      ...(timingCompleteness === undefined ? {} : { timingCompleteness }),
      ...(diagnostics.windows === undefined ? {} : { windows: diagnostics.windows }),
      ...(diagnostics.pairedOverhead === undefined
        ? {}
        : { pairedOverhead: diagnostics.pairedOverhead }),
      ...(diagnostics.cpuOverheadPercent === undefined
        ? {}
        : { cpuOverheadPercent: diagnostics.cpuOverheadPercent }),
    },
  });
}

function sameIdentity(left: GpuPassTimingWindowIdentity, right: GpuPassTimingWindowIdentity): boolean {
  return (
    left.sourceHead === right.sourceHead &&
    left.runner === right.runner &&
    left.backend === right.backend &&
    left.workload === right.workload &&
    left.frameGeneration === right.frameGeneration
  );
}

interface CollectedWindow {
  window: GpuPassTimingSampleWindow;
  completeFrames: number;
  partialFrames: number;
  failedFrames: number;
  frameFacts: GpuPassTimingFrameFact[];
}

async function collectWindow(
  host: GpuPassTimingBenchHost,
  timingEnabled: boolean,
  frameCount: number,
  side: GpuPassTimingFrameFact['side'],
  group: number,
): Promise<Result<CollectedWindow, GpuPassTimingBenchError>> {
  const frameDurationsMicroseconds: number[] = [];
  const frameFacts: GpuPassTimingFrameFact[] = [];
  let identity: GpuPassTimingWindowIdentity | undefined;
  let completeFrames = 0;
  let partialFrames = 0;
  let failedFrames = 0;
  let offPathExactZero = true;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frame = await host.draw(timingEnabled);
    if (!Number.isFinite(frame.frameDurationMicroseconds) || frame.frameDurationMicroseconds <= 0) {
      return blocked('frame duration is non-finite or non-positive');
    }
    if (identity === undefined) identity = frame.identity;
    if (!sameIdentity(identity, frame.identity)) return blocked('frame-generation identity changed', frameFacts);
    frameDurationsMicroseconds.push(frame.frameDurationMicroseconds);
    offPathExactZero = offPathExactZero && frame.offPathExactZero;
    const observation = await frame.observe(frame.receipt);
    const status = observation.status;
    if (
      timingEnabled &&
      (status === 'complete' || status === 'partial') &&
      observation.frame === undefined
    ) {
      return blocked('timing observation did not include its frame fact', frameFacts);
    }
    if (
      timingEnabled &&
      observation.frame !== undefined &&
      (status === 'complete' || status === 'partial') &&
      frameFacts.length === 0
    ) {
      frameFacts.push({
        side,
        group,
        frameIndex,
        observationStatus: status === 'partial' ? 'partial' : 'complete',
        frame: observation.frame,
      });
    }
    if (status === 'complete') completeFrames += 1;
    else if (status === 'partial') partialFrames += 1;
    else failedFrames += 1;
  }
  if (identity === undefined) return blocked('window produced no frame identity', frameFacts);
  return ok({
    window: {
      identity,
      frameDurationsMicroseconds,
      complete: completeFrames === frameCount,
      offPathExactZero,
    },
    completeFrames,
    partialFrames,
    failedFrames,
    frameFacts,
  });
}

function completeness(
  off: CollectedWindow,
  on: CollectedWindow,
): GpuPassTimingCompleteness {
  const status =
    off.failedFrames > 0 || on.failedFrames > 0
      ? 'failed'
      : off.partialFrames > 0 || on.partialFrames > 0
        ? 'partial'
        : 'complete';
  return {
    status,
    off: {
      completeFrames: off.completeFrames,
      partialFrames: off.partialFrames,
      failedFrames: off.failedFrames,
    },
    on: {
      completeFrames: on.completeFrames,
      partialFrames: on.partialFrames,
      failedFrames: on.failedFrames,
    },
  };
}

function addCompleteness(
  current: GpuPassTimingCompleteness,
  next: GpuPassTimingCompleteness,
): GpuPassTimingCompleteness {
  const status =
    current.status === 'failed' || next.status === 'failed'
      ? 'failed'
      : current.status === 'partial' || next.status === 'partial'
        ? 'partial'
        : 'complete';
  return {
    status,
    off: {
      completeFrames: current.off.completeFrames + next.off.completeFrames,
      partialFrames: current.off.partialFrames + next.off.partialFrames,
      failedFrames: current.off.failedFrames + next.off.failedFrames,
    },
    on: {
      completeFrames: current.on.completeFrames + next.on.completeFrames,
      partialFrames: current.on.partialFrames + next.on.partialFrames,
      failedFrames: current.on.failedFrames + next.on.failedFrames,
    },
  };
}

export async function runGpuPassTimingBenchmark(
  host: GpuPassTimingBenchHost,
): Promise<Result<GpuPassTimingBenchmarkReport, GpuPassTimingBenchError | GpuPassTimingReportBuildError>> {
  if (host.backend.realGpu !== true || host.backend.kind !== 'webgpu') {
    return blocked('host does not identify a real WebGPU adapter');
  }
  for (let frameIndex = 0; frameIndex < GPU_PASS_TIMING_SAMPLING.warmupFrames; frameIndex += 1) {
    const warmup = await host.draw(false);
    const warmupStatus = (await warmup.observe(warmup.receipt)).status;
    if (warmupStatus !== 'complete') return blocked(`warmup observation was ${warmupStatus}`);
  }
  const groups: GpuPassTimingWindowPair[] = [];
  const frameFacts: GpuPassTimingFrameFact[] = [];
  let timingCompleteness: GpuPassTimingCompleteness = {
    status: 'complete',
    off: { completeFrames: 0, partialFrames: 0, failedFrames: 0 },
    on: { completeFrames: 0, partialFrames: 0, failedFrames: 0 },
  };
  for (let group = 0; group < GPU_PASS_TIMING_SAMPLING.groups; group += 1) {
    const off = await collectWindow(
      host,
      false,
      GPU_PASS_TIMING_SAMPLING.framesPerGroup,
      'off',
      group,
    );
    if (!off.ok) return off;
    const on = await collectWindow(
      host,
      true,
      GPU_PASS_TIMING_SAMPLING.framesPerGroup,
      'on',
      group,
    );
    if (!on.ok) return on;
    timingCompleteness = addCompleteness(
      timingCompleteness,
      completeness(off.value, on.value),
    );
    frameFacts.push(...off.value.frameFacts, ...on.value.frameFacts);
    groups.push({ off: off.value.window, on: on.value.window });
  }
  const diagnosticsWithoutOverhead = {
    windows: groups,
    cpuOverheadPercent: host.cpuOverheadPercent,
  } as const;
  if (timingCompleteness.status !== 'complete') {
    return blocked(
      'timing observations must be complete before paired overhead is calculated',
      frameFacts,
      timingCompleteness,
      diagnosticsWithoutOverhead,
    );
  }
  const pairedOverhead = calculatePairedOverhead(groups, { enforceLimit: false });
  const diagnostics = {
    ...diagnosticsWithoutOverhead,
    pairedOverhead,
  } as const;
  if (pairedOverhead.reportedOverheadPercent > 10) {
    return blocked(
      'GPU paired overhead must be at most 10 percent',
      frameFacts,
      timingCompleteness,
      diagnostics,
    );
  }
  const report = createGpuPassTimingReport({
    source: host.source,
    runner: host.runner,
    backend: host.backend,
    workload: host.workload,
    groups,
    frameFacts,
    timingCompleteness,
    offPath: host.offPath,
    cpuOverheadPercent: host.cpuOverheadPercent,
  });
  if (!report.ok) return blocked(report.error.detail.cause, frameFacts, timingCompleteness, diagnostics);
  const validated = validateGpuPassTimingReport(report.value);
  if (!validated.ok) return blocked(validated.error.hint, frameFacts, timingCompleteness, diagnostics);
  return ok(validated.value);
}
