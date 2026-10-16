import { err, ok, type Result } from '@forgeax/engine-types';

export const GPU_PASS_TIMING_SAMPLING = Object.freeze({
  warmupFrames: 120,
  groups: 5,
  framesPerGroup: 60,
});

export interface GpuPassTimingWindowIdentity {
  sourceHead: string;
  runner: string;
  backend: string;
  workload: string;
  frameGeneration: string;
}

export interface GpuPassTimingSampleWindow {
  identity: GpuPassTimingWindowIdentity;
  frameDurationsMicroseconds: number[];
  complete: boolean;
  offPathExactZero?: boolean;
}

export interface GpuPassTimingRawPair {
  off: readonly number[];
  on: readonly number[];
}

export interface GpuPassTimingWindowPair {
  off: GpuPassTimingSampleWindow;
  on: GpuPassTimingSampleWindow;
}

export interface GpuPassTimingPairedOverhead {
  groupOverheadPercent: number[];
  reportedOverheadPercent: number;
}

export interface GpuPassTimingOverheadOptions {
  readonly enforceLimit?: boolean;
}

export type GpuPassTimingIdentityJoinErrorCode =
  | 'identity-mismatch'
  | 'window-incomplete'
  | 'off-path-nonzero'
  | 'window-insufficient';

export interface GpuPassTimingIdentityJoinError {
  code: GpuPassTimingIdentityJoinErrorCode;
  expected: string;
  hint: string;
}

export interface GpuPassTimingJoinedWindowPair {
  identity: GpuPassTimingWindowIdentity;
  off: GpuPassTimingSampleWindow;
  on: GpuPassTimingSampleWindow;
}

export function nearestRankP95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}

function isSampleWindowPair(value: GpuPassTimingRawPair | GpuPassTimingWindowPair): value is GpuPassTimingWindowPair {
  return typeof value.off === 'object' && !Array.isArray(value.off);
}

function requireSamples(samples: readonly number[], side: string): void {
  if (
    samples.length < 3 ||
    !samples.every((sample) => Number.isFinite(sample) && sample > 0)
  ) {
    throw new Error(
      `complete five paired windows are required: ${side} window needs finite positive samples for 60 frames`,
    );
  }
}

export function calculatePairedOverhead(
  groups: readonly (GpuPassTimingRawPair | GpuPassTimingWindowPair)[],
  options: GpuPassTimingOverheadOptions = {},
): GpuPassTimingPairedOverhead {
  if (groups.length === 0) throw new Error('complete five paired windows are required');
  const overheads: number[] = [];
  for (const group of groups) {
    if (isSampleWindowPair(group)) {
      if (!group.off.complete || !group.on.complete) {
        throw new Error('complete five paired windows are required');
      }
      if (group.off.offPathExactZero === false || group.on.offPathExactZero === false) {
        throw new Error('off-path timing evidence must be exact-zero');
      }
      requireSamples(group.off.frameDurationsMicroseconds, 'off');
      requireSamples(group.on.frameDurationsMicroseconds, 'on');
      const offP95 = nearestRankP95(group.off.frameDurationsMicroseconds);
      const onP95 = nearestRankP95(group.on.frameDurationsMicroseconds);
      if (offP95 === null || onP95 === null || offP95 <= 0) {
        throw new Error('complete five paired windows are required');
      }
      overheads.push(((onP95 - offP95) / offP95) * 100);
      continue;
    }
    requireSamples(group.off, 'off');
    requireSamples(group.on, 'on');
    const offP95 = nearestRankP95(group.off);
    const onP95 = nearestRankP95(group.on);
    if (offP95 === null || onP95 === null || offP95 <= 0) {
      throw new Error('complete five paired windows are required');
    }
    overheads.push(((onP95 - offP95) / offP95) * 100);
  }
  const reportedOverheadPercent = median(overheads);
  if (
    (options.enforceLimit ?? true) &&
    (reportedOverheadPercent === null || reportedOverheadPercent > 10)
  ) {
    throw new Error('GPU paired overhead must be at most 10 percent');
  }
  return { groupOverheadPercent: overheads, reportedOverheadPercent };
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

export function joinGpuPassTimingWindows(
  off: GpuPassTimingSampleWindow,
  on: GpuPassTimingSampleWindow,
): Result<GpuPassTimingJoinedWindowPair, GpuPassTimingIdentityJoinError> {
  if (!sameIdentity(off.identity, on.identity)) {
    return err({
      code: 'identity-mismatch',
      expected: 'source, runner, backend, workload, and frame-generation identity must match',
      hint: 'rerun both windows with the same runner, adapter, workload, and generation',
    });
  }
  if (!off.complete || !on.complete) {
    return err({
      code: 'window-incomplete',
      expected: 'both paired windows are complete',
      hint: 'wait for all receipt observations before joining the paired samples',
    });
  }
  if (off.offPathExactZero === false || on.offPathExactZero === false) {
    return err({
      code: 'off-path-nonzero',
      expected: 'timing-disabled off-path evidence is exact-zero',
      hint: 'disable timing and recapture without timing resources or commands',
    });
  }
  if (
    off.frameDurationsMicroseconds.length !== GPU_PASS_TIMING_SAMPLING.framesPerGroup ||
    on.frameDurationsMicroseconds.length !== GPU_PASS_TIMING_SAMPLING.framesPerGroup
  ) {
    return err({
      code: 'window-insufficient',
      expected: 'both windows contain exactly 60 frame samples',
      hint: 'discard the short window and recapture the complete 60-frame group',
    });
  }
  return ok({ identity: off.identity, off, on });
}
