import { describe, expect, it } from 'vitest';
import { color } from '../src';

// Mirrors THREE.Color.setHex / setStyle under ColorManagement: hex and CSS are sRGB,
// the stored (working) value is linear.
describe('color.linearRgb', () => {
  it('decodes a 0xRRGGBB number like THREE.Color.setHex', () => {
    const c = color.linearRgb(0xff8000);
    expect(c[0]).toBeCloseTo(1, 6);
    expect(c[1]).toBeCloseTo(0.21586, 4);
    expect(c[2]).toBe(0);
  });
  it('decodes hex strings (long and short) and CSS names', () => {
    expect(color.linearRgb('#ff8000')[1]).toBeCloseTo(0.21586, 4);
    expect(color.linearRgb('#f80')[1]).toBeCloseTo(0.2462, 3);
    expect(color.linearRgb('white')).toEqual([1, 1, 1]);
  });
  it('returns a plain 3-tuple usable as a component colour field', () => {
    const c = color.linearRgb('#808080');
    expect(c).toHaveLength(3);
    expect(Array.isArray(c)).toBe(true);
    expect(c[0]).toBeCloseTo(0.2159, 3);
  });
  it('falls back to black on malformed input', () => {
    expect(color.linearRgb('nope')).toEqual([0, 0, 0]);
    expect(color.linearRgb(Number.NaN)).toEqual([0, 0, 0]);
  });
});
