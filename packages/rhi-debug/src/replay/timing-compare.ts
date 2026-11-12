import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { TimedReplay, TimingHost } from './timing';
import {
  type BenchmarkConvergence,
  benchmarkSettings,
  coverage,
  enterRestore,
  type FrameBenchmark,
  intervalsOf,
  type PassBenchmark,
  passBenchmarks,
  type ReplayBenchmarkOptions,
  type ReplayRestore,
  type ReplayVariantBenchmark,
  runJobs,
  runOptions,
  type TimestampCoverage,
  variantBenchmark,
} from './timing-bench';
import { type PairedDeltaVerdict, pairedDeltaVerdict } from './timing-confidence';
import { DEFAULT_PIPELINE_DEPTH } from './timing-pipeline';
import { frameTimes, type TimingStats, timingStats } from './timing-stats';

/** Options of `compareReplays`; a comparison times whole frames, so it takes no skip. */
export type ReplayComparisonOptions = Omit<ReplayBenchmarkOptions, 'skip'>;

/** One side of a comparison: its own restore mode, passes and frame distribution. */
export interface ComparedReplay {
  readonly restore: ReplayRestore;
  readonly timestampCoverage: TimestampCoverage;
  readonly passes: readonly PassBenchmark[];
  readonly benchmark: ReplayVariantBenchmark;
}

/** A pass present in both tapes, matched by label and occurrence. */
export interface ComparedPass {
  readonly label: string | null;
  /** 0 for the first pass with this label, 1 for the second, ... */
  readonly occurrence: number;
  readonly baselinePassIndex: number;
  readonly candidatePassIndex: number;
  readonly baselineP50: number | null;
  readonly candidateP50: number | null;
  /** Candidate p50 minus baseline p50, in nanoseconds; null when either was never written. */
  readonly deltaP50: number | null;
}

export interface ReplayComparison {
  readonly warmup: number;
  /** Measured replays per tape. */
  readonly repeat: number;
  readonly isolate: boolean;
  /** Consecutive replays of one tape before the other takes over (ABBA order). */
  readonly chunk: number;
  readonly convergence?: BenchmarkConvergence;
  readonly baseline: ComparedReplay;
  readonly candidate: ComparedReplay;
  /** Paired candidate minus baseline whole-frame time per measured replay. */
  readonly delta: FrameBenchmark;
  /** Bootstrap 95% interval of the paired union delta's median. */
  readonly unionVerdict: PairedDeltaVerdict;
  readonly passes: readonly ComparedPass[];
  /** Labels present in only one tape. */
  readonly unmatchedPasses: {
    readonly baseline: readonly string[];
    readonly candidate: readonly string[];
  };
}

const DEFAULT_COMPARE_WARMUP = 3;
const EXTEND_CHUNKS = 2;
const hosts = new WeakMap<object, TimingHost>();

/** @internal Associate a replay session with its timing host so sessions can be compared. */
export function registerTimingHost(session: object, host: TimingHost): void {
  hosts.set(session, host);
}

/**
 * Time two tapes, each on its own replay session, in alternating chunks
 * (A B B A ...) so clock drift lands on both, and report each side plus the
 * paired candidate-minus-baseline delta with a bootstrap verdict. Each chunk
 * drains before the other side starts, so the two never share the GPU.
 */
