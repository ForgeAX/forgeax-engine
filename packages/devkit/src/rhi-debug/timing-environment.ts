import type {
  BenchmarkConvergence,
  DriftStats,
  ReplayBenchmark,
  ReplayComparison,
  TimestampCoverage,
} from '@forgeax/engine-rhi-debug';

/** Host load at one moment; null fields could not be read on this host. */
export interface HostLoadSample {
  /** ISO time of the sample. */
  readonly at: string;
  /** One-minute load average. */
  readonly load1: number | null;
  /** GPU device utilization in percent (macOS IOAccelerator); null elsewhere. */
  readonly gpuUtilizationPercent: number | null;
}

/** `before` takes the busiest sample over a short window; `after` the quietest once the replay drained. */
export type HostLoadPhase = 'before' | 'after';

/** The replay adapter as WebGPU names it. */
export interface ReplayAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
}

/**
 * Whether the replay provider rounds timestamps. `disabled` means the
 * provider was created without Dawn's timestamp quantization.
 */
export type TimestampQuantization = 'disabled' | 'enabled' | 'unknown';

export type TimingCheckName =
  | 'replay-backend'
  | 'timestamp-query'
  | 'timestamp-quantization'
  | 'gpu-idle-before'
  | 'gpu-idle-after'
  | 'cpu-load'
  | 'timestamp-coverage'
  | 'clock-drift'
  | 'convergence';

export interface TimingCheck {
  readonly name: TimingCheckName;
  readonly ok: boolean;
  /** A failed check that does not invalidate the result is a warning. */
  readonly severity: 'error' | 'warning';
  readonly detail: string;
}

export interface TimingPreflight {
  readonly checks: readonly TimingCheck[];
  readonly before: HostLoadSample | null;
  readonly after: HostLoadSample | null;
  /** GPU utilization at or above this percent marks the result invalid. */
  readonly maxGpuPercent: number;
}

export interface TimedTape {
  readonly path?: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface TimingEnvironment {
  readonly device: ReplayAdapterInfo | null;
  readonly timestampQuantization: TimestampQuantization;
  /** Engine build identity (revision, dirty state, package versions) when the host knows it. */
  readonly build: Readonly<Record<string, string | number | boolean>> | null;
  readonly tape: TimedTape;
  readonly baselineTape?: TimedTape;
  readonly startedAt: string;
  readonly elapsedMs: number;
}

export const DEFAULT_MAX_GPU_PERCENT = 5;
export const BUSY_CPU_LOAD = 4;
/** Dawn's default timestamp quantization keeps multiples of 2^16 nanoseconds. */
const DAWN_QUANTUM_NANOSECONDS = 65_536;
const QUANTIZATION_MIN_VALUES = 4;

export function gpuIdleCheck(
  name: 'gpu-idle-before' | 'gpu-idle-after',
  sample: HostLoadSample | null,
  maxGpuPercent: number,
): TimingCheck {
  const percent = sample?.gpuUtilizationPercent ?? null;
  if (percent === null)
    return { name, ok: true, severity: 'warning', detail: 'GPU utilization is not readable here' };
  const ok = percent < maxGpuPercent;
  return {
    name,
    ok,
    severity: 'error',
    detail: ok
      ? `GPU ${percent}% < ${maxGpuPercent}%`
      : `GPU ${percent}% >= ${maxGpuPercent}%: another process used the GPU, so times are not comparable`,
  };
}

export function cpuLoadCheck(sample: HostLoadSample | null): TimingCheck {
  const load = sample?.load1 ?? null;
  if (load === null)
    return { name: 'cpu-load', ok: true, severity: 'warning', detail: 'load average unavailable' };
  return {
    name: 'cpu-load',
    ok: load < BUSY_CPU_LOAD,
    severity: 'warning',
    detail: `load1 ${load.toFixed(2)}${load < BUSY_CPU_LOAD ? '' : ` >= ${BUSY_CPU_LOAD}: encoding may lag, GPU times usually hold`}`,
  };
}

/**
 * Quantization from what the provider declares, then from the data: when every
 * measured pass minimum is a multiple of 2^16 ns the ticks were rounded.
 */
export function quantizationCheck(
  declared: TimestampQuantization,
  values: readonly number[],
): TimingCheck {
  const name = 'timestamp-quantization';
  const nonzero = values.filter((value) => value > 0);
  const rounded =
    nonzero.length >= QUANTIZATION_MIN_VALUES &&
    nonzero.every(
      (value) =>
        Math.abs(value / DAWN_QUANTUM_NANOSECONDS - Math.round(value / DAWN_QUANTUM_NANOSECONDS)) <
        1e-9,
    );
  if (declared === 'enabled' || rounded)
    return {
      name,
      ok: false,
      severity: 'error',
      detail:
        'timestamps are rounded to 65.5 us; create the Dawn provider with disable-dawn-features=timestamp_quantization',
    };
  return {
    name,
    ok: true,
    severity: declared === 'disabled' ? 'error' : 'warning',
    detail:
      declared === 'disabled'
        ? 'provider created without timestamp quantization'
        : 'provider did not declare quantization; measured times are not 2^16-ns multiples',
  };
}

/** Per-pass minima and frame unions of a run, for the quantization check. */
export function measuredValues(result: {
  readonly benchmark?: ReplayBenchmark;
  readonly comparison?: ReplayComparison;
}): number[] {
  const values: number[] = [];
  const passes = [
    ...(result.benchmark?.passes ?? []),
    ...(result.comparison?.baseline.passes ?? []),
    ...(result.comparison?.candidate.passes ?? []),
  ];
  for (const pass of passes) if (pass.gpu !== null) values.push(pass.gpu.min);
  return values;
}

/** Errors among the checks make the result invalid; each one's detail is a reason. */
export function invalidReasons(checks: readonly TimingCheck[]): string[] {
  return checks
    .filter((check) => !check.ok && check.severity === 'error')
    .map((check) => `${check.name}: ${check.detail}`);
}

/** Passes without timestamps are left out of the union; name them. */
export function coverageCheck(coverage: TimestampCoverage): TimingCheck {
  const missing = coverage.missingPasses.map(
    (pass) =>
      `${pass.label ?? `#${pass.passIndex}`} (${pass.variant}, ${pass.reason}, ${pass.replays} replays)`,
  );
  return {
    name: 'timestamp-coverage',
    ok: coverage.complete,
    severity: 'warning',
    detail: coverage.complete
      ? 'every executed pass has an interval in every measured replay'
      : `not counted: ${missing.join('; ')}`,
  };
}

/** A drifting union means the clocks moved during the run; medians still hold but deltas need pairing. */
export function driftCheck(label: string, drift: DriftStats): TimingCheck {
  return {
    name: 'clock-drift',
    ok: drift.stable,
    severity: 'warning',
    detail: `${label}: half shift ${(drift.halfShift * 100).toFixed(1)}%, trend ${(drift.relativeDrift * 100).toFixed(1)}% over the run, lag-1 ${drift.lag1Autocorrelation.toFixed(2)}`,
  };
}

export function convergenceCheck(convergence: BenchmarkConvergence): TimingCheck {
  const ms = (ns: number) => (ns / 1e6).toFixed(3);
  return {
    name: 'convergence',
    ok: convergence.met,
    severity: 'warning',
    detail: `${convergence.metric} 95% interval ${ms(convergence.widthNanoseconds)} ms ${convergence.met ? '<=' : '>'} target ${ms(convergence.targetNanoseconds)} ms${convergence.met ? '' : ' (stopped at maxRepeat)'}`,
  };
}
