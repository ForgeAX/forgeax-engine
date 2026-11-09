import { describe, expect, it } from 'vitest';
import { RUNTIME_BYTES, splitTime } from '../feature/runtime-uniform.js';

describe('runtime uniform time split', () => {
  it('splits seconds into an exact whole and a fraction', () => {
    expect(splitTime(12.5)).toEqual({ whole: 12, fract: 0.5 });
    expect(splitTime(0)).toEqual({ whole: 0, fract: 0 });
  });
  it('keeps frame resolution after ten hours of play', () => {
    const t = 36000 + 1 / 60;
    const { whole, fract } = splitTime(t);
    expect(whole).toBe(36000);
    expect(Math.abs(fract - 1 / 60)).toBeLessThan(1e-7);
    // A single f32 cannot resolve a 60 Hz frame at this magnitude.
    expect(Math.abs(Math.fround(t) - t)).toBeGreaterThan(1e-4);
  });
  it('rejects invalid input as zero', () => {
    expect(splitTime(Number.NaN)).toEqual({ whole: 0, fract: 0 });
    expect(splitTime(-3)).toEqual({ whole: 0, fract: 0 });
  });
  it('reserves 80 words for the runtime uniform', () => {
    expect(RUNTIME_BYTES).toBe(320);
  });
});
