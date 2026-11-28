import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, hypot2, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { basisFunctions, curvePoint, findSpan, type NurbsCurve, solve } from '../nurbs';
import { brepError } from './types';

const TWO_PI = 2 * Math.PI;
const QUARTER = Math.PI / 2;
const TAN_PI_8 = Math.SQRT2 - 1;

/** Rational quadratic circle weights: 1 at the nine-point corners-and-midpoints, sqrt(2)/2 between. */
export const RING_CIRCLE_WEIGHTS: readonly number[] = [
  1,
  Math.SQRT1_2,
  1,
  Math.SQRT1_2,
  1,
  Math.SQRT1_2,
  1,
  Math.SQRT1_2,
  1,
];

/** The nine-point rational quadratic circle over u in [0, 1]: exact unit circle, quarter q at [q/4, (q+1)/4]. */
export const RING_CIRCLE: NurbsCurve = {
  degree: 2,
  points: [
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [-1, 1, 0],
    [-1, 0, 0],
    [-1, -1, 0],
    [0, -1, 0],
    [1, -1, 0],
    [1, 0, 0],
  ],
  weights: [...RING_CIRCLE_WEIGHTS],
  knots: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1],
};

/**
 * Closed-form inverse of the rational circle: the parameter u with circle(u) at angle `theta`.
 * Within quarter q, s = (1 + tan(psi/2) / tan(pi/8)) / 2 with psi the offset from the quarter
 * bisector, and u = (q + s) / 4. Exact up to rounding; no iteration.
 */
export function ringCircleParam(theta: number): number {
  const wrapped = theta - Math.floor(theta / TWO_PI) * TWO_PI;
  const q = Math.min(3, Math.floor(wrapped / QUARTER));
  const psi = wrapped - q * QUARTER - Math.PI / 4;
  const t = sin(psi / 2) / cos(psi / 2);
  const s = (1 + t / TAN_PI_8) / 2;
  return (q + s) / 4;
}

/** Target u at edge angle `theta` in [0, 2 pi]; the end angle 2 pi maps to u = 1, not the wrap to 0. */
export function unwrappedCircleParam(theta: number): number {
  if (theta >= TWO_PI - 1e-12) return 1;
  return ringCircleParam(theta);
}

/** Degree of the theta -> u fit. Raising it converges too slowly; sub-intervals are refined instead. */
export const RING_FIT_DEGREE = 7;
/** Sub-intervals per quarter tried in order; the first rung meeting the 3D margin is used. */
export const RING_FIT_SUBDIVISIONS: readonly number[] = [1, 2, 4, 8];
/**
 * Accepted 3D fit error as a fraction of the kernel tolerance. The validator checks
 * dist3(surface(pcurve(t)), curve(t)) <= tol, so a quarter leaves room for its sampling and rounding.
 */
export const RING_FIT_SAFETY = 0.25;

/** Nodes of one fit: each piece contributes its Lobatto nodes, sharing its end knots (C0 joins). */
function nodeCount(subdivisions: number): number {
  return 4 * subdivisions * RING_FIT_DEGREE + 1;
}

/** Clamped degree-p knot vector on [0, 2 pi] with interior multiplicity p at every sub-interval break. */
export function ringFitKnots(subdivisions: number): number[] {
  const p = RING_FIT_DEGREE;
  const knots: number[] = new Array<number>(p + 1).fill(0);
  for (let i = 1; i < 4 * subdivisions; i++) {
    const t = (i / subdivisions) * QUARTER;
    for (let k = 0; k < p; k++) knots.push(t);
  }
  for (let k = 0; k <= p; k++) knots.push(TWO_PI);
  return knots;
}

function spanStart(subdivisions: number, s: number): number {
  return (s / subdivisions) * QUARTER;
}

const fitCache = new Map<number, NurbsCurve | undefined>();

/**
 * Collocation fit of theta -> u as one clamped spline over [0, 2 pi]: each sub-interval is a degree-p
 * piece interpolated at its own Chebyshev-Lobatto nodes, end nodes shared (C0 joins). The square
 * system N P = U is solved directly.
 */
