import type { SdfPlacementBounds } from '../../raytracing/sdf-transform-certificate';
import {
  compare,
  coordinate,
  difference,
  type ExactVector,
  rational,
  transformed,
} from './exact-affine.fixture';

type R = ReturnType<typeof rational>;
export interface PlacementRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly first: number;
  readonly last: number;
}

/** Independent corner enumeration, unlike the producer's signed range sum. */
export function placementCorners(forward: ArrayLike<number>, box: SdfPlacementBounds) {
  const points: ExactVector[] = [];
  for (let bits = 0; bits < 8; bits++) {
    const point = [0, 1, 2].map((axis) =>
      rational((bits & (1 << axis) ? box.max : box.min)[axis] ?? NaN),
    );
    points.push(transformed(forward, point as unknown as ExactVector));
  }
  return points;
}

export function envelopeContains(envelope: SdfPlacementBounds, points: readonly ExactVector[]) {
  return points.every((point) =>
    [0, 1, 2].every(
      (axis) =>
        compare(rational(envelope.min[axis] ?? NaN), coordinate(point, axis)) <= 0n &&
        compare(rational(envelope.max[axis] ?? NaN), coordinate(point, axis)) >= 0n,
    ),
  );
}

function ratio(a: R, b: R): R {
  const numerator = a[0] * b[1],
    denominator = a[1] * b[0];
  if (!denominator) throw Error('Exact parallel slab must be handled before division');
  return denominator < 0n ? [-numerator, -denominator] : [numerator, denominator];
}

/** Exact closed segment, including parallel axes and both endpoints. */
export function segmentIntersectsBox(ray: PlacementRay, box: SdfPlacementBounds) {
  let first = rational(ray.first),
    last = rational(ray.last);
  if (compare(first, last) > 0n) throw Error('Ordered authored segment required');
  for (let axis = 0; axis < 3; axis++) {
    const origin = rational(ray.origin[axis] ?? NaN),
      direction = rational(ray.direction[axis] ?? NaN),
      lo = rational(box.min[axis] ?? NaN),
      hi = rational(box.max[axis] ?? NaN);
    if (direction[0] === 0n) {
      if (compare(origin, lo) < 0n || compare(origin, hi) > 0n) return false;
      continue;
    }
    let a = ratio(difference(lo, origin), direction),
      b = ratio(difference(hi, origin), direction);
    if (compare(a, b) > 0n) [a, b] = [b, a];
    if (compare(a, first) > 0n) first = a;
    if (compare(b, last) < 0n) last = b;
    if (compare(first, last) > 0n) return false;
  }
  return true;
}

export const authoredMissingBounds: SdfPlacementBounds = {
  min: [-1, -1, -0.125],
  max: [1, 1, 0.125],
};
export const authoredFarWorldBounds: SdfPlacementBounds = {
  min: [3, -1, 2.875],
  max: [5, 1, 3.125],
};

export function placementSegmentCases() {
  const cases: { name: string; ray: PlacementRay; intersects: boolean }[] = [];
  for (const speed of [0.5, 1, 2]) {
    for (const x of [0, 4])
      cases.push({
        name: `far-row-${speed}-${x}`,
        ray: { origin: [x, 0, 0], direction: [0, 0, speed], first: 0, last: 8 / speed },
        intersects: x === 4,
      });
  }
  cases.push(
    {
      name: 'middle-only',
      ray: { origin: [2, 0, 3], direction: [1, 0, 0], first: 0, last: 4 },
      intersects: true,
    },
    {
      name: 'closed-endpoint',
      ray: { origin: [2, 0, 3], direction: [1, 0, 0], first: 0, last: 1 },
      intersects: true,
    },
    {
      name: 'before-boundary',
      ray: { origin: [2, 0, 3], direction: [1, 0, 0], first: 0, last: 0.5 },
      intersects: false,
    },
    {
      name: 'parallel-on-boundary',
      ray: { origin: [3, 0, 0], direction: [0, 0, 1], first: 0, last: 8 },
      intersects: true,
    },
    {
      name: 'reverse',
      ray: { origin: [4, 0, 6], direction: [0, 0, -2], first: 0, last: 3 },
      intersects: true,
    },
  );
  return cases;
}
