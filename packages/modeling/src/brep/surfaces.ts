import { atan2, cos, hypot2, hypot3, sin } from '../dmath';
import {
  surfaceDerivatives as nurbsDerivatives,
  surfaceDomain as nurbsDomain,
  surfacePoint as nurbsPoint,
  surfaceClosest,
} from '../nurbs';
import { tally } from './ops';
import type { Frame, Surface } from './types';
import { add3, cross3, dot3, HALF_PI, madd3, type P3, scale3, sub3, TWO_PI, unit3 } from './vec';

/**
 * Right-handed orthonormal frame at `o` with axis `z`; `x` is `xHint` made orthogonal to `z`
 * (a deterministic perpendicular when absent or parallel to `z`).
 */
export function makeFrame(o: P3, z: P3, xHint?: P3): Frame {
  const zz = unit3(z);
  let x: P3 | undefined;
  if (xHint !== undefined) {
    const t = sub3(xHint, scale3(zz, dot3(xHint, zz)));
    if (dot3(t, t) > 1e-24) x = unit3(t);
  }
  if (x === undefined) {
    const ax = Math.abs(zz[0]);
    const ay = Math.abs(zz[1]);
    const az = Math.abs(zz[2]);
    const helper: P3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    x = unit3(cross3(helper, zz));
  }
  return { o, x, y: cross3(zz, x), z: zz };
}

/** Period (0 = none) and bounds of each surface parameter. */
export interface SurfaceDomain {
  readonly uPeriod: number;
  readonly vPeriod: number;
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
}

export function surfaceDomain(s: Surface): SurfaceDomain {
  switch (s.kind) {
    case 'plane':
      return {
        uPeriod: 0,
        vPeriod: 0,
        uMin: -Infinity,
        uMax: Infinity,
        vMin: -Infinity,
        vMax: Infinity,
      };
    case 'cylinder':
    case 'cone':
      return {
        uPeriod: TWO_PI,
        vPeriod: 0,
        uMin: -Infinity,
        uMax: Infinity,
        vMin: -Infinity,
        vMax: Infinity,
      };
    case 'sphere':
      return {
        uPeriod: TWO_PI,
        vPeriod: 0,
        uMin: -Infinity,
        uMax: Infinity,
        vMin: -HALF_PI,
        vMax: HALF_PI,
      };
    case 'torus':
      return {
        uPeriod: TWO_PI,
        vPeriod: TWO_PI,
        uMin: -Infinity,
        uMax: Infinity,
        vMin: -Infinity,
        vMax: Infinity,
      };
    case 'nurbs': {
      const [[u0, u1], [v0, v1]] = nurbsDomain(s.surface);
      return { uPeriod: 0, vPeriod: 0, uMin: u0, uMax: u1, vMin: v0, vMax: v1 };
    }
  }
}

function radialAt(f: Frame, c: number, s: number): P3 {
  return add3(scale3(f.x, c), scale3(f.y, s));
}

function tangentAt(f: Frame, c: number, s: number): P3 {
  return add3(scale3(f.x, -s), scale3(f.y, c));
}

export function surfacePoint(s: Surface, u: number, v: number): P3 {
  tally('surfaceEvals');
  if (s.kind === 'nurbs') return nurbsPoint(s.surface, u, v);
  const f = s.frame;
  switch (s.kind) {
    case 'plane':
      return madd3(madd3(f.o, f.x, u), f.y, v);
    case 'cylinder': {
      const r = radialAt(f, cos(u), sin(u));
      return madd3(madd3(f.o, r, s.radius), f.z, v);
    }
    case 'sphere': {
      const cv = cos(v);
      const r = radialAt(f, cos(u), sin(u));
      return madd3(madd3(f.o, r, s.radius * cv), f.z, s.radius * sin(v));
    }
    case 'cone': {
      const r = radialAt(f, cos(u), sin(u));
      return madd3(madd3(f.o, r, s.radius + v * sin(s.halfAngle)), f.z, v * cos(s.halfAngle));
    }
    case 'torus': {
      const r = radialAt(f, cos(u), sin(u));
      return madd3(madd3(f.o, r, s.major + s.minor * cos(v)), f.z, s.minor * sin(v));
    }
  }
}

/** First partial derivatives `dp/du`, `dp/dv`. */
export function surfaceDerivatives(s: Surface, u: number, v: number): { du: P3; dv: P3 } {
  tally('surfaceEvals');
  if (s.kind === 'nurbs') {
    const ders = nurbsDerivatives(s.surface, u, v, 1);
    return { du: ders[1]?.[0] as P3, dv: ders[0]?.[1] as P3 };
  }
  const f = s.frame;
  const cu = cos(u);
  const su = sin(u);
  switch (s.kind) {
    case 'plane':
      return { du: f.x, dv: f.y };
    case 'cylinder':
      return { du: scale3(tangentAt(f, cu, su), s.radius), dv: f.z };
    case 'sphere': {
      const cv = cos(v);
      const sv = sin(v);
      return {
        du: scale3(tangentAt(f, cu, su), s.radius * cv),
        dv: scale3(madd3(scale3(radialAt(f, cu, su), -sv), f.z, cv), s.radius),
      };
    }
    case 'cone': {
      const sa = sin(s.halfAngle);
      const ca = cos(s.halfAngle);
      return {
        du: scale3(tangentAt(f, cu, su), s.radius + v * sa),
        dv: madd3(scale3(radialAt(f, cu, su), sa), f.z, ca),
      };
    }
    case 'torus': {
      const cv = cos(v);
      const sv = sin(v);
      return {
        du: scale3(tangentAt(f, cu, su), s.major + s.minor * cv),
        dv: scale3(madd3(scale3(radialAt(f, cu, su), -sv), f.z, cv), s.minor),
      };
    }
  }
}

