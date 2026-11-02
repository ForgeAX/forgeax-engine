import { err, ok, type Result } from '@forgeax/engine-types';
import { cos } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  basisDerivatives,
  basisFunctions,
  checkCurve,
  elevate,
  findSpan,
  mergeKnots,
  type NurbsCurve,
  type NurbsSurface,
  normalizeCurve,
  type Parametrization,
  parametersOf,
  refine,
  solve,
  surfacePoint,
} from './nurbs';
import type { PatchSide } from './nurbs-surface';

/**
 * Least-squares surface fitting with variational fairing terms: a grid of points is
 * approximated by a control net much smaller than the grid, optionally with fixed
 * boundary curves, and the net can grow span by span until it reaches an error bound.
 */
export interface FitSurfaceOptions {
  /** Degrees along u and v (default [3, 3]). Primary panels use 5 to 7. */
  readonly degree?: readonly [number, number];
  /**
   * Control points along u and v, or 'auto': start with one span per direction and add
   * spans (where the error is largest) until `maxError` holds or `maxNet` is reached.
   */
  readonly net: readonly [number, number] | 'auto';
  /** Largest point error for 'auto', meters. */
  readonly maxError?: number;
  /** Net limit for 'auto' (default [8, 8], the primary limit). */
  readonly maxNet?: readonly [number, number];
  /**
   * Fairing weights (dimensionless; the energies integrate squared first, second and third
   * derivatives over the unit parameter square, the data term is the mean squared error):
   * `stretch` tightens the surface, `bend` reduces curvature, `rate` its variation.
   */
  readonly fair?: { readonly stretch?: number; readonly bend?: number; readonly rate?: number };
  /**
   * Fixed boundary curves: the side's control row becomes exactly the curve (raised to the
   * fit degree; its domain maps onto the side). `u0` and `u1` run along v.
   */
  readonly boundaries?: Partial<Readonly<Record<PatchSide, NurbsCurve>>>;
  /** Grid parameters (default 'chord', averaged over rows and columns). */
  readonly parametrization?: Parametrization;
  /** Explicit increasing parameters from 0 to 1 per grid direction. */
  readonly parameters?: { readonly u: readonly number[]; readonly v: readonly number[] };
}

export interface FitSurfaceResult {
  readonly surface: NurbsSurface;
  /** Root mean square and largest distance between a grid point and its surface point, m. */
  readonly rms: number;
  readonly max: number;
  /** Where `max` occurs: grid indices and the grid point. */
  readonly at: { readonly i: number; readonly j: number; readonly point: Tuple3 };
  readonly net: readonly [number, number];
  /** False when 'auto' stopped at `maxNet` above `maxError`. */
  readonly converged: boolean;
}

const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

