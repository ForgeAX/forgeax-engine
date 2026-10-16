import { describe, expect, it } from 'vitest';
import {
  linearChannelToSrgb,
  materialValuesToLinearRuntime,
  srgbChannelToLinear,
} from '../index.js';
import { authoredColorToLinear } from '../material/color-space.js';

describe('material color-space contract', () => {
  it('implements the IEC 61966-2-1 transfer-function breakpoints', () => {
    expect(srgbChannelToLinear(0.04045)).toBeCloseTo(0.0031308, 7);
    expect(linearChannelToSrgb(0.0031308)).toBeCloseTo(0.04045, 5);
    expect(srgbChannelToLinear(0.5)).toBeCloseTo(0.2140411405, 9);
  });

  it('round-trips every 8-bit sRGB channel within half an LSB', () => {
    for (let byte = 0; byte <= 255; byte += 1) {
      const encoded = byte / 255;
      const roundTrip = linearChannelToSrgb(srgbChannelToLinear(encoded));
      expect(Math.abs(roundTrip - encoded) * 255).toBeLessThanOrEqual(0.5);
    }
  });

  it('decodes RGB while preserving alpha and extra data lanes', () => {
    const runtime = authoredColorToLinear([0.5, 0.25, 0.04045, 0.37, 9]);
    expect(runtime[0]).toBeCloseTo(0.2140411405, 9);
    expect(runtime[1]).toBeCloseTo(0.0508760882, 9);
    expect(runtime[2]).toBeCloseTo(0.0031308, 7);
    expect(runtime[3]).toBe(0.37);
    expect(runtime[4]).toBe(9);
  });

  it('defaults authored color parameters to sRGB without mutating asset values', () => {
    const authored = { baseColor: [0.5, 0.25, 0.75, 0.4], roughness: 0.5 } as const;
    const runtime = materialValuesToLinearRuntime(authored, [
      { name: 'baseColor', type: 'color' },
      { name: 'roughness', type: 'f32' },
    ]);

    expect(runtime.baseColor).toEqual([
      srgbChannelToLinear(0.5),
      srgbChannelToLinear(0.25),
      srgbChannelToLinear(0.75),
      0.4,
    ]);
    expect(runtime.roughness).toBe(0.5);
    expect(authored.baseColor).toEqual([0.5, 0.25, 0.75, 0.4]);
  });

  it('honors an explicit linear MaterialAsset override', () => {
    const authored = { baseColor: [0.5, 0.25, 0.75, 0.4] } as const;
    const runtime = materialValuesToLinearRuntime(
      authored,
      [{ name: 'baseColor', type: 'color' }],
      'linear',
    );
    expect(runtime.baseColor).toEqual(authored.baseColor);
    expect(runtime.baseColor).not.toBe(authored.baseColor);
  });

  it('lets an explicit MaterialAsset color space override inherited parameter metadata', () => {
    const authored = { baseColor: [0.5, 0.25, 0.75, 0.4] } as const;
    const runtime = materialValuesToLinearRuntime(
      authored,
      [{ name: 'baseColor', type: 'color', colorSpace: 'srgb' }],
      'linear',
    );
    expect(runtime.baseColor).toEqual(authored.baseColor);
  });

  it('only treats numeric vectors as colors when their schema says so', () => {
    const runtime = materialValuesToLinearRuntime(
      { emissive: [0.5, 0.25, 0.75], uvScale: [0.5, 0.25] },
      [
        { name: 'emissive', type: 'vec3', colorSpace: 'srgb' },
        { name: 'uvScale', type: 'vec2' },
      ],
    );
    expect(runtime.emissive).toEqual([
      srgbChannelToLinear(0.5),
      srgbChannelToLinear(0.25),
      srgbChannelToLinear(0.75),
    ]);
    expect(runtime.uvScale).toEqual([0.5, 0.25]);
  });
});
