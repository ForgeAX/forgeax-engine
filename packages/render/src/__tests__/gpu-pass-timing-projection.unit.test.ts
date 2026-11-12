import { err, ok } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { projectGpuPassTimingCapture } from '../assembly/webgpu-renderer-pass-timing.js';
import type { GpuPassTimingError } from '../record/gpu-pass-timing/errors.js';
import type { GpuPassTimingCapture, GpuPassTimingFrame } from '../record/gpu-pass-timing/index.js';

function frame(patch: Partial<GpuPassTimingFrame> = {}): GpuPassTimingFrame {
  return {
    schemaVersion: '1.0',
    frameId: 7,
    deviceGeneration: 2,
    graphGeneration: 3,
    backendKind: 'webgpu',
    timestampPeriodNanoseconds: 1,
    passCapacity: 4,
    executedPassCount: 0,
    measuredPassCount: 0,
    droppedPassCount: 0,
    passes: [],
    measuredPassNanoseconds: 0,
    ...patch,
  };
}
const failure: GpuPassTimingError = {
  code: 'timestamp-readback-failed',
  expected: 'readback completes',
  hint: 'inspect the original capture',
  detail: {},
};
function capture(
  result: Awaited<ReturnType<GpuPassTimingCapture['observe']>>,
): GpuPassTimingCapture {
  return { observe: async () => result } as GpuPassTimingCapture;
}
const failed = (error: GpuPassTimingError) => ({ status: 'failed' as const, error });

describe('receipt-bound pass timing projection', () => {
  it('preserves the complete observed frame', async () => {
    const observed = frame();
    expect(await projectGpuPassTimingCapture(capture(ok(observed)), failed)).toEqual({
      status: 'complete',
      frame: observed,
    });
  });
  it('preserves the first unmeasured reason ahead of a dropped-pass diagnostic', async () => {
    const observed = frame({
      droppedPassCount: 2,
      passes: [
        {
          status: 'unmeasured',
          reason: failure,
          passName: 'copy',
          passKind: 'copy',
          executionIndex: 0,
        },
      ],
    });
    expect(await projectGpuPassTimingCapture(capture(ok(observed)), failed)).toEqual({
      status: 'partial',
      frame: observed,
      reason: failure,
    });
  });
  it('reports the original bounded query budget when passes were dropped', async () => {
    const observed = frame({ droppedPassCount: 2 });
    expect(await projectGpuPassTimingCapture(capture(ok(observed)), failed)).toEqual({
      status: 'partial',
      frame: observed,
      reason: {
        code: 'query-budget-exceeded',
        expected: 'all executed passes fit within the bounded query budget',
        hint: 'increase maxPassesPerFrame or simplify the pass graph',
        detail: { droppedPassCount: 2 },
      },
    });
  });
  it('delegates failure so the current owner retains its latest-known-good observation', async () => {
    const retained = {
      status: 'failed' as const,
      error: failure,
      latestKnownGood: { frameId: 6, deviceGeneration: 2, graphGeneration: 3 },
    };
    const report = vi.fn(() => retained);
    expect(await projectGpuPassTimingCapture(capture(err(failure)), report)).toBe(retained);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
