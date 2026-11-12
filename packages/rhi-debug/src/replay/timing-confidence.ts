import { percentile } from './timing-stats';

/** Two-sided confidence interval of a median, in the unit of the samples. */
export interface ConfidenceInterval {
  readonly confidence: number;
  readonly low: number;
  readonly high: number;
  readonly width: number;
}

/**
 * Trend of a measured quantity across consecutive replays. A stable run has a
 * flat least-squares slope and equal half medians; clock or thermal drift
 * shows up as a slope and a half-to-half shift.
 */
export interface DriftStats {
  /** Least-squares slope over sample index, in sample units per replay. */
  readonly slopePerSample: number;
  /** Slope times the sample span, relative to the median. */
  readonly relativeDrift: number;
  readonly firstHalfP50: number;
  readonly secondHalfP50: number;
  /** `secondHalfP50 / firstHalfP50 - 1`. */
  readonly halfShift: number;
  /** Lag-1 autocorrelation; near 0 for independent noise, near 1 for a slow wave. */
  readonly lag1Autocorrelation: number;
  readonly stable: boolean;
}

/** A paired difference with a bootstrap interval of its median. */
export interface PairedDeltaVerdict {
  readonly ci: ConfidenceInterval;
  /** True when the interval excludes zero. */
  readonly significant: boolean;
}

const Z95 = 1.959964;
const STABLE_RELATIVE_DRIFT = 0.05;
const STABLE_HALF_SHIFT = 0.05;
const BOOTSTRAP_ITERATIONS = 2000;
const BOOTSTRAP_SEED = 0x5eed;

/**
 * Distribution-free interval of the median from order statistics (normal
 * approximation to the binomial ranks). With fewer than 6 samples it spans
 * min..max.
 */
export function medianInterval(values: readonly number[]): ConfidenceInterval {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return interval(Number.NaN, Number.NaN);
  if (n < 6) return interval(sorted[0] as number, sorted[n - 1] as number);
  const half = (Z95 * Math.sqrt(n)) / 2;
  const lowRank = Math.max(1, Math.floor(n / 2 - half));
  const highRank = Math.min(n, Math.ceil(n / 2 + half) + 1);
  return interval(sorted[lowRank - 1] as number, sorted[highRank - 1] as number);
}

/** Percentile bootstrap of the median with a fixed seed, so reruns on the same samples agree. */
export function bootstrapMedianInterval(values: readonly number[]): ConfidenceInterval {
  const n = values.length;
  if (n === 0) return interval(Number.NaN, Number.NaN);
  const random = mulberry32(BOOTSTRAP_SEED);
  const medians: number[] = [];
  const resample = new Array<number>(n);
  for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration++) {
    for (let i = 0; i < n; i++) resample[i] = values[Math.floor(random() * n)] as number;
    medians.push(
      percentile(
        [...resample].sort((a, b) => a - b),
        0.5,
      ),
    );
  }
  medians.sort((a, b) => a - b);
  return interval(percentile(medians, 0.025), percentile(medians, 0.975));
}

export function pairedDeltaVerdict(deltas: readonly number[]): PairedDeltaVerdict {
  const ci = bootstrapMedianInterval(deltas);
  return { ci, significant: ci.low > 0 || ci.high < 0 };
}

export function driftStats(values: readonly number[]): DriftStats {
  const n = values.length;
  const mean = n === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let lagged = 0;
  let squares = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - (n - 1) / 2;
    const dy = (values[i] as number) - mean;
    sxy += dx * dy;
    sxx += dx * dx;
    squares += dy * dy;
    if (i > 0) lagged += dy * ((values[i - 1] as number) - mean);
  }
  const slopePerSample = sxx === 0 ? 0 : sxy / sxx;
  const median = percentile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
  const half = Math.floor(n / 2);
  const firstHalfP50 = halfMedian(values.slice(0, half));
  const secondHalfP50 = halfMedian(values.slice(n - half));
  const relativeDrift = median > 0 ? (slopePerSample * Math.max(0, n - 1)) / median : 0;
  const halfShift = firstHalfP50 > 0 ? secondHalfP50 / firstHalfP50 - 1 : 0;
  return {
    slopePerSample,
    relativeDrift,
    firstHalfP50,
    secondHalfP50,
    halfShift,
    lag1Autocorrelation: squares === 0 ? 0 : lagged / squares,
    stable:
      n >= 4 &&
      Math.abs(relativeDrift) <= STABLE_RELATIVE_DRIFT &&
      Math.abs(halfShift) <= STABLE_HALF_SHIFT,
  };
}

function halfMedian(values: readonly number[]): number {
  return values.length === 0
    ? Number.NaN
    : percentile(
        [...values].sort((a, b) => a - b),
        0.5,
      );
}

function interval(low: number, high: number): ConfidenceInterval {
  return { confidence: 0.95, low, high, width: high - low };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