/** Closed-form unit normal `dp/du x dp/dv` direction; defined at poles and the apex. */
export function surfaceNormal(s: Surface, u: number, v: number): P3 {
  tally('surfaceEvals');
  if (s.kind === 'nurbs') {
    const { du, dv } = surfaceDerivatives(s, u, v);
    const n = cross3(du, dv);
    const len = Math.sqrt(dot3(n, n));
    return len === 0 ? [0, 0, 0] : scale3(n, 1 / len);
  }
  const f = s.frame;
  switch (s.kind) {
    case 'plane':
      return f.z;
    case 'cylinder':
      return radialAt(f, cos(u), sin(u));
    case 'sphere':
    case 'torus': {
      const r = radialAt(f, cos(u), sin(u));
      return madd3(scale3(r, cos(v)), f.z, sin(v));
    }
    case 'cone':
      return madd3(scale3(radialAt(f, cos(u), sin(u)), cos(s.halfAngle)), f.z, -sin(s.halfAngle));
  }
}

export interface SurfaceInverse {
  readonly u: number;
  readonly v: number;
  /** Distance from the point to the surface. */
  readonly dist: number;
}

const SEAM_SNAP = 1e-9;

/** `u` modulo a full turn in [0, 2 pi) for any finite input; values within 1e-9 below the seam snap to 0. */
export function wrapPeriod(u: number): number {
  const w = u - TWO_PI * Math.floor(u / TWO_PI);
  return w >= TWO_PI - SEAM_SNAP || w < 0 ? 0 : w;
}

/** Largest deviation of a frame axis from unit length, or of two axes from orthogonal. */
export const FRAME_TOL = 1e-9;

/**
 * Why a frame is not a right-handed orthonormal one, or `undefined`: `non-finite-frame`, `non-unit-axis`,
 * `non-orthogonal-axes` or `left-handed` (`x` cross `y` must point along `z`).
 */
export function frameDefect(f: Frame): string | undefined {
  const axes = [f.x, f.y, f.z];
  const triples = [f.o, ...axes];
  const vector = (v: unknown): v is P3 =>
    Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!triples.every(vector)) return 'non-finite-frame';
  if (axes.some((a) => Math.abs(dot3(a, a) - 1) > FRAME_TOL)) return 'non-unit-axis';
  if (
    Math.abs(dot3(f.x, f.y)) > FRAME_TOL ||
    Math.abs(dot3(f.y, f.z)) > FRAME_TOL ||
    Math.abs(dot3(f.z, f.x)) > FRAME_TOL
  ) {
    return 'non-orthogonal-axes';
  }
  return dot3(cross3(f.x, f.y), f.z) > 0 ? undefined : 'left-handed';
}

/**
 * Closest-point parameters by closed form. `u` is in [0, 2 pi) for periodic kinds; on an axis
 * (a pole or an axis point) `u` is 0. Below the cone apex the signed radius is negative, so `u` is
 * the horizontal angle plus a half turn and `v` stays the signed distance along the generatrix.
 */
export function surfaceInverse(s: Surface, p: P3): SurfaceInverse {
  if (s.kind === 'nurbs') {
    const c = surfaceClosest(s.surface, [p[0], p[1], p[2]]);
    return { u: c.u, v: c.v, dist: c.distance };
  }
  const f = s.frame;
  const d = sub3(p, f.o);
  const lx = dot3(d, f.x);
  const ly = dot3(d, f.y);
  const lz = dot3(d, f.z);
  const rho = hypot2(lx, ly);
  const u = rho === 0 ? 0 : wrapPeriod(atan2(ly, lx));
  switch (s.kind) {
    case 'plane':
      return { u: lx, v: ly, dist: Math.abs(lz) };
    case 'cylinder':
      return { u, v: lz, dist: Math.abs(rho - s.radius) };
    case 'sphere':
      return { u, v: atan2(lz, rho), dist: Math.abs(hypot3(lx, ly, lz) - s.radius) };
    case 'cone': {
      const sa = sin(s.halfAngle);
      const ca = cos(s.halfAngle);
      const lower = lz * sa + s.radius * ca < 0;
      const rs = lower ? -rho : rho;
      return {
        u: lower && rho !== 0 ? wrapPeriod(atan2(-ly, -lx)) : u,
        v: (rs - s.radius) * sa + lz * ca,
        dist: Math.abs((rs - s.radius) * ca - lz * sa),
      };
    }
    case 'torus':
      return {
        u,
        v: atan2(lz, rho - s.major),
        dist: Math.abs(hypot2(rho - s.major, lz) - s.minor),
      };
  }
}
