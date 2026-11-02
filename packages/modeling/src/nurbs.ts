import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from './arrays';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import { fitSurface } from './nurbs-fit';
import { matchSurfaces } from './nurbs-match';
import {
  surfaceCompatible,
  surfaceElevate,
  surfaceExtend,
  surfaceInsertKnot,
  surfaceRefine,
  surfaceSplit,
} from './nurbs-surface';
import { fillN } from './surface-fill';

/**
 * NURBS curves and tensor-product surfaces (The NURBS Book, Piegl and Tiller): basis
 * functions, rational points and derivatives, knot insertion and refinement, degree
 * elevation, and construction by interpolation, approximation, skinning and Gordon
 * networks. Values are plain data; every constructor validates and returns a Result.
 * Algorithm numbers (A2.1 ...) refer to the book.
 */
export interface NurbsCurve {
  readonly degree: number;
  readonly points: readonly Tuple3[];
  /** One positive weight per point; absent means 1 (non-rational). */
  readonly weights?: readonly number[];
  /** Non-decreasing, `points.length + degree + 1` values. */
  readonly knots: readonly number[];
}

/** Control net `points[i][j]`: i runs along u, j along v. */
export interface NurbsSurface {
  readonly degreeU: number;
  readonly degreeV: number;
  readonly points: readonly (readonly Tuple3[])[];
  readonly weights?: readonly (readonly number[])[];
  readonly knotsU: readonly number[];
  readonly knotsV: readonly number[];
}

export type Parametrization = 'uniform' | 'chord' | 'centripetal';

export interface InterpolateOptions {
  /** Default 3, clamped to the point count - 1. */
  readonly degree?: number;
  /** Default 'centripetal'. */
  readonly parametrization?: Parametrization;
  /** Explicit increasing parameters, one per point, from 0 to 1 (overrides `parametrization`). */
  readonly parameters?: readonly number[];
}

export interface ApproximateOptions extends InterpolateOptions {
  /** Control points of the fit (degree + 1 ..= point count). */
  readonly controlPoints: number;
}

/** Homogeneous control points: [wx, wy, wz, w] per point. */
export type H = Float64Array;

function invalid(expected: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

function finite(values: readonly number[]): boolean {
  return values.every((v) => typeof v === 'number' && Number.isFinite(v));
}

function checkKnots(
  name: string,
  knots: readonly number[],
  count: number,
  degree: number,
): Result<void, ModelingError> {
  if (!Number.isInteger(degree) || degree < 1) {
    return err(invalid(`${name} degree is an integer >= 1`, { degree }));
  }
  if (count < degree + 1) {
    return err(invalid(`${name} has at least degree + 1 control points`, { count, degree }));
  }
  if (knots.length !== count + degree + 1 || !finite(knots)) {
    return err(invalid(`${name} has ${count + degree + 1} finite knots`, { knots: knots.length }));
  }
  for (let i = 1; i < knots.length; i++) {
    if ((knots[i] as number) < (knots[i - 1] as number)) {
      return err(invalid(`${name} knots are non-decreasing`, { at: i }));
    }
  }
  if ((knots[count] as number) <= (knots[degree] as number)) {
    return err(invalid(`${name} has a non-empty parameter domain`, {}));
  }
  for (let i = degree + 1; i < count; i++) {
    let m = 1;
    while (i + m < count && knots[i + m] === knots[i]) m++;
    if (m > degree) {
      return err(invalid(`${name} interior knots have multiplicity <= degree`, { at: i }));
    }
  }
  return ok(undefined);
}

function checkPoint(name: string, p: Tuple3, w: number): Result<void, ModelingError> {
  if (!finite(p) || p.length !== 3)
    return err(invalid(`${name} points are finite [x, y, z]`, { point: p }));
  if (!Number.isFinite(w) || w <= 0)
    return err(invalid(`${name} weights are finite and > 0`, { weight: w }));
  return ok(undefined);
}

const curveCache = new WeakMap<NurbsCurve, H>();
const surfaceCache = new WeakMap<NurbsSurface, H>();

function curveH(curve: NurbsCurve): H {
  const cached = curveCache.get(curve);
  if (cached !== undefined) return cached;
  const n = curve.points.length;
  const h = new Float64Array(4 * n);
  for (let i = 0; i < n; i++) {
    const p = curve.points[i] as Tuple3;
    const w = curve.weights?.[i] ?? 1;
    h.set([p[0] * w, p[1] * w, p[2] * w, w], 4 * i);
  }
  curveCache.set(curve, h);
  return h;
}

function fromH(h: H, count: number): { points: Tuple3[]; weights: number[]; rational: boolean } {
  const points: Tuple3[] = [];
  const weights: number[] = [];
  let rational = false;
  for (let i = 0; i < count; i++) {
    const w = h[4 * i + 3] as number;
    points.push([
      (h[4 * i] as number) / w,
      (h[4 * i + 1] as number) / w,
      (h[4 * i + 2] as number) / w,
    ]);
    weights.push(w);
    if (w !== 1) rational = true;
  }
  return { points, weights, rational };
}

function curveFromH(degree: number, knots: readonly number[], h: H): NurbsCurve {
  const { points, weights, rational } = fromH(h, h.length / 4);
  return rational
    ? { degree, points, weights, knots: [...knots] }
    : { degree, points, knots: [...knots] };
}

export function surfaceH(s: NurbsSurface): H {
  const cached = surfaceCache.get(s);
  if (cached !== undefined) return cached;
  const nu = s.points.length;
  const nv = (s.points[0] as readonly Tuple3[]).length;
  const h = new Float64Array(4 * nu * nv);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const p = (s.points[i] as readonly Tuple3[])[j] as Tuple3;
      const w = s.weights?.[i]?.[j] ?? 1;
      h.set([p[0] * w, p[1] * w, p[2] * w, w], 4 * (i * nv + j));
    }
  }
  surfaceCache.set(s, h);
  return h;
}

export function surfaceFromH(
  degreeU: number,
  degreeV: number,
  knotsU: readonly number[],
  knotsV: readonly number[],
  h: H,
  nu: number,
  nv: number,
): NurbsSurface {
  const { points, weights, rational } = fromH(h, nu * nv);
  const rows = (values: readonly Tuple3[] | readonly number[]) =>
    Array.from({ length: nu }, (_, i) => values.slice(i * nv, (i + 1) * nv));
  const base = {
    degreeU,
    degreeV,
    points: rows(points) as Tuple3[][],
    knotsU: [...knotsU],
    knotsV: [...knotsV],
  };
  return rational ? { ...base, weights: rows(weights) as number[][] } : base;
}

// ---- validation -------------------------------------------------------------------

export function checkCurve(curve: NurbsCurve): Result<NurbsCurve, ModelingError> {
  const n = curve.points.length;
  const knots = checkKnots('curve', curve.knots, n, curve.degree);
  if (!knots.ok) return knots;
  if (curve.weights !== undefined && curve.weights.length !== n) {
    return err(invalid('curve has one weight per point', { weights: curve.weights.length }));
  }
  for (let i = 0; i < n; i++) {
    const checked = checkPoint('curve', curve.points[i] as Tuple3, curve.weights?.[i] ?? 1);
    if (!checked.ok) return checked;
  }
  return ok(curve);
}

export function checkSurface(s: NurbsSurface): Result<NurbsSurface, ModelingError> {
  const nu = s.points.length;
  const nv = s.points[0]?.length ?? 0;
  if (s.points.some((row) => row.length !== nv)) {
    return err(invalid('surface control rows have equal length', {}));
  }
  const u = checkKnots('surface u', s.knotsU, nu, s.degreeU);
  if (!u.ok) return u;
  const v = checkKnots('surface v', s.knotsV, nv, s.degreeV);
  if (!v.ok) return v;
  if (
    s.weights !== undefined &&
    (s.weights.length !== nu || s.weights.some((r) => r.length !== nv))
  ) {
    return err(invalid('surface has one weight per control point', {}));
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const checked = checkPoint(
        'surface',
        (s.points[i] as readonly Tuple3[])[j] as Tuple3,
        s.weights?.[i]?.[j] ?? 1,
      );
      if (!checked.ok) return checked;
    }
  }
  return ok(s);
}

// ---- basis (A2.1-A2.3) -------------------------------------------------------------------

