import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf } from './arrays';
import { type ModelingError, modelingError } from './errors';
import type { Tuple3 } from './geom';
import {
  checkSurface,
  clampH,
  elevateH,
  type H,
  insertH,
  mergeKnots,
  type NurbsSurface,
  refineH,
  removeKnotH,
  surfaceDerivatives,
  surfaceDomain,
  surfaceFromH,
  surfaceH,
  surfacePoint,
} from './nurbs';

/**
 * Surface algebra (The NURBS Book chapter 5 applied per direction): knot insertion,
 * refinement, degree elevation, isoparametric split, extension and compatibility. Every
 * operation except `extend` keeps the shape exactly; each acts on the control lines
 * running along one parameter direction and leaves the other direction untouched.
 */
export type SurfaceDirection = 'u' | 'v';

/** A boundary of a patch: `u0` is the isoparm u = u-min (it runs along v). */
export type PatchSide = 'u0' | 'u1' | 'v0' | 'v1';

export interface ExtendOptions {
  /**
   * 'G2' (default) continues the boundary span's own polynomial, so the extension is as
   * smooth as the patch; 'G1' continues along the cross-boundary tangent (ruled).
   */
  readonly continuity?: 'G1' | 'G2';
}

function invalid(expected: string, detail: Record<string, unknown> = {}): ModelingError {
  return modelingError('model-invalid-argument', expected, detail);
}

interface Lines {
  readonly p: number;
  readonly knots: number[];
  /** Homogeneous control points of each line along the direction. */
  readonly hs: H[];
}

/** The control lines running along `dir`: for 'u', one per column j with points i = 0..nu-1. */
function linesOf(s: NurbsSurface, dir: SurfaceDirection): Lines {
  const nu = s.points.length;
  const nv = (s.points[0] as readonly Tuple3[]).length;
  const h = surfaceH(s);
  const [count, lines] = dir === 'u' ? [nu, nv] : [nv, nu];
  const hs: H[] = [];
  for (let l = 0; l < lines; l++) {
    const line = new Float64Array(4 * count);
    for (let k = 0; k < count; k++) {
      const o = 4 * (dir === 'u' ? k * nv + l : l * nv + k);
      line.set(h.subarray(o, o + 4), 4 * k);
    }
    hs.push(line);
  }
  return dir === 'u'
    ? { p: s.degreeU, knots: [...s.knotsU], hs }
    : { p: s.degreeV, knots: [...s.knotsV], hs };
}

function withLines(s: NurbsSurface, dir: SurfaceDirection, lines: Lines): NurbsSurface {
  const count = (lines.hs[0] as H).length / 4;
  const n = lines.hs.length;
  const [nu, nv] = dir === 'u' ? [count, n] : [n, count];
  const h = new Float64Array(4 * nu * nv);
  for (const [l, line] of lines.hs.entries()) {
    for (let k = 0; k < count; k++) {
      const o = 4 * (dir === 'u' ? k * nv + l : l * nv + k);
      h.set(line.subarray(4 * k, 4 * k + 4), o);
    }
  }
  return dir === 'u'
    ? surfaceFromH(lines.p, s.degreeV, lines.knots, s.knotsV, h, nu, nv)
    : surfaceFromH(s.degreeU, lines.p, s.knotsU, lines.knots, h, nu, nv);
}

/** Apply one curve operation to every line along `dir`; all lines share the resulting knots. */
export function mapLines(
  s: NurbsSurface,
  dir: SurfaceDirection,
  degree: number,
  op: (p: number, knots: readonly number[], h: H) => { knots: number[]; h: H },
): NurbsSurface {
  const lines = linesOf(s, dir);
  let knots: number[] = lines.knots;
  const hs = lines.hs.map((h) => {
    const out = op(lines.p, lines.knots, h);
    knots = out.knots;
    return out.h;
  });
  return withLines(s, dir, { p: degree, knots, hs });
}

function checked(s: NurbsSurface, dir?: unknown): Result<NurbsSurface, ModelingError> {
  if (dir !== undefined && dir !== 'u' && dir !== 'v')
    return err(invalid("direction is 'u' or 'v'", { dir }));
  return checkSurface(s);
}

