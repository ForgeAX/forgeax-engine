import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import {
  closedPasses,
  type MissingTimestampReason,
  type ReplayRunOptions,
  replayTimedFrame,
  type TimedReplay,
  type TimingHost,
} from './timing';
import {
  type ConfidenceInterval,
  type DriftStats,
  driftStats,
  medianInterval,
  type PairedDeltaVerdict,
  pairedDeltaVerdict,
} from './timing-confidence';
import { DEFAULT_PIPELINE_DEPTH, replayPipelined } from './timing-pipeline';
import { passLabel, planReplaySkip, type ReplaySkip, type ReplaySkipPlan } from './timing-plan';
import {
  type FrameTimes,
  frameTimes,
  type TimedInterval,
  type TimingStats,
  timingStats,
} from './timing-stats';
import type { SteadyRestoreSummary } from './timing-steady';

export interface ReplayBenchmarkOptions {
  /** Unmeasured replays per variant first; they absorb pipeline compiles and lazy clears. Default 3. */
  readonly warmup?: number;
  /** Measured replays per variant, or the minimum with `ciTargetNanoseconds`. Default 20. */
  readonly repeat?: number;
  /** Submit and drain the queue around every pass; the isolated sum is an upper bound. */
  readonly isolate?: boolean;
  /** Work to leave out in the ablated variant; base and ablated replays interleave. */
  readonly skip?: ReplaySkip;
  /**
   * How a replay returns to capture-start state. `steady` (default) keeps
   * every resource and restores mutable bytes with GPU copies; `reload`
   * re-creates and re-uploads them from the tape every replay.
   */
  readonly restore?: ReplayRestoreMode;
  /**
   * Replays submitted per timestamp bank without waiting on the GPU. Default
   * 4 in steady mode without isolation; 0 waits for every replay's readback.
   */
  readonly pipelineDepth?: number;
  /**
   * Keep adding measured rounds until the 95% interval of the convergence
   * metric (base union p50, or the paired union delta with a skip) is at most
   * this wide, up to `maxRepeat`.
   */
  readonly ciTargetNanoseconds?: number;
  /** Upper bound on measured rounds when converging. Default 200. */
  readonly maxRepeat?: number;
}

export type ReplayRestoreMode = 'steady' | 'reload';

/** Sum, union and envelope distributions over measured replays, in nanoseconds. */
export interface FrameBenchmark {
  readonly sum: TimingStats;
  readonly union: TimingStats;
  readonly envelope: TimingStats;
}

export interface ReplayVariantBenchmark {
  readonly frame: FrameBenchmark;
  /** Order-statistic 95% interval of the union p50. */
  readonly unionP50Interval: ConfidenceInterval;
  /** Trend of the union over measured replays; `stable: false` means clocks moved during the run. */
  readonly drift: DriftStats;
  /** Whole-frame times of every measured replay, in order. */
  readonly samples: readonly FrameTimes[];
}

export interface PassBenchmark {
  readonly passIndex: number;
  readonly kind: 'render' | 'compute';
  readonly label: string | null;
  readonly workIndices: readonly number[];
  /** Pass begin-to-end time in the base variant; null when never written. */
  readonly gpu: TimingStats | null;
  /** Same pass in the ablated variant; null when skipped or never written. */
  readonly ablatedGpu?: TimingStats | null;
  readonly skipped: boolean;
}

export interface ReplayAblation extends ReplayVariantBenchmark {
  readonly passIndices: readonly number[];
  readonly workIndices: readonly number[];
  /**
   * Paired base minus ablated whole-frame time per measured round. A cost
   * estimate: skipped passes leave stale or cleared content that later passes
   * still read, so the ablated image is not correct.
   */
  readonly delta: FrameBenchmark;
  /** Bootstrap 95% interval of the paired union delta's median; significant when it excludes 0. */
  readonly unionVerdict: PairedDeltaVerdict;
}

/** An executed pass that lacked a usable interval in some measured replays. */
export interface MissingPassTimestamps {
  readonly passIndex: number;
  readonly label: string | null;
  readonly kind: 'render' | 'compute';
  readonly variant: 'base' | 'ablated';
  readonly reason: MissingTimestampReason;
  /** Measured replays without an interval for this pass. */
  readonly replays: number;
}

export interface TimestampCoverage {
  /** True when every executed pass has an interval in every measured replay. */
  readonly complete: boolean;
  /** Passes left out of the union, by name; their GPU time is not counted. */
  readonly missingPasses: readonly MissingPassTimestamps[];
}