/** Knot span index of `u` (A2.1); `n` is the control point count. */
export function findSpan(n: number, p: number, u: number, knots: readonly number[]): number {
  if (u >= (knots[n] as number)) {
    let span = n - 1;
    while (span > p && (knots[span] as number) === (knots[span + 1] as number)) span--;
    return span;
  }
  if (u <= (knots[p] as number)) return p;
  let low = p;
  let high = n;
  let mid = (low + high) >> 1;
  while (u < (knots[mid] as number) || u >= (knots[mid + 1] as number)) {
    if (u < (knots[mid] as number)) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/** Non-zero basis functions N[span-p..span] at `u` (A2.2). */
export function basisFunctions(
  span: number,
  u: number,
  p: number,
  knots: readonly number[],
): number[] {
  const N = new Array<number>(p + 1).fill(0);
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - (knots[span + 1 - j] as number);
    right[j] = (knots[span + j] as number) - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = (N[r] as number) / ((right[r + 1] as number) + (left[j - r] as number));
      N[r] = saved + (right[r + 1] as number) * temp;
      saved = (left[j - r] as number) * temp;
    }
    N[j] = saved;
  }
  return N;
}

/** Basis functions and their derivatives up to order `n`: ders[k][j] (A2.3). */
export function basisDerivatives(
  span: number,
  u: number,
  p: number,
  n: number,
  knots: readonly number[],
): number[][] {
  const ndu = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0));
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  (ndu[0] as number[])[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - (knots[span + 1 - j] as number);
    right[j] = (knots[span + j] as number) - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      (ndu[j] as number[])[r] = (right[r + 1] as number) + (left[j - r] as number);
      const temp = ((ndu[r] as number[])[j - 1] as number) / ((ndu[j] as number[])[r] as number);
      (ndu[r] as number[])[j] = saved + (right[r + 1] as number) * temp;
      saved = (left[j - r] as number) * temp;
    }
    (ndu[j] as number[])[j] = saved;
  }
  const ders = Array.from({ length: n + 1 }, () => new Array<number>(p + 1).fill(0));
  for (let j = 0; j <= p; j++) (ders[0] as number[])[j] = (ndu[j] as number[])[p] as number;
  const a = [new Array<number>(p + 1).fill(0), new Array<number>(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0;
    let s2 = 1;
    (a[0] as number[])[0] = 1;
    for (let k = 1; k <= n; k++) {
      let d = 0;
      const rk = r - k;
      const pk = p - k;
      const as1 = a[s1] as number[];
      const as2 = a[s2] as number[];
      if (r >= k) {
        as2[0] = (as1[0] as number) / ((ndu[pk + 1] as number[])[rk] as number);
        d = (as2[0] as number) * ((ndu[rk] as number[])[pk] as number);
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        as2[j] =
          ((as1[j] as number) - (as1[j - 1] as number)) /
          ((ndu[pk + 1] as number[])[rk + j] as number);
        d += (as2[j] as number) * ((ndu[rk + j] as number[])[pk] as number);
      }
      if (r <= pk) {
        as2[k] = -(as1[k - 1] as number) / ((ndu[pk + 1] as number[])[r] as number);
        d += (as2[k] as number) * ((ndu[r] as number[])[pk] as number);
      }
      (ders[k] as number[])[r] = d;
      const t = s1;
      s1 = s2;
      s2 = t;
    }
  }
  let factor = p;
  for (let k = 1; k <= n; k++) {
    for (let j = 0; j <= p; j++)
      (ders[k] as number[])[j] = ((ders[k] as number[])[j] as number) * factor;
    factor *= p - k;
  }
  return ders;
}

export function binomial(n: number, k: number): number {
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return out;
}

// ---- evaluation (A4.1-A4.4) ---------------------------------------------------------------

export function domain(curve: NurbsCurve): readonly [number, number] {
  return [curve.knots[curve.degree] as number, curve.knots[curve.points.length] as number];
}

export function surfaceDomain(
  s: NurbsSurface,
): readonly [readonly [number, number], readonly [number, number]] {
  return [
    [s.knotsU[s.degreeU] as number, s.knotsU[s.points.length] as number],
    [s.knotsV[s.degreeV] as number, s.knotsV[(s.points[0] as readonly Tuple3[]).length] as number],
  ];
}

/** Rational derivatives from homogeneous ones (A4.2 / Eq. 4.8). */
function rationalCurve(Aw: Float64Array[], n: number): Tuple3[] {
  const out: Tuple3[] = [];
  const w0 = (Aw[0] as Float64Array)[3] as number;
  for (let k = 0; k <= n; k++) {
    const v = [
      (Aw[k] as Float64Array)[0] as number,
      (Aw[k] as Float64Array)[1] as number,
      (Aw[k] as Float64Array)[2] as number,
    ];
    for (let i = 1; i <= k; i++) {
      const b = binomial(k, i) * ((Aw[i] as Float64Array)[3] as number);
      const c = out[k - i] as Tuple3;
      v[0] = (v[0] as number) - b * c[0];
      v[1] = (v[1] as number) - b * c[1];
      v[2] = (v[2] as number) - b * c[2];
    }
    out.push([(v[0] as number) / w0, (v[1] as number) / w0, (v[2] as number) / w0]);
  }
  return out;
}

/** Point and derivatives up to order `n` at `t`: [C, C', C'', ...]. */
export function curveDerivatives(curve: NurbsCurve, t: number, n = 1): Tuple3[] {
  const p = curve.degree;
  const count = curve.points.length;
  const h = curveH(curve);
  const span = findSpan(count, p, t, curve.knots);
  const du = Math.min(n, p);
  const ders = basisDerivatives(span, t, p, du, curve.knots);
  const Aw: Float64Array[] = [];
  for (let k = 0; k <= n; k++) {
    const a = new Float64Array(4);
    if (k <= du) {
      for (let j = 0; j <= p; j++) {
        const b = (ders[k] as number[])[j] as number;
        const o = 4 * (span - p + j);
        for (let c = 0; c < 4; c++) a[c] = (a[c] as number) + b * (h[o + c] as number);
      }
    }
    Aw.push(a);
  }
  return rationalCurve(Aw, n);
}

export function curvePoint(curve: NurbsCurve, t: number): Tuple3 {
  return curveDerivatives(curve, t, 0)[0] as Tuple3;
}

/**
 * Surface point and partial derivatives: `out[k][l]` is the derivative k times in u
 * and l times in v, for k + l <= n (A3.6 with Eq. 4.20).
 */
export function surfaceDerivatives(s: NurbsSurface, u: number, v: number, n = 1): Tuple3[][] {
  const nu = s.points.length;
  const nv = (s.points[0] as readonly Tuple3[]).length;
  const p = s.degreeU;
  const q = s.degreeV;
  const h = surfaceH(s);
  const du = Math.min(n, p);
  const dv = Math.min(n, q);
  const su = findSpan(nu, p, u, s.knotsU);
  const sv = findSpan(nv, q, v, s.knotsV);
  const Nu = basisDerivatives(su, u, p, du, s.knotsU);
  const Nv = basisDerivatives(sv, v, q, dv, s.knotsV);
  const SKLw = Array.from({ length: n + 1 }, () =>
    Array.from({ length: n + 1 }, () => new Float64Array(4)),
  );
  for (let k = 0; k <= du; k++) {
    const temp = Array.from({ length: q + 1 }, () => new Float64Array(4));
    for (let sIdx = 0; sIdx <= q; sIdx++) {
      const t = temp[sIdx] as Float64Array;
      for (let r = 0; r <= p; r++) {
        const b = (Nu[k] as number[])[r] as number;
        const o = 4 * ((su - p + r) * nv + (sv - q + sIdx));
        for (let c = 0; c < 4; c++) t[c] = (t[c] as number) + b * (h[o + c] as number);
      }
    }
    const dd = Math.min(n - k, dv);
    for (let l = 0; l <= dd; l++) {
      const out = (SKLw[k] as Float64Array[])[l] as Float64Array;
      for (let sIdx = 0; sIdx <= q; sIdx++) {
        const b = (Nv[l] as number[])[sIdx] as number;
        const t = temp[sIdx] as Float64Array;
        for (let c = 0; c < 4; c++) out[c] = (out[c] as number) + b * (t[c] as number);
      }
    }
  }
  const SKL: Tuple3[][] = Array.from({ length: n + 1 }, () => [] as Tuple3[]);
  const w00 = ((SKLw[0] as Float64Array[])[0] as Float64Array)[3] as number;
  const wOf = (k: number, l: number) =>
    ((SKLw[k] as Float64Array[])[l] as Float64Array)[3] as number;
  for (let k = 0; k <= n; k++) {
    for (let l = 0; l <= n - k; l++) {
      const a = (SKLw[k] as Float64Array[])[l] as Float64Array;
      const v3 = [a[0] as number, a[1] as number, a[2] as number];
      const sub = (scale: number, p3: Tuple3) => {
        v3[0] = (v3[0] as number) - scale * p3[0];
        v3[1] = (v3[1] as number) - scale * p3[1];
        v3[2] = (v3[2] as number) - scale * p3[2];
      };
      for (let j = 1; j <= l; j++)
        sub(binomial(l, j) * wOf(0, j), (SKL[k] as Tuple3[])[l - j] as Tuple3);
      for (let i = 1; i <= k; i++) {
        sub(binomial(k, i) * wOf(i, 0), (SKL[k - i] as Tuple3[])[l] as Tuple3);
        for (let j = 1; j <= l; j++) {
          sub(
            binomial(k, i) * binomial(l, j) * wOf(i, j),
            (SKL[k - i] as Tuple3[])[l - j] as Tuple3,
          );
        }
      }
      (SKL[k] as Tuple3[])[l] = [
        (v3[0] as number) / w00,
        (v3[1] as number) / w00,
        (v3[2] as number) / w00,
      ];
    }
  }
  return SKL;
}