export async function compareReplays(
  baselineSession: object,
  candidateSession: object,
  options: ReplayComparisonOptions = {},
  signal?: AbortSignal,
): Promise<Result<ReplayComparison, RhiDebugError>> {
  const baseline = hosts.get(baselineSession);
  const candidate = hosts.get(candidateSession);
  if (baseline === undefined || candidate === undefined || baseline === candidate)
    return err(
      createRhiDebugError('replay-capability-mismatch', {
        stage: 'replay',
        cause: 'compareReplays needs two distinct open replay sessions',
      }),
    );
  const settings = benchmarkSettings(options);
  if (!settings.ok) return settings;
  const { repeat, maxRepeat } = settings.value;
  const warmup = options.warmup ?? DEFAULT_COMPARE_WARMUP;
  const restores: ReplayRestore[] = [];
  try {
    for (const host of [baseline, candidate]) {
      const restore = await enterRestore(host, options);
      if (!restore.ok) return restore;
      restores.push(restore.value);
    }
    const [baseRestore, candRestore] = restores as [ReplayRestore, ReplayRestore];
    const chunk = Math.max(
      1,
      2 * (options.isolate ? 0 : (options.pipelineDepth ?? DEFAULT_PIPELINE_DEPTH)),
    );
    const sides: Sides = {
      base: { host: baseline, restore: baseRestore },
      cand: { host: candidate, restore: candRestore },
    };
    const measured = await interleave(sides, options, signal, {
      warmup,
      repeat,
      maxRepeat,
      chunk,
    });
    if (!measured.ok) return measured;
    const { runs, convergence } = measured.value;
    return ok({
      warmup,
      repeat: runs.base.length,
      isolate: options.isolate === true,
      chunk,
      ...(convergence === undefined ? {} : { convergence }),
      ...summarize(baseline, candidate, baseRestore, candRestore, runs),
    });
  } finally {
    for (const [i, host] of [baseline, candidate].entries())
      if (restores[i]?.mode === 'steady') host.leaveSteady?.();
  }
}

interface Side {
  readonly host: TimingHost;
  readonly restore: ReplayRestore;
}

interface Sides {
  readonly base: Side;
  readonly cand: Side;
}

interface InterleavePlan {
  readonly warmup: number;
  readonly repeat: number;
  readonly maxRepeat: number;
  readonly chunk: number;
}

interface InterleavedRuns {
  readonly runs: { readonly base: TimedReplay[]; readonly cand: TimedReplay[] };
  readonly convergence?: BenchmarkConvergence;
}

function runSide(
  side: Side,
  options: ReplayComparisonOptions,
  count: number,
  signal: AbortSignal | undefined,
) {
  return runJobs(
    side.host,
    Array.from({ length: count }, () => runOptions(options.isolate, undefined)),
    side.restore,
    signal,
  );
}

/** Warm both sides, then run A B B A chunks until `repeat` (or the convergence target) is reached. */
async function interleave(
  sides: Sides,
  options: ReplayComparisonOptions,
  signal: AbortSignal | undefined,
  plan: InterleavePlan,
): Promise<Result<InterleavedRuns, RhiDebugError>> {
  if (plan.warmup > 0)
    for (const side of [sides.base, sides.cand]) {
      const warmed = await runSide(side, options, plan.warmup, signal);
      if (!warmed.ok) return warmed;
    }
  const runs = { base: [] as TimedReplay[], cand: [] as TimedReplay[] };
  let turn = 0;
  let convergence: BenchmarkConvergence | undefined;
  let target = plan.repeat;
  while (runs.base.length < target) {
    const count = Math.min(plan.chunk, target - runs.base.length);
    const order = turn % 2 === 0 ? (['base', 'cand'] as const) : (['cand', 'base'] as const);
    for (const which of order) {
      const replays = await runSide(sides[which], options, count, signal);
      if (!replays.ok) return replays;
      runs[which].push(...replays.value);
    }
    turn += 1;
    if (runs.base.length < target) continue;
    convergence = converge(options.ciTargetNanoseconds, runs);
    if (convergence !== undefined && !convergence.met)
      target = Math.min(plan.maxRepeat, target + EXTEND_CHUNKS * plan.chunk);
  }
  return ok({ runs, ...(convergence === undefined ? {} : { convergence }) });
}

function unionsOf(replays: readonly TimedReplay[]): number[] {
  return replays.map((replay) => frameTimes(intervalsOf(replay)).union);
}

