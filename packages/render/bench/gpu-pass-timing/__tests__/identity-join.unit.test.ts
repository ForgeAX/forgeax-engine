import { describe, expect, it } from 'vitest';
import { joinGpuPassTimingWindows, type GpuPassTimingSampleWindow } from '../statistics.js';

function sample(overrides: Partial<GpuPassTimingSampleWindow['identity']> = {}): GpuPassTimingSampleWindow {
  return {
    identity: {
      sourceHead: '0123456789abcdef0123456789abcdef01234567',
      runner: 'runner-1',
      backend: 'webgpu:test-adapter:test-driver',
      workload: '640x360:standard-scene:standard',
      frameGeneration: 'device-3:graph-7',
      ...overrides,
    },
    frameDurationsMicroseconds: Array.from({ length: 60 }, () => 100),
    complete: true,
    offPathExactZero: true,
  };
}

describe('GPU pass timing identity join', () => {
  it('joins paired windows only when source, workload, backend, and generation match', () => {
    const result = joinGpuPassTimingWindows(sample(), sample());
    expect(result).toMatchObject({ ok: true });
  });

  for (const field of ['sourceHead', 'workload', 'backend', 'frameGeneration'] as const) {
    it(`refuses a ${field} mismatch`, () => {
      const result = joinGpuPassTimingWindows(sample(), sample({ [field]: `different-${field}` }));
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'identity-mismatch', hint: expect.any(String) },
      });
    });
  }

  it('refuses partial windows and non-zero off-path windows before statistics', () => {
    const partial = sample();
    partial.complete = false;
    expect(joinGpuPassTimingWindows(sample(), partial)).toMatchObject({
      ok: false,
      error: { code: 'window-incomplete' },
    });
    const nonZero = sample();
    nonZero.offPathExactZero = false;
    expect(joinGpuPassTimingWindows(sample(), nonZero)).toMatchObject({
      ok: false,
      error: { code: 'off-path-nonzero' },
    });
  });
});