export function surfacePoint(s: NurbsSurface, u: number, v: number): Tuple3 {
  return (surfaceDerivatives(s, u, v, 0)[0] as Tuple3[])[0] as Tuple3;
}

// ---- knot insertion, refinement, elevation (A5.1, A5.9 via Bezier) ---------------------

/** Insert `t` `times` times into homogeneous points `h` (A5.1). */
export function insertH(
  p: number,
  knots: readonly number[],
  h: H,
  t: number,
  times: number,
): { knots: number[]; h: H } {
  const np = h.length / 4;
  // The span with knots[k] <= t < knots[k + 1] (A5.1); findSpan would step back to the last
  // non-empty span at the domain end, which is wrong for an unclamped end.
  let k = knots.length - 2;
  while (k > p && (knots[k] as number) > t) k--;
  let s = 0;
  for (const knot of knots) if (knot === t) s++;
  const r = Math.min(times, p - s);
  if (r <= 0) return { knots: [...knots], h: Float64Array.from(h) };
  const UQ = [...knots.slice(0, k + 1), ...new Array<number>(r).fill(t), ...knots.slice(k + 1)];
  const Q = new Float64Array(4 * (np + r));
  for (let i = 0; i <= k - p; i++) Q.set(h.subarray(4 * i, 4 * i + 4), 4 * i);
  for (let i = k - s; i < np; i++) Q.set(h.subarray(4 * i, 4 * i + 4), 4 * (i + r));
  const Rw: Float64Array[] = [];
  for (let i = 0; i <= p - s; i++)
    Rw.push(Float64Array.from(h.subarray(4 * (k - p + i), 4 * (k - p + i) + 4)));
  let L = 0;
  for (let j = 1; j <= r; j++) {
    L = k - p + j;
    for (let i = 0; i <= p - j - s; i++) {
      const alpha =
        (t - (knots[L + i] as number)) / ((knots[i + k + 1] as number) - (knots[L + i] as number));
      const a = Rw[i + 1] as Float64Array;
      const b = Rw[i] as Float64Array;
      for (let c = 0; c < 4; c++) b[c] = alpha * (a[c] as number) + (1 - alpha) * (b[c] as number);
    }
    Q.set(Rw[0] as Float64Array, 4 * L);
    Q.set(Rw[p - j - s] as Float64Array, 4 * (k + r - j - s));
  }
  for (let i = L + 1; i < k - s; i++) Q.set(Rw[i - L] as Float64Array, 4 * i);
  return { knots: UQ, h: Q };
}

/** Insert knot `t` up to `times` times (multiplicity stops at the degree). */
export function insertKnot(curve: NurbsCurve, t: number, times = 1): NurbsCurve {
  const out = insertH(curve.degree, curve.knots, curveH(curve), t, times);
  return curveFromH(curve.degree, out.knots, out.h);
}

/**
 * Split at `t` (strictly inside the domain) into the curve before and the curve after,
 * each on its original parameters; they are one polynomial, so the joint is exact.
 */
export function splitCurve(
  curve: NurbsCurve,
  t: number,
): Result<readonly [NurbsCurve, NurbsCurve], ModelingError> {
  const checked = checkCurve(curve);
  if (!checked.ok) return checked;
  const [a, b] = domain(curve);
  if (!(Number.isFinite(t) && t > a && t < b))
    return err(
      invalid('the split parameter lies strictly inside the domain', { t, domain: [a, b] }),
    );
  const p = curve.degree;
  const clamped = clampH(p, curve.knots, curveH(curve));
  const out = insertH(p, clamped.knots, clamped.h, t, p);
  const first = out.knots.indexOf(t);
  const last = out.knots.lastIndexOf(t);
  return ok([
    curveFromH(
      p,
      [...out.knots.slice(0, first), ...new Array<number>(p + 1).fill(t)],
      out.h.slice(0, 4 * first),
    ),
    curveFromH(
      p,
      [...new Array<number>(p + 1).fill(t), ...out.knots.slice(last + 1)],
      out.h.slice(4 * (last - p)),
    ),
  ]);
}

/** Insert every knot of `knots` (a non-decreasing list) that is missing (refinement). */
export function refineH(
  p: number,
  knots: readonly number[],
  h: H,
  target: readonly number[],
): { knots: number[]; h: H } {
  let current = { knots: [...knots], h };
  const count = (list: readonly number[], t: number) => list.filter((k) => k === t).length;
  for (const t of [...new Set(target)]) {
    const missing = count(target, t) - count(current.knots, t);
    if (missing > 0) current = insertH(p, current.knots, current.h, t, missing);
  }
  return current;
}

export function refine(curve: NurbsCurve, knots: readonly number[]): NurbsCurve {
  const out = refineH(curve.degree, curve.knots, curveH(curve), knots);
  return curveFromH(curve.degree, out.knots, out.h);
}

const lerp4 = (a: H, b: H, alpha: number): H => {
  const out = new Float64Array(4);
  for (let c = 0; c < 4; c++) out[c] = alpha * (a[c] as number) + (1 - alpha) * (b[c] as number);
  return out;
};

/**
 * Raise the degree of a clamped curve by `by` exactly (A5.9): Bezier pieces are
 * elevated and the interior knots removed again, so each keeps its multiplicity + `by`.
 */
