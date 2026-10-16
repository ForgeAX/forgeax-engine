import { describe, expect, it } from 'vitest';
import { summarizeCapturePixels } from '../software-capture.js';

describe('summarizeCapturePixels', () => {
  it('rejects a structurally valid uniform black frame', () => {
    const rgba = new Uint8Array(16 * 16 * 4);
    rgba.fill(6);
    for (let alpha = 3; alpha < rgba.length; alpha += 4) rgba[alpha] = 255;
    expect(summarizeCapturePixels(rgba, 16, 16)).toMatchObject({
      lumaMin: 6,
      lumaMax: 6,
      lumaRange: 0,
      varyingPixels: 0,
      rendered: false,
    });
  });

  it('accepts a bounded scene and UI colour range', () => {
    const rgba = new Uint8Array(16 * 16 * 4);
    for (let pixel = 0; pixel < 16 * 16; pixel += 1) {
      const offset = pixel * 4;
      const value = pixel < 128 ? 24 : 220;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
    expect(summarizeCapturePixels(rgba, 16, 16)).toMatchObject({
      lumaMin: 24,
      lumaMax: 220,
      lumaRange: 196,
      varyingPixels: 128,
      rendered: true,
    });
  });
});
