import { err, ok, type Result } from '@forgeax/engine-types';
import {
  GPU_PASS_TIMING_ARTIFACT_SCHEMA_VERSION,
  GPU_PASS_TIMING_BENCHMARK,
  freezeGpuPassTimingBenchmarkReport,
  type GpuPassTimingArtifactJson,
  type GpuPassTimingBenchmarkReport,
  type ReadonlyGpuPassTimingBenchmarkReport,
} from './schema.js';

export type GpuPassTimingArtifactErrorCode =
  | 'artifact-not-json-safe'
  | 'artifact-schema-mismatch'
  | 'artifact-identity-missing'
  | 'artifact-source-mismatch'
  | 'artifact-not-real-gpu'
  | 'artifact-sampling-invalid'
  | 'artifact-raw-window-invalid'
  | 'artifact-completeness-invalid'
  | 'artifact-frame-facts-invalid'
  | 'artifact-off-path-nonzero'
  | 'artifact-overhead-invalid'
  | 'artifact-verdict-invalid';

export interface GpuPassTimingArtifactError {
  readonly code: GpuPassTimingArtifactErrorCode;
  readonly path: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Record<string, GpuPassTimingArtifactJson>;
}

const SOURCE_HEAD = /^[0-9a-f]{40}$/;
const REQUIRED_PACKAGE = '@forgeax/engine-render';
const GROUP_COUNT = 5;
const FRAMES_PER_GROUP = 60;
const WARMUP_FRAMES = 120;
const GPU_OVERHEAD_LIMIT_PERCENT = 10;

function failure(
  code: GpuPassTimingArtifactErrorCode,
  path: string,
  expected: string,
  hint: string,
  detail: Record<string, GpuPassTimingArtifactJson> = {},
): Result<never, GpuPassTimingArtifactError> {
  return err({ code, path, expected, hint, detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkJsonSafe(value: unknown, path = ''): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : path;
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'bigint') {
    return path;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const badPath = checkJsonSafe(child, `${path}/${index}`);
      if (badPath !== undefined) return badPath;
    }
    return undefined;
  }
  if (!isRecord(value)) return path;
  for (const [key, child] of Object.entries(value)) {
    const badPath = checkJsonSafe(child, `${path}/${key}`);
    if (badPath !== undefined) return badPath;
  }
  return undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decimalTick(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function ticksAreOrdered(beginningTick: string, endTick: string): boolean {
  try {
    return BigInt(endTick) >= BigInt(beginningTick);
  } catch {
    return false;
  }
}

function validFrameFactPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== '1.0' ||
    !nonNegativeInteger(value.frameId) ||
    value.frameId === 0 ||
    !nonNegativeInteger(value.deviceGeneration) ||
    !nonNegativeInteger(value.graphGeneration) ||
    typeof value.backendKind !== 'string' ||
    !finiteNumber(value.timestampPeriodNanoseconds) ||
    value.timestampPeriodNanoseconds <= 0 ||
    !nonNegativeInteger(value.passCapacity) ||
    value.passCapacity === 0 ||
    !nonNegativeInteger(value.executedPassCount) ||
    !nonNegativeInteger(value.measuredPassCount) ||
    !nonNegativeInteger(value.droppedPassCount) ||
    !Array.isArray(value.passes) ||
    value.passes.length > value.passCapacity ||
    !finiteNumber(value.measuredPassNanoseconds) ||
    value.measuredPassNanoseconds < 0 ||
    value.executedPassCount !== value.passes.length + value.droppedPassCount
  ) {
    return false;
  }
  let measuredPassCount = 0;
  let measuredPassNanoseconds = 0;
  let previousExecutionIndex = -1;
  for (const pass of value.passes) {
    if (
      !isRecord(pass) ||
      typeof pass.passName !== 'string' ||
      !['raster', 'compute', 'copy'].includes(pass.passKind as string) ||
      !nonNegativeInteger(pass.executionIndex) ||
      pass.executionIndex <= previousExecutionIndex
    ) {
      return false;
    }
    previousExecutionIndex = pass.executionIndex;
    if (pass.status === 'measured') {
      if (
        (pass.passKind === 'copy'
          ? pass.measurementSource !== 'copy-boundary-envelope'
          : pass.measurementSource !== 'pass-boundary') ||
        !decimalTick(pass.beginningTick) ||
        !decimalTick(pass.endTick) ||
        !ticksAreOrdered(pass.beginningTick, pass.endTick) ||
        !finiteNumber(pass.durationNanoseconds) ||
        pass.durationNanoseconds < 0
      ) {
        return false;
      }
      measuredPassCount += 1;
      measuredPassNanoseconds += pass.durationNanoseconds;
    } else if (
      pass.status !== 'unmeasured' ||
      !isRecord(pass.reason) ||
      typeof pass.reason.code !== 'string'
    ) {
      return false;
    }
  }
  return (
    value.measuredPassCount === measuredPassCount &&
    value.measuredPassNanoseconds === measuredPassNanoseconds &&
    value.measuredPassCount <= value.executedPassCount
  );
}

