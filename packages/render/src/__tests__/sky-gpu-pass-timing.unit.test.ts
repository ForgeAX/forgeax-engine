import { describe, expect, it } from 'vitest';
import {
  createGpuPassTimingFrame,
  type GpuPassTimingEntry,
  type GpuPassTimingPassIdentity,
} from '../record/gpu-pass-timing/contract';
import { summarizeSkyGpuPassTiming } from '../record/gpu-pass-timing/sky-summary';

const base = 9_007_199_254_740_993n;

function timed(
  passName: string,
  begin: number,
  end: number,
  passKind: GpuPassTimingPassIdentity['passKind'] = 'raster',
): GpuPassTimingEntry {
  return {
    passName,
    passKind,
    viewId: 42,
    executionIndex: 0,
    status: 'measured',
    beginningTick: (base + BigInt(begin)).toString(),
    endTick: (base + BigInt(end)).toString(),
    durationNanoseconds: (end - begin) * 125_000,
    measurementSource: passKind === 'copy' ? 'copy-boundary-envelope' : 'pass-boundary',
  };
}

function missing(passName: string): GpuPassTimingEntry {
  return {
    passName,
    passKind: 'raster',
    viewId: 42,
    executionIndex: 0,
    status: 'unmeasured',
    reason: { code: 'timestamp-write-unavailable', expected: '', hint: '', detail: {} },
  };
}

function summary(passes: readonly GpuPassTimingEntry[], droppedPassCount = 0) {
  return summarizeSkyGpuPassTiming(
    createGpuPassTimingFrame({
      frameId: 40,
      deviceGeneration: 2,
      graphGeneration: 3,
      backendKind: 'webgpu',
      timestampPeriodNanoseconds: 125_000,
      passCapacity: 256,
      passes: passes.map((pass, executionIndex) => ({ ...pass, executionIndex })),
      droppedPassCount,
    }),
  );
}

describe('Standard physical sky GPU coverage', () => {
  it('includes spatial BSM filtering in both cloud and complete-sky costs', () => {
    expect(
      summary([
        timed('cloud-layer-shadow', 0, 8),
        timed('cloud-layer-shadow-filter', 8, 10),
        timed('cloud-sampled-trace', 10, 26),
      ]),
    ).toEqual({
      completeSky: { status: 'ready', milliseconds: 3.25, passCount: 3 },
      cloud: { status: 'ready', milliseconds: 3.25, passCount: 3 },
    });
  });
  it('reports complete sky and cloud interval unions without overlap, gaps, or unrelated work', () => {
    expect(
      summary([
        timed('atmosphere-sky-view', 0, 8, 'compute'),
        timed('atmosphere-aerial-perspective', 3, 12, 'compute'),
        timed('atmosphere-background', 8, 16),
        timed('atmosphere-opaque-composition', 20, 28),
        timed('cloud-layer-shadow', 28, 32),
        timed('cloud-sampled-trace', 32, 48),
        timed('cloud-layer-transport', 42, 52),
        timed('cloud-layer-resolve', 56, 60),
        timed('forward-main', 0, 80),
        timed('output-transform', 80, 100),
        timed('scene-readback', 100, 120, 'copy'),
        timed('cloud-mode0-probe', 120, 140),
        timed('reflection-probe.0.capture.0', 140, 150),
        { ...timed('atmosphere-background', 150, 180), viewId: undefined },
        missing('frame-observation'),
      ]),
    ).toEqual({
      completeSky: { status: 'ready', milliseconds: 6.5, passCount: 8 },
      cloud: { status: 'ready', milliseconds: 3.5, passCount: 4 },
    });
  });

  it('includes executed resource and history updates and enabled fog', () => {
    expect(
      summary([
        timed('atmosphere-multiple-scattering-fragment', 0, 2),
        timed('atmosphere-distant-sky-light', 2, 4, 'compute'),
        timed('atmosphere-capture-sky-view', 4, 6, 'compute'),
        timed('atmosphere-cube-5', 6, 8),
        timed('atmosphere-irradiance-5', 8, 10),
        timed('atmosphere-prefilter-8', 10, 12),
        timed('atmosphere-prefilter-copy-8', 12, 14, 'copy'),
        timed('cloud-mode0-history-clear', 14, 16),
        timed('cloud-analytic-trace', 16, 18),
        timed('analytic-fog', 18, 20),
        timed('volume-inject', 20, 22, 'compute'),
        timed('volume-integrate', 22, 24, 'compute'),
        timed('volume-temporal', 24, 26, 'compute'),
        timed('volume-composite', 26, 28),
        timed('atmosphere-prepare', 28, 48, 'copy'),
        timed('atmosphere-ibl-prepare', 48, 68, 'copy'),
      ]),
    ).toEqual({
      completeSky: { status: 'ready', milliseconds: 3.5, passCount: 14 },
      cloud: { status: 'ready', milliseconds: 0.5, passCount: 2 },
    });
  });

  it('keeps a usable cloud group when only a selected atmosphere query is missing', () => {
    expect(summary([missing('atmosphere-background'), timed('cloud-sampled-trace', 0, 8)])).toEqual(
      {
        completeSky: { status: 'unavailable', reason: 'timestamp-write-unavailable' },
        cloud: { status: 'ready', milliseconds: 1, passCount: 1 },
      },
    );
  });

  it('fails closed for selected cloud errors, drops, and unresolved durations', () => {
    for (const [passes, droppedPassCount, reason] of [
      [
        [timed('atmosphere-background', 0, 8), missing('cloud-layer-resolve')],
        0,
        'timestamp-write-unavailable',
      ],
      [[timed('cloud-sampled-trace', 0, 8)], 1, 'query-budget-exceeded'],
      [[timed('cloud-sampled-trace', 8, 0)], 0, 'timestamp-range-invalid'],
      [[timed('cloud-sampled-trace', 0, 0)], 0, 'timestamp-resolution'],
      [[timed('skybox', 0, 8), timed('forward-main', 8, 16)], 0, 'no-selected-passes'],
    ] as const) {
      const unavailable = { status: 'unavailable', reason };
      expect(summary(passes, droppedPassCount)).toEqual({
        completeSky: unavailable,
        cloud: unavailable,
      });
    }
  });
});