export function elevateH(
  p: number,
  knots: readonly number[],
  h: H,
  by: number,
): { knots: number[]; h: H } {
  if (by <= 0) return { knots: [...knots], h };
  const P = Array.from({ length: h.length / 4 }, (_, i) => h.subarray(4 * i, 4 * i + 4));
  const m = P.length + p;
  const ph = p + by;
  const ph2 = ph >> 1;
  const bezalfs = Array.from({ length: ph + 1 }, () => new Array<number>(p + 1).fill(0));
  (bezalfs[0] as number[])[0] = 1;
  (bezalfs[ph] as number[])[p] = 1;
  for (let i = 1; i <= ph2; i++) {
    const inv = 1 / binomial(ph, i);
    for (let j = Math.max(0, i - by); j <= Math.min(p, i); j++)
      (bezalfs[i] as number[])[j] = inv * binomial(p, j) * binomial(by, i - j);
  }
  for (let i = ph2 + 1; i < ph; i++)
    for (let j = Math.max(0, i - by); j <= Math.min(p, i); j++)
      (bezalfs[i] as number[])[j] = (bezalfs[ph - i] as number[])[p - j] as number;
  const Uh: number[] = [];
  const Q: H[] = [Float64Array.from(P[0] as H)];
  let kind = ph + 1;
  let r = -1;
  let a = p;
  let b = p + 1;
  let cind = 1;
  let ua = knots[0] as number;
  for (let i = 0; i <= ph; i++) Uh[i] = ua;
  let bpts: H[] = P.slice(0, p + 1).map((x) => Float64Array.from(x));
  const next: H[] = [];
  const ebpts: H[] = [];
  const alfs: number[] = [];
  while (b < m) {
    const i0 = b;
    while (b < m && knots[b] === knots[b + 1]) b++;
    const mul = b - i0 + 1;
    const ub = knots[b] as number;
    const oldr = r;
    r = p - mul;
    const lbz = oldr > 0 ? (oldr + 2) >> 1 : 1;
    const rbz = r > 0 ? ph - ((r + 1) >> 1) : ph;
    if (r > 0) {
      for (let k = p; k > mul; k--) alfs[k - mul - 1] = (ub - ua) / ((knots[a + k] as number) - ua);
      for (let j = 1; j <= r; j++) {
        const s = mul + j;
        for (let k = p; k >= s; k--)
          bpts[k] = lerp4(bpts[k] as H, bpts[k - 1] as H, alfs[k - s] as number);
        next[r - j] = bpts[p] as H;
      }
    }
    for (let i = lbz; i <= ph; i++) {
      const e = new Float64Array(4);
      for (let j = Math.max(0, i - by); j <= Math.min(p, i); j++) {
        const f = (bezalfs[i] as number[])[j] as number;
        for (let c = 0; c < 4; c++) e[c] = (e[c] as number) + f * ((bpts[j] as H)[c] as number);
      }
      ebpts[i] = e;
    }
    if (oldr > 1) {
      let first = kind - 2;
      let last = kind;
      const den = ub - ua;
      const bet = (ub - (Uh[kind - 1] as number)) / den;
      for (let tr = 1; tr < oldr; tr++) {
        let i = first;
        let j = last;
        let kj = j - kind + 1;
        while (j - i > tr) {
          if (i < cind) {
            const alf = (ub - (Uh[i] as number)) / (ua - (Uh[i] as number));
            Q[i] = lerp4(Q[i] as H, Q[i - 1] as H, alf);
          }
          if (j >= lbz) {
            const g = j - tr <= kind - ph + oldr ? (ub - (Uh[j - tr] as number)) / den : bet;
            ebpts[kj] = lerp4(ebpts[kj] as H, ebpts[kj + 1] as H, g);
          }
          i++;
          j--;
          kj--;
        }
        first--;
        last++;
      }
    }
    if (a !== p) for (let i = 0; i < ph - oldr; i++) Uh[kind++] = ua;
    for (let j = lbz; j <= rbz; j++) Q[cind++] = ebpts[j] as H;
    if (b < m) {
      bpts = [...next.slice(0, r), ...P.slice(b - p + r, b + 1).map((x) => Float64Array.from(x))];
      a = b;
      b++;
      ua = ub;
    } else for (let i = 0; i <= ph; i++) Uh[kind + i] = ub;
  }
  const out = new Float64Array(4 * Q.length);
  for (const [i, q] of Q.entries()) out.set(q, 4 * i);
  return { knots: Uh, h: out };
}

/**
 * Remove one copy of the interior knot `u` (A5.8) when the curve moves by at most `tol`
 * (homogeneous distance); undefined when it would move more.
 */
export function removeKnotH(
  p: number,
  knots: readonly number[],
  h: H,
  u: number,
  tol: number,
): { knots: number[]; h: H } | undefined {
  const n = h.length / 4 - 1;
  const r = knots.lastIndexOf(u);
  const s = knots.filter((k) => k === u).length;
  if (r <= p || r > n || s < 1) return undefined;
  const P = Array.from({ length: n + 1 }, (_, i) => h.subarray(4 * i, 4 * i + 4));
  const ord = p + 1;
  const first = r - p;
  const last = r - s;
  const off = first - 1;
  const temp: H[] = [];
  temp[0] = P[off] as H;
  temp[last + 1 - off] = P[last + 1] as H;
  let i = first;
  let j = last;
  let ii = 1;
  let jj = last - off;
  while (j - i > 0) {
    const ai = (u - (knots[i] as number)) / ((knots[i + ord] as number) - (knots[i] as number));
    const aj = (u - (knots[j] as number)) / ((knots[j + ord] as number) - (knots[j] as number));
    const ti = new Float64Array(4);
    const tj = new Float64Array(4);
    for (let c = 0; c < 4; c++) {
      ti[c] = (((P[i] as H)[c] as number) - (1 - ai) * ((temp[ii - 1] as H)[c] as number)) / ai;
      tj[c] = (((P[j] as H)[c] as number) - aj * ((temp[jj + 1] as H)[c] as number)) / (1 - aj);
    }
    temp[ii] = ti;
    temp[jj] = tj;
    i++;
    ii++;
    j--;
    jj--;
  }
  const d4 = (x: H, y: H) => {
    let sum = 0;
    for (let c = 0; c < 4; c++) {
      const d = (x[c] as number) - (y[c] as number);
      sum += d * d;
    }
    return Math.sqrt(sum);
  };
  if (j - i < 0) {
    if (d4(temp[ii - 1] as H, temp[jj + 1] as H) > tol) return undefined;
  } else {
    const ai = (u - (knots[i] as number)) / ((knots[i + ord] as number) - (knots[i] as number));
    if (d4(P[i] as H, lerp4(temp[ii + 1] as H, temp[ii - 1] as H, ai)) > tol) return undefined;
  }
  const Q: H[] = P.map((x) => Float64Array.from(x));
  for (i = first, j = last; j - i > 0; i++, j--) {
    Q[i] = temp[i - off] as H;
    Q[j] = temp[j - off] as H;
  }
  const fout = (2 * r - s - p) >> 1;
  Q.splice(fout, 1);
  const out = new Float64Array(4 * n);
  for (const [k, q] of Q.entries()) out.set(q, 4 * k);
  return { knots: knots.filter((_, k) => k !== r), h: out };
}

/** The same curve with clamped end knots on its own domain. */
export function clampH(p: number, knots: readonly number[], h: H): { knots: number[]; h: H } {
  const np = h.length / 4;
  const a = knots[p] as number;
  const b = knots[np] as number;
  let out = insertH(p, knots, h, a, p);
  out = insertH(p, out.knots, out.h, b, p);
  const start = out.knots.lastIndexOf(a) - p;
  const end = out.knots.indexOf(b) + p;
  const clamped = out.knots.slice(start, end + 1);
  for (let i = 0; i <= p; i++) {
    clamped[i] = a;
    clamped[clamped.length - 1 - i] = b;
  }
  const count = clamped.length - p - 1;
  return { knots: clamped, h: out.h.slice(4 * start, 4 * (start + count)) };
}

export function elevate(curve: NurbsCurve, by = 1): NurbsCurve {
  const clamped = clampH(curve.degree, curve.knots, curveH(curve));
  const out = elevateH(curve.degree, clamped.knots, clamped.h, by);
  return curveFromH(curve.degree + by, out.knots, out.h);
}

/** The same curve on the parameter domain [0, 1] with clamped end knots. */
export function normalizeCurve(curve: NurbsCurve): NurbsCurve {
  const clamped = clampH(curve.degree, curve.knots, curveH(curve));
  const [a, b] = [clamped.knots[0] as number, clamped.knots[clamped.knots.length - 1] as number];
  return curveFromH(
    curve.degree,
    clamped.knots.map((t) => (t === b ? 1 : (t - a) / (b - a))),
    clamped.h,
  );
}

// ---- linear algebra ------------------------------------------------------------------

/** Solve A X = B (A n x n row-major, B n x m) by Gaussian elimination with partial pivoting. */
export function solve(
  A: Float64Array,
  B: Float64Array,
  n: number,
  m: number,
): Result<Float64Array, ModelingError> {
  const a = Float64Array.from(A);
  const b = Float64Array.from(B);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r * n + col] as number) > Math.abs(a[pivot * n + col] as number)) pivot = r;
    }
    if (Math.abs(a[pivot * n + col] as number) < 1e-14) {
      return err(
        modelingError(
          'model-degenerate',
          'the fitting system is non-singular',
          { column: col },
          'remove duplicate points or lower the degree',
        ),
      );
    }
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = a[col * n + c] as number;
        a[col * n + c] = a[pivot * n + c] as number;
        a[pivot * n + c] = t;
      }
      for (let c = 0; c < m; c++) {
        const t = b[col * m + c] as number;
        b[col * m + c] = b[pivot * m + c] as number;
        b[pivot * m + c] = t;
      }
    }
    for (let r = col + 1; r < n; r++) {
      const f = (a[r * n + col] as number) / (a[col * n + col] as number);
      if (f === 0) continue;
      for (let c = col; c < n; c++)
        a[r * n + c] = (a[r * n + c] as number) - f * (a[col * n + c] as number);
      for (let c = 0; c < m; c++)
        b[r * m + c] = (b[r * m + c] as number) - f * (b[col * m + c] as number);
    }
  }
  const x = new Float64Array(n * m);
  for (let r = n - 1; r >= 0; r--) {
    for (let c = 0; c < m; c++) {
      let s = b[r * m + c] as number;
      for (let k = r + 1; k < n; k++) s -= (a[r * n + k] as number) * (x[k * m + c] as number);
      x[r * m + c] = s / (a[r * n + r] as number);
    }
  }
  return ok(x);
}