function converge(
  target: number | undefined,
  runs: { readonly base: readonly TimedReplay[]; readonly cand: readonly TimedReplay[] },
): BenchmarkConvergence | undefined {
  if (target === undefined) return undefined;
  const base = unionsOf(runs.base);
  const width = pairedDeltaVerdict(unionsOf(runs.cand).map((u, i) => u - (base[i] as number))).ci
    .width;
  return {
    metric: 'delta-union-p50',
    targetNanoseconds: target,
    widthNanoseconds: width,
    met: width <= target,
  };
}

function compared(host: TimingHost, restore: ReplayRestore, replays: readonly TimedReplay[]) {
  const passes = passBenchmarks(host, replays);
  return {
    restore,
    timestampCoverage: coverage(passes, { base: replays, ablated: [] }),
    passes,
    benchmark: variantBenchmark(replays),
  };
}

function summarize(
  baselineHost: TimingHost,
  candidateHost: TimingHost,
  baseRestore: ReplayRestore,
  candRestore: ReplayRestore,
  runs: { readonly base: readonly TimedReplay[]; readonly cand: readonly TimedReplay[] },
): Pick<
  ReplayComparison,
  'baseline' | 'candidate' | 'delta' | 'unionVerdict' | 'passes' | 'unmatchedPasses'
> {
  const baseline = compared(baselineHost, baseRestore, runs.base);
  const candidate = compared(candidateHost, candRestore, runs.cand);
  const deltas = (pick: (times: ReplayVariantBenchmark['samples'][number]) => number) =>
    candidate.benchmark.samples.map(
      (times, i) =>
        pick(times) -
        pick(baseline.benchmark.samples[i] as ReplayVariantBenchmark['samples'][number]),
    );
  const unionDeltas = deltas((times) => times.union);
  const matched = matchPasses(baseline.passes, candidate.passes);
  return {
    baseline,
    candidate,
    delta: {
      sum: timingStats(deltas((times) => times.sum)),
      union: timingStats(unionDeltas),
      envelope: timingStats(deltas((times) => times.envelope)),
    },
    unionVerdict: pairedDeltaVerdict(unionDeltas),
    ...matched,
  };
}

function occurrenceKeys(passes: readonly PassBenchmark[]): Map<string, PassBenchmark> {
  const seen = new Map<string, number>();
  const keyed = new Map<string, PassBenchmark>();
  for (const pass of passes) {
    const label = pass.label ?? `#${pass.passIndex}`;
    const occurrence = seen.get(label) ?? 0;
    seen.set(label, occurrence + 1);
    keyed.set(`${label}\u0000${occurrence}`, pass);
  }
  return keyed;
}

function p50(stats: TimingStats | null | undefined): number | null {
  return stats === null || stats === undefined ? null : stats.p50;
}

/** @internal Pair passes of two tapes by label and occurrence, in baseline order. */
export function matchPasses(
  baseline: readonly PassBenchmark[],
  candidate: readonly PassBenchmark[],
): Pick<ReplayComparison, 'passes' | 'unmatchedPasses'> {
  const base = occurrenceKeys(baseline);
  const cand = occurrenceKeys(candidate);
  const passes: ComparedPass[] = [];
  const onlyBaseline: string[] = [];
  for (const [key, pass] of base) {
    const other = cand.get(key);
    const [label, occurrence] = key.split('\u0000') as [string, string];
    if (other === undefined) {
      onlyBaseline.push(label);
      continue;
    }
    const baselineP50 = p50(pass.gpu);
    const candidateP50 = p50(other.gpu);
    passes.push({
      label: pass.label,
      occurrence: Number(occurrence),
      baselinePassIndex: pass.passIndex,
      candidatePassIndex: other.passIndex,
      baselineP50,
      candidateP50,
      deltaP50: baselineP50 === null || candidateP50 === null ? null : candidateP50 - baselineP50,
    });
  }
  const onlyCandidate = [...cand.keys()]
    .filter((key) => !base.has(key))
    .map((key) => key.split('\u0000')[0] as string);
  return { passes, unmatchedPasses: { baseline: onlyBaseline, candidate: onlyCandidate } };
}
