import { basisFunctions, curvePoint, findSpan, type NurbsCurve } from '../../nurbs';
import { dist3, type P2, type P3, sub3 } from '../vec';
import { solveBand } from './linalg';
import type { Problem } from './problem';

const DEGREE = 3;
/** Receipt widening for sampling between checked parameters (matches the analytic route). */
export const SSI_BOUND_SAFETY = 1.25;
const ROUNDS = 6;

/** One marched branch with both pcurves sampled at the same points. */
export interface Samples {
  readonly xs: readonly (readonly number[])[];
  readonly points: readonly P3[];
  readonly uvA: readonly P2[];
  readonly uvB: readonly P2[];
  readonly closed: boolean;
  readonly kinks: readonly number[];
}

export interface Fitted {
  readonly curve: NurbsCurve;
  readonly onA: NurbsCurve;
  readonly onB: NurbsCurve;
  readonly bound: number;
}

/** Normalized chord-length parameters; a closed branch gets its closing chord. */
function chordParams(points: readonly P3[]): number[] {
  const t = [0];
  for (let i = 1; i < points.length; i++) {
    t.push((t[i - 1] as number) + dist3(points[i] as P3, points[i - 1] as P3));
  }
  const total = t[t.length - 1] as number;
  return t.map((x) => x / total);
}

/**
 * Clamped cubic knots: triple knots at crease rows, and in each smooth run about one interior knot
 * per `stride` data points (every span keeps at least two data points).
 */
function knotsFor(params: readonly number[], kinks: readonly number[], stride: number): number[] {
  const breaks = [0, ...kinks.filter((k) => k > 0 && k < params.length - 1), params.length - 1];
  const knots = new Array<number>(DEGREE + 1).fill(0);
  for (let s = 0; s + 1 < breaks.length; s++) {
    const i0 = breaks[s] as number;
    const i1 = breaks[s + 1] as number;
    const span = i1 - i0;
    const inner = Math.max(0, Math.min(Math.floor(span / 2) - 1, Math.round(span / stride) - 1));
    for (let j = 1; j <= inner; j++) {
      const f = i0 + (j * span) / (inner + 1);
      const i = Math.floor(f);
      const a = f - i;
      knots.push((1 - a) * (params[i] as number) + a * (params[Math.min(i + 1, i1)] as number));
    }
    if (s + 2 < breaks.length) for (let k = 0; k < DEGREE; k++) knots.push(params[i1] as number);
  }
  for (let k = 0; k <= DEGREE; k++) knots.push(1);
  return knots;
}

/** Least-squares fit of `rows` (any width) on `knots`, end rows interpolated; banded normal equations. */
function fitRows(
  rows: readonly (readonly number[])[],
  params: readonly number[],
  knots: readonly number[],
): number[][] | undefined {
  const count = knots.length - DEGREE - 1;
  const n = count - 1;
  const m = rows.length - 1;
  const d = (rows[0] as readonly number[]).length;
  const first = rows[0] as readonly number[];
  const last = rows[m] as readonly number[];
  if (n < 1) return undefined;
  if (n === 1) return [[...first], [...last]];
  const inner = n - 1;
  const band = Array.from({ length: inner }, () => new Array<number>(DEGREE + 1).fill(0));
  const rhs = Array.from({ length: inner }, () => new Array<number>(d).fill(0));
  for (let k = 1; k < m; k++) {
    const t = params[k] as number;
    const span = findSpan(count, DEGREE, t, knots);
    const N = basisFunctions(span, t, DEGREE, knots);
    const base = span - DEGREE;
    const r = [...(rows[k] as readonly number[])];
    for (let j = 0; j <= DEGREE; j++) {
      const idx = base + j;
      const nj = N[j] as number;
      if (idx === 0)
        for (let c = 0; c < d; c++) r[c] = (r[c] as number) - nj * (first[c] as number);
      if (idx === n) for (let c = 0; c < d; c++) r[c] = (r[c] as number) - nj * (last[c] as number);
    }
    for (let j = 0; j <= DEGREE; j++) {
      const i = base + j;
      if (i < 1 || i > inner) continue;
      const ni = N[j] as number;
      const row = rhs[i - 1] as number[];
      for (let c = 0; c < d; c++) row[c] = (row[c] as number) + ni * (r[c] as number);
      for (let l = 0; l <= j; l++) {
        const q = base + l;
        if (q < 1) continue;
        const b = band[i - 1] as number[];
        b[i - q] = (b[i - q] as number) + ni * (N[l] as number);
      }
    }
  }
  const x = solveBand(band, rhs, DEGREE);
  if (x === undefined) return undefined;
  return [[...first], ...x, [...last]];
}

