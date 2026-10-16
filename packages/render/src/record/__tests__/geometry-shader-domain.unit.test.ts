import { describe, expect, it } from 'vitest';
import { isHdrGeometryTarget } from '../main-pass-geometry';

describe('geometry shader numeric domain', () => {
  it.each([
    false,
    true,
  ])('keeps both float HDR attachment formats linear with tonemap=%s', (tonemap) => {
    expect(isHdrGeometryTarget(tonemap, 'rgba16float')).toBe(true);
    expect(isHdrGeometryTarget(tonemap, 'rgba32float')).toBe(true);
    expect(isHdrGeometryTarget(tonemap, 'rgba8unorm')).toBe(false);
    expect(isHdrGeometryTarget(tonemap, 'bgra8unorm-srgb')).toBe(false);
    expect(isHdrGeometryTarget(tonemap, undefined)).toBe(tonemap);
  });
});
