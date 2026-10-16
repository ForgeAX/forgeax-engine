import { describe, expect, it } from 'vitest';
import {
  observeBrowserGpuPassTimingDisabled,
  runBrowserGpuPassTiming,
} from './gpu-pass-timing-browser-runner.js';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

describe.skipIf(!browserReady)('GPU pass timing Browser dev-server runner', () => {
  // Every case creates a fresh renderer, including the disabled-timing case.
  // Software WebGPU initialization alone can exceed Vitest's 15s default;
  // retain the same bounded startup allowance for all three cases.
  it('returns the standard unavailable observation when GPU timing is disabled', {
    timeout: 30_000,
  }, async () => {
    const { requested, omitted } = await observeBrowserGpuPassTimingDisabled();
    expect(requested.timings).toMatchObject({
      status: 'unavailable',
      reason: { code: 'gpu-timing-not-enabled' },
    });
    expect(requested.timings).not.toHaveProperty('frame');
    expect(omitted.timings).toBeUndefined();
  });

  it('keeps receipt facts and unsupported timing structured without stopping draw', {
    timeout: 30_000,
  }, async () => {
    const result = await runBrowserGpuPassTiming();
    expect(result.frames).toBe(3);
    if (result.supported) {
      expect(result.unavailable).toBe(false);
      expect(result.measuredPasses).toBeGreaterThan(0);
    } else {
      expect(result.unavailable).toBe(true);
      expect(result.measuredPasses).toBe(0);
    }
    expect(result.visible).toBe(true);
  });

  it('keeps raster suppression as a test-only falsifier, never timing evidence', {
    timeout: 30_000,
  }, async () => {
    const result = await runBrowserGpuPassTiming({ suppressRaster: true });
    expect(result.rasterSuppressed).toBe(true);
    expect(result.frames).toBe(3);
    if (result.supported) expect(result.measuredPasses).toBeGreaterThan(0);
  });
});
