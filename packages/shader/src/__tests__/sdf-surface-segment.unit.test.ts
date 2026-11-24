import { expect, it } from 'vitest';
import { SDF_SURFACE_SEGMENT_BOX_CLEAR_WGSL } from '../sdf-surface-root-request-wgsl';
import { segmentBits as bits, segmentControl, segmentRay } from './sdf-surface-segment.fixture';

const box = (lo: number[], hi = lo) => [lo.map(bits), hi.map(bits)] as const;

it('matches the original predicate for bounded dyadic intervals, signed zero and closed endpoints', () => {
  const run = segmentControl();
  for (const x of [-2, -0, 0, 0.5, 2])
    for (const dx of [-2, -0, 0, 0.5, 2]) {
      const ray = segmentRay([x, -x, 0], [dx, 0, -dx]);
      ray.originHi = [x + 0.5, -x + 0.5, 0.5].map(bits);
      ray.directionHi = [dx + 0.5, 0, -dx + 0.5].map(bits);
      const segment = run.prepare(ray);
      for (const bound of [-8, -2, -0, 0, 0.5, 2, 8]) {
        const [lo, hi] = box([bound, bound, bound], [bound + 1, bound + 1, bound + 1]);
        expect(run.clear(segment, lo, hi)).toBe(run.original(ray, lo, hi));
        expect(run.wrapper(ray, lo, hi)).toBe(run.original(ray, lo, hi));
      }
    }
  const ray = segmentRay();
  for (const endpoint of [0, 2]) {
    const [lo, hi] = box([endpoint, 0, 0]);
    expect(run.wrapper(ray, lo, hi)).toBe(false);
  }
  ray.valid = 0;
  const [lo, hi] = box([8, 0, 0]);
  expect(run.wrapper(ray, lo, hi)).toBe(true); // The public wrapper never inspected this flag.
});

it('rejects a whole invalid ray or bounds even when another axis could separate', () => {
  const run = segmentControl();
  const [lo, hi] = box([8, 8, 8]);
  for (const field of ['originLo', 'originHi', 'directionLo', 'directionHi'] as const)
    for (const axis of [0, 1, 2])
      for (const invalid of [0x7fc00001, 0x7f800000, 0xff800000, 1]) {
        const ray = segmentRay();
        ray[field][axis] = invalid;
        expect(run.clear(run.prepare(ray), lo, hi)).toBe(false);
        expect(run.wrapper(ray, lo, hi)).toBe(run.original(ray, lo, hi));
      }
  for (const axis of [0, 1, 2]) {
    const invalidLo = [...lo];
    invalidLo[axis] = bits(9);
    expect(run.wrapper(segmentRay(), invalidLo, hi)).toBe(false);
    const ray = segmentRay();
    ray.originLo[axis] = bits(1);
    expect(run.wrapper(ray, lo, hi)).toBe(false);
    for (const invalid of [0x7fc00001, 0x7f800000, 1]) {
      for (const endpoint of ['lo', 'hi'] as const) {
        const invalidLo = [...lo];
        const invalidHi = [...hi];
        (endpoint === 'lo' ? invalidLo : invalidHi)[axis] = invalid;
        expect(run.wrapper(segmentRay(), invalidLo, invalidHi)).toBe(false);
      }
    }
  }
  for (const range of [
    { x: bits(3), y: bits(2) },
    { x: 1, y: bits(2) },
    { x: bits(0), y: 0x7f800000 },
  ]) {
    const ray = segmentRay();
    ray.tRange = range;
    expect(run.wrapper(ray, lo, hi)).toBe(false);
  }
});

it('retains a separating axis when another position overflows and preserves multiply-before-add', () => {
  const run = segmentControl();
  for (const axis of [0, 1, 2]) {
    const direction = [0, 0, 0];
    direction[axis] = 3.4028234663852886e38;
    const ray = segmentRay([0, 0, 0], direction);
    const [lo, hi] = box([8, 8, 8]);
    expect(run.clear(run.prepare(ray), lo, hi)).toBe(true);
    expect(run.wrapper(ray, lo, hi)).toBe(run.original(ray, lo, hi));
    ray.originLo = direction.map(bits);
    ray.originHi = direction.map(bits);
    ray.tRange = { x: bits(1), y: bits(1) };
    expect(run.wrapper(ray, lo, hi)).toBe(true);
  }
  const mutant = SDF_SURFACE_SEGMENT_BOX_CLEAR_WGSL.replace(
    'sdfIntervalAdd(origin.axis[axis],sdfIntervalMultiply(direction.axis[axis],time))',
    'sdfIntervalMultiply(sdfIntervalAdd(origin.axis[axis],direction.axis[axis]),time)',
  );
  const ray = segmentRay([2, 0, 0]);
  ray.tRange = { x: bits(2), y: bits(2) };
  const [lo, hi] = box([4, 0, 0]);
  expect(run.wrapper(ray, lo, hi)).toBe(false);
  expect(segmentControl(mutant).wrapper(ray, lo, hi)).toBe(true);
});

it('reuses only the current row enclosure, rereads every bound, and adds no interval work per box', () => {
  const run = segmentControl();
  const ray = segmentRay();
  const segment = run.prepare(ray);
  expect(run.operations).toEqual({ multiply: 3, add: 3 });
  for (const bound of [8, 0, 2, -8]) {
    const [lo, hi] = box([bound, 0, 0]);
    expect(run.clear(segment, lo, hi)).toBe(bound === 8 || bound === -8);
  }
  expect(run.operations).toEqual({ multiply: 3, add: 3 });
  const nextRay = segmentRay([8, 0, 0]);
  const [lo, hi] = box([8, 0, 0]);
  expect(run.clear(run.prepare(nextRay), lo, hi)).toBe(false);
  expect(run.clear(segment, lo, hi)).toBe(true); // A stale-row mutant is observable.
  const touching = SDF_SURFACE_SEGMENT_BOX_CLEAR_WGSL.replace(
    'position.hi<bounds.axis[axis].lo',
    'position.hi<=bounds.axis[axis].lo',
  );
  const [endLo, endHi] = box([2, 0, 0]);
  expect(segmentControl(touching).wrapper(ray, endLo, endHi)).toBe(true);
  expect(run.wrapper(ray, endLo, endHi)).toBe(false);
});
