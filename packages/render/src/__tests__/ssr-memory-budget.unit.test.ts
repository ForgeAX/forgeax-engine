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
      fallbackInputBytes: 16_588_800,
      sceneColorBytes: 4_147_200,
      ssrOwnedBytes: 48_383_420,
      budgetBytes: SSR_SPATIAL_MEMORY_BUDGET_BYTES,
      withinBudget: true,
    });
  });

  it('counts all portable scratch and Forward inputs and rejects 4K before allocation', () => {
    const portable = estimateSsrSpatialMemory(
      { width: 1920, height: 1080 },
      { execution: 'fragment', forward: true },
    );
    expect(portable.fragmentScratchBytes).toBe(portable.depthPyramidBytes + 16);
    expect(portable.forwardInputsBytes).toBe(1920 * 1080 * 36);
    expect(portable.ssrOwnedBytes).toBe(125_797_256);
    expect(portable.withinBudget).toBe(true);
    const msaa = estimateSsrSpatialMemory(
      { width: 1920, height: 1080 },
      { execution: 'fragment', forward: true, forwardSampleCount: 4 },
    );
    expect(msaa.ssrOwnedBytes - portable.ssrOwnedBytes).toBe(1920 * 1080 * 96);
    expect(msaa.withinBudget).toBe(true);
    expect(
      estimateSsrSpatialMemory(
        { width: 3840, height: 2160 },
        { execution: 'fragment', forward: true },
      ).withinBudget,
    ).toBe(false);
  });

  it('derives odd extents without reflection history resources', () => {
    const odd = estimateSsrSpatialMemory({ width: 5, height: 3 });
    expect(odd).toMatchObject({
      depthPyramidBytes: 12,
      traceBytes: 120,
      hitReactivityBytes: 60,
      sceneColorBytes: 16,
      ssrOwnedBytes: 328,
    });
  });

  it('charges one half-resolution hit-color level on the portable route', () => {
    const size = { width: 17, height: 9 };
    const memory = estimateSsrSpatialMemory(size, { execution: 'fragment' });
    expect(memory.sceneColorBytes).toBe(8 * 4 * 8);
    expect(memory.fragmentScratchBytes).toBe(memory.depthPyramidBytes + 16);
  });
});
