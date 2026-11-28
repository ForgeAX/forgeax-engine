import { err, ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, hypot2, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { brepError } from './types';
import type { P2 } from './vec';

/**
 * One face of a blend seen in a 2D section plane: a straight `line` through `p` with unit outward
 * normal `n`, or an `arc` of circle `c`, `r` whose outward normal is `sign * (q - c) / r`.
 */
export type Element2 =
  | { readonly kind: 'line'; readonly p: P2; readonly n: P2 }
  | { readonly kind: 'arc'; readonly c: P2; readonly r: number; readonly sign: 1 | -1 };

/** The rolling-ball (fillet) or equal-setback (chamfer) solution at one corner of a section. */
export interface Corner2 {
  /** The material angle at the corner is below pi; a convex corner loses material, a concave one gains it. */
  readonly convex: boolean;
  /** Fillet: the ball center. Chamfer: the corner point itself. */
  readonly center: P2;
  readonly a: P2;
  readonly b: P2;
}

/** Below this, two section normals count as parallel and the faces as tangent. */
const TANGENT = 1e-9;

export function partial<T>(
  reason: string,
  expected: string,
  ids?: Readonly<Record<string, unknown>>,
): Result<T, ModelingError> {
  return err(brepError('brep-face-unsupported', expected, { reason, ...ids }));
}

const dot = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1];
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const madd = (a: P2, b: P2, s: number): P2 => [a[0] + b[0] * s, a[1] + b[1] * s];
const cross = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0];

function unit(a: P2): P2 {
  const l = hypot2(a[0], a[1]);
  return l === 0 ? a : [a[0] / l, a[1] / l];
}

export function normalAt(e: Element2, q: P2): P2 {
  if (e.kind === 'line') return e.n;
  const d = unit(sub(q, e.c));
  return [e.sign * d[0], e.sign * d[1]];
}

/** The element moved by `delta` along its outward normal, or `undefined` when an arc collapses. */
export function offsetElement(e: Element2, delta: number): Element2 | undefined {
  if (e.kind === 'line') return { kind: 'line', p: madd(e.p, e.n, delta), n: e.n };
  const r = e.r + e.sign * delta;
  return r > TANGENT * Math.max(1, e.r) ? { kind: 'arc', c: e.c, r, sign: e.sign } : undefined;
}

/** Closest point of the element's full line or circle to `q`. */
export function footOf(e: Element2, q: P2): P2 {
  if (e.kind === 'line') return madd(q, e.n, -dot(sub(q, e.p), e.n));
  return madd(e.c, unit(sub(q, e.c)), e.r);
}

function lineCircle(p: P2, d: P2, c: P2, r: number): P2[] {
  const t0 = dot(sub(c, p), d);
  const foot = madd(p, d, t0);
  const h2 = r * r - dot(sub(c, foot), sub(c, foot));
  if (h2 < 0) return [];
  const h = Math.sqrt(h2);
  return [madd(foot, d, -h), madd(foot, d, h)];
}

/** Every intersection point of two elements' full lines or circles (tangent pairs give none or two equal points). */
export function intersect2(a: Element2, b: Element2): P2[] {
  if (a.kind === 'line' && b.kind === 'line') {
    const da: P2 = [-a.n[1], a.n[0]];
    const db: P2 = [-b.n[1], b.n[0]];
    const den = cross(da, db);
    if (Math.abs(den) < TANGENT) return [];
    return [madd(a.p, da, cross(sub(b.p, a.p), db) / den)];
  }
  if (a.kind === 'line' && b.kind === 'arc') return lineCircle(a.p, [-a.n[1], a.n[0]], b.c, b.r);
  if (a.kind === 'arc' && b.kind === 'line') return lineCircle(b.p, [-b.n[1], b.n[0]], a.c, a.r);
  const ca = a as Element2 & { kind: 'arc' };
  const cb = b as Element2 & { kind: 'arc' };
  const d = sub(cb.c, ca.c);
  const l = hypot2(d[0], d[1]);
  if (l < TANGENT) return [];
  const x = (l * l + ca.r * ca.r - cb.r * cb.r) / (2 * l);
  const h2 = ca.r * ca.r - x * x;
  if (h2 < 0) return [];
  const e = unit(d);
  const m = madd(ca.c, e, x);
  const h = Math.sqrt(h2);
  return [madd(m, [-e[1], e[0]], h), madd(m, [-e[1], e[0]], -h)];
}

