import { describe, expect, it } from 'vitest';
import type { ExecutionHdrFrameObservation } from '../execution/types';
import {
  BLOOM_CLASS_ABOVE,
  BLOOM_CLASS_BELOW,
  BLOOM_CLASS_KNEE,
  bloomClass,
  bloomSettingsFromCamera,
  bloomWeight,
  classifyLuminance,
  decodeHdrFrame,
  evFromCode,
  halfToFloat,
  LUMINANCE_EV_MIN,
  luminanceEvCode,
  rec709Luminance,
} from '../observation-pixels';

const BLOOM = { enabled: true, threshold: 1, smoothWidth: 0.5, intensity: 0.5 };

/** A 2x1 `rgba16float` readback with 4 bytes of row padding. */
function halfFrame(
  pixels: readonly (readonly [number, number, number])[],
): ExecutionHdrFrameObservation {
  const bytesPerRow = pixels.length * 8 + 4;
  const bytes = new Uint8Array(bytesPerRow);
  const view = new DataView(bytes.buffer);
  const half: Record<number, number> = { 0: 0x0000, 0.5: 0x3800, 1: 0x3c00, 2: 0x4000, 4: 0x4400 };
  pixels.forEach((rgb, x) => {
    for (const [channel, value] of rgb.entries())
      view.setUint16(x * 8 + channel * 2, half[value] as number, true);
    view.setUint16(x * 8 + 6, 0x3c00, true);
  });
  return {
    frameId: 7,
    width: pixels.length,
    height: 1,
    bytesPerRow,
    format: 'rgba16float',
    bytes,
  } as unknown as ExecutionHdrFrameObservation;
}

describe('observation pixels', () => {
  it('decodes binary16 including subnormals, infinities and NaN', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x7bff)).toBe(65504);
    expect(halfToFloat(0x0001)).toBe(2 ** -24);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0x7e00)).toBeNaN();
  });

  it('decodes a padded rgba16float readback into dense RGB', () => {
    const frame = decodeHdrFrame(
      halfFrame([
        [1, 0.5, 0],
        [4, 2, 1],
      ]),
    );
    expect(frame.width).toBe(2);
    expect(Array.from(frame.rgb)).toEqual([1, 0.5, 0, 4, 2, 1]);
  });

  it('rejects truncated readbacks and LDR formats', () => {
    const frame = halfFrame([[1, 1, 1]]);
    expect(() => decodeHdrFrame({ ...frame, bytes: new Uint8Array(4) })).toThrow(
      'live-hdr-layout-invalid',
    );
    expect(() =>
      decodeHdrFrame({ ...frame, format: 'rgba8unorm' } as unknown as ExecutionHdrFrameObservation),
    ).toThrow('live-hdr-format-unsupported');
  });

  it('uses the bloom high-pass Rec.709 weights and clamps to the half range', () => {
    expect(rec709Luminance(1, 1, 1)).toBeCloseTo(1, 6);
    expect(rec709Luminance(0, 1, 0)).toBeCloseTo(0.7152, 6);
    expect(rec709Luminance(Infinity, 0, 0)).toBe(65504);
    expect(rec709Luminance(Number.NaN, 0, 0)).toBe(0);
  });

  it('round-trips EV codes in 1/8-stop bins', () => {
    expect(luminanceEvCode(0)).toBe(0);
    expect(luminanceEvCode(-1)).toBe(0);
    expect(evFromCode(0)).toBeNull();
    expect(evFromCode(luminanceEvCode(1))).toBe(0);
    expect(evFromCode(luminanceEvCode(2 ** 3.25))).toBe(3.25);
    expect(luminanceEvCode(2 ** -40)).toBe(1);
    expect(evFromCode(1)).toBe(LUMINANCE_EV_MIN);
    expect(luminanceEvCode(65504)).toBeLessThanOrEqual(255);
  });

  it('classifies the smoothstep knee like the bloom shader', () => {
    expect(bloomClass(1, BLOOM)).toBe(BLOOM_CLASS_BELOW);
    expect(bloomClass(1.25, BLOOM)).toBe(BLOOM_CLASS_KNEE);
    expect(bloomClass(1.5, BLOOM)).toBe(BLOOM_CLASS_ABOVE);
    expect(bloomWeight(1.25, BLOOM)).toBeCloseTo(0.5, 6);
    expect(bloomWeight(2, BLOOM)).toBe(1);
    const step = { threshold: 1, smoothWidth: 0 };
    expect(bloomClass(1, step)).toBe(BLOOM_CLASS_BELOW);
    expect(bloomClass(1.0001, step)).toBe(BLOOM_CLASS_ABOVE);
    expect(bloomWeight(1.0001, step)).toBe(1);
  });

  it('counts classes and luminance stats over a frame', () => {
    const planes = classifyLuminance(
      { width: 3, height: 1, rgb: new Float32Array([0, 0, 0, 1.2, 1.2, 1.2, 4, 4, 4]) },
      BLOOM,
    );
    expect(Array.from(planes.bloomClass)).toEqual([0, 1, 2]);
    expect(planes.evCode[0]).toBe(0);
    expect(planes.stats.counts).toEqual({ below: 1, knee: 1, above: 1 });
    expect(planes.stats.max).toBeCloseTo(4, 5);
    expect(planes.stats.bloomFraction).toBeCloseTo(2 / 3, 6);
  });

  it('reads Camera bloom fields with the Camera schema defaults', () => {
    expect(bloomSettingsFromCamera({})).toEqual({
      enabled: false,
      threshold: -1,
      smoothWidth: 0.01,
      intensity: 0.5,
    });
    expect(bloomSettingsFromCamera({ bloom: 1, bloomThreshold: 0.8 }).threshold).toBe(0.8);
  });
});
