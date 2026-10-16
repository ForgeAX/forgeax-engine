import type { ExecutionMeasurement } from './types';

function percentile(sorted: ArrayLike<number>, fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

export interface MeasurementSeries {
  add(value: number): ExecutionMeasurement;
  clear(): void;
}

export function createMeasurementSeries(capacity = 240): MeasurementSeries {
  const values: number[] = [];
  let samples = 0;
  return {
    add(value): ExecutionMeasurement {
      samples += 1;
      values.push(value);
      if (values.length > capacity) values.shift();
      let numeric = true;
      for (let index = 0; index < values.length; index++) {
        if (!Number.isFinite(values[index]) || Object.is(values[index], -0)) {
          numeric = false;
          break;
        }
      }
      const sorted = numeric ? Float64Array.from(values).sort() : [...values].sort((a, b) => a - b);
      let jitter = 0;
      for (let index = 1; index < values.length; index += 1) {
        jitter += Math.abs((values[index] ?? 0) - (values[index - 1] ?? 0));
      }
      return {
        samples,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        jitter: values.length < 2 ? 0 : jitter / (values.length - 1),
      };
    },
    clear(): void {
      values.length = 0;
      samples = 0;
    },
  };
}
