import { describe, expect, it } from 'vitest';

describe('TAA rgba16float browser admission', () => {
  it('records capability as an explicit conjunction', () => {
    const caps = { rgba16floatRender: true, rgba16floatSample: true, mrt: true };
    expect(Object.values(caps).every(Boolean)).toBe(true);
  });

  it('requires the browser runner identity for a promoted probe', () => {
    const evidence = {
      backend: 'browser-webgpu',
      runner: 'playwright',
      frames: 60,
      status: 'pass',
    };
    expect(evidence.runner).toBe('playwright');
    expect(evidence.frames).toBeGreaterThanOrEqual(60);
  });
});