function dirDomain(s: NurbsSurface, dir: SurfaceDirection): readonly [number, number] {
  return surfaceDomain(s)[dir === 'u' ? 0 : 1];
}

/** Insert knot `t` along `dir` up to `times` times (multiplicity stops at the degree). */
export function surfaceInsertKnot(
  s: NurbsSurface,
  dir: SurfaceDirection,
  t: number,
  times = 1,
): Result<NurbsSurface, ModelingError> {
  const c = checked(s, dir);
  if (!c.ok) return c;
  const [a, b] = dirDomain(s, dir);
  if (!(Number.isFinite(t) && t >= a && t <= b))
    return err(invalid('the knot lies in the parameter domain', { dir, t, domain: [a, b] }));
  if (!(Number.isInteger(times) && times >= 1))
    return err(invalid('times is an integer >= 1', { times }));
  const p = dir === 'u' ? s.degreeU : s.degreeV;
  return ok(mapLines(s, dir, p, (q, knots, h) => insertH(q, knots, h, t, times)));
}

/** Insert every knot of the non-decreasing list `knots` along `dir` that is missing. */
export function surfaceRefine(
  s: NurbsSurface,
  dir: SurfaceDirection,
  knots: readonly number[],
): Result<NurbsSurface, ModelingError> {
  const c = checked(s, dir);
  if (!c.ok) return c;
  const [a, b] = dirDomain(s, dir);
  if (
    !Array.isArray(knots) ||
    knots.some((t, i) => !Number.isFinite(t) || t < a || t > b || (i > 0 && t < knots[i - 1]))
  )
    return err(
      invalid('knots is a non-decreasing list inside the domain', { dir, domain: [a, b] }),
    );
  const p = dir === 'u' ? s.degreeU : s.degreeV;
  return ok(mapLines(s, dir, p, (q, current, h) => refineH(q, current, h, knots)));
}

/**
 * Raise the degree along `dir` by `by` exactly (A5.9 on each line; end knots are
 * clamped first). Interior knots keep their multiplicity plus `by`.
 */
export function surfaceElevate(
  s: NurbsSurface,
  dir: SurfaceDirection,
  by = 1,
): Result<NurbsSurface, ModelingError> {
  const c = checked(s, dir);
  if (!c.ok) return c;
  if (!(Number.isInteger(by) && by >= 0)) return err(invalid('by is an integer >= 0', { by }));
  const p = dir === 'u' ? s.degreeU : s.degreeV;
  return ok(
    mapLines(s, dir, p + by, (q, knots, h) => {
      const clamped = clampH(q, knots, h);
      return elevateH(q, clamped.knots, clamped.h, by);
    }),
  );
}

/**
 * Split at the isoparm `dir` = `t` (strictly inside the domain) into the part before and
 * the part after. Both keep the original parametrization; they are one polynomial, so
 * the seam is exactly as smooth as the patch there.
 */
export function surfaceSplit(
  s: NurbsSurface,
  dir: SurfaceDirection,
  t: number,
): Result<readonly [NurbsSurface, NurbsSurface], ModelingError> {
  const c = checked(s, dir);
  if (!c.ok) return c;
  const [a, b] = dirDomain(s, dir);
  if (!(Number.isFinite(t) && t > a && t < b))
    return err(
      invalid('the split parameter lies strictly inside the domain', { dir, t, domain: [a, b] }),
    );
  const p = dir === 'u' ? s.degreeU : s.degreeV;
  const lines = linesOf(
    mapLines(s, dir, p, (q, knots, h) => {
      const clamped = clampH(q, knots, h);
      return insertH(q, clamped.knots, clamped.h, t, q);
    }),
    dir,
  );
  const first = lines.knots.indexOf(t);
  const last = lines.knots.lastIndexOf(t);
  const before: Lines = {
    p,
    knots: [...lines.knots.slice(0, first), ...new Array<number>(p + 1).fill(t)],
    hs: lines.hs.map((h) => h.slice(0, 4 * first)),
  };
  const after: Lines = {
    p,
    knots: [...new Array<number>(p + 1).fill(t), ...lines.knots.slice(last + 1)],
    hs: lines.hs.map((h) => h.slice(4 * (last - p))),
  };
  return ok([withLines(s, dir, before), withLines(s, dir, after)]);
}