export interface ReplayRestore {
  readonly mode: ReplayRestoreMode;
  /** Why steady restore was requested but not used. */
  readonly fallbackReason?: string;
  readonly steady?: SteadyRestoreSummary;
  /** Replays per timestamp bank; 0 when every replay waited for its readback. */
  readonly pipelineDepth: number;
}

export interface BenchmarkConvergence {
  readonly metric: 'base-union-p50' | 'delta-union-p50';
  readonly targetNanoseconds: number;
  /** Width of the metric's 95% interval after the last round. */
  readonly widthNanoseconds: number;
  readonly met: boolean;
}

export interface ReplayBenchmark {
  readonly warmup: number;
  /** Measured rounds actually run (per variant). */
  readonly repeat: number;
  readonly isolate: boolean;
  readonly restore: ReplayRestore;
  readonly convergence?: BenchmarkConvergence;
  readonly timestampCoverage: TimestampCoverage;
  readonly passes: readonly PassBenchmark[];
  readonly base: ReplayVariantBenchmark;
  readonly ablated?: ReplayAblation;
}

const DEFAULT_WARMUP = 3;
const DEFAULT_REPEAT = 20;
const DEFAULT_MAX_REPEAT = 200;
const EXTEND_ROUNDS = 10;

type Variant = 'base' | 'ablated';
type Runs = Record<Variant, TimedReplay[]>;
type RunRounds = (rounds: number, firstRound: number) => Promise<Result<Runs, RhiDebugError>>;

/**
 * Replay the frame `warmup + repeat` times per variant and summarize pass and
 * whole-frame GPU time over the measured replays. With a skip, base and
 * ablated replays alternate in ABBA order so drift lands on both.
 */
export async function benchmarkReplayPasses(
  host: TimingHost,
  options: ReplayBenchmarkOptions = {},
  signal?: AbortSignal,
): Promise<Result<ReplayBenchmark, RhiDebugError>> {
  const settings = benchmarkSettings(options);
  if (!settings.ok) return settings;
  const { warmup, repeat, maxRepeat } = settings.value;
  const plan = hasSkip(options.skip)
    ? planReplaySkip(host.context.tape, host.index, options.skip as ReplaySkip)
    : ok(undefined);
  if (!plan.ok) return plan;
  const restore = await enterRestore(host, options);
  if (!restore.ok) return restore;
  try {
    const variants: Variant[] = plan.value === undefined ? ['base'] : ['base', 'ablated'];
    const run = roundRunner(host, variants, options.isolate, plan.value, restore.value, signal);
    const warmed = await run(warmup, 0);
    if (!warmed.ok) return warmed;
    const runs: Runs = { base: [], ablated: [] };
    let rounds = 0;
    let convergence: BenchmarkConvergence | undefined;
    for (let batch = repeat; batch > 0; ) {
      const measured = await run(batch, warmup + rounds);
      if (!measured.ok) return measured;
      runs.base.push(...measured.value.base);
      runs.ablated.push(...measured.value.ablated);
      rounds += batch;
      convergence = converge(options.ciTargetNanoseconds, runs, plan.value !== undefined);
      batch =
        convergence === undefined || convergence.met
          ? 0
          : Math.min(EXTEND_ROUNDS, maxRepeat - rounds);
    }
    return ok({
      ...summarize(host, options.isolate === true, warmup, rounds, runs, plan.value),
      restore: restore.value,
      ...(convergence === undefined ? {} : { convergence }),
    });
  } finally {
    if (restore.value.mode === 'steady') host.leaveSteady?.();
  }
}

/** @internal */
export function benchmarkSettings(
  options: ReplayBenchmarkOptions,
): Result<{ warmup: number; repeat: number; maxRepeat: number }, RhiDebugError> {
  const warmup = options.warmup ?? DEFAULT_WARMUP;
  const repeat = options.repeat ?? DEFAULT_REPEAT;
  const maxRepeat = Math.max(repeat, options.maxRepeat ?? DEFAULT_MAX_REPEAT);
  const depth = options.pipelineDepth ?? DEFAULT_PIPELINE_DEPTH;
  const target = options.ciTargetNanoseconds;
  const valid =
    Number.isInteger(warmup) &&
    warmup >= 0 &&
    Number.isInteger(repeat) &&
    repeat >= 1 &&
    Number.isInteger(maxRepeat) &&
    Number.isInteger(depth) &&
    depth >= 0 &&
    (target === undefined || (Number.isFinite(target) && target > 0));
  if (valid) return ok({ warmup, repeat, maxRepeat });
  return err(
    createRhiDebugError('replay-capability-mismatch', {
      stage: 'replay',
      cause:
        `benchmark needs integer warmup >= 0, repeat >= 1, maxRepeat, pipelineDepth >= 0 ` +
        `and a positive ciTargetNanoseconds (got ${warmup}, ${repeat}, ${maxRepeat}, ${depth}, ${target})`,
    }),
  );
}

