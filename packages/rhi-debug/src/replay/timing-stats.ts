/** One GPU interval in nanoseconds on the replay device's timestamp timeline. */
export interface TimedInterval {
  readonly begin: number;
  readonly end: number;
}

/** Distribution of one measured quantity over the measured replays, in nanoseconds. */
export interface TimingStats {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
  /** Population standard deviation. */
  readonly stddev: number;
}

/** Whole-frame GPU time of one replay, three ways. */
export interface FrameTimes {
  /** Sum of every pass's own begin-to-end time; overcounts when passes overlap. */
  readonly sum: number;
  /** Length of the union of every pass interval: time the GPU had at least one pass open. */
  readonly union: number;
  /** First begin to last end, including idle gaps between passes. */
  readonly envelope: number;
}

/**
 * Total length covered by the intervals. Overlapping and touching intervals
 * count once, so consecutive passes that a tile-based GPU runs concurrently
 * are not double counted.
 */
export function intervalUnion(intervals: readonly TimedInterval[]): number {
  const sorted = intervals
    .filter((interval) => interval.end > interval.begin)
    .sort((a, b) => a.begin - b.begin);
  let total = 0;
  let open: TimedInterval | undefined;
  for (const interval of sorted) {
    if (open === undefined || interval.begin > open.end) {
      if (open !== undefined) total += open.end - open.begin;
      open = { begin: interval.begin, end: interval.end };
    } else if (interval.end > open.end) {
      open = { begin: open.begin, end: interval.end };
    }
  }
  return open === undefined ? total : total + open.end - open.begin;
}

/** First begin to last end; 0 for no interval. */
export function intervalEnvelope(intervals: readonly TimedInterval[]): number {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const { begin, end } of intervals) {
    if (end <= begin) continue;
    first = Math.min(first, begin);
    last = Math.max(last, end);
  }
  return last > first ? last - first : 0;
}

export function frameTimes(intervals: readonly TimedInterval[]): FrameTimes {
  let sum = 0;
  for (const { begin, end } of intervals) if (end > begin) sum += end - begin;
  return { sum, union: intervalUnion(intervals), envelope: intervalEnvelope(intervals) };
}

/** Nearest-rank percentile of ascending `sorted` values; `q` in [0, 1]. */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil(Math.min(1, Math.max(0, q)) * sorted.length);
  return sorted[Math.max(0, rank - 1)] as number;
}

export function timingStats(values: readonly number[]): TimingStats {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const mean = count === 0 ? Number.NaN : sorted.reduce((sum, value) => sum + value, 0) / count;
  const variance =
    count === 0 ? Number.NaN : sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  return {
    count,
    min: sorted[0] ?? Number.NaN,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[count - 1] ?? Number.NaN,
    mean,
    stddev: Math.sqrt(variance),
  };
}
