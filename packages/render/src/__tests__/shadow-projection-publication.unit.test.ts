import { expect, it } from 'vitest';
import type { GpuDrivenBatch, SubmissionPlan } from '../gpu-driven/batch-topology';
import {
  publishReadonlyMap,
  sameShadowProjectionLayout,
} from '../gpu-driven/shadow-projection-publication';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

it('publishes one read-only capability without exposing its owned map through iteration callbacks', () => {
  const value = { resource: 'first' };
  const publication = publishReadonlyMap(new Map([[7, value]]));
  expect(publication.get(7)).toBe(value);
  expect([...publication]).toEqual([[7, value]]);
  expect([...publication.entries()]).toEqual([[7, value]]);
  expect([...publication.keys()]).toEqual([7]);
  expect([...publication.values()]).toEqual([value]);
  expect(publication.has(7)).toBe(true);
  expect(publication.size).toBe(1);
  expect(Object.isFrozen(publication)).toBe(true);
  for (const method of ['set', 'delete', 'clear'])
    expect(Reflect.get(publication, method)).toBeUndefined();
  const receiver = {};
  publication.forEach(function (this: unknown, entry, key, map) {
    expect(this).toBe(receiver);
    expect(map).toBe(publication);
    expect(entry).toBe(value);
    expect(key).toBe(7);
  }, receiver);
});

it('retains exactly equal draw layout across new plans but rejects same-count membership and resource changes', () => {
  const fixture = createFilterPlanFixture();
  const source = fixture.prepare().source;
  const batch = source.batches.at(0);
  if (batch === undefined || batch.candidates.length === 0) throw Error('missing batch');
  const rewrap = (replacement: GpuDrivenBatch): SubmissionPlan => ({
    ...source,
    revision: source.revision + 1,
    batches: [replacement, ...source.batches.slice(1)],
  });
  const cloned = { ...batch, candidates: batch.candidates.map((candidate) => ({ ...candidate })) };
  expect(sameShadowProjectionLayout(source, rewrap(cloned))).toBe(true);
  for (const field of [
    'primitiveIndex',
    'generation',
    'drawItemIndex',
    'instanceOrdinal',
  ] as const) {
    const candidates = cloned.candidates.map((candidate, index) =>
      index === cloned.candidates.length - 1
        ? { ...candidate, [field]: candidate[field] + 1 }
        : candidate,
    );
    expect(sameShadowProjectionLayout(source, rewrap({ ...cloned, candidates }))).toBe(false);
  }
  for (const field of [
    'batchId',
    'generation',
    'contentEpoch',
    'visibleBase',
    'indirectOffset',
  ] as const) {
    expect(
      sameShadowProjectionLayout(source, rewrap({ ...cloned, [field]: cloned[field] + 1 })),
    ).toBe(false);
  }
  expect(
    sameShadowProjectionLayout(
      source,
      rewrap({ ...cloned, visibleAllocationCapacity: batch.visibleCapacity + 1 }),
    ),
  ).toBe(false);
  expect(sameShadowProjectionLayout(source, rewrap({ ...cloned, key: { ...batch.key } }))).toBe(
    false,
  );
  expect(
    sameShadowProjectionLayout(
      source,
      rewrap({ ...cloned, candidates: cloned.candidates.slice(1) }),
    ),
  ).toBe(false);
  expect(sameShadowProjectionLayout(source, { ...source, batches: source.batches.slice(1) })).toBe(
    false,
  );
});

it('publishes independent owned maps while preserving ordered values', () => {
  const a = {},
    b = {};
  const first = publishReadonlyMap(
    new Map([
      [1, a],
      [2, b],
    ]),
  );
  expect(
    publishReadonlyMap(
      new Map([
        [1, a],
        [2, b],
      ]),
    ),
  ).not.toBe(first);
  const reordered = publishReadonlyMap(
    new Map([
      [2, b],
      [1, a],
    ]),
  );
  expect(reordered).not.toBe(first);
  expect([...reordered.keys()]).toEqual([2, 1]);
  const changed = publishReadonlyMap(
    new Map([
      [1, b],
      [2, b],
    ]),
  );
  expect(changed).not.toBe(first);
  expect(first.get(1)).toBe(a);
  const borrowed = new Map([
    [1, a],
    [2, b],
  ]);
  const wrapped = publishReadonlyMap(new Map(borrowed));
  expect(wrapped).not.toBe(borrowed);
  expect(Reflect.get(wrapped, 'set')).toBeUndefined();
});

it('distinguishes missing keys from undefined values and preserves detached readers', () => {
  const first = publishReadonlyMap(new Map([[1, undefined]]));
  const changed = publishReadonlyMap(new Map([[2, undefined]]));
  expect(changed).not.toBe(first);
  const { get, has, keys, entries } = first;
  expect(get(1)).toBeUndefined();
  expect(has(1)).toBe(true);
  expect(has(2)).toBe(false);
  expect([...keys()]).toEqual([1]);
  expect([...entries()]).toEqual([[1, undefined]]);
  const nan = publishReadonlyMap(new Map([[1, Number.NaN]]));
  const repeated = publishReadonlyMap(new Map([[1, Number.NaN]]));
  expect(repeated).not.toBe(nan);
  expect(Number.isNaN(repeated.get(1))).toBe(true);
  expect(Number.isNaN(nan.get(1))).toBe(true);
  const positive = publishReadonlyMap(new Map([[1, 0]]));
  const negative = publishReadonlyMap(new Map([[1, -0]]));
  expect(Object.is(negative.get(1), -0)).toBe(true);
  expect(Object.is(positive.get(1), 0)).toBe(true);
});
