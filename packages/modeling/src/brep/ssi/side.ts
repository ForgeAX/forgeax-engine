import { maxOf } from '../../arrays';
import { cos, hypot2, hypot3, sin } from '../../dmath';
import type { NurbsSurface } from '../../nurbs';
import { surfaceDerivatives, surfaceDomain, surfacePoint } from '../../nurbs';
import { surfaceInverse } from '../surfaces';
import type { Surface } from '../types';
import { cross3, dist3, dot3, len3, type P2, type P3, scale3, sub3, TWO_PI } from '../vec';
import type { ParamBox } from './types';

export type AnalyticSurface = Exclude<Surface, { kind: 'nurbs' }>;

/** Point and first partials of a parametric face at one (u, v). */
export interface Jet {
  readonly p: P3;
  readonly du: P3;
  readonly dv: P3;
}

/**
 * A NURBS face marched in unwrapped parameters: a closed direction (the two parameter ends are one
 * seam in space and the face spans the whole domain) has a period and no boundary there.
 */
export interface NurbsSide {
  readonly surface: NurbsSurface;
  readonly box: ParamBox;
  readonly period: readonly [number, number];
  /** Interior knot lines inside the box where the surface normal jumps: `dir` 0 is a u = value line. */
  readonly kinks: readonly { readonly dir: 0 | 1; readonly value: number }[];
  jet(u: number, v: number): Jet;
  inside(u: number, v: number): boolean;
  /** The first parameter outside a bounded direction, and the bound it crossed. */
  exit(u: number, v: number): { readonly dir: 0 | 1; readonly value: number } | undefined;
}

const SEAM_SAMPLES = 7;

function wrapInto(x: number, lo: number, period: number): number {
  if (period === 0) return x;
  const k = Math.floor((x - lo) / period);
  return x - k * period;
}

/** Scale of the control net: the largest coordinate magnitude, at least 1. */
function netScale(s: NurbsSurface): number {
  let m = 1;
  for (const row of s.points) for (const p of row) m = Math.max(m, maxOf(p.map(Math.abs)));
  return m;
}

function seamPeriod(s: NurbsSurface, box: ParamBox, dir: 0 | 1): number {
  const [[u0, u1], [v0, v1]] = surfaceDomain(s);
  const full =
    dir === 0 ? box[0][0] === u0 && box[0][1] === u1 : box[1][0] === v0 && box[1][1] === v1;
  if (!full) return 0;
  const tol = 1e-10 * netScale(s);
  for (let k = 0; k < SEAM_SAMPLES; k++) {
    const f = k / (SEAM_SAMPLES - 1);
    const a =
      dir === 0 ? surfacePoint(s, u0, v0 + (v1 - v0) * f) : surfacePoint(s, u0 + (u1 - u0) * f, v0);
    const b =
      dir === 0 ? surfacePoint(s, u1, v0 + (v1 - v0) * f) : surfacePoint(s, u0 + (u1 - u0) * f, v1);
    if (dist3(a, b) > tol) return 0;
  }
  return dir === 0 ? u1 - u0 : v1 - v0;
}

const KINK_SAMPLES = 5;
const KINK_SINE = 1e-6;

function unitNormal(s: NurbsSurface, u: number, v: number): P3 | undefined {
  const d = surfaceDerivatives(s, u, v, 1);
  const n = cross3((d[1] as P3[])[0] as P3, (d[0] as P3[])[1] as P3);
  const l = len3(n);
  return l > 0 ? scale3(n, 1 / l) : undefined;
}

