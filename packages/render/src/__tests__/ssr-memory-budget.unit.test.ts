import { describe, expect, it } from 'vitest';
import { estimateSsrSpatialMemory, SSR_SPATIAL_MEMORY_BUDGET_BYTES } from '../ssr/resources';

describe('SSR descriptor-derived memory budget', () => {
  it('keeps the admitted 1080p descriptor sum under the 43 MiB budget', () => {
    const estimate = estimateSsrSpatialMemory({ width: 1920, height: 1080 });

    expect(estimate).toMatchObject({
      halfWidth: 960,
      halfHeight: 540,
      depthPyramidBytes: 2_764_220,
      traceBytes: 4_147_200,
      hitReactivityBytes: 2_073_600,
      resolvedBytes: 5_528_440,
      historyBytes: 12_441_600,
      temporalParamsBytes: 32,
      fallbackInputBytes: 16_588_800,
      ssrOwnedBytes: 43_543_892,
      budgetBytes: SSR_SPATIAL_MEMORY_BUDGET_BYTES,
      withinBudget: true,
    });
  });

  it('derives odd extents and the exact zero-temporal reduction', () => {
    const odd = estimateSsrSpatialMemory({ width: 5, height: 3 });
    expect(odd).toMatchObject({
      depthPyramidBytes: 12,
      traceBytes: 16,
      hitReactivityBytes: 8,
      resolvedBytes: 24,
      historyBytes: 48,
      temporalParamsBytes: 32,
      ssrOwnedBytes: 260,
    });

    const noTemporal = estimateSsrSpatialMemory({ width: 5, height: 3 }, { temporal: false });
    expect(noTemporal).toMatchObject({
      resolvedBytes: 0,
      historyBytes: 0,
      temporalParamsBytes: 0,
      ssrOwnedBytes: 156,
      withinBudget: true,
    });
  });
});
