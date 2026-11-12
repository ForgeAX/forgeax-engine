import { describe, expect, it } from 'vitest';
import { estimateSsrSpatialMemory, SSR_SPATIAL_MEMORY_BUDGET_BYTES } from '../ssr/resources';

describe('SSR descriptor-derived memory budget', () => {
  it('keeps the admitted 1080p descriptor sum under the 320 MiB in-flight budget', () => {
    const estimate = estimateSsrSpatialMemory({ width: 1920, height: 1080 });

    expect(estimate).toMatchObject({
      traceWidth: 1920,
      traceHeight: 1080,
      depthPyramidBytes: 2_764_220,
      traceBytes: 16_588_800,
      hitReactivityBytes: 8_294_400,
      resolvedBytes: 22_117_240,
      historyBytes: 124_416_000,
      temporalParamsBytes: 32,
      fallbackInputBytes: 16_588_800,
      ssrOwnedBytes: 190_769_492,
      budgetBytes: SSR_SPATIAL_MEMORY_BUDGET_BYTES,
      withinBudget: true,
    });
  });

  it('counts all portable scratch and Forward inputs and rejects 4K before allocation', () => {
    const portable = estimateSsrSpatialMemory(
      { width: 1920, height: 1080 },
      { execution: 'fragment', forward: true },
    );
    expect(portable.fragmentScratchBytes).toBe(
      portable.depthPyramidBytes + portable.resolvedBytes + 16,
    );
    expect(portable.forwardInputsBytes).toBe(1920 * 1080 * 28);
    expect(portable.ssrOwnedBytes).toBe(273_711_768);
    expect(portable.withinBudget).toBe(true);
    expect(
      estimateSsrSpatialMemory(
        { width: 3840, height: 2160 },
        { execution: 'fragment', forward: true },
      ).withinBudget,
    ).toBe(false);
  });

  it('counts exactly one resolved mip for a one-pixel view', () => {
    expect(estimateSsrSpatialMemory({ width: 1, height: 1 })).toMatchObject({
      resolvedBytes: 8,
      traceBytes: 8,
      historyBytes: 60,
    });
  });

  it('derives odd extents and the exact zero-temporal reduction', () => {
    const odd = estimateSsrSpatialMemory({ width: 5, height: 3 });
    expect(odd).toMatchObject({
      depthPyramidBytes: 12,
      traceBytes: 120,
      hitReactivityBytes: 60,
      resolvedBytes: 144,
      historyBytes: 900,
      temporalParamsBytes: 32,
      ssrOwnedBytes: 1388,
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
