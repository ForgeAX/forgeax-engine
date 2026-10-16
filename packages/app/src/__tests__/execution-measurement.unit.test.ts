import { describe, expect, it, vi } from 'vitest';
import { createMeasurementSeries } from '../execution/measurement';

describe('execution measurement series', () => {
  it('uses native numeric sorting for finite measurements', () => {
    const series = createMeasurementSeries();
    const sort = vi.spyOn(Array.prototype, 'sort');
    try {
      for (let index = 0; index < 300; index++) series.add(((index * 193) % 331) / 10);
      expect(sort).not.toHaveBeenCalled();
    } finally {
      sort.mockRestore();
    }
  });

  it('retains numeric comparator semantics through overflow, nonfinite values and reset', () => {
    for (const capacity of [0, 1, 3, 240, Infinity, NaN, -1]) {
      const series = createMeasurementSeries(capacity),
        values: number[] = [];
      let samples = 0;
      const sequence = [
        0,
        -0,
        0,
        Infinity,
        -Infinity,
        NaN,
        ...Array.from({ length: 260 }, (_, index) => ((index * 193) % 331) / 10),
      ];
      for (const value of sequence) {
        samples++;
        values.push(value);
        if (values.length > capacity) values.shift();
        const sorted = [...values].sort((a, b) => a - b);
        const pick = (fraction: number) =>
          sorted[
            Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
          ] ?? 0;
        let jitter = 0;
        for (let index = 1; index < values.length; index++)
          jitter += Math.abs((values[index] ?? 0) - (values[index - 1] ?? 0));
        expect(series.add(value)).toEqual({
          samples,
          p50: pick(0.5),
          p95: pick(0.95),
          p99: pick(0.99),
          jitter: values.length < 2 ? 0 : jitter / (values.length - 1),
        });
      }
      series.clear();
      expect(series.add(1.5)).toEqual({
        samples: 1,
        p50: capacity < 1 ? 0 : 1.5,
        p95: capacity < 1 ? 0 : 1.5,
        p99: capacity < 1 ? 0 : 1.5,
        jitter: 0,
      });
    }
  });
  it('reports bounded percentiles while retaining the total sample count', () => {
    const series = createMeasurementSeries(3);
    series.add(100);
    series.add(2);
    series.add(3);
    const report = series.add(4);
    expect(report).toEqual({ samples: 4, p50: 3, p95: 4, p99: 4, jitter: 1 });
  });

  it('clears samples for a rebuilt World identity', () => {
    const series = createMeasurementSeries();
    series.add(1);
    series.clear();
    expect(series.add(5).samples).toBe(1);
  });
});
