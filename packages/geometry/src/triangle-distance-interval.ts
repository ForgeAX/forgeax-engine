import type { FieldVec3 } from '@forgeax/engine-types';
import type { QueryTriangle } from './triangle-query';

/** Enclosure of unsigned distance to a closed triangle, not a solid sign. */
export interface TriangleDistanceInterval {
  readonly lower: number;
  readonly upper: number;
}
type I = readonly [number, number];
type V = readonly [I, I, I];
const wide: I = [-Infinity, Infinity];
const bits = new DataView(new ArrayBuffer(8));

/** Adjacent binary64 number; elementary operations are rounded outwards. */
function adjacent(value: number, up: boolean) {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  bits.setFloat64(0, value, true);
  let low = bits.getUint32(0, true),
    high = bits.getUint32(4, true);
  if (up === value > 0) {
    low = (low + 1) >>> 0;
    if (low === 0) high = (high + 1) >>> 0;
  } else {
    if (low === 0) high = (high - 1) >>> 0;
    low = (low - 1) >>> 0;
  }
  bits.setUint32(0, low, true);
  bits.setUint32(4, high, true);
  return bits.getFloat64(0, true);
}
function range(lower: number, upper: number): I {
  return Number.isNaN(lower) || Number.isNaN(upper)
    ? wide
    : [adjacent(lower, false), adjacent(upper, true)];
}
const exact = (value: number): I => [value, value];
const zero = (a: I) => a[0] === 0 && a[1] === 0;
const add = (a: I, b: I): I => (zero(a) ? b : zero(b) ? a : range(a[0] + b[0], a[1] + b[1]));
const sub = (a: I, b: I): I =>
  a[0] === a[1] && b[0] === b[1] && a[0] === b[0] && Number.isFinite(a[0])
    ? exact(0)
    : add(a, [-b[1], -b[0]]);
function mul(a: I, b: I): I {
  if ((zero(a) && b.every(Number.isFinite)) || (zero(b) && a.every(Number.isFinite)))
    return exact(0);
  const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return range(Math.min(...p), Math.max(...p));
}
function divide(a: I, b: I): I {
  if (b[0] <= 0 && b[1] >= 0) return wide;
  return mul(a, range(1 / b[1], 1 / b[0]));
}
function square(a: I): I {
  if (zero(a)) return exact(0);
  const p = [a[0] * a[0], a[1] * a[1]];
  return [
    a[0] <= 0 && a[1] >= 0 ? 0 : Math.max(0, adjacent(Math.min(...p), false)),
    adjacent(Math.max(...p), true),
  ];
}
const vector = (p: FieldVec3): V => [exact(p[0]), exact(p[1]), exact(p[2])];
const minus = (a: V, b: V): V => [sub(a[0], b[0]), sub(a[1], b[1]), sub(a[2], b[2])];
const scaled = (a: V, t: I): V => [mul(a[0], t), mul(a[1], t), mul(a[2], t)];
const dot = (a: V, b: V) => add(add(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]));
const norm2 = (a: V) => add(add(square(a[0]), square(a[1])), square(a[2]));
const cross = (a: V, b: V): V => [
  sub(mul(a[1], b[2]), mul(a[2], b[1])),
  sub(mul(a[2], b[0]), mul(a[0], b[2])),
  sub(mul(a[0], b[1]), mul(a[1], b[0])),
];

function segmentSquared(p: V, a: V, b: V): I {
  const e = minus(b, a),
    ap = minus(p, a),
    length = norm2(e);
  if (!(length[0] > 0)) {
    // A zero/uncertain denominator cannot certify an edge's closest parameter.
    return [0, Math.min(norm2(ap)[1], norm2(minus(p, b))[1])];
  }
  const t = divide(dot(ap, e), length);
  const clamped: I = [Math.max(0, Math.min(1, t[0])), Math.max(0, Math.min(1, t[1]))];
  return norm2(minus(ap, scaled(e, clamped)));
}

/** Possible face projection contributes a lower bound; only a proved interior
 * projection contributes an upper bound. Uncertain degeneracy remains [0,Inf]. */
function faceSquared(p: V, a: V, b: V, c: V): I {
  const ab = minus(b, a),
    ac = minus(c, a),
    n = cross(ab, ac),
    n2 = norm2(n);
  if (!(n2[0] > 0)) return [0, Infinity];
  const ap = minus(p, a),
    d = dot(ap, n),
    projection = minus(ap, scaled(n, divide(d, n2)));
  const u = divide(dot(cross(projection, ac), n), n2);
  const v = divide(dot(cross(ab, projection), n), n2),
    sum = add(u, v);
  if (u[1] < 0 || v[1] < 0 || sum[0] > 1) return [Infinity, Infinity];
  const distance = divide(square(d), n2);
  return [Math.max(0, distance[0]), u[0] >= 0 && v[0] >= 0 && sum[1] <= 1 ? distance[1] : Infinity];
}

