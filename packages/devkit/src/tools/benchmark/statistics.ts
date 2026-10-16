export interface SampleStatistics {
  readonly count: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

export function calculateSampleStatistics(samples: readonly number[]): SampleStatistics {
  if (samples.length === 0) throw new RangeError('benchmark samples must not be empty');
  const sorted = [...samples].sort((left, right) => left - right);
  const medianIndex = (sorted.length - 1) / 2;
  const median = interpolate(sorted, medianIndex);
  const p95 = interpolate(sorted, Math.ceil(sorted.length * 0.95) - 1);
  const max = sorted[sorted.length - 1];
  if (max === undefined) throw new RangeError('benchmark samples must not be empty');
  return { count: sorted.length, median, p95, max };
}

function interpolate(values: readonly number[], index: number): number {
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = values[lower];
  const upperValue = values[upper];
  if (lowerValue === undefined || upperValue === undefined) {
    throw new RangeError('benchmark percentile index is out of range');
  }
  return lower === upper ? lowerValue : lowerValue + (upperValue - lowerValue) * (index - lower);
}