function invalid(expected: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

/** Gauss-Legendre nodes and weights on [-1, 1] (Newton on the Legendre recurrence). */
function gaussLegendre(n: number): { x: number[]; w: number[] } {
  const x: number[] = [];
  const w: number[] = [];
  for (let i = 1; i <= n; i++) {
    let z = cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let dp = 1;
    for (let it = 0; it < 100; it++) {
      let p0 = 1;
      let p1 = z;
      for (let k = 2; k <= n; k++) {
        const p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      const pn = n === 1 ? z : p1;
      const pm = n === 1 ? 1 : p0;
      dp = (n * (z * pn - pm)) / (z * z - 1);
      const step = pn / dp;
      z -= step;
      if (Math.abs(step) < 1e-16) break;
    }
    x.push(z);
    w.push(2 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
}

/** Gram matrix of the `order`-th derivatives of the basis on its domain, row-major. */
function gram(p: number, knots: readonly number[], count: number, order: number): Float64Array {
  const G = new Float64Array(count * count);
  if (order > p) return G;
  const { x, w } = gaussLegendre(p + 1);
  for (let s = p; s < count; s++) {
    const a = knots[s] as number;
    const b = knots[s + 1] as number;
    if (!(b > a)) continue;
    for (const [q, xi] of x.entries()) {
      const t = a + ((b - a) * (xi + 1)) / 2;
      const d = basisDerivatives(s, t, p, order, knots)[order] as number[];
      const wq = ((w[q] as number) * (b - a)) / 2;
      for (let r = 0; r <= p; r++)
        for (let c = 0; c <= p; c++) {
          const o = (s - p + r) * count + (s - p + c);
          G[o] = (G[o] as number) + wq * (d[r] as number) * (d[c] as number);
        }
    }
  }
  return G;
}

/** Fairing weights: integrated squared first (stretch), second (bend) and third (rate) derivatives. */
export interface Fairing {
  readonly stretch: number;
  readonly bend: number;
  readonly rate: number;
}

/**
 * @internal The fairing energy of a tensor net (p, U) x (q, V) as the quadratic form
 * sum g P[ki] P[kj] over control keys `i * nv + j`; `visit` receives every non-zero term in
 * a fixed order. The single energy source of `fitSurface` and `fillN`.
 */
export function forEachFairing(
  p: number,
  U: readonly number[],
  q: number,
  V: readonly number[],
  fair: Fairing,
  visit: (ki: number, kj: number, g: number) => void,
): void {
  const nu = U.length - p - 1;
  const nv = V.length - q - 1;
  const terms: [number, number, number][] = [];
  if (fair.stretch > 0) terms.push([1, 0, fair.stretch], [0, 1, fair.stretch]);
  if (fair.bend > 0) terms.push([2, 0, fair.bend], [1, 1, 2 * fair.bend], [0, 2, fair.bend]);
  if (fair.rate > 0)
    terms.push([3, 0, fair.rate], [2, 1, 3 * fair.rate], [1, 2, 3 * fair.rate], [0, 3, fair.rate]);
  for (const [a, b, weight] of terms) {
    const Gu = gram(p, U, nu, a);
    const Gv = gram(q, V, nv, b);
    for (let i = 0; i < nu; i++)
      for (let k = 0; k < nu; k++) {
        const gu = Gu[i * nu + k] as number;
        if (gu === 0) continue;
        for (let j = 0; j < nv; j++)
          for (let l = 0; l < nv; l++) {
            const g = weight * gu * (Gv[j * nv + l] as number);
            if (g !== 0) visit(i * nv + j, k * nv + l, g);
          }
      }
  }
}

/** Knots for `count` control points over `params` (Eq. 9.68; averaged when interpolating). */
function placedKnots(params: readonly number[], p: number, count: number): number[] {
  const m = params.length - 1;
  const n = count - 1;
  const knots = new Array<number>(p + 1).fill(0);
  if (count === params.length) {
    for (let j = 1; j <= n - p; j++) {
      let s = 0;
      for (let i = j; i <= j + p - 1; i++) s += params[i] as number;
      knots.push(s / p);
    }
  } else {
    const d = (m + 1) / (n - p + 1);
    for (let j = 1; j <= n - p; j++) {
      const i = Math.floor(j * d);
      const alpha = j * d - i;
      knots.push((1 - alpha) * (params[i - 1] as number) + alpha * (params[i] as number));
    }
  }
  for (let i = 0; i <= p; i++) knots.push(1);
  return knots;
}

/** Insert the midpoint of the longest span until the vector holds `count` control points. */
function growKnots(knots: readonly number[], p: number, count: number): number[] {
  const out = [...knots];
  while (out.length - p - 1 < count) {
    let best = p;
    for (let s = p; s < out.length - p - 1; s++)
      if (
        (out[s + 1] as number) - (out[s] as number) >
        (out[best + 1] as number) - (out[best] as number)
      )
        best = s;
    out.splice(best + 1, 0, ((out[best] as number) + (out[best + 1] as number)) / 2);
  }
  return out;
}

/** Interior knots of `b` (with multiplicity) all present in `a`. */
function contains(a: readonly number[], b: readonly number[], p: number): boolean {
  const count = (list: readonly number[], t: number) => list.filter((k) => k === t).length;
  const interior = b.slice(p + 1, b.length - p - 1);
  return interior.every((t) => count(a, t) >= count(interior, t));
}

interface Problem {
  readonly rows: readonly (readonly Tuple3[])[];
  readonly pu: readonly number[];
  readonly pv: readonly number[];
  readonly p: number;
  readonly q: number;
  readonly fair: Fairing;
  /** Boundary curves raised to the fit degree, by side. */
  readonly sides: Partial<Record<PatchSide, NurbsCurve>>;
}

/** Fixed rows: control points of the boundary curves refined to the fit knots. */
function fixedRows(
  problem: Problem,
  U: readonly number[],
  V: readonly number[],
): Result<Map<number, Tuple3>, ModelingError> {
  const nu = U.length - problem.p - 1;
  const nv = V.length - problem.q - 1;
  const fixed = new Map<number, Tuple3>();
  for (const side of ['u0', 'u1', 'v0', 'v1'] as const) {
    const curve = problem.sides[side];
    if (curve === undefined) continue;
    const alongV = side === 'u0' || side === 'u1';
    const target = alongV ? V : U;
    const degree = alongV ? problem.q : problem.p;
    if (!contains(target, curve.knots, degree))
      return err(
        modelingError(
          'model-precondition',
          'the fit knots contain the boundary curve knots',
          { side },
          "use net: 'auto' (it starts from the boundary knots) or a single-span boundary curve",
        ),
      );
    const refined = refine(curve, target);
    for (const [k, point] of refined.points.entries()) {
      const i = alongV ? (side === 'u0' ? 0 : nu - 1) : k;
      const j = alongV ? k : side === 'v0' ? 0 : nv - 1;
      const key = i * nv + j;
      const previous = fixed.get(key);
      if (
        previous !== undefined &&
        len3(previous[0] - point[0], previous[1] - point[1], previous[2] - point[2]) >
          1e-9 * (1 + len3(...point))
      )
        return err(
          modelingError(
            'model-precondition',
            'boundary curves meet at the shared corner',
            { side, corner: [i, j] },
            'make the end points of the boundary curves coincide',
          ),
        );
      fixed.set(key, point);
    }
  }
  return ok(fixed);
}

function solveFit(
  problem: Problem,
  U: readonly number[],
  V: readonly number[],
): Result<Omit<FitSurfaceResult, 'converged'>, ModelingError> {
  const { rows, pu, pv, p, q, fair } = problem;
  const nu = U.length - p - 1;
  const nv = V.length - q - 1;
  const fixedR = fixedRows(problem, U, V);
  if (!fixedR.ok) return fixedR;
  const fixed = fixedR.value;
  const index = new Int32Array(nu * nv).fill(-1);
  let unknowns = 0;
  for (let k = 0; k < nu * nv; k++) if (!fixed.has(k)) index[k] = unknowns++;
  const A = new Float64Array(unknowns * unknowns);
  const B = new Float64Array(unknowns * 3);
  const total = rows.length * (rows[0] as readonly Tuple3[]).length;
  const basisU = pu.map((t) => {
    const s = findSpan(nu, p, t, U);
    return { s, N: basisFunctions(s, t, p, U) };
  });
  const basisV = pv.map((t) => {
    const s = findSpan(nv, q, t, V);
    return { s, N: basisFunctions(s, t, q, V) };
  });
  const local: { key: number; b: number }[] = [];
  for (const [k, bu] of basisU.entries()) {
    for (const [l, bv] of basisV.entries()) {
      local.length = 0;
      for (let r = 0; r <= p; r++)
        for (let c = 0; c <= q; c++)
          local.push({
            key: (bu.s - p + r) * nv + (bv.s - q + c),
            b: (bu.N[r] as number) * (bv.N[c] as number),
          });
      const Q = (rows[k] as readonly Tuple3[])[l] as Tuple3;
      const rhs = [Q[0], Q[1], Q[2]];
      for (const { key, b } of local) {
        const x = fixed.get(key);
        if (x !== undefined)
          for (let c = 0; c < 3; c++) rhs[c] = (rhs[c] as number) - b * (x[c] as number);
      }
      for (const { key: ki, b: bi } of local) {
        const fi = index[ki] as number;
        if (fi < 0) continue;
        for (let c = 0; c < 3; c++)
          B[3 * fi + c] = (B[3 * fi + c] as number) + (bi * (rhs[c] as number)) / total;
        for (const { key: kj, b: bj } of local) {
          const fj = index[kj] as number;
          if (fj >= 0)
            A[fi * unknowns + fj] = (A[fi * unknowns + fj] as number) + (bi * bj) / total;
        }
      }
    }
  }
  forEachFairing(p, U, q, V, fair, (ki, kj, g) => {
    const fi = index[ki] as number;
    if (fi < 0) return;
    const fj = index[kj] as number;
    if (fj >= 0) A[fi * unknowns + fj] = (A[fi * unknowns + fj] as number) + g;
    else {
      const x = fixed.get(kj) as Tuple3;
      for (let c = 0; c < 3; c++) B[3 * fi + c] = (B[3 * fi + c] as number) - g * (x[c] as number);
    }
  });
  const x = unknowns === 0 ? ok(new Float64Array(0)) : solve(A, B, unknowns, 3);
  if (!x.ok) return x;
  const points = Array.from({ length: nu }, (_, i) =>
    Array.from({ length: nv }, (_, j): Tuple3 => {
      const key = i * nv + j;
      const f = index[key] as number;
      if (f < 0) return fixed.get(key) as Tuple3;
      return [x.value[3 * f] as number, x.value[3 * f + 1] as number, x.value[3 * f + 2] as number];
    }),
  );
  const surface: NurbsSurface = { degreeU: p, degreeV: q, points, knotsU: [...U], knotsV: [...V] };
  let sum = 0;
  let max = -1;
  let at = { i: 0, j: 0, point: (rows[0] as readonly Tuple3[])[0] as Tuple3 };
  for (const [i, u] of pu.entries())
    for (const [j, v] of pv.entries()) {
      const Q = (rows[i] as readonly Tuple3[])[j] as Tuple3;
      const S = surfacePoint(surface, u, v);
      const d = len3(S[0] - Q[0], S[1] - Q[1], S[2] - Q[2]);
      sum += d * d;
      if (d > max) {
        max = d;
        at = { i, j, point: Q };
      }
    }
  return ok({ surface, rms: Math.sqrt(sum / total), max, at, net: [nu, nv] });
}

/** Shared parameters of a grid direction: per-line parameters averaged over the lines. */
function gridParameters(
  lines: readonly (readonly Tuple3[])[],
  kind: Parametrization,
): Result<number[], ModelingError> {
  const n = (lines[0] as readonly Tuple3[]).length;
  const sums = new Array<number>(n).fill(0);
  for (const line of lines) {
    const local = parametersOf(line, kind);
    if (!local.ok) return local;
    for (let k = 0; k < n; k++) sums[k] = (sums[k] as number) + (local.value[k] as number);
  }
  const out = sums.map((s) => s / lines.length);
  out[0] = 0;
  out[n - 1] = 1;
  return ok(out);
}

function checkParams(params: readonly number[], count: number): boolean {
  return (
    Array.isArray(params) &&
    params.length === count &&
    params[0] === 0 &&
    params[count - 1] === 1 &&
    params.every((t, i) => Number.isFinite(t) && (i === 0 || t > (params[i - 1] as number)))
  );
}

/**
 * Fit a grid of points `rows[i][j]` (i along u, j along v) with a smaller control net:
 * least squares plus optional fairing and fixed boundary curves. With
 * `net: 'auto'` the fit starts from one span per direction and adds spans
 * until `maxError` holds.
 */
export function fitSurface(
  rows: readonly (readonly Tuple3[])[],
  options: FitSurfaceOptions,
): Result<FitSurfaceResult, ModelingError> {
  const nv = rows[0]?.length ?? 0;
  if (!Array.isArray(rows) || rows.length < 2 || nv < 2 || rows.some((r) => r.length !== nv))
    return err(
      invalid('a fit grid has at least 2 x 2 points in equal rows', { rows: rows?.length }),
    );
  for (const row of rows)
    for (const point of row)
      if (!(point.length === 3 && point.every(Number.isFinite)))
        return err(invalid('grid points are finite [x, y, z]', { point }));
  const [p, q] = options.degree ?? [3, 3];
  if (![p, q].every((d) => Number.isInteger(d) && d >= 1))
    return err(invalid('degree holds two integers >= 1', { degree: options.degree }));
  const fair = {
    stretch: options.fair?.stretch ?? 0,
    bend: options.fair?.bend ?? 0,
    rate: options.fair?.rate ?? 0,
  };
  if (![fair.stretch, fair.bend, fair.rate].every((w) => Number.isFinite(w) && w >= 0))
    return err(invalid('fair weights are finite and >= 0', { fair: options.fair }));
  const smooth = fair.stretch + fair.bend + fair.rate > 0;
  let pu: number[];
  let pv: number[];
  if (options.parameters !== undefined) {
    if (!checkParams(options.parameters.u, rows.length) || !checkParams(options.parameters.v, nv))
      return err(invalid('parameters.u / .v increase strictly from 0 to 1, one per grid line', {}));
    pu = [...options.parameters.u];
    pv = [...options.parameters.v];
  } else {
    const kind = options.parametrization ?? 'chord';
    const columns = Array.from({ length: nv }, (_, j) => rows.map((r) => r[j] as Tuple3));
    const u = gridParameters(columns, kind);
    if (!u.ok) return u;
    const v = gridParameters(rows, kind);
    if (!v.ok) return v;
    pu = u.value;
    pv = v.value;
  }
  const sides: Partial<Record<PatchSide, NurbsCurve>> = {};
  for (const [side, curve] of Object.entries(options.boundaries ?? {}) as [
    PatchSide,
    NurbsCurve,
  ][]) {
    if (!['u0', 'u1', 'v0', 'v1'].includes(side))
      return err(invalid("boundaries are keyed by 'u0', 'u1', 'v0' or 'v1'", { side }));
    const checked = checkCurve(curve);
    if (!checked.ok) return checked;
    if (curve.weights !== undefined)
      return err(
        modelingError(
          'model-precondition',
          'boundary curves are non-rational',
          { side },
          'refit the curve with nurbs.approximate',
        ),
      );
    const degree = side === 'u0' || side === 'u1' ? q : p;
    if (curve.degree > degree)
      return err(
        modelingError(
          'model-precondition',
          'a boundary curve degree is at most the fit degree along it',
          { side, curve: curve.degree, fit: degree },
          'raise the fit degree',
        ),
      );
    const n = normalizeCurve(curve);
    sides[side] = n.degree < degree ? elevate(n, degree - n.degree) : n;
  }
  const problem: Problem = { rows, pu, pv, p, q, fair, sides };
  const boundaryKnots = (along: 'u' | 'v') => {
    const degree = along === 'u' ? p : q;
    const curves = (along === 'v' ? ['u0', 'u1'] : ['v0', 'v1'])
      .map((s) => sides[s as PatchSide])
      .filter((c): c is NurbsCurve => c !== undefined);
    const single = [
      ...new Array<number>(degree + 1).fill(0),
      ...new Array<number>(degree + 1).fill(1),
    ];
    return curves.length === 0 ? undefined : mergeKnots([single, ...curves.map((c) => c.knots)]);
  };
  const points = [rows.length, nv] as const;
  const degrees = [p, q] as const;
  if (options.net === 'auto') {
    const maxError = options.maxError;
    if (!(typeof maxError === 'number' && Number.isFinite(maxError) && maxError > 0))
      return err(invalid("net 'auto' needs maxError, a positive number of meters", { maxError }));
    const maxNet = options.maxNet ?? [8, 8];
    if (!maxNet.every((n, d) => Number.isInteger(n) && n >= (degrees[d] as number) + 1))
      return err(invalid('maxNet holds two integers >= degree + 1', { maxNet }));
    const start = (d: 0 | 1) => {
      const degree = degrees[d];
      return (
        boundaryKnots(d === 0 ? 'u' : 'v') ?? [
          ...new Array<number>(degree + 1).fill(0),
          ...new Array<number>(degree + 1).fill(1),
        ]
      );
    };
    let U = start(0);
    let V = start(1);
    let best = solveFit(problem, U, V);
    if (!best.ok) return best;
    for (;;) {
      const current = best.value;
      if (current.max <= maxError) return ok({ ...current, converged: true });
      const candidates: { U: number[]; V: number[] }[] = [];
      for (const d of [0, 1] as const) {
        const knots = d === 0 ? U : V;
        const degree = degrees[d];
        const count = knots.length - degree - 1;
        if (count >= (maxNet[d] as number) || (!smooth && count >= points[d])) continue;
        const t = (d === 0 ? pu : pv)[d === 0 ? current.at.i : current.at.j] as number;
        const s = findSpan(count, degree, t, knots);
        // The median data parameter of the span keeps data on both sides of the new knot.
        const lo = knots[s] as number;
        const hi = knots[s + 1] as number;
        const inside = (d === 0 ? pu : pv).filter((x) => x > lo && x < hi);
        if (inside.length < 2) continue;
        const mid = inside[inside.length >> 1] as number;
        const grown = [...knots.slice(0, s + 1), mid, ...knots.slice(s + 1)];
        candidates.push(d === 0 ? { U: grown, V } : { U, V: grown });
      }
      if (candidates.length === 0) return ok({ ...current, converged: false });
      let chosen:
        | { U: number[]; V: number[]; fit: Omit<FitSurfaceResult, 'converged'> }
        | undefined;
      for (const c of candidates) {
        const fit = solveFit(problem, c.U, c.V);
        if (!fit.ok) {
          if (fit.error.code === 'model-degenerate') continue;
          return fit;
        }
        if (chosen === undefined || fit.value.max < chosen.fit.max)
          chosen = { ...c, fit: fit.value };
      }
      if (chosen === undefined) return ok({ ...current, converged: false });
      const pick = chosen as { U: number[]; V: number[]; fit: Omit<FitSurfaceResult, 'converged'> };
      U = pick.U;
      V = pick.V;
      best = ok(pick.fit);
    }
  }
  const net = options.net;
  if (
    !Array.isArray(net) ||
    !net.every(
      (n, d) =>
        Number.isInteger(n) &&
        n >= (degrees[d] as number) + 1 &&
        (smooth || n <= (points[d] as number)),
    )
  )
    return err(
      invalid(
        'net holds two integers from degree + 1 to the grid size (larger nets need fair weights)',
        { net, grid: points },
      ),
    );
  const knotsFor = (d: 0 | 1) => {
    const degree = degrees[d];
    const count = net[d] as number;
    const fromBoundary = boundaryKnots(d === 0 ? 'u' : 'v');
    if (fromBoundary !== undefined) return growKnots(fromBoundary, degree, count);
    const params = d === 0 ? pu : pv;
    return count <= params.length
      ? placedKnots(params, degree, count)
      : growKnots(placedKnots(params, degree, params.length), degree, count);
  };
  const U = knotsFor(0);
  const V = knotsFor(1);
  if (U.length - p - 1 !== net[0] || V.length - q - 1 !== net[1])
    return err(
      modelingError(
        'model-precondition',
        'the boundary curves fit in the requested net',
        { net, boundary: [U.length - p - 1, V.length - q - 1] },
        "raise net or use net: 'auto'",
      ),
    );
  const fit = solveFit(problem, U, V);
  if (!fit.ok) return fit;
  return ok({ ...fit.value, converged: true });
}
