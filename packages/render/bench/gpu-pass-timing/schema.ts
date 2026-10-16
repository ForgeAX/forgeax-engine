import type { GpuPassTimingFrame } from '../../src/record/gpu-pass-timing/contract.js';

export const GPU_PASS_TIMING_BENCHMARK = 'render-gpu-pass-timing' as const;
export const GPU_PASS_TIMING_ARTIFACT_SCHEMA_VERSION = '1.0' as const;

export type GpuPassTimingArtifactVerdict = 'accepted' | 'refused' | 'blocked';

export interface GpuPassTimingSourceIdentity {
  sourceHead: string;
  package: string;
}

export interface GpuPassTimingRunnerIdentity {
  name: string;
  version: string;
  os: string;
  browser: string | null;
}

export interface GpuPassTimingBackendIdentity {
  kind: string;
  adapter: string;
  driver: string;
  browser: string;
  realGpu: boolean;
}

export interface GpuPassTimingWorkloadIdentity {
  resolution: { width: number; height: number };
  scene: string;
  pipeline: string;
}

export interface GpuPassTimingSampling {
  warmupFrames: number;
  groups: number;
  framesPerGroup: number;
  quantile: 'nearest-rank-p95';
}

export interface GpuPassTimingWindowSummary {
  frameDurationsMicroseconds: number[];
  p95FrameDurationMicroseconds: number;
}

export interface GpuPassTimingRawGroup {
  group: number;
  frames: number;
  off: GpuPassTimingWindowSummary;
  on: GpuPassTimingWindowSummary;
}

export interface GpuPassTimingWindows {
  groups: GpuPassTimingRawGroup[];
}

export interface GpuPassTimingCompletenessSide {
  completeFrames: number;
  partialFrames: number;
  failedFrames: number;
}

export interface GpuPassTimingCompleteness {
  status: 'complete' | 'partial' | 'failed';
  off: GpuPassTimingCompletenessSide;
  on: GpuPassTimingCompletenessSide;
}

export interface GpuPassTimingFrameFact {
  side: 'off' | 'on';
  group: number;
  frameIndex: number;
  observationStatus: 'complete' | 'partial';
  frame: GpuPassTimingFrame;
}

export interface GpuPassTimingOffPath {
  featureResources: number;
  commandCount: number;
  pendingPromises: number;
  mapCalls: number;
  factObjects: number;
  profilerGpuRecords: number;
}

export interface GpuPassTimingPairedGroup {
  group: number;
  offP95FrameDurationMicroseconds: number;
  onP95FrameDurationMicroseconds: number;
  overheadPercent: number;
}

export interface GpuPassTimingOverhead {
  pairedGroups: GpuPassTimingPairedGroup[];
  reportedOverheadPercent: number;
  thresholdPercent: 10;
  verdict?: 'accepted' | 'refused';
}

export interface GpuPassTimingCpuVerdict {
  verdict: 'accepted' | 'refused';
  overheadPercent: number;
  thresholdPercent: 20;
}

export interface GpuPassTimingBenchmarkReport {
  schemaVersion: typeof GPU_PASS_TIMING_ARTIFACT_SCHEMA_VERSION;
  benchmark: typeof GPU_PASS_TIMING_BENCHMARK;
  source: GpuPassTimingSourceIdentity;
  runner: GpuPassTimingRunnerIdentity;
  backend: GpuPassTimingBackendIdentity;
  workload: GpuPassTimingWorkloadIdentity;
  sampling: GpuPassTimingSampling;
  windows: GpuPassTimingWindows;
  frameFacts: GpuPassTimingFrameFact[];
  timingCompleteness: GpuPassTimingCompleteness;
  offPath: GpuPassTimingOffPath;
  overhead: GpuPassTimingOverhead;
  cpu: GpuPassTimingCpuVerdict;
  verdict: GpuPassTimingArtifactVerdict;
  reason: string;
  hint: string;
}

export type GpuPassTimingArtifactJson =
  | null
  | boolean
  | number
  | string
  | GpuPassTimingArtifactJson[]
  | { [key: string]: GpuPassTimingArtifactJson };

export type ReadonlyGpuPassTimingBenchmarkReport = {
  readonly [Key in keyof GpuPassTimingBenchmarkReport]: ReadonlyValue<
    GpuPassTimingBenchmarkReport[Key]
  >;
};

type ReadonlyValue<Value> = Value extends (infer Item)[]
  ? readonly ReadonlyValue<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: ReadonlyValue<Value[Key]> }
    : Value;

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function freezeGpuPassTimingBenchmarkReport(
  report: GpuPassTimingBenchmarkReport,
): ReadonlyGpuPassTimingBenchmarkReport {
  return deepFreeze(report) as ReadonlyGpuPassTimingBenchmarkReport;
}