// ---- fitting (A9.1, A9.7) ----------------------------------------------------------------

function distance(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++)
    s += ((a[i] as number) - (b[i] as number)) * ((a[i] as number) - (b[i] as number));
  return Math.sqrt(s);
}

/** Parameters in [0, 1] for rows of data (each row a point of any dimension). */
export function parametersOf(
  rows: readonly (readonly number[])[],
  kind: Parametrization,
): Result<number[], ModelingError> {
  const n = rows.length;
  if (kind === 'uniform') return ok(rows.map((_, i) => i / (n - 1)));
  const steps: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = distance(rows[i] as readonly number[], rows[i - 1] as readonly number[]);
    steps.push(kind === 'chord' ? d : Math.sqrt(d));
  }
  const total = steps.reduce((x, y) => x + y, 0);
  if (!(total > 0))
    return err(modelingError('model-degenerate', 'the points are not all coincident', {}));
  if (steps.some((d) => d === 0)) {
    return err(
      modelingError('model-degenerate', 'consecutive points are distinct', {
        at: steps.indexOf(0) + 1,
      }),
    );
  }
  const out = [0];
  let acc = 0;
  for (let i = 0; i < n - 2; i++) {
    acc += steps[i] as number;
    out.push(acc / total);
  }
  out.push(1);
  return ok(out);
}

/** Knots by averaging (Eq. 9.8). */
export function averagedKnots(params: readonly number[], p: number): number[] {
  const n = params.length - 1;
  const knots = new Array<number>(p + 1).fill(0);
  for (let j = 1; j <= n - p; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += params[i] as number;
    knots.push(s / p);
  }
  for (let i = 0; i <= p; i++) knots.push(1);
  return knots;
}

function checkParameters(params: readonly number[], count: number): Result<void, ModelingError> {
  if (params.length !== count || !finite(params) || params[0] !== 0 || params[count - 1] !== 1) {
    return err(
      invalid('parameters has one value per point, from 0 to 1', { parameters: params.length }),
    );
  }
  for (let i = 1; i < count; i++) {
    if ((params[i] as number) <= (params[i - 1] as number)) {
      return err(invalid('parameters increase strictly', { at: i }));
    }
  }
  return ok(undefined);
}

/** Interpolate rows of any dimension (homogeneous allowed); returns control rows. */
function interpolateRows(
  rows: readonly (readonly number[])[],
  p: number,
  params: readonly number[],
  knots: readonly number[],
): Result<Float64Array, ModelingError> {
  const n = rows.length;
  const dim = (rows[0] as readonly number[]).length;
  const A = new Float64Array(n * n);
  const B = new Float64Array(n * dim);
  for (let k = 0; k < n; k++) {
    const t = params[k] as number;
    const span = findSpan(n, p, t, knots);
    const N = basisFunctions(span, t, p, knots);
    for (let j = 0; j <= p; j++) A[k * n + span - p + j] = N[j] as number;
    for (let c = 0; c < dim; c++) B[k * dim + c] = (rows[k] as readonly number[])[c] as number;
  }
  return solve(A, B, n, dim);
}

function resolveFit(
  rows: readonly (readonly number[])[],
  options: InterpolateOptions,
): Result<{ p: number; params: number[] }, ModelingError> {
  if (rows.length < 2) return err(invalid('a fit has at least 2 points', { count: rows.length }));
  for (const row of rows)
    if (!finite(row)) return err(invalid('fit points are finite', { point: row }));
  const degree = options.degree ?? 3;
  if (!Number.isInteger(degree) || degree < 1)
    return err(invalid('degree is an integer >= 1', { degree }));
  const p = Math.min(degree, rows.length - 1);
  if (options.parameters !== undefined) {
    const checked = checkParameters(options.parameters, rows.length);
    if (!checked.ok) return checked;
    return ok({ p, params: [...options.parameters] });
  }
  const params = parametersOf(rows, options.parametrization ?? 'centripetal');
  if (!params.ok) return params;
  return ok({ p, params: params.value });
}

/** The curve through `points` (global interpolation, A9.1), parameter domain [0, 1]. */
export function interpolate(
  points: readonly Tuple3[],
  options: InterpolateOptions = {},
): Result<NurbsCurve, ModelingError> {
  const fit = resolveFit(points, options);
  if (!fit.ok) return fit;
  const { p, params } = fit.value;
  const knots = averagedKnots(params, p);
  const control = interpolateRows(points, p, params, knots);
  if (!control.ok) return control;
  const c = control.value;
  return ok({
    degree: p,
    points: points.map(
      (_, i): Tuple3 => [c[3 * i] as number, c[3 * i + 1] as number, c[3 * i + 2] as number],
    ),
    knots,
  });
}

/**
 * Least-squares curve with `controlPoints` control points through the end points and
 * near the others (A9.7), parameter domain [0, 1].
 */
export function approximate(
  points: readonly Tuple3[],
  options: ApproximateOptions,
): Result<NurbsCurve, ModelingError> {
  const fit = resolveFit(points, options);
  if (!fit.ok) return fit;
  const { p, params } = fit.value;
  const m = points.length - 1;
  const count = options.controlPoints;
  if (!Number.isInteger(count) || count < p + 1 || count > points.length) {
    return err(
      invalid('controlPoints is an integer in [degree + 1, point count]', { controlPoints: count }),
    );
  }
  if (count === points.length) return interpolate(points, { ...options, parameters: params });
  const n = count - 1;
  const d = (m + 1) / (n - p + 1);
  const knots = new Array<number>(p + 1).fill(0);
  for (let j = 1; j <= n - p; j++) {
    const i = Math.floor(j * d);
    const alpha = j * d - i;
    knots.push((1 - alpha) * (params[i - 1] as number) + alpha * (params[i] as number));
  }
  for (let i = 0; i <= p; i++) knots.push(1);
  return fitKnots(points, params, p, knots);
}

/**
 * Least-squares fit on a given clamped knot vector (end points interpolated): the core of
 * `approximate`, for callers that place knots themselves.
 * @internal
 */
export function fitKnots(
  points: readonly Tuple3[],
  params: readonly number[],
  p: number,
  knots: readonly number[],
): Result<NurbsCurve, ModelingError> {
  const m = points.length - 1;
  const count = knots.length - p - 1;
  const n = count - 1;
  const inner = n - 1;
  const P0 = points[0] as Tuple3;
  const Pn = points[m] as Tuple3;
  const Nrows: number[][] = [];
  const R: number[][] = [];
  for (let k = 1; k < m; k++) {
    const t = params[k] as number;
    const span = findSpan(count, p, t, knots);
    const N = basisFunctions(span, t, p, knots);
    const row = new Array<number>(count).fill(0);
    for (let j = 0; j <= p; j++) row[span - p + j] = N[j] as number;
    Nrows.push(row);
    const q = points[k] as Tuple3;
    R.push(
      [0, 1, 2].map(
        (c) =>
          (q[c] as number) -
          (row[0] as number) * (P0[c] as number) -
          (row[n] as number) * (Pn[c] as number),
      ),
    );
  }
  const A = new Float64Array(inner * inner);
  const B = new Float64Array(inner * 3);
  for (let k = 0; k < Nrows.length; k++) {
    const row = Nrows[k] as number[];
    for (let i = 1; i < n; i++) {
      const ni = row[i] as number;
      if (ni === 0) continue;
      for (let j = 1; j < n; j++)
        A[(i - 1) * inner + j - 1] =
          (A[(i - 1) * inner + j - 1] as number) + ni * (row[j] as number);
      for (let c = 0; c < 3; c++)
        B[(i - 1) * 3 + c] =
          (B[(i - 1) * 3 + c] as number) + ni * ((R[k] as number[])[c] as number);
    }
  }
  const x = inner === 0 ? ok(new Float64Array(0)) : solve(A, B, inner, 3);
  if (!x.ok) return x;
  const control: Tuple3[] = [P0];
  for (let i = 0; i < inner; i++)
    control.push([
      x.value[3 * i] as number,
      x.value[3 * i + 1] as number,
      x.value[3 * i + 2] as number,
    ]);
  control.push(Pn);
  return ok({ degree: p, points: control, knots: [...knots] });
}

// ---- surfaces: grid interpolation, skinning, Gordon -------------------------------------

