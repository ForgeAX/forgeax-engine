import { expect, it } from 'vitest';
import type { DispatchEntry } from '../../render-system-extract';
import { buildFoldDispatchPlan, type FoldBucket } from '../mesh-ssbo';

function bucket(count: number): FoldBucket {
  return {
    entries: Array.from(
      { length: count },
      (_, renderableIndex) => ({ renderableIndex }) as DispatchEntry,
    ),
    bucketSize: count,
    transforms: new Float32Array(count * 16),
    materialHandle: 1,
    layer: 0,
    sortKey: 0,
  };
}

it.each([
  0, 1, 128, 129, 256, 257, 10000,
])('admits every member of a %i-instance run through bounded pages', (count) => {
  const source = bucket(count);
  const indices = new Map(Array.from({ length: count }, (_, index) => [index, index]));
  const plan = buildFoldDispatchPlan([source], indices, 128);
  expect([...plan.headBuckets.values()].every((page) => page.bucketSize <= 128)).toBe(true);
  expect(plan.headBuckets.size + plan.skipIndices.size).toBe(count - (count % 128 === 1 ? 1 : 0));
  expect(plan.foldedBucketCount).toBe(plan.headBuckets.size);
});

it('keeps the original native storage run and detached transform owner', () => {
  const source = bucket(10000);
  const indices = new Map(
    source.entries.map((entry) => [entry.renderableIndex, entry.renderableIndex]),
  );
  const plan = buildFoldDispatchPlan([source], indices);
  expect(plan.headBuckets.get(0)).toBe(source);
  expect(plan.skipIndices.size).toBe(9999);
});

it.each([0, 1, 1.5, Number.NaN])('rejects invalid physical page capacity %s', (capacity) => {
  expect(() => buildFoldDispatchPlan([], new Map(), capacity)).toThrow(RangeError);
});
