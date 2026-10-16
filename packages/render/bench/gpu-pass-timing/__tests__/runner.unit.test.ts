import { describe, expect, it } from 'vitest';
import type { GpuPassTimingFrame } from '../../../src/record/gpu-pass-timing/contract.js';
import {
  runGpuPassTimingBenchmark,
  type GpuPassTimingBenchHost,
  type GpuPassTimingBenchObservation,
} from '../runner.js';

const sourceHead = '0123456789abcdef0123456789abcdef01234567';

function frame(frameId: number): GpuPassTimingFrame {
  return {
    schemaVersion: '1.0',
    frameId,
    deviceGeneration: 0,
    graphGeneration: 1,
    backendKind: 'webgpu',
    timestampPeriodNanoseconds: 1,
    passCapacity: 64,
    executedPassCount: 1,
    measuredPassCount: 1,
    droppedPassCount: 0,
    passes: [
      {
        passName: 'main',
        passKind: 'raster',
        executionIndex: 0,
        status: 'measured',
        measurementSource: 'pass-boundary',
        beginningTick: String(frameId * 100),
        endTick: String(frameId * 100 + 42),
        durationNanoseconds: 42,
      },
    ],
    measuredPassNanoseconds: 42,
  };
}

function host(
  onStatus: GpuPassTimingBenchObservation['status'],
  onFrameDurationMicroseconds = 100,
): GpuPassTimingBenchHost {
  let frameId = 0;
  return {
    source: { sourceHead, package: '@forgeax/engine-render' },
    runner: { name: 'runner', version: '1', os: 'test', browser: null },
    backend: {
      kind: 'webgpu',
      adapter: 'test-adapter',
      driver: 'test-driver',
      browser: 'dawn-node',
      realGpu: true,
    },
    workload: {
      resolution: { width: 32, height: 32 },
      scene: 'standard-renderer-minimal',
      pipeline: 'standard',
    },
    draw: async (timingEnabled) => {
      frameId += 1;
      return {
        receipt: { frameId },
        frameDurationMicroseconds: timingEnabled ? onFrameDurationMicroseconds : 100,
        identity: {
          sourceHead,
          runner: 'runner',
          backend: 'webgpu:test-adapter:test-driver',
          workload: '32x32:standard-renderer-minimal:standard',
          frameGeneration: 'device-0:graph-standard',
        },
        offPathExactZero: true,
        observe: async (): Promise<GpuPassTimingBenchObservation> =>
          timingEnabled
            ? { status: onStatus, ...(onStatus === 'complete' || onStatus === 'partial' ? { frame: frame(frameId) } : {}) }
            : { status: 'complete' },
      };
    },
    offPath: {
      featureResources: 0,
      commandCount: 0,
      pendingPromises: 0,
      mapCalls: 0,
      factObjects: 0,
      profilerGpuRecords: 0,
    },
    cpuOverheadPercent: 0,
  };
}

describe('GPU pass timing benchmark frame facts', () => {
  it('retains one numeric on-path frame fact per accepted group', async () => {
    const result = await runGpuPassTimingBenchmark(host('complete'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frameFacts).toHaveLength(5);
    expect(result.value.frameFacts.map((fact) => fact.group)).toEqual([0, 1, 2, 3, 4]);
    expect(result.value.frameFacts[0]?.frame.passes[0]).toMatchObject({
      status: 'measured',
      durationNanoseconds: 42,
      beginningTick: expect.any(String),
      endTick: expect.any(String),
    });
    expect(result.value.frameFacts[0]?.frame.measuredPassNanoseconds).toBe(42);
  });

  it('keeps partial numeric facts in the blocked result without accepting the benchmark', async () => {
    const result = await runGpuPassTimingBenchmark(host('partial'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail.frameFacts).toHaveLength(5);
    expect(result.error.detail.frameFacts?.[0]?.observationStatus).toBe('partial');
    expect(result.error.detail.frameFacts?.[0]?.frame.measuredPassNanoseconds).toBe(42);
  });

  it('keeps raw windows and overhead facts when the paired gate refuses', async () => {
    const result = await runGpuPassTimingBenchmark(host('complete', 112));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail.windows).toHaveLength(5);
    expect(result.error.detail.windows?.[0]?.off.frameDurationsMicroseconds).toHaveLength(60);
    expect(result.error.detail.windows?.[0]?.on.frameDurationsMicroseconds).toHaveLength(60);
    expect(result.error.detail.pairedOverhead).toMatchObject({
      groupOverheadPercent: [12, 12, 12, 12, 12],
      reportedOverheadPercent: 12,
    });
    expect(result.error.detail.cpuOverheadPercent).toBe(0);
  });

});
