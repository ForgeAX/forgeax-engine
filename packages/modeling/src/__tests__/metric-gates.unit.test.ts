import { bakeMaps } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { flip } from '../tools/flip';
import { goldenCase, goldenReport } from '../tools/golden';
import {
  type ColorImage,
  colorImage,
  heatmapPng,
  imageDeltaE,
  shimmer,
  ssim,
} from '../tools/image-metrics';

const solid = (w: number, h: number, v: number): ColorImage =>
  colorImage(w, h, new Uint8Array(w * h * 4).fill(v));
const a = solid(16, 16, 100);
const b = solid(16, 16, 200);
const empty = new Uint8Array(256);

describe('image metrics refuse vacuous input', () => {
  it('an empty mask is an error, not a mean of 0', () => {
    expect(() => ssim(a, b, empty)).toThrow(RangeError);
    expect(() => imageDeltaE(a, b, empty)).toThrow(RangeError);
    expect(() => shimmer([a, b], empty)).toThrow(RangeError);
  });

  it('a mask of the wrong length is an error', () => {
    expect(() => ssim(a, b, new Uint8Array(10).fill(1))).toThrow(RangeError);
    expect(() => imageDeltaE(a, b, new Uint8Array(300).fill(1))).toThrow(RangeError);
  });

  it('a non-empty mask still measures', () => {
    const one = new Uint8Array(256);
    one[5] = 1;
    expect(imageDeltaE(a, b, one).mean).toBeGreaterThan(1);
    expect(ssim(a, a, one).mean).toBeCloseTo(1, 12);
  });

  it('a non-finite image gives an error, not a NaN mean', () => {
    const bad = { width: 16, height: 16, rgb: new Float32Array(16 * 16 * 3).fill(Number.NaN) };
    expect(() => ssim(a, bad)).toThrow(RangeError);
    expect(() => imageDeltaE(a, bad)).toThrow(RangeError);
    expect(() => flip(a, bad)).toThrow(RangeError);
    expect(() => shimmer([a, bad])).toThrow(RangeError);
  });

  it('flip needs a finite positive ppd', () => {
    for (const ppd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e9])
      expect(() => flip(a, b, { ppd })).toThrow(RangeError);
    expect(flip(a, b, { ppd: 40 }).mean).toBeGreaterThan(0.1);
  });

  it('colorImage rejects a buffer shorter than width * height * 4', () => {
    expect(() => colorImage(4, 4, new Uint8Array(8))).toThrow(RangeError);
    expect(() => colorImage(0, 4, new Uint8Array(0))).toThrow(RangeError);
  });

  it('heatmapPng needs a positive finite max, a whole map and finite values', () => {
    expect(() => heatmapPng(new Float32Array(4), 2, 2, 0)).toThrow(RangeError);
    expect(() => heatmapPng(new Float32Array(4), 2, 2, Number.NaN)).toThrow(RangeError);
    expect(() => heatmapPng(new Float32Array(3), 2, 2, 1)).toThrow(RangeError);
    expect(() => heatmapPng(new Float32Array([Number.NaN, 0, 0, 0]), 2, 2, 1)).toThrow(RangeError);
    const masked = heatmapPng(
      new Float32Array([Number.NaN, 0, 0, 0]),
      2,
      2,
      1,
      Uint8Array.of(0, 1, 1, 1),
    );
    expect(masked.length).toBeGreaterThan(8);
  });
});

describe('goldenReport cannot pass without measuring', () => {
  const R = 32;
  const g = goldenCase('sphere', R);
  const baked = bakeMaps({
    base: g.base,
    detail: g.detail,
    maps: ['normal'],
    resolution: R,
    normals: g.normals,
    budget: 1e12,
  });
  if (!baked.ok) throw baked.error;
  const settings = { resolution: R, distance: 0.05 };

  it('a bake without the measured maps fails', () => {
    const r = goldenReport(g, { ...baked.value, textures: {} }, settings);
    expect(r.pass).toBe(false);
    expect(r.issues[0]?.detail).toMatchObject({ check: 'golden-unmeasured' });
  });

  it('a NaN measurement fails the gate instead of passing it', () => {
    const nan = { ...g, surface: { ...g.surface, normal: () => [Number.NaN, 0, 0] as const } };
    const r = goldenReport(nan, baked.value, settings);
    expect(r.pass).toBe(false);
    expect(r.issues.map((i) => i.detail)).toContainEqual(
      expect.objectContaining({ check: 'golden-unmeasured', finite: false }),
    );
  });

  it('non-finite thresholds and settings are errors', () => {
    expect(() => goldenReport(g, baked.value, settings, { p95: Number.NaN })).toThrow(RangeError);
    expect(() => goldenReport(g, baked.value, settings, { aoMae: Number.NaN })).toThrow(RangeError);
    expect(() => goldenReport(g, baked.value, { ...settings, distance: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => goldenReport(g, baked.value, { ...settings, resolution: 0 })).toThrow(RangeError);
  });

  it('a measured bake still passes', () => {
    const r = goldenReport(g, baked.value, settings);
    expect(r.pass).toBe(true);
    expect(r.texels).toBeGreaterThan(100);
  });
});