/** Make curves compatible: same degree, clamped [0, 1] domain and one shared knot vector. */
export function compatibleCurves(curves: readonly NurbsCurve[]): NurbsCurve[] {
  const degree = maxOf(curves.map((c) => c.degree));
  const raised = curves.map((c) => {
    const n = normalizeCurve(c);
    return n.degree < degree ? elevate(n, degree - n.degree) : n;
  });
  const union = mergeKnots(raised.map((c) => c.knots));
  return raised.map((c) => refine(c, union));
}

export function mergeKnots(vectors: readonly (readonly number[])[]): number[] {
  const counts = new Map<number, number>();
  for (const knots of vectors) {
    const local = new Map<number, number>();
    for (const t of knots) local.set(t, (local.get(t) ?? 0) + 1);
    for (const [t, n] of local) counts.set(t, Math.max(counts.get(t) ?? 0, n));
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([t, n]) => new Array<number>(n).fill(t));
}

export interface LoftSurfaceOptions {
  /** Degree across the sections (default 3, clamped to section count - 1). */
  readonly degree?: number;
  readonly parametrization?: Parametrization;
  /** Explicit section parameters from 0 to 1. */
  readonly parameters?: readonly number[];
}

/**
 * Skinned surface through section curves (A10.3): u runs along the sections, v across
 * them; section k is the isoparm v = parameter k. Curves are made compatible first.
 */
export function loftSurface(
  curves: readonly NurbsCurve[],
  options: LoftSurfaceOptions = {},
): Result<NurbsSurface, ModelingError> {
  if (curves.length < 2)
    return err(invalid('a loft has at least 2 sections', { count: curves.length }));
  for (const curve of curves) {
    const checked = checkCurve(curve);
    if (!checked.ok) return checked;
  }
  const sections = compatibleCurves(curves);
  const first = sections[0] as NurbsCurve;
  const nu = first.points.length;
  const hs = sections.map(curveH);
  let params: number[];
  const q = Math.min(options.degree ?? 3, curves.length - 1);
  if (!Number.isInteger(q) || q < 1)
    return err(invalid('degree is an integer >= 1', { degree: options.degree }));
  if (options.parameters !== undefined) {
    const checked = checkParameters(options.parameters, curves.length);
    if (!checked.ok) return checked;
    params = [...options.parameters];
  } else {
    // Average the per-column parameters (Eq. 10.8 with the chosen parametrization).
    const sums = new Array<number>(curves.length).fill(0);
    let columns = 0;
    for (let i = 0; i < nu; i++) {
      const column = hs.map((h) =>
        [h[4 * i] as number, h[4 * i + 1] as number, h[4 * i + 2] as number].map(
          (v) => v / (h[4 * i + 3] as number),
        ),
      );
      const local = parametersOf(column, options.parametrization ?? 'chord');
      if (!local.ok) continue;
      columns++;
      for (let k = 0; k < sums.length; k++)
        sums[k] = (sums[k] as number) + (local.value[k] as number);
    }
    if (columns === 0)
      return err(modelingError('model-degenerate', 'the sections are distinct', {}));
    params = sums.map((s) => s / columns);
    params[0] = 0;
    params[params.length - 1] = 1;
  }
  const knotsV = averagedKnots(params, q);
  const nv = curves.length;
  const out = new Float64Array(4 * nu * nv);
  for (let i = 0; i < nu; i++) {
    const rows = hs.map((h) => Array.from(h.subarray(4 * i, 4 * i + 4)));
    const control = interpolateRows(rows, q, params, knotsV);
    if (!control.ok) return control;
    for (let j = 0; j < nv; j++)
      out.set(control.value.subarray(4 * j, 4 * j + 4), 4 * (i * nv + j));
  }
  return ok(surfaceFromH(first.degree, q, first.knots, knotsV, out, nu, nv));
}

/** Surface through a grid of points `rows[i][j]` (i along u, j along v), A9.4. */
export function interpolateGrid(
  rows: readonly (readonly Tuple3[])[],
  options: {
    readonly degreeU?: number;
    readonly degreeV?: number;
    readonly parametrization?: Parametrization;
  } = {},
): Result<NurbsSurface, ModelingError> {
  const nv = rows[0]?.length ?? 0;
  if (rows.length < 2 || nv < 2 || rows.some((r) => r.length !== nv)) {
    return err(invalid('a grid has at least 2 x 2 points in equal rows', { rows: rows.length }));
  }
  const curves: NurbsCurve[] = [];
  const kind = options.parametrization ?? 'centripetal';
  // Shared v parameters: average over rows.
  const sums = new Array<number>(nv).fill(0);
  for (const row of rows) {
    const local = parametersOf(row, kind);
    if (!local.ok) return local;
    for (let j = 0; j < nv; j++) sums[j] = (sums[j] as number) + (local.value[j] as number);
  }
  const params = sums.map((s) => s / rows.length);
  params[0] = 0;
  params[nv - 1] = 1;
  for (const row of rows) {
    const curve = interpolate(row, { degree: options.degreeV ?? 3, parameters: params });
    if (!curve.ok) return curve;
    curves.push(curve.value);
  }
  const lofted = loftSurface(curves, {
    degree: options.degreeU ?? 3,
    parametrization: kind,
  });
  if (!lofted.ok) return lofted;
  return ok(transpose(lofted.value));
}

/** Swap the u and v directions. */
export function transpose(s: NurbsSurface): NurbsSurface {
  const nu = s.points.length;
  const nv = (s.points[0] as readonly Tuple3[]).length;
  const points = Array.from({ length: nv }, (_, j) =>
    Array.from({ length: nu }, (_, i) => (s.points[i] as readonly Tuple3[])[j] as Tuple3),
  );
  const base = {
    degreeU: s.degreeV,
    degreeV: s.degreeU,
    points,
    knotsU: [...s.knotsV],
    knotsV: [...s.knotsU],
  };
  return s.weights === undefined
    ? base
    : {
        ...base,
        weights: Array.from({ length: nv }, (_, j) =>
          Array.from({ length: nu }, (_, i) => (s.weights?.[i] as readonly number[])[j] as number),
        ),
      };
}

/** Same surface with degrees raised to (p, q) and knots refined to (U, V). */
function conform(
  s: NurbsSurface,
  p: number,
  q: number,
  U: readonly number[] | undefined,
  V: readonly number[] | undefined,
): NurbsSurface {
  const lift = (
    surface: NurbsSurface,
    degree: number,
    knots: readonly number[] | undefined,
  ): NurbsSurface => {
    // Work on columns: each row i along u is a v-curve; transpose to process u.
    const nu = surface.points.length;
    const rows: NurbsCurve[] = [];
    for (let i = 0; i < nu; i++) {
      rows.push({
        degree: surface.degreeV,
        points: surface.points[i] as readonly Tuple3[],
        knots: surface.knotsV,
        ...(surface.weights === undefined
          ? {}
          : { weights: surface.weights[i] as readonly number[] }),
      });
    }
    let curves = rows.map((c) =>
      c.degree < degree ? elevate(c, degree - c.degree) : normalizeCurve(c),
    );
    if (knots !== undefined) curves = curves.map((c) => refine(c, knots));
    const c0 = curves[0] as NurbsCurve;
    const rational = curves.some((c) => c.weights !== undefined);
    const base = {
      degreeU: surface.degreeU,
      degreeV: c0.degree,
      points: curves.map((c) => [...c.points]),
      knotsU: [...surface.knotsU],
      knotsV: [...c0.knots],
    };
    return rational
      ? { ...base, weights: curves.map((c) => [...(c.weights ?? c.points.map(() => 1))]) }
      : base;
  };
  const inV = lift(s, q, V);
  return transpose(lift(transpose(inV), p, U));
}

export interface NetworkOptions {
  /** Degree of the refit network curves and of the skins (default 3). */
  readonly degree?: number;
  /** Samples per network curve for the refit (default 32 per span between intersections). */
  readonly samples?: number;
  /** Intersection tolerance (default 1e-6 of the network size, at least 1e-9). */
  readonly tolerance?: number;
}

/**
 * Gordon surface through a curve network (Section 10.5): `uCurves` run along u and
 * cross every `vCurves` member. Each curve is refit with shared parameters so the
 * intersections land on common isoparms; the surface is skin(u) + skin(v) - grid.
 * Returns `model-precondition` when a pair does not intersect within tolerance.
 */
