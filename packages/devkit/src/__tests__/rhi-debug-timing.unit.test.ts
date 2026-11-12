import type { ReplayBenchmark, TimingStats } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';
import { discoverRhiDebugOperations } from '../rhi-debug/operations';
import { timingBenchmarkOptions, timingFromBenchmark } from '../rhi-debug/timing';

const artifact = { kind: 'rhi-tape', source: 'cli', path: 'frame.rhitape', digest: 'x' } as const;

function stats(p50: number): TimingStats {
  return { count: 1, min: p50, p50, p95: p50, max: p50, mean: p50, stddev: 0 };
}

describe('rhi.timing options', () => {
  it('declares the benchmark flags on the manifest', () => {
    const timing = discoverRhiDebugOperations().find(
      (operation) => operation.name === 'rhi.timing',
    );
    expect(Object.keys(timing?.inputSchema.properties ?? {})).toEqual([
      'artifact',
      'compare',
      'repeat',
      'warmup',
      'isolate',
      'skip',
      'skipPasses',
      'skipWorks',
      'restore',
      'pipelineDepth',
      'ciMs',
      'maxRepeat',
      'timeoutMs',
      'maxGpuPercent',
      'requireIdle',
    ]);
  });

  it('maps CLI input to benchmark options, leaving defaults to the replay', () => {
    expect(timingBenchmarkOptions({ artifact })).toEqual({});
    expect(
      timingBenchmarkOptions({
        artifact,
        repeat: 5,
        warmup: 1,
        isolate: true,
        skip: 'shadow',
        skipPasses: [2],
        skipWorks: [7],
      }),
    ).toEqual({
      repeat: 5,
      warmup: 1,
      isolate: true,
      skip: { passLabel: 'shadow', passIndices: [2], workIndices: [7] },
    });
    expect(
      timingBenchmarkOptions({
        artifact,
        restore: 'reload',
        pipelineDepth: 0,
        ciMs: 0.25,
        maxRepeat: 80,
        timeoutMs: 1000,
      }),
    ).toEqual({ restore: 'reload', pipelineDepth: 0, ciTargetNanoseconds: 250_000, maxRepeat: 80 });
  });

  it('collapses a benchmark to base medians in the FrameTiming shape', () => {
    const frame = { sum: stats(30), union: stats(25), envelope: stats(28) };
    const benchmark: ReplayBenchmark = {
      warmup: 3,
      repeat: 20,
      isolate: false,
      passes: [
        {
          passIndex: 0,
          kind: 'render',
          label: 'a',
          workIndices: [0],
          gpu: stats(10),
          skipped: false,
        },
        { passIndex: 1, kind: 'compute', label: null, workIndices: [], gpu: null, skipped: false },
      ],
      restore: { mode: 'steady', pipelineDepth: 4 },
      timestampCoverage: { complete: true, missingPasses: [] },
      base: {
        frame,
        samples: [],
        unionP50Interval: { confidence: 0.95, low: 25, high: 25, width: 0 },
        drift: {
          slopePerSample: 0,
          relativeDrift: 0,
          firstHalfP50: 25,
          secondHalfP50: 25,
          halfShift: 0,
          lag1Autocorrelation: 0,
          stable: true,
        },
      },
    };
    expect(timingFromBenchmark(benchmark)).toEqual({
      passes: [
        { passIndex: 0, kind: 'render', label: 'a', workIndices: [0], gpuNanoseconds: 10 },
        { passIndex: 1, kind: 'compute', label: null, workIndices: [], gpuNanoseconds: null },
      ],
      totalGpuNanoseconds: 30,
    });
  });
});
