import { mkdirSync, writeFileSync } from 'node:fs';
import type { FieldVec3 } from '@forgeax/engine-types';
import { afterAll, expect, it } from 'vitest';
import {
  cappedDistanceSampleError,
  distanceBoxBandLimit,
  distanceBoxOutsideBand,
  triangleDistanceInterval,
} from '../triangle-distance-interval';
import {
  createTriangleQuery,
  type QueryTriangle,
  type TriangleNearestWork,
} from '../triangle-query';

// Independent exact rational arithmetic over the actual IEEE input bits. The
// oracle does not call the interval kernel or the existing float BVH query.
type R = readonly [bigint, bigint];
type V = readonly [R, R, R];
const observations: {
  name: string;
  lower: number | string;
  upper: number | string;
  exactSquared: readonly string[];
  contains: boolean;
}[] = [];
afterAll(() => {
  const directory = process.env.FORGEAX_INTERVAL_ARTIFACTS;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${directory}/primitive-intervals.json`,
    JSON.stringify(
      {
        scope:
          'CPU primitive and capped nearest BVH enclosures against exact rational source bits; not producer, Global composition, GPU or GI acceptance',
        observations,
      },
      null,
      2,
    ),
  );
});
const ZERO: R = [0n, 1n],
  ONE: R = [1n, 1n];
function fraction(n: bigint, d: bigint): R {
  if (d === 0n) throw Error('Exact oracle denominator is zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b !== 0n) {
    const r = a % b;
    a = b;
    b = r;
  }
  return [n / a, d / a];
}
const plus = (a: R, b: R) => fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const minus = (a: R, b: R) => plus(a, [-b[0], b[1]]);
const times = (a: R, b: R) => fraction(a[0] * b[0], a[1] * b[1]);
const over = (a: R, b: R) => fraction(a[0] * b[1], a[1] * b[0]);
const compare = (a: R, b: R) => a[0] * b[1] - b[0] * a[1];
function rational(value: number): R {
  if (!Number.isFinite(value)) throw Error('Finite oracle input required');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  const bits = view.getBigUint64(0, true),
    exponent = Number((bits >> 52n) & 2047n);
  const mantissa = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const power = exponent ? exponent - 1075 : -1074,
    sign = bits >> 63n ? -1n : 1n;
  return power >= 0
    ? fraction(sign * (mantissa << BigInt(power)), 1n)
    : fraction(sign * mantissa, 1n << BigInt(-power));
}
const vector = (p: FieldVec3): V => [rational(p[0]), rational(p[1]), rational(p[2])];
const subtract = (a: V, b: V): V => [minus(a[0], b[0]), minus(a[1], b[1]), minus(a[2], b[2])];
const scale = (a: V, t: R): V => [times(a[0], t), times(a[1], t), times(a[2], t)];
const dot = (a: V, b: V) => plus(plus(times(a[0], b[0]), times(a[1], b[1])), times(a[2], b[2]));
const cross = (a: V, b: V): V => [
  minus(times(a[1], b[2]), times(a[2], b[1])),
  minus(times(a[2], b[0]), times(a[0], b[2])),
  minus(times(a[0], b[1]), times(a[1], b[0])),
];

function edgeDistance(p: V, a: V, b: V) {
  const e = subtract(b, a),
    ap = subtract(p, a),
    length = dot(e, e);
  let t = length[0] === 0n ? ZERO : over(dot(ap, e), length);
  if (compare(t, ZERO) < 0n) t = ZERO;
  if (compare(t, ONE) > 0n) t = ONE;
  const d = subtract(ap, scale(e, t));
  return dot(d, d);
}
function exactSquared(point: FieldVec3, triangle: QueryTriangle): R {
  const p = vector(point),
    a = vector(triangle[0]),
    b = vector(triangle[1]),
    c = vector(triangle[2]);
  const candidates = [edgeDistance(p, a, b), edgeDistance(p, b, c), edgeDistance(p, c, a)];
  const ab = subtract(b, a),
    ac = subtract(c, a),
    n = cross(ab, ac),
    denominator = dot(n, n);
  if (denominator[0] !== 0n) {
    const ap = subtract(p, a),
      height = dot(ap, n),
      projection = subtract(ap, scale(n, over(height, denominator)));
    const u = over(dot(cross(projection, ac), n), denominator),
      v = over(dot(cross(ab, projection), n), denominator);
    if (compare(u, ZERO) >= 0n && compare(v, ZERO) >= 0n && compare(plus(u, v), ONE) <= 0n)
      candidates.push(over(times(height, height), denominator));
  }
  return candidates.reduce((a, b) => (compare(a, b) <= 0n ? a : b));
}
function contains(lower: number, upper: number, squared: R) {
  const result =
    lower >= 0 &&
    upper >= lower &&
    compare(times(rational(lower), rational(lower)), squared) <= 0n &&
    (upper === Infinity || compare(times(rational(upper), rational(upper)), squared) >= 0n);
  observations.push({
    name: expect.getState().currentTestName ?? 'unnamed',
    lower: Number.isFinite(lower) ? lower : String(lower),
    upper: Number.isFinite(upper) ? upper : String(upper),
    exactSquared: squared.map(String),
    contains: result,
  });
  return result;
}

it('encloses exact rational nearest distance across face, edge, vertex and degenerate cases', () => {
  const triangles: QueryTriangle[] = [
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 2 ** -70, 0],
    ],
  ];
  let tested = 0;
  for (const triangle of triangles)
    for (let x = -2; x <= 3; x++)
      for (let y = -2; y <= 3; y++) {
        const p: FieldVec3 = [x / 4, y / 4, (x - y) / 8];
        const result = triangleDistanceInterval(p, triangle);
        expect(
          contains(result.lower, result.upper, exactSquared(p, triangle)),
          JSON.stringify({ p, triangle, result }),
        ).toBe(true);
        tested++;
      }
  expect(tested).toBe(180);
});

it('retains enclosures at finite f32 scale and translation extremes', () => {
  for (const power of [-120, -40, 0, 40, 100]) {
    const s = 2 ** power;
    const triangle: QueryTriangle = [
      [s, 0, 0],
      [0, s, 0],
      [0, 0, s],
    ];
    const p: FieldVec3 = [s / 8, s / 4, s / 16];
    const result = triangleDistanceInterval(p, triangle);
    expect(contains(result.lower, result.upper, exactSquared(p, triangle))).toBe(true);
  }
  const t = 2 ** 100,
    s = 2 ** 80;
  const triangle: QueryTriangle = [
    [t, t, t],
    [t + s, t, t],
    [t, t + s, t],
  ];
  const p: FieldVec3 = [t + s / 4, t + s / 4, t + s / 8];
  const result = triangleDistanceInterval(p, triangle);
  expect(contains(result.lower, result.upper, exactSquared(p, triangle))).toBe(true);
});

it('certifies a nontrivial finite lower and upper bound for a well-conditioned face', () => {
  const triangle: QueryTriangle = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    point: FieldVec3 = [0, 0, 0];
  const result = triangleDistanceInterval(point, triangle);
  expect(contains(result.lower, result.upper, exactSquared(point, triangle))).toBe(true);
  // Prevent a vacuous implementation returning [0, Infinity] from passing the
  // enclosure corpus. These are analytic scale witnesses, not GPU hit epsilons.
  expect(result.lower).toBeGreaterThan(0.5);
  expect(result.upper).toBeLessThan(1);
});

it('rejects zero-width float certainty and signed-union or dropped-mesh lower-bound mutants', () => {
  const tilted: QueryTriangle = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    p: FieldVec3 = [0, 0, 0];
  const exact = exactSquared(p, tilted),
    guessed = Math.sqrt(1 / 3);
  expect(contains(guessed, guessed, exact)).toBe(false);
  // These are deliberately injected sign/membership errors, not an observation
  // that the current visibility producer emits these particular scalar values.
  const near: QueryTriangle = [
    [0.125, -1, -1],
    [0.125, 1, -1],
    [0.125, 0, 1],
  ];
  const unionSquared = exactSquared(p, near);
  const signedMinAbs = Math.abs(Math.min(-1, 0.125));
  expect(contains(signedMinAbs, Infinity, unionSquared)).toBe(false);
  expect(contains(1, Infinity, unionSquared)).toBe(false);
  expect(contains(0.125, Infinity, unionSquared)).toBe(true);
});

it('retains the exact full-roster nearest interval through outward BVH pruning and caps', () => {
  const triangles: QueryTriangle[] = Array.from({ length: 16 }, (_, row) => {
    const x = row * 2;
    return [
      [x + 1, 0, 0],
      [x, 1, 0],
      [x, 0, 1],
    ];
  });
  const query = createTriangleQuery(triangles);
  for (let x = -2; x <= 34; x++)
    for (const cap of [0.25, 1, 100]) {
      const p: FieldVec3 = [x / 2, 0.125, 0.25];
      const distance = triangles
        .map((t) => exactSquared(p, t))
        .reduce((a, b) => (compare(a, b) <= 0n ? a : b));
      const capSquared = times(rational(cap), rational(cap));
      const expected = compare(distance, capSquared) < 0n ? distance : capSquared;
      const result = query.nearestInterval(p, cap);
      expect(result).not.toBeNull();
      if (result) expect(contains(result.lower, result.upper, expected)).toBe(true);
    }
});

it('keeps exhausted nearest work unknown while allowing a proved capped-empty query', () => {
  const triangles: QueryTriangle[] = [
    [
      [0.125, -1, -1],
      [0.125, 1, -1],
      [0.125, 0, 1],
    ],
    [
      [1, -1, -1],
      [1, 1, -1],
      [1, 0, 1],
    ],
  ];
  const query = createTriangleQuery(triangles);
  expect(query.nearestInterval([0, 0, 0], 2, { remaining: 0 })).toBeNull();
  expect(query.nearestInterval([0, 0, 0], 2, { remaining: 1 })).toBeNull();
  expect(query.nearestInterval([100, 0, 0], 0.25, { remaining: 0 })).toEqual({
    lower: 0.25,
    upper: 0.25,
  });
});

function emptyWork(): TriangleNearestWork {
  return {
    nodes: 0,
    legacyPrimitives: 0,
    certificatePrimitives: 0,
    sharedPrimitives: 0,
    certificateExtraPrimitives: 0,
    totalPrimitives: 0,
  };
}

it('fuses old scalar bits with an independent interval while charging each needed primitive once', () => {
  const triangles: QueryTriangle[] = Array.from({ length: 16 }, (_, row) => [
    [row * 2 + 1, 0, 0],
    [row * 2, 1, 0],
    [row * 2, 0, 1],
  ]);
  const query = createTriangleQuery(triangles);
  for (let i = 0; i < 37; i++)
    for (const cap of [0.25, 1, 100]) {
      const p: FieldVec3 = [i / 2 - 1, 0.125, 0.25],
        oldBudget = { remaining: 10000 },
        newBudget = { remaining: 10000 },
        work = emptyWork();
      const old = query.nearestSquared(p, cap, oldBudget),
        result = query.nearestSample(p, cap, newBudget, work);
      expect(result).not.toBeNull();
      if (!result) continue;
      expect(Object.is(result.sampleSquared, old)).toBe(true);
      expect(work.legacyPrimitives).toBe(10000 - oldBudget.remaining);
      expect(work.totalPrimitives).toBe(10000 - newBudget.remaining);
      expect(work.totalPrimitives).toBe(work.legacyPrimitives + work.certificateExtraPrimitives);
      expect(work.certificatePrimitives).toBe(
        work.sharedPrimitives + work.certificateExtraPrimitives,
      );
      const nearest = triangles
          .map((t) => exactSquared(p, t))
          .reduce((a, b) => (compare(a, b) <= 0n ? a : b)),
        limit = times(rational(cap), rational(cap));
      expect(
        contains(result.lower, result.upper, compare(nearest, limit) < 0n ? nearest : limit),
      ).toBe(true);
    }
  const work = emptyWork(),
    budget = { remaining: 1 };
  expect(query.nearestSample([0, 0, 0], 100, budget, work)).toBeNull();
  expect(work.totalPrimitives).toBe(1);
  expect(budget.remaining).toBe(0);
});

it('keeps a wrong old zero scalar separate from certificate-only closer geometry', () => {
  const n = 2 ** 20,
    ap: FieldVec3 = [n / 4 + 1, (2 * n - 1) / 4 + 2, (n - 1) / 4 + 1];
  const a: FieldVec3 = [-ap[0], -ap[1], -ap[2]],
    b: FieldVec3 = [a[0] + n, a[1] + n - 1, a[2]],
    c: FieldVec3 = [a[0], a[1] + n, a[2] + n - 1];
  const plane = (x: number): QueryTriangle => [
    [x, -0.25, -0.25],
    [x, 0.25, -0.25],
    [x, 0, 0.25],
  ];
  const triangles: QueryTriangle[] = [[a, b, c], plane(2 ** -44), plane(10), plane(20)];
  expect(triangles.flat(2).every((value) => Math.fround(value) === value)).toBe(true);
  const query = createTriangleQuery(triangles),
    p: FieldVec3 = [0, 0, 0],
    work = emptyWork();
  const old = query.nearestSquared(p, 100),
    result = query.nearestSample(p, 100, undefined, work);
  const nearest = triangles
    .map((t) => exactSquared(p, t))
    .reduce((a, b) => (compare(a, b) <= 0n ? a : b));
  expect(old).toBe(0);
  expect(compare(nearest, ZERO) > 0n).toBe(true);
  expect(result).not.toBeNull();
  if (!result) return;
  expect(Object.is(result.sampleSquared, old)).toBe(true);
  expect(work.certificateExtraPrimitives).toBeGreaterThan(0);
  expect(contains(0, 0, nearest)).toBe(false);
  expect(contains(result.lower, result.upper, nearest)).toBe(true);
  expect(result.upper).toBeGreaterThan(0);
});

it('bounds actual signed f32 sample magnitudes against capped exact unsigned source distance', () => {
  const triangle: QueryTriangle = [
      [1, -2, -2],
      [1, 2, -2],
      [1, 0, 2],
    ],
    query = createTriangleQuery([triangle]);
  for (let i = 0; i < 33; i++)
    for (const band of [0.125, 1, 4])
      for (const sign of [-1, 1]) {
        const p: FieldVec3 = [i / 8 - 2, 0.125, 0.25],
          result = query.nearestSample(p, band);
        expect(result).not.toBeNull();
        if (!result) continue;
        const sample = Math.fround(sign * Math.min(Math.sqrt(result.sampleSquared), band)),
          error = cappedDistanceSampleError(sample, result, band);
        expect(error).not.toBeNull();
        if (error === null) continue;
        const actual = exactSquared(p, triangle),
          limit = times(rational(band), rational(band)),
          capped = compare(actual, limit) < 0n ? actual : limit;
        const magnitude = rational(Math.abs(sample)),
          lower = minus(magnitude, rational(error)),
          upper = plus(magnitude, rational(error));
        expect(
          compare(
            times(
              compare(lower, ZERO) < 0n ? ZERO : lower,
              compare(lower, ZERO) < 0n ? ZERO : lower,
            ),
            capped,
          ) <= 0n,
        ).toBe(true);
        expect(compare(times(upper, upper), capped) >= 0n).toBe(true);
        observations.push({
          name: 'capped-f32-unsigned-sample',
          lower: Math.max(0, Math.abs(sample) - error),
          upper: Math.abs(sample) + error,
          exactSquared: capped.map(String),
          contains: true,
        });
      }
  // Opposite sign votes do not certify the magnitude of signed interpolation.
  expect(Math.abs((1 + -1) / 2)).toBe(0);
  expect((Math.abs(1) + Math.abs(-1)) / 2).toBe(1);
  for (const [sample, interval, band] of [
    [NaN, { lower: 0, upper: 1 }, 1],
    [Infinity, { lower: 0, upper: 1 }, 1],
    [1 / 3, { lower: 0, upper: 1 }, 1],
    [2, { lower: 0, upper: 1 }, 1],
    [0, { lower: -1, upper: 1 }, 1],
    [0, { lower: 2, upper: 1 }, 1],
    [0, { lower: 0, upper: 1 }, Infinity],
  ] as const)
    expect(cappedDistanceSampleError(sample, interval, band)).toBeNull();
});

it('proves band-filled boxes from an outward radius and catches the omitted-radius control', () => {
  const center: FieldVec3 = [0, 0, 0],
    box = { min: [-0.25, -0.25, -0.25] as FieldVec3, max: [0.25, 0.25, 0.25] as FieldVec3 };
  const plane = (x: number): QueryTriangle => [
    [x, -2, -2],
    [x, 2, -2],
    [x, 0, 2],
  ];
  const far = triangleDistanceInterval(center, plane(1)),
    near = triangleDistanceInterval(center, plane(Math.fround(0.6)));
  expect(distanceBoxOutsideBand(center, box, far, 0.5)).toBe(true);
  for (const x of [-0.25, 0.25])
    for (const y of [-0.25, 0.25])
      for (const z of [-0.25, 0.25])
        expect(
          compare(exactSquared([x, y, z], plane(1)), times(rational(0.5), rational(0.5))) >= 0n,
        ).toBe(true);
  expect(distanceBoxOutsideBand(center, box, near, 0.5)).toBe(false);
  // The wrong center-only test certifies clear while a real box corner is in band.
  expect(near.lower >= 0.5).toBe(true);
  const corner = exactSquared([0.25, 0.25, 0.25], plane(Math.fround(0.6)));
  expect(compare(corner, times(rational(0.5), rational(0.5))) < 0n).toBe(true);
  expect(
    distanceBoxOutsideBand(center, { min: [-1e308, 0, 0], max: [1e308, 0, 0] }, far, 0.5),
  ).toBe(false);
  expect(distanceBoxOutsideBand(center, { min: [1, 0, 0], max: [0, 0, 0] }, far, 0.5)).toBe(false);
});

it('proves exact zero at one-point boundary bricks without collapsing nonzero or wide uncertainty', () => {
  const point: FieldVec3 = [Math.fround(0.17), Math.fround(-0.23), 0],
    box = { min: point, max: point };
  expect(distanceBoxBandLimit(point, box, 0.5)).toBe(0.5);
  expect(distanceBoxOutsideBand(point, box, { lower: 0.5, upper: 0.5 }, 0.5)).toBe(true);
  const extended = { min: point, max: [point[0] + 2 ** -20, point[1], point[2]] as FieldVec3 };
  expect(distanceBoxOutsideBand(point, extended, { lower: 0.5, upper: 0.5 }, 0.5)).toBe(false);
  const origin: FieldVec3 = [0, 0, 0],
    triangle: QueryTriangle = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
  expect(compare(exactSquared(origin, triangle), ZERO)).toBe(0n);
  expect(triangleDistanceInterval(origin, triangle)).toEqual({ lower: 0, upper: 0 });
  expect(cappedDistanceSampleError(0, { lower: 0, upper: 1 }, 1)).toBeGreaterThanOrEqual(1);
});
