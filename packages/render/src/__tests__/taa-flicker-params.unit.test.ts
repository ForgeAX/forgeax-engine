import { describe, expect, it } from 'vitest';
import { flickerParams } from '../typed-render-graph-primitives';

describe('flickerParams (UE TSR flicker cvar terms)', () => {
  it('uses period 2 at 60 Hz or unknown dt', () => {
    const owner = {};
    const first = flickerParams(true, 0, owner, 1920);
    expect(first.invThreshold).toBeCloseTo(1 - 0.95 ** 2, 6);
    expect(first.invMaxParallax).toBeCloseTo(1 / 10, 6);
    const second = flickerParams(true, 1 / 60, owner, 1920);
    expect(second.invThreshold).toBeCloseTo(1 - 0.95 ** 2, 6);
  });

  it('shortens the period below 60 fps', () => {
    const owner = {};
    flickerParams(true, 0, owner, 1920);
    // 30 fps => refreshToCap = 2 => period 1
    const p = flickerParams(true, 1 / 30, owner, 1920);
    expect(p.invThreshold).toBeCloseTo(0.05, 6);
    expect(p.invMaxParallax).toBeCloseTo(1 / 20, 6);
  });

  it('scales parallax tolerance with width and passes enabled through', () => {
    const p = flickerParams(false, undefined, {}, 1200);
    expect(p.enabled).toBe(false);
    expect(p.invMaxParallax).toBeCloseTo(1 / (10 * (1200 / 1920)), 6);
  });
});