/** Unit tangent of the element at `q`, signed to point along `toward`. */
export function tangentToward(e: Element2, q: P2, toward: P2): P2 {
  const n = normalAt(e, q);
  const t: P2 = [-n[1], n[0]];
  return dot(t, toward) >= 0 ? t : [-t[0], -t[1]];
}

/** True when `q` lies on the face side of the corner `at`: along `t` from it, measured along the element. */
function onSide(e: Element2, at: P2, t: P2, q: P2, tol: number): boolean {
  if (e.kind === 'line') return dot(sub(q, at), t) > tol;
  const ra = sub(at, e.c);
  const rq = sub(q, e.c);
  const turn = atan2(cross(ra, rq), dot(ra, rq));
  const ccw = cross(ra, t) > 0 ? 1 : -1;
  return ccw * turn * e.r > tol;
}

/**
 * The fillet of radius `r` at the corner `at` between elements `a` and `b`; `ta`, `tb` are the unit
 * tangents pointing from the corner into each face. The ball center is the intersection of the two
 * offsets nearest the corner whose feet land on both faces; a contact past the end of a face is the
 * caller's to detect from the returned points.
 */
export function filletCorner(
  a: Element2,
  ta: P2,
  b: Element2,
  tb: P2,
  at: P2,
  r: number,
  tol: number,
): Result<Corner2, ModelingError> {
  const na = normalAt(a, at);
  const nb = normalAt(b, at);
  if (Math.abs(cross(na, nb)) < TANGENT && dot(na, nb) > 0) {
    return partial('blend-tangent', 'faces meeting at an angle (tangent faces need no blend)');
  }
  const convex = dot(nb, ta) < 0;
  const delta = convex ? -r : r;
  const oa = offsetElement(a, delta);
  const ob = offsetElement(b, delta);
  if (oa === undefined || ob === undefined) {
    return partial('blend-collapse', 'a fillet radius below the curvature radius of both faces', {
      radius: r,
    });
  }
  let best: Corner2 | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const c of intersect2(oa, ob)) {
    const pa = footOf(a, c);
    const pb = footOf(b, c);
    if (!onSide(a, at, ta, pa, -tol) || !onSide(b, at, tb, pb, -tol)) continue;
    const d = hypot2(c[0] - at[0], c[1] - at[1]);
    if (d < bestDistance) {
      bestDistance = d;
      best = { convex, center: c, a: pa, b: pb };
    }
  }
  if (best === undefined) {
    return partial('blend-no-contact', 'a ball of this radius touching both faces near the edge', {
      radius: r,
    });
  }
  return ok(best);
}

/** The point at distance `d` from `at` along the element in direction `t` (chord distance on an arc). */
function setback(e: Element2, at: P2, t: P2, d: number): P2 | undefined {
  if (e.kind === 'line') return madd(at, t, d);
  const half = d / (2 * e.r);
  if (!(half < 1)) return undefined;
  const c = 1 - 2 * half * half;
  const s = Math.sqrt(1 - c * c);
  const ra = sub(at, e.c);
  const angle = (cross(ra, t) > 0 ? 1 : -1) * atan2(s, c);
  const ca = cos(angle);
  const sa = sin(angle);
  return [e.c[0] + ra[0] * ca - ra[1] * sa, e.c[1] + ra[0] * sa + ra[1] * ca];
}

/** The equal-setback chamfer of distance `d` at the corner `at`: one point on each face, `d` from the corner. */
export function chamferCorner(
  a: Element2,
  ta: P2,
  b: Element2,
  tb: P2,
  at: P2,
  d: number,
): Result<Corner2, ModelingError> {
  const na = normalAt(a, at);
  const nb = normalAt(b, at);
  if (Math.abs(cross(na, nb)) < TANGENT && dot(na, nb) > 0) {
    return partial('blend-tangent', 'faces meeting at an angle (tangent faces need no chamfer)');
  }
  const pa = setback(a, at, ta, d);
  const pb = setback(b, at, tb, d);
  if (pa === undefined || pb === undefined) {
    return partial('chamfer-too-long', 'a chamfer distance below the diameter of a curved face', {
      distance: d,
    });
  }
  return ok({ convex: dot(nb, ta) < 0, center: at, a: pa, b: pb });
}
