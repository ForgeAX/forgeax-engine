import { describe, expect, it } from 'vitest';
import {
  abbaIncrement,
  projectTimingFrame,
  summarizeIntervalSet,
  summarizePerformanceWindow,
  summarizeSamples,
} from '../../../../apps/hello/ssr/scripts/smoke-performance-sequence-aggregation.mjs';
import { createGpuPassTimingFrame } from '../record/gpu-pass-timing/contract';

describe('SSR performance sequence interval aggregation', () => {
  it('preserves run quantiles and rejects missing CPU completion evidence', () => {
    const windows = [
      [1, 2, 3],
      [5, 6, 7],
      [6, 7, 8],
      [2, 3, 4],
    ].map((samples) => ({
      envelope: summarizeSamples(samples),
    }));
    expect(abbaIncrement(windows, 'envelope')).toMatchObject({ p50Ms: 4, p95Ms: 4 });
    expect(abbaIncrement(windows.slice(0, 3), 'envelope')).toBeNull();
    const frame = createGpuPassTimingFrame({
      frameId: 1,
      deviceGeneration: 0,
      graphGeneration: 0,
      backendKind: 'webgpu',
      timestampPeriodNanoseconds: 1,
      passCapacity: 1,
      passes: [
        {
          passName: 'draw',
          passKind: 'raster',
          executionIndex: 0,
          status: 'measured',
          measurementSource: 'pass-boundary',
          beginningTick: '10',
          endTick: '30',
          durationNanoseconds: 20,
        },
      ],
    });
    const report = {
      performanceTiming: {
        timingFrames: [frame],
        cpu: {
          samples: [1],
          completionWaitSamples: [2],
          endToEndSamples: [3],
        },
      },
    };
    expect(summarizePerformanceWindow(report, 0, 1).complete).toBe(true);
    expect(
      summarizePerformanceWindow(
        {
          performanceTiming: {
            ...report.performanceTiming,
            cpu: { samples: [1] },
          },
        },
        0,
        1,
      ).complete,
    ).toBe(false);
    expect(summarizePerformanceWindow(report, 0, 2).complete).toBe(false);
  });

  it('keeps outer span across disjoint intervals while union stays disjoint', () => {
    const summary = summarizeIntervalSet([
      { passName: 'first', beginning: 0n, end: 10n },
      { passName: 'second', beginning: 20n, end: 30n },
    ]);

    expect(summary.outerSpanTicks).toBe('30');
    expect(summary.unionTicks).toBe('20');
    expect(summary.duplicatedTicks).toBe('0');
  });

  it('retains overlap and missing-copy coverage without admitting partial timing', () => {
    const frame = createGpuPassTimingFrame({
      frameId: 1,
      deviceGeneration: 0,
      graphGeneration: 0,
      backendKind: 'webgpu',
      timestampPeriodNanoseconds: 1,
      passCapacity: 3,
      passes: [
        {
          passName: 'ssr-trace',
          passKind: 'compute',
          executionIndex: 0,
          status: 'measured',
          measurementSource: 'pass-boundary',
          beginningTick: '10',
          endTick: '30',
          durationNanoseconds: 20,
        },
        {
          passName: 'ssr-compose',
          passKind: 'raster',
          executionIndex: 1,
          status: 'measured',
          measurementSource: 'pass-boundary',
          beginningTick: '20',
          endTick: '40',
          durationNanoseconds: 20,
        },
        {
          passName: 'copy',
          passKind: 'copy',
          executionIndex: 2,
          status: 'unmeasured',
          reason: { code: 'timestamp-write-unavailable', expected: '', hint: '', detail: {} },
        },
      ],
    });
    const result = projectTimingFrame(frame);
    expect(result.status).toBe('partial');
    expect(result.coverage?.ssr).toMatchObject({
      sumNanoseconds: 40,
      unionNanoseconds: 30,
      overlapNanoseconds: 10,
    });
    expect(result.coverage?.copyEnvelope?.unmeasuredPassCount).toBe(1);
    expect(result.coverage?.passBoundary?.unmeasuredPassCount).toBe(0);
    const invalid = {
      ...frame,
      passes: frame.passes.map((pass) =>
        pass.status === 'measured' ? { ...pass, durationNanoseconds: 99 } : pass,
      ),
    };
    expect(projectTimingFrame(invalid).status).toBe('failed');
  });
});
