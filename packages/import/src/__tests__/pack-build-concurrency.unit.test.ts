import { expect, it } from 'vitest';
import { packBuildConcurrency } from '../pack-build-concurrency.js';

it('bounds Pack lanes by CPU, heap headroom, free memory and the explicit serial override', () => {
  const GiB = 1024 ** 3;
  const room = {
    parallelism: 16,
    freeBytes: 64 * GiB,
    heapHeadroomBytes: 8 * GiB,
    concurrentCookers: true,
  };
  expect(packBuildConcurrency(room)).toBe(2);
  expect(packBuildConcurrency({ ...room, concurrentCookers: false })).toBe(1);
  expect(packBuildConcurrency({ ...room, parallelism: 1 })).toBe(1);
  expect(packBuildConcurrency({ ...room, freeBytes: 3 * GiB })).toBe(1);
  expect(packBuildConcurrency({ ...room, heapHeadroomBytes: 3 * GiB })).toBe(1);
  expect(packBuildConcurrency(room, '1')).toBe(1);
  for (const requested of ['', '0', '3', 'NaN', '1.5'])
    expect(() => packBuildConcurrency(room, requested)).toThrow(RangeError);
});
