import { expect, it } from 'vitest';
import { ssrCoordinateErrors } from './ssr-gpu-dispatch';

it('checks continuous mirror-hit UVs and rejects nearest-texel quantization', () => {
  // Receiver (32.5, 16.5) in the 64x32 analytical mirror fixture hits
  // UV (0.6409469116, 0.5203439343). The source is a linear UV ramp.
  // Hit colours are stored weighted by 1/(1+luma) like the production trace.
  const words = Array<number>(64 * 32 * 4).fill(0);
  const offset = (16 * 64 + 32) * 4;
  words.splice(offset, 4, 14029, 13701, 0, 0x3c00);
  const continuous = ssrCoordinateErrors(words);
  expect(continuous).toHaveLength(1);
  expect(continuous[0]).toBeLessThan(0.0003);

  // The nearest texel instead encodes UV (0.6484375, 0.515625).
  words.splice(offset, 4, 14051, 13690, 0, 0x3c00);
  expect(ssrCoordinateErrors(words)[0]).toBeGreaterThan(0.007);
});

it('retains partial wall footprints and rejects back-facing receiver contamination', () => {
  const words = Array<number>(64 * 32 * 4).fill(0);
  const offset = (16 * 64 + 38) * 4;
  // Only column 39 covers the wall at this hit; column 38 is the receiver.
  words.splice(offset, 4, 13973, 13697, 0, 0x3800);
  expect(ssrCoordinateErrors(words)).toHaveLength(1);
  expect(ssrCoordinateErrors(words)[0]).toBeLessThan(0.0003);
  words.splice(offset, 4, 13397, 13195, 0, 0x3800);
  expect(ssrCoordinateErrors(words)[0]).toBeGreaterThan(0.25);
});