function reverseKnots(knots: readonly number[]): number[] {
  const a = knots[0] as number;
  const b = knots[knots.length - 1] as number;
  return knots.map((k) => a + b - k).reverse();
}

/** The same surface with `dir` reversed (its normal flips); the domain stays the same interval. */
export function surfaceReverse(s: NurbsSurface, dir: SurfaceDirection): NurbsSurface {
  if (dir === 'u')
    return {
      ...s,
      points: [...s.points].reverse(),
      ...(s.weights === undefined ? {} : { weights: [...s.weights].reverse() }),
      knotsU: reverseKnots(s.knotsU),
    };
  return {
    ...s,
    points: s.points.map((row) => [...row].reverse()),
    ...(s.weights === undefined ? {} : { weights: s.weights.map((row) => [...row].reverse()) }),
    knotsV: reverseKnots(s.knotsV),
  };
}

/** The same surface with clamped knots and domain [0, 1] along `dir`. */
export function surfaceNormalize(s: NurbsSurface, dir: SurfaceDirection): NurbsSurface {
  const p = dir === 'u' ? s.degreeU : s.degreeV;
  return mapLines(s, dir, p, (q, knots, h) => {
    const clamped = clampH(q, knots, h);
    const a = clamped.knots[0] as number;
    const b = clamped.knots[clamped.knots.length - 1] as number;
    return { knots: clamped.knots.map((t) => (t === b ? 1 : (t - a) / (b - a))), h: clamped.h };
  });
}

/**
 * Make surfaces compatible along `dir`: domain [0, 1], one degree (the highest) and one
 * knot vector (the union), each exactly the same shape as before.
 */
