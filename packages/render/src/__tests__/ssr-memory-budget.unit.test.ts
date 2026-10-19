import { describe, expect, it } from 'vitest';
import { estimateSsrSpatialMemory, SSR_SPATIAL_MEMORY_BUDGET_BYTES } from '../ssr/resources';

describe('SSR descriptor-derived memory budget', () => {
  it('keeps the admitted 1080p descriptor sum under the 128 MiB budget', () => {
    const estimate = estimateSsrSpatialMemory({ width: 1920, height: 1080 });

    expect(estimate).toMatchObject({
      traceWidth: 1920,
      traceHeight: 1080,
      depthPyramidBytes: 2_764_220,
      traceBytes: 16_588_800,
      hitReactivityBytes: 8_294_400,
      resolvedBytes: 22_117_240,
      historyBytes: 49_766_400,
      temporalParamsBytes: 32,
      fallbackInputBytes: 16_588_800,
      ssrOwnedBytes: 116_119_892,
      budgetBytes: SSR_SPATIAL_MEMORY_BUDGET_BYTES,
      withinBudget: true,
    });
  });

  it('counts exactly one resolved mip for a one-pixel view', () => {
    expect(estimateSsrSpatialMemory({ width: 1, height: 1 })).toMatchObject({
      resolvedBytes: 8,
      traceBytes: 8,
      historyBytes: 24,
    });
  });

  it('derives odd extents and the exact zero-temporal reduction', () => {
    const odd = estimateSsrSpatialMemory({ width: 5, height: 3 });
    expect(odd).toMatchObject({
      depthPyramidBytes: 12,
      traceBytes: 120,
      hitReactivityBytes: 60,
      resolvedBytes: 144,
      historyBytes: 360,
      temporalParamsBytes: 32,
      ssrOwnedBytes: 848,
    });

    const noTemporal = estimateSsrSpatialMemory({ width: 5, height: 3 }, { temporal: false });
    expect(noTemporal).toMatchObject({
      resolvedBytes: 0,
      historyBytes: 0,
      temporalParamsBytes: 0,
      ssrOwnedBytes: 312,
      withinBudget: true,
    });
  });
});
