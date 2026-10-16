import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { GpuPassTimingReason } from './errors.js';

export const GPU_PASS_TIMING_SCHEMA_VERSION = '1.0' as const;

export interface GpuPassTimingOptions {
  readonly maxPassesPerFrame?: number | undefined;
  readonly maxFramesInFlight?: number | undefined;
  readonly retentionFrames?: number | undefined;
}

export interface NormalizedGpuPassTimingOptions {
  readonly maxPassesPerFrame: number;
  readonly maxFramesInFlight: number;
  readonly retentionFrames: number;
}

export const DEFAULT_GPU_PASS_TIMING_OPTIONS: NormalizedGpuPassTimingOptions = Object.freeze({
  maxPassesPerFrame: 256,
  maxFramesInFlight: 3,
  retentionFrames: 8,
});

function optionError(field: string, value: number, min: number, max: number): GpuPassTimingReason {
  return {
    code: 'invalid-timing-options',
    expected: `${field} is an integer in [${min}, ${max}]`,
    hint: `set ${field} to an integer in [${min}, ${max}]`,
    detail: { field, value, min, max },
  };
}

function validInteger(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function normalizeGpuPassTimingOptions(
  options: GpuPassTimingOptions = {},
): Result<NormalizedGpuPassTimingOptions, GpuPassTimingReason> {
  const maxPassesPerFrame =
    options.maxPassesPerFrame ?? DEFAULT_GPU_PASS_TIMING_OPTIONS.maxPassesPerFrame;
  if (!validInteger(maxPassesPerFrame, 1, 2048)) {
    return err(optionError('maxPassesPerFrame', maxPassesPerFrame, 1, 2048));
  }
  const maxFramesInFlight =
    options.maxFramesInFlight ?? DEFAULT_GPU_PASS_TIMING_OPTIONS.maxFramesInFlight;
  if (!validInteger(maxFramesInFlight, 1, 8)) {
    return err(optionError('maxFramesInFlight', maxFramesInFlight, 1, 8));
  }
  const retentionFrames =
    options.retentionFrames ?? DEFAULT_GPU_PASS_TIMING_OPTIONS.retentionFrames;
  if (!validInteger(retentionFrames, 1, 8)) {
    return err(optionError('retentionFrames', retentionFrames, 1, 8));
  }
  return ok(Object.freeze({ maxPassesPerFrame, maxFramesInFlight, retentionFrames }));
}

export interface GpuPassTimingPassIdentity {
  /** Camera entity for view work; absent for shared simulation and composition. */
  readonly viewId?: number | undefined;
  readonly passName: string;
  readonly passKind: 'raster' | 'compute' | 'copy';
  readonly executionIndex: number;
}

export type GpuPassTimingMeasurementSource = 'pass-boundary' | 'copy-boundary-envelope';

export interface GpuPassTimingMeasuredEntry extends GpuPassTimingPassIdentity {
  readonly status: 'measured';
  readonly measurementSource: GpuPassTimingMeasurementSource;
  readonly beginningTick: string;
  readonly endTick: string;
  readonly durationNanoseconds: number;
  readonly timerResolution?: 'equal-ticks' | undefined;
}

export interface GpuPassTimingUnmeasuredEntry extends GpuPassTimingPassIdentity {
  readonly status: 'unmeasured';
  readonly reason: GpuPassTimingReason;
}

export type GpuPassTimingEntry = GpuPassTimingMeasuredEntry | GpuPassTimingUnmeasuredEntry;

export interface GpuPassTimingFrame {
  readonly schemaVersion: typeof GPU_PASS_TIMING_SCHEMA_VERSION;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly backendKind: RhiCaps['backendKind'];
  readonly timestampPeriodNanoseconds: number;
  readonly passCapacity: number;
  readonly executedPassCount: number;
  readonly measuredPassCount: number;
  readonly droppedPassCount: number;
  readonly passes: readonly GpuPassTimingEntry[];
  /** Sum with repeated interval coverage; not frame latency or exclusive GPU cost. */
  readonly measuredPassNanoseconds: number;
}

export interface GpuPassTimingFrameInput {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly backendKind: RhiCaps['backendKind'];
  readonly timestampPeriodNanoseconds: number;
  readonly passCapacity: number;
  readonly passes: readonly GpuPassTimingEntry[];
  readonly droppedPassCount?: number | undefined;
}

export interface GpuPassTimingRef {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
}

export interface GpuPassTimingCapability {
  readonly timestampQuery: boolean;
  readonly timestampPeriodNanoseconds: number | null;
}

/**
 * Receipt-bound GPU pass facts. The four statuses are exhaustive: a caller can
 * branch on `status` without guessing whether a missing duration means that
 * the device lacks capability, the bounded capture failed, or a pass was
 * intentionally left unmeasured. A pass duration is not frame latency.
 */
export type GpuPassTimingObservation =
  | { readonly status: 'complete'; readonly frame: GpuPassTimingFrame }
  | {
      readonly status: 'partial';
      readonly frame: GpuPassTimingFrame;
      readonly reason: GpuPassTimingReason;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: GpuPassTimingReason;
      readonly capability: GpuPassTimingCapability;
    }
  | {
      readonly status: 'failed';
      readonly error: GpuPassTimingReason;
      readonly latestKnownGood?: GpuPassTimingRef | undefined;
    };

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function createGpuPassTimingFrame(input: GpuPassTimingFrameInput): GpuPassTimingFrame {
  let measuredPassCount = 0;
  let measuredPassNanoseconds = 0;
  for (const pass of input.passes) {
    if (pass.status === 'measured') {
      measuredPassCount += 1;
      measuredPassNanoseconds += pass.durationNanoseconds;
    }
  }
  return {
    schemaVersion: GPU_PASS_TIMING_SCHEMA_VERSION,
    frameId: input.frameId,
    deviceGeneration: input.deviceGeneration,
    graphGeneration: input.graphGeneration,
    backendKind: input.backendKind,
    timestampPeriodNanoseconds: input.timestampPeriodNanoseconds,
    passCapacity: input.passCapacity,
    executedPassCount: input.passes.length + (input.droppedPassCount ?? 0),
    measuredPassCount,
    droppedPassCount: input.droppedPassCount ?? 0,
    passes: input.passes,
    measuredPassNanoseconds,
  };
}

export function freezeGpuPassTimingFrame(frame: GpuPassTimingFrame): GpuPassTimingFrame {
  return deepFreeze(frame);
}