export function networkSurface(
  uCurves: readonly NurbsCurve[],
  vCurves: readonly NurbsCurve[],
  options: NetworkOptions = {},
): Result<NurbsSurface, ModelingError> {
  if (uCurves.length < 2 || vCurves.length < 2) {
    return err(
      invalid('a network has at least 2 curves in each direction', {
        u: uCurves.length,
        v: vCurves.length,
      }),
    );
  }
  for (const curve of [...uCurves, ...vCurves]) {
    const checked = checkCurve(curve);
    if (!checked.ok) return checked;
  }
  const us = uCurves.map(normalizeCurve);
  const vs = vCurves.map(normalizeCurve);
  // Parameters of each intersection on each curve.
  const tol = options.tolerance ?? 1e-6;
  const onU: number[][] = us.map(() => []);
  const onV: number[][] = vs.map(() => []);
  const grid: Tuple3[][] = vs.map(() => []);
  for (const [k, cu] of us.entries()) {
    for (const [l, cv] of vs.entries()) {
      const hit = intersectCurves(cu, cv);
      if (hit.distance > tol) {
        return err(
          modelingError(
            'model-precondition',
            'every u-curve meets every v-curve',
            { u: k, v: l, distance: hit.distance },
            'adjust the curves so they cross, or raise tolerance',
          ),
        );
      }
      const snap = (t: number) => (t < 1e-7 ? 0 : t > 1 - 1e-7 ? 1 : t);
      (onU[k] as number[])[l] = snap(hit.s);
      (onV[l] as number[])[k] = snap(hit.t);
      (grid[l] as Tuple3[])[k] = curvePoint(cu, hit.s);
    }
  }
  const sortedCheck = (rows: number[][]) =>
    rows.every((r) => r.every((t, i) => i === 0 || t > (r[i - 1] as number) + 1e-6));
  if (!sortedCheck(onU) || !sortedCheck(onV)) {
    return err(
      modelingError(
        'model-precondition',
        'network curves cross in a consistent order',
        {},
        'order uCurves and vCurves along the directions they span',
      ),
    );
  }
  const average = (rows: readonly number[][]) => {
    const mean = (rows[0] as number[]).map(
      (_, i) => rows.reduce((s, r) => s + (r[i] as number), 0) / rows.length,
    );
    const a = mean[0] as number;
    const b = mean[mean.length - 1] as number;
    return mean.map((t, i) => (i === 0 ? 0 : i === mean.length - 1 ? 1 : (t - a) / (b - a)));
  };
  const uBar = average(onU);
  const vBar = average(onV);
  const degree = options.degree ?? 3;
  const per = options.samples ?? 32;
  const refit = (
    curve: NurbsCurve,
    local: readonly number[],
    common: readonly number[],
  ): Result<NurbsCurve, ModelingError> => {
    // Piecewise-linear reparametrization pinning the intersections to the common values;
    // the outermost intersections become the domain ends (overhangs are dropped).
    const params: number[] = [];
    const samples: Tuple3[] = [];
    for (let a = 0; a + 1 < common.length; a++) {
      const c0 = common[a] as number;
      const c1 = common[a + 1] as number;
      const l0 = local[a] as number;
      const l1 = local[a + 1] as number;
      for (let s = 0; s < per; s++) {
        const f = s / per;
        params.push(c0 + (c1 - c0) * f);
        samples.push(curvePoint(curve, l0 + (l1 - l0) * f));
      }
    }
    params.push(1);
    samples.push(curvePoint(curve, local[local.length - 1] as number));
    return interpolate(samples, { degree, parameters: params });
  };
  const fitU: NurbsCurve[] = [];
  for (const [k, c] of us.entries()) {
    const f = refit(c, onU[k] as number[], uBar);
    if (!f.ok) return f;
    fitU.push(f.value);
  }
  const fitV: NurbsCurve[] = [];
  for (const [l, c] of vs.entries()) {
    const f = refit(c, onV[l] as number[], vBar);
    if (!f.ok) return f;
    fitV.push(f.value);
  }
  const skinU = loftSurface(fitU, { degree, parameters: vBar });
  if (!skinU.ok) return skinU;
  const skinVT = loftSurface(fitV, { degree, parameters: uBar });
  if (!skinVT.ok) return skinVT;
  const skinV = transpose(skinVT.value);
  // Tensor interpolation of the intersection grid at (uBar, vBar).
  const rows = uBar.map((_, l) => vBar.map((__, k) => (grid[l] as Tuple3[])[k] as Tuple3));
  const columns: NurbsCurve[] = [];
  for (const row of rows) {
    const c = interpolate(row, { degree, parameters: vBar });
    if (!c.ok) return c;
    columns.push(c.value);
  }
  const tensorT = loftSurface(columns, { degree, parameters: uBar });
  if (!tensorT.ok) return tensorT;
  const tensor = transpose(tensorT.value);
  const p = Math.max(skinU.value.degreeU, skinV.degreeU, tensor.degreeU);
  const q = Math.max(skinU.value.degreeV, skinV.degreeV, tensor.degreeV);
  const lifted = [skinU.value, skinV, tensor].map((s) => conform(s, p, q, undefined, undefined));
  const U = mergeKnots(lifted.map((s) => s.knotsU));
  const V = mergeKnots(lifted.map((s) => s.knotsV));
  const [a, b, c] = lifted.map((s) => surfaceH(conform(s, p, q, U, V))) as [H, H, H];
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++)
    out[i] = (a[i] as number) + (b[i] as number) - (c[i] as number);
  return ok(surfaceFromH(p, q, U, V, out, U.length - p - 1, V.length - q - 1));
}

/** Closest approach of two curves on [0, 1] (sampling, then Newton on the squared distance). */
function intersectCurves(a: NurbsCurve, b: NurbsCurve): { s: number; t: number; distance: number } {
  const n = 64;
  let best = { s: 0, t: 0, d: Infinity };
  const pa = Array.from({ length: n + 1 }, (_, i) => curvePoint(a, i / n));
  const pb = Array.from({ length: n + 1 }, (_, j) => curvePoint(b, j / n));
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const d = distance(pa[i] as Tuple3, pb[j] as Tuple3);
      if (d < best.d) best = { s: i / n, t: j / n, d };
    }
  }
  let { s, t } = best;
  for (let it = 0; it < 50; it++) {
    const [A, A1, A2] = curveDerivatives(a, s, 2) as [Tuple3, Tuple3, Tuple3];
    const [B, B1, B2] = curveDerivatives(b, t, 2) as [Tuple3, Tuple3, Tuple3];
    const r = [A[0] - B[0], A[1] - B[1], A[2] - B[2]];
    const dot = (x: readonly number[], y: readonly number[]) =>
      (x[0] as number) * (y[0] as number) +
      (x[1] as number) * (y[1] as number) +
      (x[2] as number) * (y[2] as number);
    const g0 = dot(r, A1);
    const g1 = -dot(r, B1);
    const h00 = dot(A1, A1) + dot(r, A2);
    const h11 = dot(B1, B1) - dot(r, B2);
    const h01 = -dot(A1, B1);
    const det = h00 * h11 - h01 * h01;
    if (det === 0) break;
    const ds = (h11 * g0 - h01 * g1) / det;
    const dt = (h00 * g1 - h01 * g0) / det;
    const ns = Math.min(1, Math.max(0, s - ds));
    const nt = Math.min(1, Math.max(0, t - dt));
    const done = Math.abs(ns - s) < 1e-15 && Math.abs(nt - t) < 1e-15;
    s = ns;
    t = nt;
    if (done) break;
  }
  return { s, t, distance: distance(curvePoint(a, s), curvePoint(b, t)) };
}

/**
 * Closest surface point to `p` (point inversion, Section 6.1): a sampled start, then
 * Newton steps on the distance gradient, clamped to the domain.
 */
