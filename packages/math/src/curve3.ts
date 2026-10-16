import type { Vec3, Vec3Like } from './types';
import { create, distance } from './vec3';

export interface CatmullRomOptions {
  readonly closed?: boolean;
  readonly parameterization?: 'uniform' | 'centripetal' | 'chordal';
}
const DEFAULT_OPTIONS: CatmullRomOptions = {};
export type Curve3Sampler = (out: Vec3, t: number) => Vec3;

/** Whole-path Catmull-Rom, centripetal by default. Open ends extrapolate their
 * neighbours; closed paths wrap without a duplicate control point. No allocation.
 * Empty input writes zero, one point is constant, t is clamped to [0,1].
 */
export function catmullRom(
  out: Vec3,
  points: readonly Vec3Like[],
  t: number,
  options: CatmullRomOptions = DEFAULT_OPTIONS,
): Vec3 {
  return evaluate(out, points, t, options, false);
}

/** Unit direction from the analytic derivative; constant curves write zero. */
export function catmullRomTangent(
  out: Vec3,
  points: readonly Vec3Like[],
  t: number,
  options: CatmullRomOptions = DEFAULT_OPTIONS,
): Vec3 {
  evaluate(out, points, t, options, true);
  const length = Math.hypot(out[0] as number, out[1] as number, out[2] as number);
  if (length > 0) for (let axis = 0; axis < 3; axis++) out[axis] = (out[axis] as number) / length;
  return out;
}

function evaluate(
  out: Vec3,
  points: readonly Vec3Like[],
  t: number,
  options: CatmullRomOptions,
  derivative: boolean,
): Vec3 {
  const n = points.length;
  if (n < 2) {
    for (let axis = 0; axis < 3; axis++) out[axis] = derivative ? 0 : (points[0]?.[axis] ?? 0);
    return out;
  }
  const closed = options.closed ?? false;
  const segments = closed ? n : n - 1;
  const scaled = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * segments;
  const segment = Math.min(segments - 1, Math.floor(scaled));
  const u = scaled - segment;
  if (!derivative && (u === 0 || u === 1)) {
    const endpoint = points[(segment + (u === 1 ? 1 : 0)) % n] as Vec3Like;
    const x = endpoint[0] as number,
      y = endpoint[1] as number,
      z = endpoint[2] as number;
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
  }
  const p1 = points[segment] as Vec3Like,
    p2 = points[(segment + 1) % n] as Vec3Like;
  const p0 = closed ? points[(segment + n - 1) % n] : points[segment - 1];
  const p3 = closed ? points[(segment + 2) % n] : points[segment + 2];
  const mode = options.parameterization ?? 'centripetal';
  let dt0 = 1,
    dt1 = 1,
    dt2 = 1;
  if (mode !== 'uniform') {
    const power = mode === 'centripetal' ? 0.5 : 1;
    dt1 = distance(p1, p2) ** power;
    dt0 = p0 ? distance(p0, p1) ** power : dt1;
    dt2 = p3 ? distance(p2, p3) ** power : dt1;
    // Coincident neighbours borrow the live segment's knot interval. No
    // absolute world-unit epsilon: small valid curves remain small curves.
    if (dt1 === 0) dt1 = 1;
    if (dt0 === 0) dt0 = dt1;
    if (dt2 === 0) dt2 = dt1;
  }
  // Calculate all axes before writing: out may alias a control point.
  let x = 0,
    y = 0,
    z = 0;
  for (let axis = 0; axis < 3; axis++) {
    const b = p1[axis] as number,
      c = p2[axis] as number;
    const a = p0 ? (p0[axis] as number) : 2 * b - c;
    const d = p3 ? (p3[axis] as number) : 2 * c - b;
    const m1 =
      mode === 'uniform'
        ? (c - a) * 0.5
        : dt1 * ((b - a) / dt0 - (c - a) / (dt0 + dt1) + (c - b) / dt1);
    const m2 =
      mode === 'uniform'
        ? (d - b) * 0.5
        : dt1 * ((c - b) / dt1 - (d - b) / (dt1 + dt2) + (d - c) / dt2);
    const c2 = 3 * (c - b) - 2 * m1 - m2,
      c3 = 2 * (b - c) + m1 + m2;
    const value = derivative ? m1 + u * (2 * c2 + 3 * u * c3) : b + u * (m1 + u * (c2 + u * c3));
    if (axis === 0) x = value;
    else if (axis === 1) y = value;
    else z = value;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** Explicit caller-owned chord-length table for a sampler. out.length-1 is the
 * subdivision count (>=1); rebuild after changing controls. Two Vec3 scratch
 * allocations per build; distance lookup and curve sampling allocate nothing.
 * Approximation, not an analytic arc-length guarantee: increase subdivisions
 * until the application's distance/error budget converges.
 */
export function arcLengths(out: Float32Array, sample: Curve3Sampler): Float32Array {
  if (out.length < 2) {
    out.fill(0);
    return out;
  }
  let previous = create(),
    current = create(),
    sum = 0;
  sample(previous, 0);
  out[0] = 0;
  for (let i = 1; i < out.length; i++) {
    sample(current, i / (out.length - 1));
    sum += distance(previous, current);
    out[i] = sum;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return out;
}

/** Clamp a distance to a valid cumulative table and invert by binary search.
 * Zero-length paths and nonfinite distance return 0; repeated lengths are safe.
 * Table comes from arcLengths; lookups are O(log subdivisions).
 */
export function parameterAtDistance(lengths: Float32Array, distance: number): number {
  const last = lengths.length - 1,
    total = lengths[last] ?? 0;
  if (last < 1 || !(total > 0) || !Number.isFinite(distance)) return 0;
  if (distance <= 0) return 0;
  if (distance >= total) return 1;
  let low = 0,
    high = last;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if ((lengths[mid] as number) <= distance) low = mid;
    else high = mid;
  }
  const start = lengths[low] as number,
    end = lengths[high] as number;
  return (low + (end > start ? (distance - start) / (end - start) : 0)) / last;
}
