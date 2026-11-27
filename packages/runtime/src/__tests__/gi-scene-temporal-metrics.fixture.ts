/** Diagnostic statistics, never a substitute for a scene's physical or temporal oracle. */
export interface TemporalMetrics {
  readonly samples: number;
  readonly elements: number;
  readonly referenceScale: number;
  readonly meanSeries: readonly number[];
  readonly maxRange: number;
  readonly maxAdjacentRms: number;
  readonly maxLagTwoRms: number;
  readonly maxPeriodTwo: number;
  readonly maxHalfDrift: number;
}

function finite(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) throw new Error('Nonfinite temporal sample');
  return value;
}

function componentMetrics(values: readonly number[], scale: number) {
  let adjacent = 0;
  let lagTwo = 0;
  let even = 0;
  let odd = 0;
  let first = 0;
  let last = 0;
  const half = Math.floor(values.length / 2);
  for (const [index, value] of values.entries()) {
    if (index > 0) adjacent += (value - finite(values[index - 1])) ** 2;
    if (index > 1) lagTwo += (value - finite(values[index - 2])) ** 2;
    if (index % 2 === 0) even += value;
    else odd += value;
    if (index < half) first += value;
    if (index >= values.length - half) last += value;
  }
  return {
    range: (Math.max(...values) - Math.min(...values)) / scale,
    adjacentRms: Math.sqrt(adjacent / (values.length - 1)) / scale,
    lagTwoRms: Math.sqrt(lagTwo / (values.length - 2)) / scale,
    periodTwo: Math.abs(even / Math.ceil(values.length / 2) - odd / half) / scale,
    halfDrift: Math.abs(last - first) / (half * scale),
  };
}

/** Aggregate after measuring each location; averaging locations first hides opposite phases. */
export function temporalMetrics(
  samples: readonly ArrayLike<number>[],
  referenceScale: number,
): TemporalMetrics {
  const elements = samples[0]?.length ?? 0;
  if (samples.length < 4 || samples.length > 4096 || elements < 1)
    throw new Error('Temporal evidence requires 4..4096 nonempty frames');
  if (!Number.isFinite(referenceScale) || referenceScale <= 0)
    throw new Error('A positive independent reference scale is required');
  for (const sample of samples)
    if (sample.length !== elements) throw new Error('Temporal sample dimensions changed');
  const totals = new Float64Array(samples.length);
  let maxRange = 0;
  let maxAdjacentRms = 0;
  let maxLagTwoRms = 0;
  let maxPeriodTwo = 0;
  let maxHalfDrift = 0;
  for (let element = 0; element < elements; element++) {
    const values = samples.map((sample, frame) => {
      const value = finite(sample[element]);
      totals[frame] = finite(finite(totals[frame]) + value);
      return value;
    });
    const metrics = componentMetrics(values, referenceScale);
    maxRange = Math.max(maxRange, metrics.range);
    maxAdjacentRms = Math.max(maxAdjacentRms, metrics.adjacentRms);
    maxLagTwoRms = Math.max(maxLagTwoRms, metrics.lagTwoRms);
    maxPeriodTwo = Math.max(maxPeriodTwo, metrics.periodTwo);
    maxHalfDrift = Math.max(maxHalfDrift, metrics.halfDrift);
  }
  return {
    samples: samples.length,
    elements,
    referenceScale,
    meanSeries: Array.from(totals, (total) => total / elements),
    maxRange,
    maxAdjacentRms,
    maxLagTwoRms,
    maxPeriodTwo,
    maxHalfDrift,
  };
}

/** Independent closed-form constant-input EMA; count is accepted observations, not frames. */
export function stationaryEma(initial: number, target: number, history: number, count: number) {
  if (
    !Number.isFinite(initial) ||
    !Number.isFinite(target) ||
    !(history >= 0 && history < 1) ||
    !Number.isSafeInteger(count) ||
    count < 0
  )
    throw new Error('Invalid stationary EMA reference input');
  return finite(target + (initial - target) * history ** count);
}