export function surfaceClosest(
  s: NurbsSurface,
  p: Tuple3,
  samples = 24,
): { readonly u: number; readonly v: number; readonly point: Tuple3; readonly distance: number } {
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  let best = { u: u0, v: v0, d: Infinity };
  for (let i = 0; i <= samples; i++) {
    for (let j = 0; j <= samples; j++) {
      const u = u0 + ((u1 - u0) * i) / samples;
      const v = v0 + ((v1 - v0) * j) / samples;
      const d = distance(surfacePoint(s, u, v), p);
      if (d < best.d) best = { u, v, d };
    }
  }
  const dot = (x: Tuple3, y: readonly number[]) =>
    x[0] * (y[0] as number) + x[1] * (y[1] as number) + x[2] * (y[2] as number);
  const newton = (u: number, v: number) => {
    for (let it = 0; it < 30; it++) {
      const d = surfaceDerivatives(s, u, v, 2);
      const S = (d[0] as Tuple3[])[0] as Tuple3;
      const Su = (d[1] as Tuple3[])[0] as Tuple3;
      const Sv = (d[0] as Tuple3[])[1] as Tuple3;
      const Suu = (d[2] as Tuple3[])[0] as Tuple3;
      const Suv = (d[1] as Tuple3[])[1] as Tuple3;
      const Svv = (d[0] as Tuple3[])[2] as Tuple3;
      const r = [S[0] - p[0], S[1] - p[1], S[2] - p[2]];
      const f = dot(Su, r);
      const g = dot(Sv, r);
      const a = dot(Su, Su) + dot(Suu, r);
      const b = dot(Su, Sv) + dot(Suv, r);
      const c = dot(Sv, Sv) + dot(Svv, r);
      const det = a * c - b * b;
      if (det === 0) break;
      const nu = Math.min(u1, Math.max(u0, u - (c * f - b * g) / det));
      const nv = Math.min(v1, Math.max(v0, v - (a * g - b * f) / det));
      const done = Math.abs(nu - u) <= 1e-15 * (u1 - u0) && Math.abs(nv - v) <= 1e-15 * (v1 - v0);
      u = nu;
      v = nv;
      if (done) break;
    }
    const point = surfacePoint(s, u, v);
    return { u, v, point, distance: distance(point, p) };
  };
  // On a closed direction the seam's two parameter ends are one place; Newton clamps at the
  // end it starts from, so a point in the last span also starts from the other end.
  const seamU = [0, 0.5, 1].every(
    (f) =>
      distance(surfacePoint(s, u0, v0 + (v1 - v0) * f), surfacePoint(s, u1, v0 + (v1 - v0) * f)) <=
      1e-9 * (1 + distance(surfacePoint(s, u0, v0), [0, 0, 0])),
  );
  const seamV = [0, 0.5, 1].every(
    (f) =>
      distance(surfacePoint(s, u0 + (u1 - u0) * f, v0), surfacePoint(s, u0 + (u1 - u0) * f, v1)) <=
      1e-9 * (1 + distance(surfacePoint(s, u0, v0), [0, 0, 0])),
  );
  const starts: [number, number][] = [[best.u, best.v]];
  if (seamU && (best.u === u0 || best.u === u1)) starts.push([best.u === u0 ? u1 : u0, best.v]);
  if (seamV && (best.v === v0 || best.v === v1)) starts.push([best.u, best.v === v0 ? v1 : v0]);
  let result = { u: best.u, v: best.v, point: surfacePoint(s, best.u, best.v), distance: best.d };
  for (const [u, v] of starts) {
    const hit = newton(u, v);
    if (hit.distance < result.distance) result = hit;
  }
  return result;
}

/** Differential geometry of a surface point (Do Carmo 3.3): unit normal along Su x Sv. */
export interface SurfaceCurvature {
  readonly point: Tuple3;
  readonly su: Tuple3;
  readonly sv: Tuple3;
  readonly normal: Tuple3;
  /** First (E, F, G) and second (L, M, N) fundamental forms. */
  readonly first: readonly [number, number, number];
  readonly second: readonly [number, number, number];
  readonly gaussian: number;
  readonly mean: number;
  /** Principal curvatures, `k1 >= k2`. */
  readonly k1: number;
  readonly k2: number;
}

/** Curvatures at (u, v), or undefined where the parametrization is singular (poles). */
export function surfaceCurvature(
  s: NurbsSurface,
  u: number,
  v: number,
): SurfaceCurvature | undefined {
  const d = surfaceDerivatives(s, u, v, 2);
  const point = (d[0] as Tuple3[])[0] as Tuple3;
  const su = (d[1] as Tuple3[])[0] as Tuple3;
  const sv = (d[0] as Tuple3[])[1] as Tuple3;
  const suu = (d[2] as Tuple3[])[0] as Tuple3;
  const suv = (d[1] as Tuple3[])[1] as Tuple3;
  const svv = (d[0] as Tuple3[])[2] as Tuple3;
  const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c: Tuple3 = [
    su[1] * sv[2] - su[2] * sv[1],
    su[2] * sv[0] - su[0] * sv[2],
    su[0] * sv[1] - su[1] * sv[0],
  ];
  const E = dot(su, su);
  const F = dot(su, sv);
  const G = dot(sv, sv);
  const area = Math.sqrt(dot(c, c));
  if (!(area > 1e-12 * (E + G)) || !(area > 0)) return undefined;
  const normal: Tuple3 = [c[0] / area, c[1] / area, c[2] / area];
  const L = dot(suu, normal);
  const M = dot(suv, normal);
  const N = dot(svv, normal);
  const det = E * G - F * F;
  const gaussian = (L * N - M * M) / det;
  const mean = (E * N - 2 * F * M + G * L) / (2 * det);
  const root = Math.sqrt(Math.max(0, mean * mean - gaussian));
  return {
    point,
    su,
    sv,
    normal,
    first: [E, F, G],
    second: [L, M, N],
    gaussian,
    mean,
    k1: mean + root,
    k2: mean - root,
  };
}

/** Normal curvature of `c` along the tangent direction `w` (projected onto the tangent plane). */
export function normalCurvature(c: SurfaceCurvature, w: Tuple3): number {
  const dot = (a: Tuple3, b: Tuple3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [E, F, G] = c.first;
  const [L, M, N] = c.second;
  const p = dot(c.su, w);
  const q = dot(c.sv, w);
  const det = E * G - F * F;
  const a = (G * p - F * q) / det;
  const b = (E * q - F * p) / det;
  const length2 = E * a * a + 2 * F * a * b + G * b * b;
  return length2 > 0 ? (L * a * a + 2 * M * a * b + N * b * b) / length2 : 0;
}

/** Curvature of a curve at `t`: unit tangent, curvature and the binormal (C' x C'' direction). */
export function curveCurvature(
  curve: NurbsCurve,
  t: number,
): {
  readonly point: Tuple3;
  readonly tangent: Tuple3;
  readonly speed: number;
  readonly curvature: number;
  readonly binormal: Tuple3;
  /** Unit principal normal (toward the center of curvature); zero on straight parts. */
  readonly normal: Tuple3;
} {
  const [point, d1, d2] = curveDerivatives(curve, t, 2) as [Tuple3, Tuple3, Tuple3];
  const speed = Math.sqrt(d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2]);
  const b: Tuple3 = [
    d1[1] * d2[2] - d1[2] * d2[1],
    d1[2] * d2[0] - d1[0] * d2[2],
    d1[0] * d2[1] - d1[1] * d2[0],
  ];
  const bl = Math.sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
  const tangent: Tuple3 = speed > 0 ? [d1[0] / speed, d1[1] / speed, d1[2] / speed] : [0, 0, 0];
  if (!(speed > 0) || !(bl > 0))
    return { point, tangent, speed, curvature: 0, binormal: [0, 0, 0], normal: [0, 0, 0] };
  const binormal: Tuple3 = [b[0] / bl, b[1] / bl, b[2] / bl];
  return {
    point,
    tangent,
    speed,
    curvature: bl / (speed * speed * speed),
    binormal,
    normal: [
      binormal[1] * tangent[2] - binormal[2] * tangent[1],
      binormal[2] * tangent[0] - binormal[0] * tangent[2],
      binormal[0] * tangent[1] - binormal[1] * tangent[0],
    ],
  };
}

/** Builders and evaluators; everything here is pure. */
export const nurbs = {
  check: checkCurve,
  checkSurface,
  point: curvePoint,
  derivatives: curveDerivatives,
  domain,
  surfacePoint,
  surfaceDerivatives,
  surfaceDomain,
  closest: surfaceClosest,
  curvature: surfaceCurvature,
  normalCurvature,
  curveCurvature,
  insertKnot,
  refine,
  elevate,
  split: splitCurve,
  normalize: normalizeCurve,
  compatible: compatibleCurves,
  interpolate,
  approximate,
  loft: loftSurface,
  grid: interpolateGrid,
  network: networkSurface,
  fitSurface,
  match: matchSurfaces,
  transpose,
  /** Surface algebra along one direction ('u' or 'v'); every operation returns a Result. */
  surface: {
    insertKnot: surfaceInsertKnot,
    refine: surfaceRefine,
    elevate: surfaceElevate,
    split: surfaceSplit,
    extend: surfaceExtend,
    compatible: surfaceCompatible,
    fillN,
  },
};