/** Knot lines of full multiplicity inside the box across which the unit normal jumps. */
function kinkLines(s: NurbsSurface, box: ParamBox): { dir: 0 | 1; value: number }[] {
  const out: { dir: 0 | 1; value: number }[] = [];
  for (const dir of [0, 1] as const) {
    const knots = dir === 0 ? s.knotsU : s.knotsV;
    const p = dir === 0 ? s.degreeU : s.degreeV;
    const [lo, hi] = box[dir];
    const [olo, ohi] = box[1 - dir] as readonly [number, number];
    const delta = 1e-7 * (hi - lo);
    for (let i = 0; i < knots.length; ) {
      const k = knots[i] as number;
      let j = i;
      while (j < knots.length && knots[j] === k) j++;
      if (j - i >= p && k > lo && k < hi) {
        let kink = false;
        for (let m = 0; m < KINK_SAMPLES && !kink; m++) {
          const o = olo + ((ohi - olo) * (m + 0.5)) / KINK_SAMPLES;
          const a = dir === 0 ? unitNormal(s, k - delta, o) : unitNormal(s, o, k - delta);
          const b = dir === 0 ? unitNormal(s, k + delta, o) : unitNormal(s, o, k + delta);
          kink = a !== undefined && b !== undefined && len3(cross3(a, b)) > KINK_SINE;
        }
        if (kink) out.push({ dir, value: k });
      }
      i = j;
    }
  }
  return out;
}

export function nurbsSide(surface: NurbsSurface, bounds: ParamBox | undefined): NurbsSide {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const box: ParamBox = bounds ?? [
    [u0, u1],
    [v0, v1],
  ];
  const period: readonly [number, number] = [
    seamPeriod(surface, box, 0),
    seamPeriod(surface, box, 1),
  ];
  const epsU = 1e-12 * (box[0][1] - box[0][0]);
  const epsV = 1e-12 * (box[1][1] - box[1][0]);
  return {
    surface,
    box,
    period,
    kinks: kinkLines(surface, box),
    jet(u, v) {
      const d = surfaceDerivatives(
        surface,
        wrapInto(u, box[0][0], period[0]),
        wrapInto(v, box[1][0], period[1]),
        1,
      );
      const row0 = d[0] as P3[];
      return { p: row0[0] as P3, du: (d[1] as P3[])[0] as P3, dv: row0[1] as P3 };
    },
    inside(u, v) {
      return (
        (period[0] > 0 || (u >= box[0][0] - epsU && u <= box[0][1] + epsU)) &&
        (period[1] > 0 || (v >= box[1][0] - epsV && v <= box[1][1] + epsV))
      );
    },
    exit(u, v) {
      for (const [dir, x, eps] of [
        [0, u, epsU],
        [1, v, epsV],
      ] as const) {
        if (period[dir] > 0) continue;
        const [lo, hi] = box[dir];
        if (x < lo - eps) return { dir, value: lo };
        if (x > hi + eps) return { dir, value: hi };
      }
      return undefined;
    },
  };
}

/**
 * An analytic face seen as a signed, 1-Lipschitz implicit function (zero on the surface, gradient of
 * unit length away from its axis) plus the parameter rectangle it is bounded to.
 */
export interface AnalyticSide {
  readonly surface: AnalyticSurface;
  readonly box: ParamBox;
  readonly period: readonly [number, number];
  /** Linear in space (a plane): the sign over a convex hull is decided at its vertices. */
  readonly linear: boolean;
  f(p: P3): number;
  /** Unit gradient of `f`; the zero vector on an axis where it is undefined. */
  grad(p: P3): P3;
  inside(p: P3): boolean;
  uv(p: P3): P2;
}