function curveOf(
  ctrl: readonly (readonly number[])[],
  offset: number,
  knots: readonly number[],
): NurbsCurve {
  return {
    degree: DEGREE,
    points: ctrl.map((r) => [
      r[offset] as number,
      r[offset + 1] as number,
      r[offset + 2] as number,
    ]),
    knots: [...knots],
  };
}

/** Rows `[x, y, z, uA, vA, 0, uB, vB, 0]` of a branch; a closed branch repeats its first row. */
function rowsOf(s: Samples, problem: Problem): number[][] {
  const rows = s.points.map((p, i) => {
    const a = s.uvA[i] as P2;
    const b = s.uvB[i] as P2;
    return [p[0], p[1], p[2], a[0], a[1], 0, b[0], b[1], 0];
  });
  if (s.closed) {
    const p = s.points[0] as P3;
    const ua = closeUv(s.uvA, problem.uvPeriod[0]);
    const ub = closeUv(s.uvB, problem.uvPeriod[1]);
    rows.push([p[0], p[1], p[2], ua[0], ua[1], 0, ub[0], ub[1], 0]);
  }
  return rows;
}

/** The first (u, v) of a closed branch continued past its last point (shifted by whole periods). */
function closeUv(uv: readonly P2[], period: readonly [number, number]): P2 {
  const a = uv[0] as P2;
  const z = uv[uv.length - 1] as P2;
  const f = (x: number, ref: number, p: number) => (p > 0 ? x + p * Math.round((ref - x) / p) : x);
  return [f(a[0], z[0], period[0]), f(a[1], z[1], period[1])];
}

/**
 * Geometric distance of `q` from the intersection curve: correct a state near `guess` onto the curve
 * in the plane through `q` normal to the local tangent.
 */
function offCurve(problem: Problem, q: P3, guess: readonly number[]): number {
  const l = problem.local(guess);
  if (l === undefined) return Infinity;
  const x = problem.correct(guess, { kind: 'plane', anchor: q, t: l.t });
  return x === undefined ? Infinity : dist3(problem.point(x), q);
}

/**
 * Largest geometric deviation of the fitted curve and both pcurve images from the intersection,
 * checked at the data parameters and their midpoints.
 */
function measure(
  problem: Problem,
  s: Samples,
  params: readonly number[],
  fit: Omit<Fitted, 'bound'>,
): number {
  let worst = 0;
  const xs = s.closed
    ? [
        ...s.xs,
        toward(problem, s.xs[0] as readonly number[], s.xs[s.xs.length - 1] as readonly number[]),
      ]
    : s.xs;
  const check = (t: number, guess: readonly number[]) => {
    const c = curvePoint(fit.curve, t) as unknown as P3;
    const a = curvePoint(fit.onA, t);
    const b = curvePoint(fit.onB, t);
    worst = Math.max(
      worst,
      offCurve(problem, c, guess),
      offCurve(problem, problem.imageA([a[0], a[1]]), guess),
      offCurve(problem, problem.imageB([b[0], b[1]]), guess),
    );
  };
  for (let i = 0; i < params.length && worst !== Infinity; i++) {
    const x0 = xs[i] as readonly number[];
    check(params[i] as number, x0);
    if (i + 1 < params.length) {
      const x1 = xs[i + 1] as readonly number[];
      check(
        0.5 * ((params[i] as number) + (params[i + 1] as number)),
        x0.map((v, k) => 0.5 * (v + (x1[k] as number))),
      );
    }
  }
  return worst;
}