function requiredIdentity(report: GpuPassTimingBenchmarkReport): Result<void, GpuPassTimingArtifactError> {
  if (!isRecord(report.source) || !isRecord(report.runner) || !isRecord(report.backend)) {
    return failure(
      'artifact-identity-missing',
      '/source',
      'source, runner, and backend identity objects',
      'rerun the benchmark with source and device identity capture enabled',
    );
  }
  if (
    !SOURCE_HEAD.test(report.source.sourceHead) ||
    report.source.package !== REQUIRED_PACKAGE ||
    typeof report.runner.name !== 'string' ||
    typeof report.runner.version !== 'string' ||
    typeof report.runner.os !== 'string' ||
    (report.runner.browser !== null && typeof report.runner.browser !== 'string') ||
    typeof report.backend.kind !== 'string' ||
    typeof report.backend.adapter !== 'string' ||
    typeof report.backend.driver !== 'string' ||
    typeof report.backend.browser !== 'string'
  ) {
    return failure(
      'artifact-source-mismatch',
      '/source',
      'a source SHA and matching render package/runner/backend identity',
      'rerun with the same Render source, runner, and backend identity recorded in the artifact',
    );
  }
  if (report.backend.realGpu !== true || report.backend.kind !== 'webgpu') {
    return failure(
      'artifact-not-real-gpu',
      '/backend',
      'realGpu=true with the WebGPU backend',
      'run on a real WebGPU adapter; RhiNull and capability-only evidence cannot be accepted',
    );
  }
  return ok(undefined);
}

function validateSampling(report: GpuPassTimingBenchmarkReport): Result<void, GpuPassTimingArtifactError> {
  if (!isRecord(report.workload) || !isRecord(report.sampling)) {
    return failure(
      'artifact-identity-missing',
      '/workload',
      'workload and sampling identity objects',
      'rerun with resolution, scene, pipeline, and sampling identity recorded',
    );
  }
  const resolution = report.workload.resolution;
  if (
    !isRecord(resolution) ||
    !finiteNumber(resolution.width) ||
    !finiteNumber(resolution.height) ||
    resolution.width <= 0 ||
    resolution.height <= 0 ||
    typeof report.workload.scene !== 'string' ||
    typeof report.workload.pipeline !== 'string' ||
    report.sampling.warmupFrames !== WARMUP_FRAMES ||
    report.sampling.groups !== GROUP_COUNT ||
    report.sampling.framesPerGroup !== FRAMES_PER_GROUP ||
    report.sampling.quantile !== 'nearest-rank-p95'
  ) {
    return failure(
      'artifact-sampling-invalid',
      '/sampling',
      '120 warmup frames, 5 paired groups, 60 frames per side, nearest-rank p95',
      'rerun the paired benchmark with the fixed M5 sampling window',
    );
  }
  return ok(undefined);
}