export function fitRingUCurve(subdivisions: number): NurbsCurve | undefined {
  if (fitCache.has(subdivisions)) return fitCache.get(subdivisions);
  const p = RING_FIT_DEGREE;
  const knots = ringFitKnots(subdivisions);
  const count = knots.length - p - 1;
  const params: number[] = [];
  for (let s = 0; s < 4 * subdivisions; s++) {
    const a = spanStart(subdivisions, s);
    const b = spanStart(subdivisions, s + 1);
    for (let j = s === 0 ? 0 : 1; j <= p; j++) {
      if (j === 0) params.push(a);
      else if (j === p) params.push(b);
      else params.push(a + ((b - a) * (1 - cos((Math.PI * j) / p))) / 2);
    }
  }
  if (params.length !== count || count !== nodeCount(subdivisions)) {
    fitCache.set(subdivisions, undefined);
    return undefined;
  }
  const A = new Float64Array(count * count);
  const B = new Float64Array(count);
  for (let r = 0; r < count; r++) {
    const t = params[r] as number;
    const span = findSpan(count, p, t, knots);
    const N = basisFunctions(span, t, p, knots);
    for (let j = 0; j <= p; j++) A[r * count + span - p + j] = N[j] as number;
    B[r] = unwrappedCircleParam(t);
  }
  const x = solve(A, B, count, 1);
  const fit = x.ok
    ? { degree: p, points: Array.from(x.value, (v): [number, number, number] => [v, 0, 0]), knots }
    : undefined;
  fitCache.set(subdivisions, fit);
  return fit;
}

/**
 * Samples for measuring a fit: a uniform grid at least four times denser than the finest rung's nodes,
 * plus the midpoint of every finest sub-interval (the knot-interval midpoints).
 */
const SAMPLE_GRID = 4 * nodeCount(RING_FIT_SUBDIVISIONS[RING_FIT_SUBDIVISIONS.length - 1] ?? 1);
function ringFitSamples(): number[] {
  const samples: number[] = [];
  for (let j = 0; j <= SAMPLE_GRID; j++) samples.push((TWO_PI * j) / SAMPLE_GRID);
  const finest = RING_FIT_SUBDIVISIONS[RING_FIT_SUBDIVISIONS.length - 1] ?? 1;
  for (let s = 0; s < 4 * finest; s++) {
    samples.push((spanStart(finest, s) + spanStart(finest, s + 1)) / 2);
  }
  return samples;
}
const SAMPLES = ringFitSamples();

const clampUnit = (u: number): number => Math.min(1, Math.max(0, u));

const measureCache = new Map<number, { uError: number; chordError: number }>();

/** Largest parameter error and largest unit-circle chord error of one rung, over the sample set. */
export function measureRingFit(subdivisions: number): { uError: number; chordError: number } {
  const cached = measureCache.get(subdivisions);
  if (cached !== undefined) return cached;
  const result = measureRingFitUncached(subdivisions);
  measureCache.set(subdivisions, result);
  return result;
}

function measureRingFitUncached(subdivisions: number): { uError: number; chordError: number } {
  const fit = fitRingUCurve(subdivisions);
  if (fit === undefined) return { uError: Infinity, chordError: Infinity };
  let uError = 0;
  let chordError = 0;
  for (const theta of SAMPLES) {
    const u = curvePoint(fit, theta)[0];
    const target = unwrappedCircleParam(theta);
    uError = Math.max(uError, Math.abs(u - target));
    const p = curvePoint(RING_CIRCLE, clampUnit(u));
    const q = curvePoint(RING_CIRCLE, clampUnit(target));
    chordError = Math.max(chordError, hypot2(p[0] - q[0], p[1] - q[1]));
  }
  return { uError, chordError };
}

/**
 * Ring trim at profile radius `radius` and profile parameter `v`: the degree-p fit of u with control
 * points `[u, v, 0]` over the edge domain [0, 2 pi]. The first rung whose 3D error
 * `radius * chord` is within `tol * RING_FIT_SAFETY` is taken; otherwise the closed `brep-tol-exceeded`
 * error carries the measured error.
 */
export function ringTrimCurve(
  radius: number,
  tol: number,
  v: number,
): Result<NurbsCurve, ModelingError> {
  let last = Infinity;
  let lastRung = 1;
  for (const subdivisions of RING_FIT_SUBDIVISIONS) {
    const fit = fitRingUCurve(subdivisions);
    const { chordError } = measureRingFit(subdivisions);
    last = radius * chordError;
    lastRung = subdivisions;
    if (fit !== undefined && last <= tol * RING_FIT_SAFETY) {
      return ok({
        degree: fit.degree,
        knots: [...fit.knots],
        points: fit.points.map((c): [number, number, number] => [c[0], v, 0]),
      });
    }
  }
  return err(
    brepError('brep-tol-exceeded', 'a ring trim fit within tol * RING_FIT_SAFETY', {
      measured: last,
      tol,
      radius,
      subdivisions: lastRung,
    }),
  );
}
