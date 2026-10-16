import { expect, it } from 'vitest';
import { ssrCoordinateErrors } from './ssr-gpu-dispatch';

it('checks continuous mirror-hit UVs and rejects nearest-texel quantization', () => {
  // Receiver (32.5, 16.5) in the 64x32 analytical mirror fixture hits
  // UV (0.6409469116, 0.5203439343). The source is a linear UV ramp.
  const words = Array<number>(64 * 16 * 4).fill(0);
  const offset = (8 * 64 + 16) * 4;
  words.splice(offset, 4, 14625, 14378, 0, 0x3c00);
  const continuous = ssrCoordinateErrors(words);
  expect(continuous).toHaveLength(1);
  expect(continuous[0]).toBeLessThan(0.0003);

  // The nearest texel instead encodes UV (0.6484375, 0.515625).
  words.splice(offset, 4, 14640, 14368, 0, 0x3c00);
  expect(ssrCoordinateErrors(words)[0]).toBeGreaterThan(0.007);
});

it('retains partial wall footprints and rejects back-facing receiver contamination', () => {
  const words = Array<number>(64 * 16 * 4).fill(0);
  const offset = (8 * 64 + 19) * 4;
  // Only column 39 covers the wall at this hit; column 38 is the receiver.
  words.splice(offset, 4, 14576, 14369, 0, 0x3800);
  expect(ssrCoordinateErrors(words)).toHaveLength(1);
  expect(ssrCoordinateErrors(words)[0]).toBeLessThan(0.0003);
  words.splice(offset, 4, 13721, 13536, 0, 0x3800);
  expect(ssrCoordinateErrors(words)[0]).toBeGreaterThan(0.25);
});
