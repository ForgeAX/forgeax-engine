import { describe, expect, it } from 'vitest';
import { normalizeReadbackRgba } from '../../scripts/smoke-diagnostics.mjs';

describe('Dawn evidence channel order', () => {
  it.each(['bgra8unorm', 'bgra8unorm-srgb'])('normalizes %s and preserves row padding', format => {
    const pixels = new Uint8Array([255, 160, 20, 255, 7, 8, 9, 10, 80, 40, 10, 200, 1, 2, 3, 4]);
    expect([...normalizeReadbackRgba(pixels, 1, 2, 8, format)]).toEqual([
      20, 160, 255, 255, 7, 8, 9, 10, 10, 40, 80, 200, 1, 2, 3, 4,
    ]);
  });
  it.each(['rgba8unorm', 'rgba8unorm-srgb'])('preserves %s', format => {
    const pixels = new Uint8Array([20, 160, 255, 255]);
    expect(normalizeReadbackRgba(pixels, 1, 1, 4, format)).toBe(pixels);
    expect([...pixels]).toEqual([20, 160, 255, 255]);
  });
  it('refuses an unsupported format instead of inventing pixel evidence', () => {
    expect(() => normalizeReadbackRgba(new Uint8Array(8), 1, 1, 8, 'rgba16float')).toThrow('Unsupported');
  });
});