function validateWindows(report: GpuPassTimingBenchmarkReport): Result<void, GpuPassTimingArtifactError> {
  if (!isRecord(report.windows) || !Array.isArray(report.windows.groups)) {
    return failure(
      'artifact-raw-window-invalid',
      '/windows/groups',
      'five raw paired groups',
      'retain every off/on group and its intermediate p95 values in the report',
    );
  }
  if (report.windows.groups.length !== GROUP_COUNT) {
    return failure(
      'artifact-raw-window-invalid',
      '/windows/groups',
      'exactly five raw paired groups',
      'rerun until all five off/on groups are complete',
    );
  }
  for (const [index, group] of report.windows.groups.entries()) {
    if (
      !isRecord(group) ||
      group.group !== index ||
      group.frames !== FRAMES_PER_GROUP ||
      !isRecord(group.off) ||
      !isRecord(group.on)
    ) {
      return failure(
        'artifact-raw-window-invalid',
        `/windows/groups/${index}`,
        'paired off/on raw windows with 60 frames and stable group order',
        'keep group counts and frame-generation identity aligned between off and on',
      );
    }
    for (const mode of ['off', 'on'] as const) {
      const window = group[mode];
      if (
        !Array.isArray(window.frameDurationsMicroseconds) ||
        window.frameDurationsMicroseconds.length === 0 ||
        !window.frameDurationsMicroseconds.every(finiteNumber) ||
        !finiteNumber(window.p95FrameDurationMicroseconds) ||
        window.p95FrameDurationMicroseconds <= 0
      ) {
        return failure(
          'artifact-raw-window-invalid',
          `/windows/groups/${index}/${mode}`,
          'finite positive raw frame durations and p95',
          'discard the incomplete window and capture a fresh finite sample set',
        );
      }
    }
  }
  return ok(undefined);
}

function validateCompleteness(
  report: GpuPassTimingBenchmarkReport,
): Result<void, GpuPassTimingArtifactError> {
  const completeness = report.timingCompleteness;
  if (
    !isRecord(completeness) ||
    completeness.status !== 'complete' ||
    !isRecord(completeness.off) ||
    !isRecord(completeness.on) ||
    completeness.off.completeFrames !== GROUP_COUNT * FRAMES_PER_GROUP ||
    completeness.on.completeFrames !== GROUP_COUNT * FRAMES_PER_GROUP ||
    completeness.off.partialFrames !== 0 ||
    completeness.off.failedFrames !== 0 ||
    completeness.on.partialFrames !== 0 ||
    completeness.on.failedFrames !== 0
  ) {
    return failure(
      'artifact-completeness-invalid',
      '/timingCompleteness',
      'complete status with 300 complete frames and zero partial/failed frames per side',
      'do not promote partial or failed receipt observations; recapture the missing window',
    );
  }
  return ok(undefined);
}

function validateFrameFacts(
  report: GpuPassTimingBenchmarkReport,
): Result<void, GpuPassTimingArtifactError> {
  if (!Array.isArray(report.frameFacts) || report.frameFacts.length !== GROUP_COUNT) {
    return failure(
      'artifact-frame-facts-invalid',
      '/frameFacts',
      'one complete on-path GPU frame fact for each paired group',
      'retain a representative observed frame with raw ticks and measured pass durations for every on group',
    );
  }
  for (const [index, fact] of report.frameFacts.entries()) {
    if (
      !isRecord(fact) ||
      fact.side !== 'on' ||
      fact.group !== index ||
      !nonNegativeInteger(fact.frameIndex) ||
      fact.frameIndex >= FRAMES_PER_GROUP ||
      fact.observationStatus !== 'complete' ||
      !validFrameFactPayload(fact.frame)
    ) {
      return failure(
        'artifact-frame-facts-invalid',
        `/frameFacts/${index}`,
        'an ordered complete on-path frame fact with JSON-safe raw ticks and self-consistent pass totals',
        'capture one complete timing observation per on group; never replace missing or partial durations with zero',
      );
    }
    const frame = fact.frame as Record<string, unknown>;
    if (
      frame.droppedPassCount !== 0 ||
      frame.measuredPassCount !== frame.executedPassCount
    ) {
      return failure(
        'artifact-frame-facts-invalid',
        `/frameFacts/${index}/frame`,
        'complete frame facts with every executed pass measured and no dropped pass',
        'keep partial frame facts in blocked evidence and recapture the accepted benchmark',
      );
    }
  }
  return ok(undefined);
}

function validateOffPath(report: GpuPassTimingBenchmarkReport): Result<void, GpuPassTimingArtifactError> {
  const offPath = report.offPath;
  if (
    !isRecord(offPath) ||
    ![
      offPath.featureResources,
      offPath.commandCount,
      offPath.pendingPromises,
      offPath.mapCalls,
      offPath.factObjects,
      offPath.profilerGpuRecords,
    ].every((count) => count === 0)
  ) {
    return failure(
      'artifact-off-path-nonzero',
      '/offPath',
      'all timing resources, commands, promises, maps, facts, and profiler GPU records equal zero',
      'disable gpuPassTiming and recapture the off path without allocating timing state',
    );
  }
  return ok(undefined);
}