/** Validate the sqrt candidate by outward squared inequalities. The contract
 * does not assume Math.sqrt itself has a portable one-ulp error guarantee. */
function rootBound(value: number, up: boolean) {
  if (value === 0 || value === Infinity) return value;
  let candidate = Math.sqrt(value);
  for (let step = 0; step < 8; step++) {
    const squared = square(exact(candidate));
    if (up ? squared[0] >= value : squared[1] <= value) return candidate;
    candidate = adjacent(candidate, up);
  }
  return up ? Infinity : 0;
}

/** Finite validated source coordinates only. Every possible closest feature is
 * retained; ambiguity widens the interval, never excludes geometry. No BVH
 * pruning, sample cap, sign, voxel interpolation or GPU certificate is implied. */
export function triangleDistanceInterval(
  point: FieldVec3,
  triangle: QueryTriangle,
): TriangleDistanceInterval {
  const p = vector(point),
    a = vector(triangle[0]),
    b = vector(triangle[1]),
    c = vector(triangle[2]);
  const features = [
    faceSquared(p, a, b, c),
    segmentSquared(p, a, b),
    segmentSquared(p, b, c),
    segmentSquared(p, c, a),
  ];
  const lower = Math.max(0, Math.min(...features.map((x) => x[0])));
  const upper = Math.max(0, Math.min(...features.map((x) => x[1])));
  return { lower: rootBound(lower, false), upper: rootBound(upper, true) };
}

/** Outward lower bound used by nearest-query pruning, with exact source bounds. */
export function pointBoxDistanceInterval(
  point: FieldVec3,
  box: { readonly min: FieldVec3; readonly max: FieldVec3 },
): TriangleDistanceInterval {
  const d = [0, 1, 2].map((axis) => {
    const p = point[axis] ?? NaN,
      lo = box.min[axis] ?? NaN,
      hi = box.max[axis] ?? NaN;
    if (p < lo) return sub(exact(lo), exact(p));
    if (p > hi) return sub(exact(p), exact(hi));
    return exact(0);
  });
  const a = d[0],
    b = d[1],
    c = d[2];
  if (!a || !b || !c) return { lower: 0, upper: Infinity };
  const squared = norm2([a, b, c]);
  return {
    lower: rootBound(Math.max(0, squared[0]), false),
    upper: rootBound(Math.max(0, squared[1]), true),
  };
}

/** Error of an actual stored f32 magnitude against a capped unsigned enclosure.
 * No sign, interior or interpolation claim follows. Null means no certificate. */
export function cappedDistanceSampleError(
  sample: number,
  interval: TriangleDistanceInterval,
  band: number,
): number | null {
  if (
    !Number.isFinite(sample) ||
    Math.fround(sample) !== sample ||
    !Number.isFinite(band) ||
    band < 0 ||
    Math.abs(sample) > band ||
    !(interval.lower >= 0) ||
    !(interval.upper >= interval.lower)
  )
    return null;
  const lower = Math.min(band, interval.lower),
    upper = Math.min(band, interval.upper);
  const difference = sub(exact(Math.abs(sample)), [lower, upper]);
  const error = Math.max(Math.abs(difference[0]), Math.abs(difference[1]));
  return Number.isFinite(error) ? error : null;
}

/** Sufficient certified center-distance threshold to fill the closed box at band.
 * The center may itself have rounding error: its actual value defines both the
 * nearest enclosure and the outward enclosing radius. False means unproved,
 * never a hit or an empty-space result. */
export function distanceBoxBandLimit(
  center: FieldVec3,
  box: { readonly min: FieldVec3; readonly max: FieldVec3 },
  band: number,
): number | null {
  if (![...center, ...box.min, ...box.max, band].every(Number.isFinite) || band < 0) return null;
  const radius: I[] = [];
  for (const axis of [0, 1, 2] as const) {
    if (box.min[axis] > box.max[axis]) return null;
    const lower = sub(exact(center[axis]), exact(box.min[axis])),
      upper = sub(exact(center[axis]), exact(box.max[axis]));
    radius.push([0, Math.max(...lower.map(Math.abs), ...upper.map(Math.abs))]);
  }
  const x = radius[0],
    y = radius[1],
    z = radius[2];
  if (!x || !y || !z) return null;
  const bound = rootBound(norm2([x, y, z])[1], true),
    threshold = add(exact(band), exact(bound))[1];
  return Number.isFinite(threshold) ? threshold : null;
}

/** False is unproved, never a geometry hit or an empty-space decision. */
export function distanceBoxOutsideBand(
  center: FieldVec3,
  box: { readonly min: FieldVec3; readonly max: FieldVec3 },
  nearest: TriangleDistanceInterval,
  band: number,
): boolean {
  if (!(nearest.lower >= 0) || !(nearest.upper >= nearest.lower)) return false;
  const limit = distanceBoxBandLimit(center, box, band);
  return limit !== null && nearest.lower >= limit;
}
