import { describe, expect, it } from 'vitest';
import { bradfordAdaptD65 } from '../pipeline/standard-output/auto-exposure/oracle';
import {
  applyStandardWhiteBalance,
  sampleStandardColorLut,
} from '../pipeline/standard-output/color-transform';

describe('Standard output chain integration', () => {
  it('keeps manual D65 and strength zero as exact identity operations', () => {
    expect(applyStandardWhiteBalance([0.2, 0.4, 0.8], 6504, 0)).toEqual([0.2, 0.4, 0.8]);
    const identityLut = new Float32Array(2 * 2 * 2 * 4);
    for (let index = 0; index < identityLut.length; index += 4) {
      identityLut[index] = 0.8;
      identityLut[index + 1] = 0.1;
      identityLut[index + 2] = 0.2;
      identityLut[index + 3] = 0.35;
    }
    expect(sampleStandardColorLut({ size: 2, data: identityLut }, [0.2, 0.4, 0.8], 0, 0.7)).toEqual(
      [0.2, 0.4, 0.8, 0.7],
    );
  });

  it('matches the Bradford oracle and tint semantics for a non-neutral camera', () => {
    const rgb: [number, number, number] = [0.2, 0.4, 0.8];
    const adapted = bradfordAdaptD65(rgb, 5000);
    const actual = applyStandardWhiteBalance(rgb, 5000, 0.2);
    expect(actual[0]).toBeCloseTo(adapted[0] * 1.2, 6);
    expect(actual[1]).toBeCloseTo(adapted[1] * 0.8, 6);
    expect(actual[2]).toBeCloseTo(adapted[2] * 1.2, 6);
    expect(actual).not.toEqual(rgb);
  });

  it('treats an identity display LUT as identity, darks included', () => {
    // UE PostProcessCombineLUTs.usf:200-202: sRGB-encoded index at texel centres.
    const size = 32;
    const lut = new Float32Array(size ** 3 * 4);
    for (let z = 0; z < size; z += 1)
      for (let y = 0; y < size; y += 1)
        for (let x = 0; x < size; x += 1)
          lut.set(
            [x / (size - 1), y / (size - 1), z / (size - 1), 1],
            ((z * size + y) * size + x) * 4,
          );
    for (const value of [0.001, 0.01, 0.18, 0.5, 1]) {
      const sampled = sampleStandardColorLut({ size, data: lut }, [value, value, value]);
      expect(sampled[0]).toBeCloseTo(value, 4);
    }
  });

  it('preserves LUT alpha while applying RGB strength', () => {
    const lut = new Float32Array(2 * 2 * 2 * 4).fill(0);
    for (let index = 0; index < lut.length; index += 4) {
      lut[index] = 1;
      lut[index + 1] = 0.5;
      lut[index + 2] = 0.25;
      lut[index + 3] = 0.1;
    }
    const sampled = sampleStandardColorLut({ size: 2, data: lut }, [0.2, 0.4, 0.8], 0.5, 0.9);
    // LUT texels are sRGB-encoded: 1, 0.5, 0.25 decode to 1, 0.2140, 0.0508.
    expect(sampled[0]).toBeCloseTo(0.6);
    expect(sampled[1]).toBeCloseTo(0.307, 3);
    expect(sampled[2]).toBeCloseTo(0.4254, 3);
    expect(sampled[3]).toBe(0.9);
  });
});
