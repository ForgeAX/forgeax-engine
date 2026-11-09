import type {
  FrameTiming,
  ReplayBenchmark,
  ReplayBenchmarkOptions,
  ReplayComparison,
  ReplayRestoreMode,
  ReplaySkip,
} from '@forgeax/engine-rhi-debug';
import type { CommandResult } from '../types.js';
import type { ArtifactRef } from './operations.js';
import type { TimingEnvironment, TimingPreflight } from './timing-environment.js';

export interface RhiTimingInput {
  readonly artifact: ArtifactRef;
  /** Measured replays, or the minimum with `ciMs`. Default 20. */
  readonly repeat?: number;
  /** Unmeasured replays first (pipeline compiles, lazy clears). Default 3. */
  readonly warmup?: number;
  /** Submit and drain the queue around every pass; the isolated sum bounds the real frame from above. */
  readonly isolate?: boolean;
  /** RegExp over pass labels to skip in an interleaved ablated variant. */
  readonly skip?: string;
  /** `passIndex` values to skip. */
  readonly skipPasses?: readonly number[];
  /** `workIndex` values (single draws or dispatches) to skip inside their passes. */
  readonly skipWorks?: readonly number[];
  /** `steady` (default) restores state with GPU copies; `reload` re-uploads the tape every replay. */
  readonly restore?: ReplayRestoreMode;
  /** Replays submitted per timestamp bank without waiting. Default 4; 0 waits for every replay. */
  readonly pipelineDepth?: number;
  /** Extend repeat until the 95% interval of the union p50 (or of the paired delta) is at most this many ms. */
  readonly ciMs?: number;
  /** Upper bound on measured replays when converging. Default 200. */
  readonly maxRepeat?: number;
  /** Fail with `timing-timeout` when the whole operation takes longer. Default 600000. */
  readonly timeoutMs?: number;
  /** Baseline tape: time it interleaved against `artifact` (the candidate) and report candidate minus baseline. */
  readonly compare?: ArtifactRef;
  /** GPU utilization (percent) at or above which the result is invalid. Default 5. */
  readonly maxGpuPercent?: number;
  /** Fail with `gpu-busy` instead of measuring when the GPU is busy before the run. */
  readonly requireIdle?: boolean;
}

export interface RhiTimingOutput {
  readonly artifact: ArtifactRef;
  /** False when a preflight error check failed; `invalidReasons` says why. */
  readonly valid: boolean;
  readonly invalidReasons: readonly string[];
  readonly preflight: TimingPreflight;
  readonly environment: TimingEnvironment;
  /** Per-pass base p50 and the base p50 of the summed pass time; absent with `compare`. */
  readonly timing?: FrameTiming;
  /** Single-tape benchmark; absent with `compare`. */
  readonly benchmark?: ReplayBenchmark;
  /** With `compare`: the baseline tape and the interleaved comparison. */
  readonly baseline?: ArtifactRef;
  readonly comparison?: ReplayComparison;
}

const indexList = { type: 'array', items: { type: 'integer', minimum: 0 } } as const;

/** Timing knobs shared by the manifest and the CLI flag schema; `compare` is added per surface. */
export const RHI_TIMING_OPTION_PROPERTIES = {
  repeat: { type: 'integer', minimum: 1 },
  warmup: { type: 'integer', minimum: 0 },
  isolate: { type: 'boolean' },
  skip: { type: 'string' },
  skipPasses: indexList,
  skipWorks: indexList,
  restore: { type: 'string', enum: ['steady', 'reload'] },
  pipelineDepth: { type: 'integer', minimum: 0 },
  ciMs: { type: 'number', exclusiveMinimum: 0 },
  maxRepeat: { type: 'integer', minimum: 1 },
  timeoutMs: { type: 'integer', minimum: 1 },
  maxGpuPercent: { type: 'number', exclusiveMinimum: 0 },
  requireIdle: { type: 'boolean' },
} as const;

export const DEFAULT_TIMING_TIMEOUT_MS = 600_000;

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export function timingBenchmarkOptions(input: RhiTimingInput): ReplayBenchmarkOptions {
  const skip: ReplaySkip = {
    ...optional('passLabel', input.skip),
    ...optional('passIndices', input.skipPasses),
    ...optional('workIndices', input.skipWorks),
  };
  return {
    ...optional('repeat', input.repeat),
    ...optional('warmup', input.warmup),
    ...(input.isolate === true ? { isolate: true } : {}),
    ...(Object.keys(skip).length === 0 ? {} : { skip }),
    ...optional('restore', input.restore),
    ...optional('pipelineDepth', input.pipelineDepth),
    ...optional('ciTargetNanoseconds', input.ciMs === undefined ? undefined : input.ciMs * 1e6),
    ...optional('maxRepeat', input.maxRepeat),
  };
}

/** Collapse a benchmark to the single-replay `FrameTiming` shape using base medians. */
export function timingFromBenchmark(benchmark: ReplayBenchmark): FrameTiming {
  return {
    passes: benchmark.passes.map((pass) => ({
      passIndex: pass.passIndex,
      kind: pass.kind,
      label: pass.label,
      workIndices: pass.workIndices,
      gpuNanoseconds: pass.gpu?.p50 ?? null,
    })),
    totalGpuNanoseconds: benchmark.base.frame.sum.p50,
  };
}

/**
 * Resolve `work` or fail with `timing-timeout` after `timeoutMs`, aborting
 * `controller` so cooperative replay loops stop. A replay stuck inside the
 * GPU driver cannot be interrupted; the CLI process exits after the error.
 */
export async function withTimingTimeout<T>(
  work: (signal: AbortSignal) => Promise<CommandResult<T>>,
  timeoutMs: number,
  stage: () => string,
): Promise<CommandResult<T>> {
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CommandResult<T>>((resolveTimeout) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveTimeout({
        ok: false,
        error: {
          code: 'timing-timeout',
          expected: `rhi.timing to finish within ${timeoutMs} ms`,
          hint: 'Lower repeat/maxRepeat or ciMs, check that no other process holds the GPU, or raise --timeout-ms.',
          detail: { timeoutMs, elapsedMs: Date.now() - started, stage: stage() },
        },
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
