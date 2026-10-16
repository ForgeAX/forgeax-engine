import { describe, expect, it } from 'vitest';
import {
  GPU_PASS_TIMING_BENCHMARK,
  validateGpuPassTimingReport,
  type GpuPassTimingBenchmarkReport,
} from '../index.js';

function validReport(): GpuPassTimingBenchmarkReport {
  const groups = Array.from({ length: 5 }, (_, index) => ({
    group: index,
    frames: 60,
    off: {
      frameDurationsMicroseconds: [100, 110, 120],
      p95FrameDurationMicroseconds: 120,
    },
    on: {
      frameDurationsMicroseconds: [100, 110, 120],
      p95FrameDurationMicroseconds: 120,
    },
  }));
  const frameFacts = Array.from({ length: 5 }, (_, group) => ({
    side: 'on' as const,
    group,
    frameIndex: 0,
    observationStatus: 'complete' as const,
    frame: {
      schemaVersion: '1.0' as const,
      frameId: group + 1,
      deviceGeneration: 0,
      graphGeneration: 1,
      backendKind: 'webgpu' as const,
      timestampPeriodNanoseconds: 1,
      passCapacity: 64,
      executedPassCount: 1,
      measuredPassCount: 1,
      droppedPassCount: 0,
      passes: [
        {
          passName: 'main',
          passKind: 'raster' as const,
          executionIndex: 0,
          status: 'measured' as const,
          measurementSource: 'pass-boundary' as const,
          beginningTick: '100',
          endTick: '142',
          durationNanoseconds: 42,
        },
      ],
      measuredPassNanoseconds: 42,
    },
  }));
  return {
    schemaVersion: '1.0',
    benchmark: GPU_PASS_TIMING_BENCHMARK,
    source: {
      sourceHead: '0123456789abcdef0123456789abcdef01234567',
      package: '@forgeax/engine-render',
    },
    runner: {
      name: 'gpu-pass-timing',
      version: '1.0.0',
      os: 'darwin-arm64',
      browser: null,
    },
    backend: {
      kind: 'webgpu',
      adapter: 'test-adapter',
      driver: 'test-driver',
      browser: 'node-dawn',
      realGpu: true,
    },
    workload: {
      resolution: { width: 640, height: 360 },
      scene: 'standard-scene',
      pipeline: 'standard',
    },
    sampling: {
      warmupFrames: 120,
      groups: 5,
      framesPerGroup: 60,
      quantile: 'nearest-rank-p95',
    },
    windows: { groups },
    frameFacts,
    timingCompleteness: {
      status: 'complete',
      off: { completeFrames: 5 * 60, partialFrames: 0, failedFrames: 0 },
      on: { completeFrames: 5 * 60, partialFrames: 0, failedFrames: 0 },
    },
    offPath: {
      featureResources: 0,
      commandCount: 0,
      pendingPromises: 0,
      mapCalls: 0,
      factObjects: 0,
      profilerGpuRecords: 0,
    },
    overhead: {
      pairedGroups: groups.map((group) => ({
        group: group.group,
        offP95FrameDurationMicroseconds: 120,
        onP95FrameDurationMicroseconds: 120,
        overheadPercent: 0,
      })),
      reportedOverheadPercent: 0,
      thresholdPercent: 10,
    },
    cpu: { verdict: 'accepted', overheadPercent: 0, thresholdPercent: 20 },
    verdict: 'accepted',
    reason: 'GPU timing artifact is complete and within the owner ceiling',
    hint: 'Keep the same runner and workload identity for comparable reports',
  };
}

function expectRefused(mutator: (report: GpuPassTimingBenchmarkReport) => void): void {
  const report = validReport();
  mutator(report);
  const result = validateGpuPassTimingReport(report);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    code: expect.any(String),
    expected: expect.any(String),
    hint: expect.any(String),
  });
}

describe('GPU pass timing artifact validator', () => {
  it('accepts a complete real-GPU artifact with stable identity and exact-zero off path', () => {
    const report = validReport();
    const result = validateGpuPassTimingReport(report);

    expect(result).toMatchObject({ ok: true });
    expect(Object.isFrozen(report)).toBe(true);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('refuses missing source, runner, backend, workload, or sampling identity', () => {
    for (const field of ['source', 'runner', 'backend', 'workload', 'sampling'] as const) {
      expectRefused((report) => {
        delete (report as unknown as Record<string, unknown>)[field];
      });
    }
  });

  it('refuses source mismatch and non-real GPU evidence', () => {
    expectRefused((report) => {
      report.source.package = '@forgeax/engine-profiler';
    });
    expectRefused((report) => {
      report.backend.realGpu = false;
    });
    expectRefused((report) => {
      report.backend.kind = 'rhi-null';
    });
  });

  it('refuses incomplete timing that pretends to be complete', () => {
    expectRefused((report) => {
      report.timingCompleteness.status = 'partial';
      report.verdict = 'accepted';
    });
    expectRefused((report) => {
      report.timingCompleteness.on.failedFrames = 1;
      report.verdict = 'accepted';
    });
  });

  it('refuses non-finite values, missing raw groups, and inconsistent counts', () => {
    expectRefused((report) => {
      report.windows.groups[0].off.p95FrameDurationMicroseconds = Number.NaN;
    });
    expectRefused((report) => {
      report.windows.groups = report.windows.groups.slice(0, 4);
    });
    expectRefused((report) => {
      report.windows.groups[0].frames = 59;
    });
    expectRefused((report) => {
      delete (report as unknown as Record<string, unknown>).frameFacts;
    });
    expectRefused((report) => {
      report.frameFacts[0].frame.measuredPassNanoseconds = 41;
    });
  });

  it('refuses non-zero off-path evidence and an overhead above ten percent', () => {
    expectRefused((report) => {
      report.offPath.mapCalls = 1;
    });
    expectRefused((report) => {
      report.overhead.reportedOverheadPercent = 10.01;
      report.verdict = 'accepted';
    });
  });

  it('keeps refusal and blocked verdicts distinct from accepted', () => {
    const refusal = validReport();
    refusal.verdict = 'refused';
    const blocked = validReport();
    blocked.verdict = 'blocked';

    expect(validateGpuPassTimingReport(refusal)).toMatchObject({ ok: false });
    expect(validateGpuPassTimingReport(blocked)).toMatchObject({ ok: false });
  });
});
