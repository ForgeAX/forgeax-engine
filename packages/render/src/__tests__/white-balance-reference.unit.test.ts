import { describe, expect, it } from 'vitest';
import { applyStandardWhiteBalance } from '../pipeline/standard-output/color-transform';
import { whiteBalanceCases } from './white-balance-reference.fixture';

describe('linear sRGB white balance reference', () => {
  for (const sample of whiteBalanceCases) {
    it(sample.name, () => {
      const rgb = sample.rgb.map((value) => value * sample.exposure) as [number, number, number];
      const actual = applyStandardWhiteBalance(rgb, sample.temperature, sample.tint);
      for (const [channel, expected] of sample.expected.entries()) {
        expect(actual[channel]).toBeCloseTo(expected, 5);
      }
    });
  }
});
