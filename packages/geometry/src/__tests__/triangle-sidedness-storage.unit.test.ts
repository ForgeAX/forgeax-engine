import { expect, it } from 'vitest';
import {
  packTriangleSidedness,
  triangleSidednessAt,
  validateTriangleSidedness,
} from '../triangle-sidedness-storage';

it('roundtrips every source bit including bit31, word boundaries and the empty span', () => {
  for (const count of [0, 1, 31, 32, 33, 63, 64, 65]) {
    const flags = Uint8Array.from({ length: count }, (_, i) =>
      Number(i % 3 === 1 || i === 31 || i === 63),
    );
    const words = packTriangleSidedness(flags).unwrap();
    expect(validateTriangleSidedness(words, count).ok).toBe(true);
    for (let i = 0; i < count; i++)
      expect(triangleSidednessAt(words, count, i).unwrap()).toBe(flags[i]);
  }
  expect(
    packTriangleSidedness(Uint8Array.from({ length: 32 }, (_, i) => Number(i === 31))).unwrap()[0],
  ).toBe(0x80000000);
});
it('rejects invalid source values, nonzero tail bits, truncated spans and out-of-range access', () => {
  for (const flag of [-1, 2, NaN, Infinity, 0.5])
    expect(packTriangleSidedness([flag]).ok).toBe(false);
  expect(packTriangleSidedness({ length: 1.5 }).ok).toBe(false);
  expect(validateTriangleSidedness(new Uint32Array([0x80000000]), 1).ok).toBe(false);
  expect(validateTriangleSidedness(new Uint32Array([0]), 33).ok).toBe(false);
  expect(validateTriangleSidedness(new Uint32Array([0]), 0).ok).toBe(false);
  for (const index of [-1, 1, 0.5, NaN])
    expect(triangleSidednessAt(new Uint32Array([0]), 1, index).ok).toBe(false);
});