/** @internal */
export async function enterRestore(
  host: TimingHost,
  options: ReplayBenchmarkOptions,
): Promise<Result<ReplayRestore, RhiDebugError>> {
  const requested = options.restore ?? 'steady';
  if (requested === 'reload') return ok({ mode: 'reload', pipelineDepth: 0 });
  if (host.enterSteady === undefined)
    return ok({
      mode: 'reload',
      fallbackReason: 'session has no steady restore',
      pipelineDepth: 0,
    });
  const entered = await host.enterSteady();
  if (!entered.ok) return entered;
  if (!entered.value.steady)
    return ok({ mode: 'reload', fallbackReason: entered.value.reason, pipelineDepth: 0 });
  const depth = options.isolate ? 0 : (options.pipelineDepth ?? DEFAULT_PIPELINE_DEPTH);
  return ok({ mode: 'steady', steady: entered.value.summary, pipelineDepth: depth });
}

function roundRunner(
  host: TimingHost,
  variants: readonly Variant[],
  isolate: boolean | undefined,
  plan: ReplaySkipPlan | undefined,
  restore: ReplayRestore,
  signal: AbortSignal | undefined,
): RunRounds {
  return async (rounds, firstRound) => {
    if (rounds === 0) return ok({ base: [], ablated: [] });
    const order: Variant[] = [];
    for (let round = firstRound; round < firstRound + rounds; round++)
      order.push(...(round % 2 === 0 ? variants : [...variants].reverse()));
    const jobs = order.map((variant) =>
      runOptions(isolate, variant === 'ablated' ? plan : undefined),
    );
    const replays = await runJobs(host, jobs, restore, signal);
    if (!replays.ok) return replays;
    const runs: Runs = { base: [], ablated: [] };
    replays.value.forEach((replay, i) => {
      runs[order[i] as Variant].push(replay);
    });
    return ok(runs);
  };
}

/** @internal Run timed replays pipelined when the restore allows it, else one at a time. */
export function runJobs(
  host: TimingHost,
  jobs: readonly ReplayRunOptions[],
  restore: ReplayRestore,
  signal: AbortSignal | undefined,
): Promise<Result<TimedReplay[], RhiDebugError>> {
  return restore.pipelineDepth > 0
    ? replayPipelined(host, jobs, restore.pipelineDepth, signal)
    : sequential(host, jobs, signal);
}

async function sequential(
  host: TimingHost,
  jobs: readonly ReplayRunOptions[],
  signal: AbortSignal | undefined,
): Promise<Result<TimedReplay[], RhiDebugError>> {
  const replays: TimedReplay[] = [];
  for (const job of jobs) {
    const replay = await replayTimedFrame(host, job, signal);
    if (!replay.ok) return replay;
    replays.push(replay.value);
  }
  return ok(replays);
}

function converge(
  target: number | undefined,
  runs: Runs,
  paired: boolean,
): BenchmarkConvergence | undefined {
  if (target === undefined) return undefined;
  const union = (replay: TimedReplay) => frameTimes(intervalsOf(replay)).union;
  const width = paired
    ? pairedDeltaVerdict(
        runs.base.map((replay, i) => union(replay) - union(runs.ablated[i] as TimedReplay)),
      ).ci.width
    : medianInterval(runs.base.map(union)).width;
  return {
    metric: paired ? 'delta-union-p50' : 'base-union-p50',
    targetNanoseconds: target,
    widthNanoseconds: width,
    met: width <= target,
  };
}

function hasSkip(skip: ReplaySkip | undefined): boolean {
  return (
    skip !== undefined &&
    ((skip.passLabel !== undefined && skip.passLabel !== '') ||
      (skip.passIndices?.length ?? 0) > 0 ||
      (skip.workIndices?.length ?? 0) > 0)
  );
}

/** @internal */
export function runOptions(isolate: boolean | undefined, skip: ReplaySkipPlan | undefined) {
  return { ...(isolate ? { isolate: true } : {}), ...(skip === undefined ? {} : { skip }) };
}