export function surfaceCompatible(
  surfaces: readonly NurbsSurface[],
  dir: SurfaceDirection,
): Result<NurbsSurface[], ModelingError> {
  if (!Array.isArray(surfaces) || surfaces.length === 0)
    return err(invalid('compatible takes at least one surface', {}));
  for (const s of surfaces) {
    const c = checked(s, dir);
    if (!c.ok) return c;
  }
  const degree = maxOf(surfaces.map((s) => (dir === 'u' ? s.degreeU : s.degreeV)));
  const raised: NurbsSurface[] = [];
  for (const s of surfaces) {
    const n = surfaceNormalize(s, dir);
    const p = dir === 'u' ? n.degreeU : n.degreeV;
    const e = surfaceElevate(n, dir, degree - p);
    if (!e.ok) return e;
    raised.push(e.value);
  }
  const union = mergeKnots(raised.map((s) => (dir === 'u' ? s.knotsU : s.knotsV)));
  const out: NurbsSurface[] = [];
  for (const s of raised) {
    const r = surfaceRefine(s, dir, union);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}

/** Extrapolated Bezier: control points of the same polynomial on [0, lambda] (de Casteljau). */
function extrapolate(bezier: readonly H[], lambda: number): H[] {
  const q = bezier.map((x) => Float64Array.from(x));
  const out: H[] = [Float64Array.from(q[0] as H)];
  for (let k = 1; k < q.length; k++) {
    for (let i = 0; i < q.length - k; i++) {
      const a = q[i] as H;
      const b = q[i + 1] as H;
      for (let c = 0; c < 4; c++)
        a[c] = (1 - lambda) * (a[c] as number) + lambda * (b[c] as number);
    }
    out.push(Float64Array.from(q[0] as H));
  }
  return out;
}

/** Scale of the control net, for removal tolerances. */
function netScale(s: NurbsSurface): number {
  let m = 1;
  for (const row of s.points) for (const p of row) m = Math.max(m, ...p.map(Math.abs));
  return m;
}

/** Remove `times` copies of `u` along `dir` from every line when all lines allow it. */
function removeKnot(
  s: NurbsSurface,
  dir: SurfaceDirection,
  u: number,
  times: number,
  tol: number,
): NurbsSurface {
  let lines = linesOf(s, dir);
  for (let k = 0; k < times; k++) {
    const out = lines.hs.map((h) => removeKnotH(lines.p, lines.knots, h, u, tol));
    if (out.some((o) => o === undefined)) break;
    lines = {
      p: lines.p,
      knots: (out[0] as { knots: number[] }).knots,
      hs: out.map((o) => (o as { h: H }).h),
    };
  }
  return withLines(s, dir, lines);
}

/** Extend past the u-max (or v-max) end by the parameter amount `d`. */
function extendEnd(
  raw: NurbsSurface,
  dir: SurfaceDirection,
  d: number,
  continuity: 'G1' | 'G2',
): NurbsSurface {
  const p = dir === 'u' ? raw.degreeU : raw.degreeV;
  const s = mapLines(raw, dir, p, (q, knots, h) => clampH(q, knots, h));
  const lines = linesOf(s, dir);
  const knots = lines.knots;
  const n = (lines.hs[0] as H).length / 4;
  const b = knots[n] as number;
  const tol = 1e-12 * netScale(s);
  if (continuity === 'G1') {
    // C'(b) = p (P_n-1 - P_n-2) / (b - U[n-1]); the new span is linear in homogeneous space.
    const factor = p / (b - (knots[n - 1] as number));
    const hs = lines.hs.map((h) => {
      const last = h.subarray(4 * (n - 1), 4 * n);
      const prev = h.subarray(4 * (n - 2), 4 * (n - 1));
      const out = new Float64Array(4 * (n + p));
      out.set(h);
      for (let k = 1; k <= p; k++)
        for (let c = 0; c < 4; c++)
          out[4 * (n - 1 + k) + c] =
            (last[c] as number) +
            (k / p) * d * factor * ((last[c] as number) - (prev[c] as number));
      return out;
    });
    const extended = withLines(s, dir, {
      p,
      knots: [
        ...knots.slice(0, n),
        ...new Array<number>(p).fill(b),
        ...new Array<number>(p + 1).fill(b + d),
      ],
      hs,
    });
    return removeKnot(extended, dir, b, p, tol);
  }
  // G2: the last span as a Bezier segment on [c, b], continued to [c, b + d].
  const c = [...knots].reverse().find((t) => t < b) as number;
  const start = knots[p] as number;
  const mc = knots.filter((t) => t === c).length;
  const bez = c > start ? linesOf(surfaceInsertKnotRaw(s, dir, c, p - mc), dir) : lines;
  const m = (bez.hs[0] as H).length / 4;
  const lambda = (b + d - c) / (b - c);
  const hs = bez.hs.map((h) => {
    const segment = Array.from({ length: p + 1 }, (_, k) =>
      h.subarray(4 * (m - 1 - p + k), 4 * (m - p + k)),
    );
    const out = Float64Array.from(h);
    for (const [k, q] of extrapolate(segment, lambda).entries()) out.set(q, 4 * (m - 1 - p + k));
    return out;
  });
  const extended = withLines(s, dir, {
    p,
    knots: [...bez.knots.slice(0, m), ...new Array<number>(p + 1).fill(b + d)],
    hs,
  });
  return c > start ? removeKnot(extended, dir, c, p - mc, tol) : extended;
}

function surfaceInsertKnotRaw(
  s: NurbsSurface,
  dir: SurfaceDirection,
  t: number,
  times: number,
): NurbsSurface {
  const p = dir === 'u' ? s.degreeU : s.degreeV;
  return mapLines(s, dir, p, (q, knots, h) => insertH(q, knots, h, t, times));
}

const SIDE_SAMPLES = 16;

/** Mean distance between the side of `s` and the same side of `e` (the extension's reach). */
function reach(s: NurbsSurface, e: NurbsSurface, side: PatchSide): number {
  const along = side === 'u0' || side === 'u1' ? 1 : 0;
  const pick = (x: NurbsSurface, f: number) => {
    const [[u0, u1], [v0, v1]] = surfaceDomain(x);
    const fixed = side === 'u0' ? u0 : side === 'u1' ? u1 : side === 'v0' ? v0 : v1;
    const run = along === 1 ? v0 + (v1 - v0) * f : u0 + (u1 - u0) * f;
    return along === 1 ? surfacePoint(x, fixed, run) : surfacePoint(x, run, fixed);
  };
  let sum = 0;
  for (let k = 0; k <= SIDE_SAMPLES; k++) {
    const f = k / SIDE_SAMPLES;
    const a = pick(s, f);
    const b = pick(e, f);
    const d: Tuple3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    sum += Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  }
  return sum / (SIDE_SAMPLES + 1);
}

/**
 * Extend the patch past `side` by about `length` meters (the mean distance between the
 * old and the new side). The original domain keeps its shape; the new domain grows by
 * the extension's parameter length.
 */
export function surfaceExtend(
  s: NurbsSurface,
  side: PatchSide,
  length: number,
  options: ExtendOptions = {},
): Result<NurbsSurface, ModelingError> {
  const c = checked(s);
  if (!c.ok) return c;
  if (side !== 'u0' && side !== 'u1' && side !== 'v0' && side !== 'v1')
    return err(invalid("side is 'u0', 'u1', 'v0' or 'v1'", { side }));
  if (!(Number.isFinite(length) && length > 0))
    return err(invalid('length is a finite number > 0', { length }));
  const continuity = options.continuity ?? 'G2';
  if (continuity !== 'G1' && continuity !== 'G2')
    return err(invalid("continuity is 'G1' or 'G2'", { continuity }));
  const dir: SurfaceDirection = side === 'u0' || side === 'u1' ? 'u' : 'v';
  const atStart = side === 'u0' || side === 'v0';
  const base = atStart ? surfaceReverse(s, dir) : s;
  const endSide: PatchSide = dir === 'u' ? 'u1' : 'v1';
  // First-order parameter step from the mean cross-boundary speed, then secant steps.
  const b = dirDomain(base, dir)[1];
  let speed = 0;
  for (let k = 0; k <= SIDE_SAMPLES; k++) {
    const [[u0, u1], [v0, v1]] = surfaceDomain(base);
    const f = k / SIDE_SAMPLES;
    const [u, v] = dir === 'u' ? [b, v0 + (v1 - v0) * f] : [u0 + (u1 - u0) * f, b];
    const d = surfaceDerivatives(base, u, v, 1);
    const w = (dir === 'u' ? (d[1] as Tuple3[])[0] : (d[0] as Tuple3[])[1]) as Tuple3;
    speed += Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
  }
  speed /= SIDE_SAMPLES + 1;
  if (!(speed > 0))
    return err(
      modelingError('model-degenerate', 'the patch has a cross-boundary tangent at the side', {
        side,
      }),
    );
  // Secant iteration on the reach, starting from the first-order step.
  let d0 = length / speed;
  let extended = extendEnd(base, dir, d0, continuity);
  let g0 = reach(base, extended, endSide) - length;
  let d1 = d0 * (length / (g0 + length));
  for (let it = 0; it < 24 && Math.abs(g0) > 1e-10 * length; it++) {
    const next = extendEnd(base, dir, d1, continuity);
    const g1 = reach(base, next, endSide) - length;
    extended = next;
    if (Math.abs(g1) <= 1e-10 * length || g1 === g0) break;
    const d2 = d1 - (g1 * (d1 - d0)) / (g1 - g0);
    [d0, g0, d1] = [d1, g1, d2 > 0 ? d2 : d1 / 2];
  }
  if (!atStart) return ok(extended);
  // Reversing back maps [a, b + d] onto itself; shift so the original part keeps [a, b].
  const back = surfaceReverse(extended, dir);
  const shift = dirDomain(back, dir)[1] - dirDomain(s, dir)[1];
  return ok(
    dir === 'u'
      ? { ...back, knotsU: back.knotsU.map((t) => t - shift) }
      : { ...back, knotsV: back.knotsV.map((t) => t - shift) },
  );
}
