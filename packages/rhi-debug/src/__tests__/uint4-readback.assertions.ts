import { expect } from 'vitest';
import type { verifyUint4Readback } from './uint4-readback.fixture';

export function assertUint4Readback(result: Awaited<ReturnType<typeof verifyUint4Readback>>) {
  if (result.status !== 'available') throw new Error(result.reason);
  expect(result.before).toMatchObject({ format: 'rgba32uint', width: 4, height: 2 });
  const words = (bytes: Uint8Array) => [
    ...new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
  ];
  const initial = [0xf0000000, 0xffffffff, 0x5912296b, 3];
  const replaced = [0xf0000001, 0xfffffffe, 0x5912296b, 3];
  const empty = [0, 0, 0, 0];
  expect(words(result.before.bytes)).toEqual([
    ...initial,
    ...empty,
    ...initial,
    ...initial,
    ...initial,
    ...empty,
    ...initial,
    ...initial,
  ]);
  expect(words(result.after.bytes)).toEqual([
    ...initial,
    ...empty,
    ...replaced,
    ...replaced,
    ...initial,
    ...empty,
    ...initial,
    ...initial,
  ]);
  expect(result.live).toEqual(result.after.bytes);
}