function summarize(
  host: TimingHost,
  isolate: boolean,
  warmup: number,
  repeat: number,
  runs: Runs,
  plan: ReplaySkipPlan | undefined,
): Omit<ReplayBenchmark, 'restore' | 'convergence'> {
  const passes = passBenchmarks(
    host,
    runs.base,
    plan === undefined ? undefined : runs.ablated,
    plan,
  );
  const timestampCoverage = coverage(passes, runs);
  const base = variantBenchmark(runs.base);
  if (plan === undefined) return { warmup, repeat, isolate, timestampCoverage, passes, base };
  const ablated = variantBenchmark(runs.ablated);
  const deltas = (pick: (times: FrameTimes) => number) =>
    base.samples.map((times, i) => pick(times) - pick(ablated.samples[i] as FrameTimes));
  const unionDeltas = deltas((times) => times.union);
  return {
    warmup,
    repeat,
    isolate,
    timestampCoverage,
    passes,
    base,
    ablated: {
      ...ablated,
      passIndices: plan.passIndices,
      workIndices: plan.workIndices,
      delta: {
        sum: timingStats(deltas((times) => times.sum)),
        union: timingStats(unionDeltas),
        envelope: timingStats(deltas((times) => times.envelope)),
      },
      unionVerdict: pairedDeltaVerdict(unionDeltas),
    },
  };
}

/** @internal Per-pass stats of the base runs, plus the ablated runs when a skip plan is given. */
export function passBenchmarks(
  host: TimingHost,
  base: readonly TimedReplay[],
  ablated?: readonly TimedReplay[],
  plan?: ReplaySkipPlan,
): PassBenchmark[] {
  const skipped = new Set(plan?.passIndices ?? []);
  return closedPasses(host.index).map(
    (pass, slot): PassBenchmark => ({
      passIndex: pass.passIndex,
      kind: pass.kind,
      label: passLabel(host.context.tape, pass.beginEventIndex),
      workIndices: pass.workIndices,
      gpu: slotStats(base, slot),
      ...(ablated === undefined ? {} : { ablatedGpu: slotStats(ablated, slot) }),
      skipped: skipped.has(pass.passIndex),
    }),
  );
}

/** @internal */
export function coverage(
  passes: readonly PassBenchmark[],
  runs: Readonly<Record<Variant, readonly TimedReplay[]>>,
): TimestampCoverage {
  const missingPasses: MissingPassTimestamps[] = [];
  for (const variant of ['base', 'ablated'] as const) {
    const counts = new Map<string, { slot: number; reason: MissingTimestampReason; n: number }>();
    for (const replay of runs[variant])
      for (const missing of replay.missing) {
        const key = `${missing.slot}:${missing.reason}`;
        const entry = counts.get(key) ?? { slot: missing.slot, reason: missing.reason, n: 0 };
        entry.n += 1;
        counts.set(key, entry);
      }
    for (const { slot, reason, n } of counts.values()) {
      const pass = passes[slot] as PassBenchmark;
      missingPasses.push({
        passIndex: pass.passIndex,
        label: pass.label,
        kind: pass.kind,
        variant,
        reason,
        replays: n,
      });
    }
  }
  missingPasses.sort((a, b) => a.passIndex - b.passIndex);
  return { complete: missingPasses.length === 0, missingPasses };
}

/** @internal */
export function intervalsOf(replay: TimedReplay): TimedInterval[] {
  return replay.intervals.filter((interval): interval is TimedInterval => interval !== null);
}

/** @internal */
export function variantBenchmark(runs: readonly TimedReplay[]): ReplayVariantBenchmark {
  const samples = runs.map((run) => frameTimes(intervalsOf(run)));
  const unions = samples.map((times) => times.union);
  return {
    frame: {
      sum: timingStats(samples.map((times) => times.sum)),
      union: timingStats(unions),
      envelope: timingStats(samples.map((times) => times.envelope)),
    },
    unionP50Interval: medianInterval(unions),
    drift: driftStats(unions),
    samples,
  };
}

/** @internal */
export function slotStats(runs: readonly TimedReplay[], slot: number): TimingStats | null {
  const values: number[] = [];
  for (const run of runs) {
    const interval = run.intervals[slot];
    if (interval !== null && interval !== undefined) values.push(interval.end - interval.begin);
  }
  return values.length === 0 ? null : timingStats(values);
}