function validateOverhead(report: GpuPassTimingBenchmarkReport): Result<void, GpuPassTimingArtifactError> {
  const overhead = report.overhead;
  if (
    !isRecord(overhead) ||
    !Array.isArray(overhead.pairedGroups) ||
    overhead.pairedGroups.length !== GROUP_COUNT ||
    overhead.thresholdPercent !== GPU_OVERHEAD_LIMIT_PERCENT ||
    !finiteNumber(overhead.reportedOverheadPercent) ||
    overhead.reportedOverheadPercent > GPU_OVERHEAD_LIMIT_PERCENT ||
    (overhead.verdict !== undefined && overhead.verdict !== 'accepted') ||
    !overhead.pairedGroups.every(
      (group, index) =>
        isRecord(group) &&
        group.group === index &&
        finiteNumber(group.offP95FrameDurationMicroseconds) &&
        finiteNumber(group.onP95FrameDurationMicroseconds) &&
        group.offP95FrameDurationMicroseconds > 0 &&
        finiteNumber(group.overheadPercent),
    )
  ) {
    return failure(
      'artifact-overhead-invalid',
      '/overhead',
      'five finite paired overheads with reported GPU overhead at most 10 percent',
      're-run the paired benchmark with complete windows; GPU owner ceiling is independent of CPU 20 percent governance',
    );
  }
  return ok(undefined);
}

function validateCpu(report: GpuPassTimingBenchmarkReport): Result<void, GpuPassTimingArtifactError> {
  const cpu = report.cpu;
  if (
    !isRecord(cpu) ||
    !finiteNumber(cpu.overheadPercent) ||
    cpu.thresholdPercent !== 20 ||
    cpu.verdict !== (cpu.overheadPercent <= 20 ? 'accepted' : 'refused')
  ) {
    return failure(
      'artifact-overhead-invalid',
      '/cpu',
      'an independent CPU verdict using the unchanged 20 percent threshold',
      'keep CPU ProfileCapture units and phases separate from the GPU timing report',
    );
  }
  return ok(undefined);
}

export function validateGpuPassTimingReport(
  report: GpuPassTimingBenchmarkReport,
): Result<ReadonlyGpuPassTimingBenchmarkReport, GpuPassTimingArtifactError> {
  const jsonPath = checkJsonSafe(report);
  if (jsonPath !== undefined) {
    return failure(
      'artifact-not-json-safe',
      jsonPath,
      'JSON-safe finite primitive values, arrays, and objects only',
      'serialize only bounded JSON facts; remove non-finite values and runtime handles',
    );
  }
  if (
    !isRecord(report) ||
    report.schemaVersion !== GPU_PASS_TIMING_ARTIFACT_SCHEMA_VERSION ||
    report.benchmark !== GPU_PASS_TIMING_BENCHMARK
  ) {
    return failure(
      'artifact-schema-mismatch',
      '/schemaVersion',
      `schemaVersion=${GPU_PASS_TIMING_ARTIFACT_SCHEMA_VERSION} and benchmark=${GPU_PASS_TIMING_BENCHMARK}`,
      'emit the current versioned Render GPU timing artifact schema',
    );
  }
  const checks = [
    requiredIdentity(report),
    validateSampling(report),
    validateWindows(report),
    validateCompleteness(report),
    validateFrameFacts(report),
    validateOffPath(report),
    validateOverhead(report),
    validateCpu(report),
  ];
  for (const check of checks) if (!check.ok) return check;
  if (
    report.verdict !== 'accepted' ||
    typeof report.reason !== 'string' ||
    report.reason.length === 0 ||
    typeof report.hint !== 'string' ||
    report.hint.length === 0
  ) {
    return failure(
      'artifact-verdict-invalid',
      '/verdict',
      'accepted verdict with a non-empty reason and recovery hint',
      'keep refused or blocked artifacts as evidence, but never label them accepted',
    );
  }
  return ok(freezeGpuPassTimingBenchmarkReport(report));
}