/** Bounded analytic face, or the name of the direction a caller must bound. */
export function analyticSide(
  s: AnalyticSurface,
  bounds: ParamBox | undefined,
): AnalyticSide | { readonly unbounded: 'u' | 'v' } {
  const periodic: readonly [boolean, boolean] = [s.kind !== 'plane', s.kind === 'torus'];
  const fallback: readonly [
    readonly [number, number] | undefined,
    readonly [number, number] | undefined,
  ] = [
    periodic[0] ? [0, TWO_PI] : undefined,
    s.kind === 'torus'
      ? [0, TWO_PI]
      : s.kind === 'sphere'
        ? [-Math.PI / 2, Math.PI / 2]
        : undefined,
  ];
  const bu = bounds?.[0] ?? fallback[0];
  const bv = bounds?.[1] ?? fallback[1];
  if (bu === undefined) return { unbounded: 'u' };
  if (bv === undefined) return { unbounded: 'v' };
  const box: ParamBox = [bu, bv];
  const full = (r: readonly [number, number]) => r[1] - r[0] >= TWO_PI * (1 - 1e-12);
  const period: readonly [number, number] = [
    periodic[0] && full(bu) ? TWO_PI : 0,
    periodic[1] && full(bv) ? TWO_PI : 0,
  ];
  const f = s.frame;
  const local = (p: P3): P3 => {
    const d = sub3(p, f.o);
    return [dot3(d, f.x), dot3(d, f.y), dot3(d, f.z)];
  };
  const world = (a: number, b: number, c: number): P3 => [
    f.x[0] * a + f.y[0] * b + f.z[0] * c,
    f.x[1] * a + f.y[1] * b + f.z[1] * c,
    f.x[2] * a + f.y[2] * b + f.z[2] * c,
  ];
  const radial = (l: P3): readonly [number, number, number] => {
    const rho = hypot2(l[0], l[1]);
    return rho === 0 ? [0, 0, 0] : [l[0] / rho, l[1] / rho, rho];
  };
  const eps = (r: readonly [number, number]) => 1e-12 * Math.max(1, Math.abs(r[0]), Math.abs(r[1]));
  const within = (
    x: number,
    r: readonly [number, number],
    period: number,
    wrap: boolean,
  ): boolean => {
    if (period > 0) return true;
    const y = wrap ? wrapInto(x, r[0] - eps(r), TWO_PI) : x;
    return y >= r[0] - eps(r) && y <= r[1] + eps(r);
  };
  const uv = (p: P3): P2 => {
    const inv = surfaceInverse(s, p);
    return [inv.u, inv.v];
  };
  const inside = (p: P3): boolean => {
    const [u, v] = uv(p);
    return within(u, bu, period[0], periodic[0]) && within(v, bv, period[1], periodic[1]);
  };
  const base = { surface: s, box, period, inside, uv };
  switch (s.kind) {
    case 'plane':
      return { ...base, linear: true, f: (p) => local(p)[2], grad: () => f.z };
    case 'cylinder':
      return {
        ...base,
        linear: false,
        f: (p) => {
          const l = local(p);
          return hypot2(l[0], l[1]) - s.radius;
        },
        grad: (p) => {
          const [cx, cy] = radial(local(p));
          return world(cx, cy, 0);
        },
      };
    case 'sphere':
      return {
        ...base,
        linear: false,
        f: (p) => {
          const l = local(p);
          return hypot3(l[0], l[1], l[2]) - s.radius;
        },
        grad: (p) => {
          const l = local(p);
          const r = hypot3(l[0], l[1], l[2]);
          return r === 0 ? [0, 0, 0] : world(l[0] / r, l[1] / r, l[2] / r);
        },
      };
    case 'cone': {
      const sa = sin(s.halfAngle);
      const ca = cos(s.halfAngle);
      return {
        ...base,
        linear: false,
        f: (p) => {
          const l = local(p);
          return (hypot2(l[0], l[1]) - s.radius) * ca - l[2] * sa;
        },
        grad: (p) => {
          const [cx, cy, rho] = radial(local(p));
          return rho === 0 ? [0, 0, 0] : world(cx * ca, cy * ca, -sa);
        },
      };
    }
    case 'torus':
      return {
        ...base,
        linear: false,
        f: (p) => {
          const l = local(p);
          return hypot2(hypot2(l[0], l[1]) - s.major, l[2]) - s.minor;
        },
        grad: (p) => {
          const l = local(p);
          const [cx, cy, rho] = radial(l);
          const a = rho - s.major;
          const r = hypot2(a, l[2]);
          return r === 0 || rho === 0 ? [0, 0, 0] : world((cx * a) / r, (cy * a) / r, l[2] / r);
        },
      };
  }
}
