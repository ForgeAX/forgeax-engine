import { createProfiler } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';
import type { RendererOptions } from '../render-contract';

describe('Render profiler default-off allocation boundary', () => {
  it('keeps the complete render capability path at zero event objects', () => {
    const allocationReport = { profilerEventObjectAllocations: 0 };
    const profiler = createProfiler({ enabled: false, allocationReport });
    const options = { profiler } satisfies RendererOptions;

    expect(options.profiler).toBe(profiler);
    expect({
      profilerEventObjectAllocations: allocationReport.profilerEventObjectAllocations,
      artifact: profiler.latestCapture(),
      activeCaptureId: profiler.activeCaptureId(),
    }).toEqual({
      profilerEventObjectAllocations: 0,
      artifact: undefined,
      activeCaptureId: undefined,
    });
  });
});
