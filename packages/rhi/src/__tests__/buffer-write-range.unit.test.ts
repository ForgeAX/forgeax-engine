import { expect, it } from 'vitest';
import { bufferWriteRange } from '../buffer-write-range';

it.each([
  [new Uint8Array(16), 4, 8, 4, 8],
  [new Uint16Array(8), 2, 4, 4, 8],
  [new Int32Array(4), 1, 2, 4, 8],
  [new Float32Array(4), 1, undefined, 4, 12],
  [new Float64Array(4), 1, 2, 8, 16],
  [new BigInt64Array(4), 1, 2, 8, 16],
  [new DataView(new ArrayBuffer(32), 8, 16), 4, 8, 4, 8],
  [new ArrayBuffer(16), 4, undefined, 4, 12],
] as const)('resolves source units for %s', (data, offset, size, byteOffset, byteLength) => {
  expect(bufferWriteRange(data, offset, size).unwrap()).toEqual({ byteOffset, byteLength });
});

it.each([
  [-1, 1],
  [0.5, 1],
  [0, -1],
  [0, 1.5],
  [3, 2],
  [5, 0],
  [Number.NaN, 1],
  [0, Number.POSITIVE_INFINITY],
] as const)('rejects invalid element range %s, %s', (offset, size) => {
  expect(bufferWriteRange(new Uint32Array(4), offset, size).ok).toBe(false);
});

it('requires a multiple of four bytes and preserves a zero-length end range', () => {
  expect(bufferWriteRange(new Uint8Array(16), 0, 3).ok).toBe(false);
  expect(bufferWriteRange(new Uint32Array(4), 4, 0).unwrap()).toEqual({
    byteOffset: 16,
    byteLength: 0,
  });
});
