import { describe, expect, it } from 'vitest';
import type {
  GpuPassTimingEntry,
  GpuPassTimingObservation,
} from '../record/gpu-pass-timing/index.js';
import {
  createGpuPassTimingFrame,
  DEFAULT_GPU_PASS_TIMING_OPTIONS,
  freezeGpuPassTimingFrame,
  normalizeGpuPassTimingOptions,
} from '../record/gpu-pass-timing/index.js';
import { parseGpuPassTimingTicks } from '../record/gpu-pass-timing/parser.js';

describe('GPU pass timing contract', () => {
  it('uses bounded defaults and accepts only the documented option ranges', () => {
    expect(DEFAULT_GPU_PASS_TIMING_OPTIONS).toEqual({
      maxPassesPerFrame: 256,
      maxFramesInFlight: 3,
      retentionFrames: 8,
    });
    expect(normalizeGpuPassTimingOptions()).toMatchObject({
      ok: true,
      value: DEFAULT_GPU_PASS_TIMING_OPTIONS,
    });
    expect(normalizeGpuPassTimingOptions({ maxPassesPerFrame: 1 })).toMatchObject({
      ok: true,
      value: { maxPassesPerFrame: 1, maxFramesInFlight: 3, retentionFrames: 8 },
    });
    expect(normalizeGpuPassTimingOptions({ maxPassesPerFrame: 2048 })).toMatchObject({
      ok: true,
    });
    expect(normalizeGpuPassTimingOptions({ maxFramesInFlight: 1 })).toMatchObject({
      ok: true,
    });
    expect(normalizeGpuPassTimingOptions({ maxFramesInFlight: 8 })).toMatchObject({
      ok: true,
    });
    expect(normalizeGpuPassTimingOptions({ maxPassesPerFrame: 0 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-timing-options' },
    });
    expect(normalizeGpuPassTimingOptions({ maxPassesPerFrame: 2049 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-timing-options' },
    });
  });

  it('preserves frame and pass identity, sums measured entries only, and freezes facts', () => {
    const measured: GpuPassTimingEntry = {
      passName: 'main',
      passKind: 'raster',
      executionIndex: 2,
      status: 'measured',
      measurementSource: 'pass-boundary',
      beginningTick: '10000000000000000001',
      endTick: '10000000000000000011',
      durationNanoseconds: 10,
    };
    const unmeasured: GpuPassTimingEntry = {
      passName: 'copy',
      passKind: 'copy',
      executionIndex: 3,
      status: 'unmeasured',
      reason: {
        code: 'timestamp-owner-conflict',
        expected: 'the pass has an available timestamp pair',
        hint: 'wait for the producer-owned timestamp range before observing this pass',
        detail: { passName: 'copy' },
      },
    };
    const frame = freezeGpuPassTimingFrame(
      createGpuPassTimingFrame({
        frameId: 41,
        deviceGeneration: 7,
        graphGeneration: 9,
        backendKind: 'webgpu',
        timestampPeriodNanoseconds: 1,
        passCapacity: 256,
        passes: [measured, unmeasured],
      }),
    );

    expect(frame).toMatchObject({
      schemaVersion: '1.0',
      frameId: 41,
      deviceGeneration: 7,
      graphGeneration: 9,
      executedPassCount: 2,
      measuredPassCount: 1,
      droppedPassCount: 0,
      measuredPassNanoseconds: 10,
    });
    expect(frame.passes[0]).toEqual(measured);
    expect(frame.passes[1]).toEqual(unmeasured);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.passes)).toBe(true);
    expect(Object.isFrozen(frame.passes[0])).toBe(true);
  });

  it('keeps executed, retained, measured, and dropped pass counts self-consistent', () => {
    const frame = createGpuPassTimingFrame({
      frameId: 8,
      deviceGeneration: 1,
      graphGeneration: 2,
      backendKind: 'webgpu',
      timestampPeriodNanoseconds: 1,
      passCapacity: 1,
      passes: [
        {
          passName: 'retained',
          passKind: 'compute',
          executionIndex: 0,
          status: 'unmeasured',
          reason: {
            code: 'query-budget-exceeded',
            expected: 'the pass fits the bounded query budget',
            hint: 'increase maxPassesPerFrame',
            detail: {},
          },
        },
      ],
      droppedPassCount: 2,
    });

    expect(frame).toMatchObject({
      executedPassCount: 3,
      measuredPassCount: 0,
      droppedPassCount: 2,
      passes: [{ passName: 'retained' }],
    });
  });

  it('parses decimal string ticks without exposing BigInt and accepts equal ticks as zero', () => {
    expect(
      parseGpuPassTimingTicks({
        beginningTick: '900719925474099300',
        endTick: '900719925474099303',
        timestampPeriodNanoseconds: 0.5,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        status: 'measured',
        beginningTick: '900719925474099300',
        endTick: '900719925474099303',
        durationNanoseconds: 1.5,
      },
    });
    expect(
      parseGpuPassTimingTicks({
        beginningTick: '44',
        endTick: '44',
        timestampPeriodNanoseconds: 2,
      }),
    ).toMatchObject({
      ok: true,
      value: { status: 'measured', durationNanoseconds: 0, timerResolution: 'equal-ticks' },
    });
  });

  it('rejects non-positive periods, reversed ticks, and unsafe duration conversion', () => {
    for (const period of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        parseGpuPassTimingTicks({
          beginningTick: '1',
          endTick: '2',
          timestampPeriodNanoseconds: period,
        }),
      ).toMatchObject({ ok: false, error: { code: 'timestamp-period-unavailable' } });
    }
    expect(
      parseGpuPassTimingTicks({
        beginningTick: '12',
        endTick: '11',
        timestampPeriodNanoseconds: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: 'timestamp-range-invalid' } });
    expect(
      parseGpuPassTimingTicks({
        beginningTick: '0',
        endTick: '999999999999999999999999999999',
        timestampPeriodNanoseconds: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: 'timestamp-range-invalid' } });
  });

  it('keeps all four observation statuses JSON-safe and retains only an identity ref for LKG', () => {
    const observations: GpuPassTimingObservation[] = [
      {
        status: 'complete',
        frame: createGpuPassTimingFrame({
          frameId: 1,
          deviceGeneration: 1,
          graphGeneration: 1,
          backendKind: 'webgpu',
          timestampPeriodNanoseconds: 1,
          passCapacity: 1,
          passes: [],
        }),
      },
      {
        status: 'partial',
        frame: createGpuPassTimingFrame({
          frameId: 2,
          deviceGeneration: 1,
          graphGeneration: 1,
          backendKind: 'webgpu',
          timestampPeriodNanoseconds: 1,
          passCapacity: 1,
          passes: [],
        }),
        reason: {
          code: 'timing-in-flight-exhausted',
          expected: 'a bounded timing slot is available',
          hint: 'reduce the timing capture rate or increase maxFramesInFlight',
          detail: { maxFramesInFlight: 1 },
        },
      },
      {
        status: 'unavailable',
        reason: {
          code: 'timestamp-query-unsupported',
          expected: 'the active device exposes timestamp-query',
          hint: 'use a backend that supports timestamp-query',
          detail: { backendKind: 'wgpu-webgl2' },
        },
        capability: { timestampQuery: false, timestampPeriodNanoseconds: null },
      },
      {
        status: 'failed',
        error: {
          code: 'timestamp-readback-failed',
          expected: 'the resolved timing buffer can be read',
          hint: 'wait for a later receipt and inspect the retained latest-known-good ref',
          detail: { frameId: 3 },
          cause: { code: 'webgpu-runtime-error' },
        },
        latestKnownGood: { frameId: 2, deviceGeneration: 1, graphGeneration: 1 },
      },
    ];
    expect(JSON.parse(JSON.stringify(observations))).toEqual(observations);
  });
});