/** `x` shifted by whole periods of the state to lie next to `ref`. */
function toward(problem: Problem, x: readonly number[], ref: readonly number[]): number[] {
  return x.map((v, k) => {
    const p = problem.period[k] as number;
    return p > 0 ? v - p * Math.round((v - (ref[k] as number)) / p) : v;
  });
}

/** Insert a corrected point between every pair of consecutive samples. */
function densify(problem: Problem, s: Samples): Samples | undefined {
  const n = s.points.length;
  const xs: (readonly number[])[] = [];
  const kinks: number[] = [];
  const kinkSet = new Set(s.kinks);
  const segs = s.closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    if (kinkSet.has(i)) kinks.push(xs.length);
    const x0 = s.xs[i] as readonly number[];
    xs.push(x0);
    if (i >= segs) continue;
    const unwrapped = toward(problem, s.xs[(i + 1) % n] as readonly number[], x0);
    const mid = x0.map((v, k) => 0.5 * (v + (unwrapped[k] as number)));
    const l = problem.local(mid);
    const p0 = s.points[i] as P3;
    const p1 = s.points[(i + 1) % n] as P3;
    const anchor: P3 = [0.5 * (p0[0] + p1[0]), 0.5 * (p0[1] + p1[1]), 0.5 * (p0[2] + p1[2])];
    const chord = sub3(p1, p0);
    const q =
      l === undefined ? undefined : problem.correct(mid, { kind: 'plane', anchor, t: chord });
    if (q === undefined) return undefined;
    xs.push(q);
  }
  return withSamples(problem, xs, s.closed, kinks);
}

/** Samples of a state sequence: points and both (u, v) unwrapped along the branch. */
export function withSamples(
  problem: Problem,
  xs: readonly (readonly number[])[],
  closed: boolean,
  kinks: readonly number[],
): Samples {
  const uvA: P2[] = [];
  const uvB: P2[] = [];
  const unwrap = (prev: P2 | undefined, uv: P2, period: readonly [number, number]): P2 => {
    if (prev === undefined) return uv;
    const f = (x: number, ref: number, p: number) =>
      p > 0 ? x + p * Math.round((ref - x) / p) : x;
    return [f(uv[0], prev[0], period[0]), f(uv[1], prev[1], period[1])];
  };
  for (const x of xs) {
    const [a, b] = problem.uv(x);
    uvA.push(unwrap(uvA[uvA.length - 1], a, problem.uvPeriod[0]));
    uvB.push(unwrap(uvB[uvB.length - 1], b, problem.uvPeriod[1]));
  }
  return { xs, points: xs.map((x) => problem.point(x)), uvA, uvB, closed, kinks };
}

/**
 * Cubic fit of a branch and its two pcurves on one parameter and knot vector, refined (more
 * control points, then denser samples) until the measured deviation is within `tol`.
 */
export function fitBranch(
  problem: Problem,
  samples: Samples,
  tol: number,
): { readonly fit: Fitted; readonly ok: boolean } | undefined {
  let s = samples;
  let best: Fitted | undefined;
  for (let round = 0; round < ROUNDS; round++) {
    const rows = rowsOf(s, problem);
    const pts = rows.map((r) => [r[0], r[1], r[2]] as unknown as P3);
    const params = chordParams(pts);
    if (!params.every(Number.isFinite)) return undefined;
    const kinks = s.kinks;
    for (let stride = 8; stride >= 2; stride /= 2) {
      const knots = knotsFor(params, kinks, stride);
      const ctrl = fitRows(rows, params, knots);
      if (ctrl === undefined) continue;
      const fit = {
        curve: curveOf(ctrl, 0, knots),
        onA: curveOf(ctrl, 3, knots),
        onB: curveOf(ctrl, 6, knots),
        bound: 0,
      };
      const bound = Math.max(measure(problem, s, params, fit) * SSI_BOUND_SAFETY, 1e-15);
      if (bound <= tol) return { fit: { ...fit, bound }, ok: true };
      if (best === undefined || bound < best.bound) best = { ...fit, bound };
    }
    const denser = densify(problem, s);
    if (denser === undefined) break;
    s = denser;
  }
  return best === undefined ? undefined : { fit: best, ok: false };
}
