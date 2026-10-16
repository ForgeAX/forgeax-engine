import { describe, expect, it } from 'vitest';
import {
  GPU_PASS_TIMING_SAMPLING,
  calculatePairedOverhead,
  median,
  nearestRankP95,
  type GpuPassTimingSampleWindow,
} from '../statistics.js';
import { evaluateCpuOverhead } from '../report.js';

function window(
  frameDurationsMicroseconds: number[],
  overrides: Partial<GpuPassTimingSampleWindow> = {},
): GpuPassTimingSampleWindow {
  return {
    identity: {
      sourceHead: '0123456789abcdef0123456789abcdef01234567',
      runner: 'runner-1',
      backend: 'webgpu:test-adapter:test-driver',
      workload: '640x360:standard-scene:standard',
      frameGeneration: 'device-3:graph-7',
    },
    frameDurationsMicroseconds,
    complete: true,
    ...overrides,
  };
}

describe('GPU pass timing paired statistics', () => {
  it('uses nearest-rank p95 and median over paired groups', () => {
    expect(nearestRankP95([10, 20, 30, 40])).toBe(40);
    expect(nearestRankP95([1, 2, 3, 4, 5])).toBe(5);
    expect(median([3, 1, 2, 9])).toBe(2.5);
    expect(
      calculatePairedOverhead(
        [
          { off: [100, 100, 100, 100], on: [110, 110, 110, 110] },
          { off: [200, 200, 200, 200], on: [190, 190, 190, 190] },
        ],
      ),
    ).toMatchObject({
      groupOverheadPercent: [10, -5],
      reportedOverheadPercent: 2.5,
    });
  });

  it('fixes the benchmark window at 120 warmup, five groups, and 60 frames', () => {
    expect(GPU_PASS_TIMING_SAMPLING).toEqual({
      warmupFrames: 120,
      groups: 5,
      framesPerGroup: 60,
    });
  });

  it('rejects insufficient, incomplete, and over-ten-percent windows', () => {
    expect(() =>
      calculatePairedOverhead([{ off: [100], on: [100] }]),
    ).toThrowError(/complete five paired windows/i);
    expect(() =>
      calculatePairedOverhead(
        Array.from({ length: 5 }, () => ({ off: [100, 100], on: [100, 100] })),
      ),
    ).toThrowError(/60 frames/i);
    expect(() =>
      calculatePairedOverhead(
        Array.from({ length: 5 }, () => ({ off: [100, 100, 100], on: [112, 112, 112] })),
      ),
    ).toThrowError(/10 percent/i);
    expect(
      calculatePairedOverhead(
        Array.from({ length: 5 }, () => ({ off: [100, 100, 100], on: [112, 112, 112] })),
        { enforceLimit: false },
      ),
    ).toMatchObject({
      groupOverheadPercent: [12, 12, 12, 12, 12],
      reportedOverheadPercent: 12,
    });
  });

  it('does not turn non-zero off-path evidence into an accepted GPU result', () => {
    const off = window([100, 100, 100]);
    const on = window([100, 100, 100], { offPathExactZero: false });
    expect(() => calculatePairedOverhead([{ off, on }])).toThrowError(/off-path/i);
  });

  it('keeps the CPU profiler twenty-percent gate independent from GPU ten-percent overhead', () => {
    expect(evaluateCpuOverhead(19)).toMatchObject({ verdict: 'accepted', thresholdPercent: 20 });
    expect(evaluateCpuOverhead(21)).toMatchObject({ verdict: 'refused', thresholdPercent: 20 });
    expect(evaluateCpuOverhead(21, { gpuOverheadPercent: 5 })).toMatchObject({
      verdict: 'refused',
      thresholdPercent: 20,
      gpuVerdict: 'accepted',
    });
  });
});
