import { ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import type { NurbsCurve } from '../nurbs';
import { surfaceInverse } from './surfaces';
import { type BrepDetailCode, brepFail, type Curve, type Frame, type Surface } from './types';
import { cross3, dot3, len3, madd3, type P3, scale3, sub3, TWO_PI, unit3 } from './vec';

/** Ball in which unbounded branches are reported: an open branch covers every point of it. */
/** Surfaces with a frame; a NURBS pair is reported unsupported before these routes run. */
export type AnalyticSurface = Exclude<Surface, { kind: 'nurbs' }>;

export interface IntersectionWindow {
  readonly c: P3;
  readonly r: number;
}

/** A curve with its parameter interval before pcurves and receipts are attached. */
export interface RawBranch {
  readonly curve: Curve;
  readonly t0: number;
  readonly t1: number;
  readonly closed: boolean;
}

export interface Touch {
  readonly code: Extract<BrepDetailCode, 'brep-ssi-tangent' | 'brep-ssi-coincident'>;
  readonly gap: number | null;
  readonly contact?: P3;
}

/** What one surface pair holds: branches, tangent or coincident contacts, or neither. */
export interface Section {
  readonly raws: readonly RawBranch[];
  readonly touches?: readonly Touch[];
  readonly unsupported?: true;
  /** Axis offset of a near-coaxial pair: its rings then carry a numeric receipt, not closed-form. */
  readonly offset?: number;
}

export const NOTHING: Section = { raws: [] };
export const UNSUPPORTED: Section = { raws: [], unsupported: true };
export const PAR = 1e-9;
const CONIC_BAND = 1e-9;
const FD_STEP = 1e-4;
const CHAIN_START = 24;
const CHAIN_DEPTH = 14;
const CHAIN_PIECES = 4096;

export function touching(gap: number | null, contact: P3): Section {
  return { raws: [], touches: [{ code: 'brep-ssi-tangent', gap, contact }] };
}

export function loopOf(curve: Curve): RawBranch {
  return { curve, t0: 0, t1: TWO_PI, closed: true };
}

function circleIn(plane: AnalyticSurface, c: P3, radius: number): Curve {
  const f = plane.frame;
  return { kind: 'circle', frame: { o: c, x: f.x, y: f.y, z: f.z }, radius };
}

function frameOf(o: P3, x: P3, y: P3): Frame {
  return { o, x, y, z: cross3(x, y) };
}

const needWindow = <T>(): Result<T, ModelingError> =>
  brepFail('brep-bad-argument', 'a window for an unbounded branch', { reason: 'window' });

export function lineRaw(
  o: P3,
  d: P3,
  win: IntersectionWindow | undefined,
): Result<RawBranch, ModelingError> {
  if (win === undefined) return needWindow();
  const tc = dot3(sub3(win.c, o), d);
  return ok({ curve: { kind: 'line', o, d }, t0: tc - win.r, t1: tc + win.r, closed: false });
}

function pair(
  a: Result<RawBranch, ModelingError>,
  b: Result<RawBranch, ModelingError>,
): Result<Section, ModelingError> {
  if (!a.ok) return a;
  if (!b.ok) return b;
  return ok({ raws: [a.value, b.value] });
}

export function planePlane(
  p: AnalyticSurface,
  q: AnalyticSurface,
  tol: number,
  win: IntersectionWindow | undefined,
): Result<Section, ModelingError> {
  const n1 = p.frame.z;
  const n2 = q.frame.z;
  const d = cross3(n1, n2);
  const c1 = dot3(n1, p.frame.o);
  const c2 = dot3(n2, q.frame.o);
  if (len3(d) <= PAR) {
    const sep = Math.abs(dot3(sub3(q.frame.o, p.frame.o), n1));
    if (sep <= tol) {
      return ok({ raws: [], touches: [{ code: 'brep-ssi-coincident', gap: sep }] });
    }
    return ok(NOTHING);
  }
  const dd = dot3(d, d);
  const o = scale3(madd3(scale3(cross3(n2, d), c1), cross3(d, n1), c2), 1 / dd);
  const r = lineRaw(o, unit3(d), win);
  return r.ok ? ok({ raws: [r.value] }) : r;
}

function planeSphere(p: AnalyticSurface, s: Surface & { kind: 'sphere' }, tol: number): Section {
  const n = p.frame.z;
  const dsg = dot3(sub3(s.frame.o, p.frame.o), n);
  const gap = s.radius - Math.abs(dsg);
  const foot = madd3(s.frame.o, n, -dsg);
  if (gap < -tol) return NOTHING;
  if (gap <= tol) return touching(gap, foot);
  return { raws: [loopOf(circleIn(p, foot, Math.sqrt(gap * (s.radius + Math.abs(dsg)))))] };
}

function planeCylinder(
  p: AnalyticSurface,
  c: Surface & { kind: 'cylinder' },
  tol: number,
  win: IntersectionWindow | undefined,
): Result<Section, ModelingError> {
  const n = p.frame.z;
  const z = c.frame.z;
  const o = c.frame.o;
  const dsg = dot3(sub3(o, p.frame.o), n);
  const cs = dot3(z, n);
  if (len3(cross3(n, z)) <= PAR) {
    return ok({ raws: [loopOf(circleIn(p, madd3(o, z, -dsg / cs), c.radius))] });
  }
  const g = unit3(madd3(z, n, -cs));
  if (Math.abs(cs) <= PAR) {
    const gap = c.radius - Math.abs(dsg);
    const foot = madd3(o, n, -dsg);
    if (gap < -tol) return ok(NOTHING);
    if (gap <= tol) return ok(touching(gap, foot));
    const side = scale3(cross3(n, g), Math.sqrt(gap * (c.radius + Math.abs(dsg))));
    return pair(lineRaw(madd3(foot, side, 1), g, win), lineRaw(madd3(foot, side, -1), g, win));
  }
  const curve: Curve = {
    kind: 'ellipse',
    frame: frameOf(madd3(o, z, -dsg / cs), g, cross3(n, g)),
    a: c.radius / Math.abs(cs),
    b: c.radius,
  };
  return ok({ raws: [loopOf(curve)] });
}

const QUADRATIC_KNOTS = [0, 0, 0, 1, 1, 1];

function conicArc(pts: readonly P3[], weights: readonly number[]): RawBranch {
  const curve: NurbsCurve = {
    degree: 2,
    points: pts.map((x) => [x[0], x[1], x[2]]),
    weights: [...weights],
    knots: QUADRATIC_KNOTS,
  };
  return { curve: { kind: 'nurbs', curve }, t0: 0, t1: 1, closed: false };
}

function planeCone(
  p: AnalyticSurface,
  k: Surface & { kind: 'cone' },
  tol: number,
  win: IntersectionWindow | undefined,
): Result<Section, ModelingError> {
  const z = k.frame.z;
  const sa = sin(k.halfAngle);
  const c = cos(k.halfAngle);
  const apex = madd3(k.frame.o, z, (-k.radius * c) / sa);
  const n = p.frame.z;
  const e = dot3(sub3(p.frame.o, apex), n);
  const b = dot3(n, z);
  const a = Math.sqrt(Math.max(0, 1 - b * b));
  const origin = madd3(apex, n, e);
  if (Math.abs(e) <= tol) {
    const ratio = a > PAR ? c / a : Number.POSITIVE_INFINITY;
    if (ratio >= 1) return ok(touching(ratio === 1 ? 0 : null, origin));
    const sn = Math.sqrt(1 - ratio * ratio);
    if (sn <= tol) return ok(touching(sn, origin));
    const g = unit3(madd3(z, n, -b));
    const m = cross3(n, g);
    return pair(
      lineRaw(origin, madd3(scale3(g, ratio), m, sn), win),
      lineRaw(origin, madd3(scale3(g, ratio), m, -sn), win),
    );
  }
  if (a <= PAR)
    return ok({ raws: [loopOf(circleIn(p, origin, (Math.abs(sa) / c) * Math.abs(e)))] });
  const g = unit3(madd3(z, n, -b));
  const m = cross3(n, g);
  const dd = b * b - sa * sa;
  const at = (s: number, t: number): P3 => madd3(madd3(origin, g, s), m, t);
  const centre = (a * b * e) / dd;
  if (dd > CONIC_BAND) {
    const curve: Curve = {
      kind: 'ellipse',
      frame: frameOf(at(centre, 0), g, m),
      a: (Math.abs(e * sa) * c) / dd,
      b: Math.abs(e * sa) / Math.sqrt(dd),
    };
    return ok({ raws: [loopOf(curve)] });
  }
  if (win === undefined) return needWindow();
  const T0 = dot3(sub3(win.c, origin), m) - win.r;
  const T1 = T0 + 2 * win.r;
  if (dd >= -CONIC_BAND) {
    const al = (c * c) / (2 * a * b * e);
    const be = (e * (c * c - b * b)) / (2 * a * b);
    const x = (t: number): P3 => at(al * t * t + be, t);
    const mid = at(al * T0 * T1 + be, (T0 + T1) / 2);
    return ok({ raws: [conicArc([x(T0), mid, x(T1)], [1, 1, 1])] });
  }
  const dm = -dd;
  const ah = (Math.abs(e * sa) * c) / dm;
  const bh = Math.abs(e * sa) / Math.sqrt(dm);
  const s0 = T0 / bh;
  const s1 = T1 / bh;
  const c0 = Math.sqrt(1 + s0 * s0);
  const c1 = Math.sqrt(1 + s1 * s1);
  const cd = c1 * c0 - s1 * s0;
  const ch = Math.sqrt((cd + 1) / 2);
  const sh = Math.sqrt(Math.max(0, (cd - 1) / 2));
  const sm = s0 * ch + c0 * sh;
  const cm = c0 * ch + s0 * sh;
  const arc = (sg: number): RawBranch => {
    const map = (x: number, y: number): P3 =>
      at(centre + sg * ah * (cm * x + sm * y), bh * (sm * x + cm * y));
    return conicArc([map(ch, -sh), map(1 / ch, 0), map(ch, sh)], [1, ch, 1]);
  };
  return ok({ raws: [arc(1), arc(-1)] });
}

function derivative(f: (t: number) => P3, t: number, h: number): P3 {
  const a = f(t + 2 * h);
  const b = f(t + h);
  const c = f(t - h);
  const d = f(t - 2 * h);
  const k = 1 / (12 * h);
  return [
    (-a[0] + 8 * b[0] - 8 * c[0] + d[0]) * k,
    (-a[1] + 8 * b[1] - 8 * c[1] + d[1]) * k,
    (-a[2] + 8 * b[2] - 8 * c[2] + d[2]) * k,
  ];
}

/**
 * A closed cubic Hermite chain through `f` on [0, 1], split in halves until every interior sample of a
 * piece lies within `eps` of both surfaces. One clamped cubic NURBS with interior knots of multiplicity 3.
 */
export function hermiteLoop(
  f: (tau: number) => P3,
  a: Surface,
  b: Surface,
  eps: number,
): RawBranch {
  const near = (x: P3): boolean =>
    surfaceInverse(a, x).dist <= eps && surfaceInverse(b, x).dist <= eps;
  interface Piece {
    readonly t1: number;
    readonly ctrl: readonly [P3, P3, P3, P3];
  }
  const build = (t0: number, t1: number): Piece => {
    const h = (t1 - t0) / 3;
    const p0 = f(t0);
    const p3 = f(t1);
    return {
      t1,
      ctrl: [
        p0,
        madd3(p0, derivative(f, t0, FD_STEP), h),
        madd3(p3, derivative(f, t1, FD_STEP), -h),
        p3,
      ],
    };
  };
  const strayed = (s: Piece, t0: number): boolean => {
    const [q0, q1, q2, q3] = s.ctrl;
    for (let i = 1; i < 8; i++) {
      const u = i / 8;
      const w = 1 - u;
      const k0 = w * w * w;
      const k1 = 3 * w * w * u;
      const k2 = 3 * w * u * u;
      const k3 = u * u * u;
      const x: P3 = [
        k0 * q0[0] + k1 * q1[0] + k2 * q2[0] + k3 * q3[0],
        k0 * q0[1] + k1 * q1[1] + k2 * q2[1] + k3 * q3[1],
        k0 * q0[2] + k1 * q1[2] + k2 * q2[2] + k3 * q3[2],
      ];
      if (!near(x) || len3(sub3(x, f(t0 + u * (s.t1 - t0)))) > eps) return true;
    }
    return false;
  };
  const out: Piece[] = [];
  const refine = (t0: number, t1: number, depth: number): void => {
    const piece = build(t0, t1);
    if (depth < CHAIN_DEPTH && out.length < CHAIN_PIECES && strayed(piece, t0)) {
      const mid = (t0 + t1) / 2;
      refine(t0, mid, depth + 1);
      refine(mid, t1, depth + 1);
    } else out.push(piece);
  };
  for (let i = 0; i < CHAIN_START; i++) refine(i / CHAIN_START, (i + 1) / CHAIN_START, 0);
  const points: P3[] = [(out[0] as Piece).ctrl[0]];
  const knots = [0, 0, 0, 0];
  for (const piece of out) {
    points.push(piece.ctrl[1], piece.ctrl[2], piece.ctrl[3]);
    knots.push(piece.t1, piece.t1, piece.t1);
  }
  knots.length -= 3;
  knots.push(1, 1, 1, 1);
  points[points.length - 1] = points[0] as P3;
  const curve: NurbsCurve = {
    degree: 3,
    points: points.map((x) => [x[0], x[1], x[2]]),
    knots,
  };
  return { curve: { kind: 'nurbs', curve }, t0: 0, t1: 1, closed: true };
}

function sinc(x: number): number {
  return Math.abs(x) < 1e-4 ? 1 - (x * x) / 6 : sin(x) / x;
}

function planeTorus(p: AnalyticSurface, t: Surface & { kind: 'torus' }, tol: number): Section {
  const { major: R, minor: r } = t;
  if (!(R - r > tol)) return UNSUPPORTED;
  const n = p.frame.z;
  const z = t.frame.z;
  const o = t.frame.o;
  if (len3(cross3(n, z)) <= PAR) {
    const h = dot3(sub3(p.frame.o, o), z);
    const gap = r - Math.abs(h);
    const c = madd3(o, z, h);
    if (gap < -tol) return NOTHING;
    if (gap <= tol) return touching(gap, madd3(c, t.frame.x, R));
    const rho = Math.sqrt(gap * (r + Math.abs(h)));
    return { raws: [loopOf(circleIn(p, c, R + rho)), loopOf(circleIn(p, c, R - rho))] };
  }
  if (Math.abs(dot3(n, z)) > PAR) return UNSUPPORTED;
  const ds = dot3(sub3(p.frame.o, o), n);
  const d = Math.abs(ds);
  const ey = cross3(z, n);
  const base = madd3(o, n, ds);
  if (d <= tol / 2) {
    const meridian = (sg: number): RawBranch =>
      loopOf({
        kind: 'circle',
        frame: { o: madd3(base, ey, sg * R), x: ey, y: z, z: n },
        radius: r,
      });
    return { raws: [meridian(1), meridian(-1)] };
  }
  if (Math.abs(d - (R - r)) <= tol) return touching(d - (R - r), base);
  if (Math.abs(d - (R + r)) <= tol) return touching(d - (R + r), madd3(base, n, 0));
  if (d > R + r) return NOTHING;
  const eps = tol / 8;
  if (d < R - r) {
    const lobe = (sg: number): RawBranch =>
      hermiteLoop(
        (tau) => {
          const v = -Math.PI + TWO_PI * tau;
          const rho = R + r * cos(v);
          const y = sg * Math.sqrt((rho - d) * (rho + d));
          return madd3(madd3(base, ey, y), z, r * sin(v));
        },
        p,
        t,
        eps,
      );
    return { raws: [lobe(1), lobe(-1)] };
  }
  const cvm = (d - R) / r;
  const vm = atan2(Math.sqrt(Math.max(0, (1 - cvm) * (1 + cvm))), cvm);
  const loop = hermiteLoop(
    (tau) => {
      const phi = -Math.PI / 2 + TWO_PI * tau;
      const v = vm * sin(phi);
      const rho = R + r * cos(v);
      const y =
        vm * cos(phi) * Math.sqrt((r * (rho + d) * sinc((vm - v) / 2) * sinc((vm + v) / 2)) / 2);
      return madd3(madd3(base, ey, y), z, r * sin(v));
    },
    p,
    t,
    eps,
  );
  return { raws: [loop] };
}

/** The plane `p` against any quadric or torus `q`; a pair this route does not trace is `unsupported`. */
export function planeSection(
  p: AnalyticSurface,
  q: AnalyticSurface,
  tol: number,
  win: IntersectionWindow | undefined,
): Result<Section, ModelingError> {
  switch (q.kind) {
    case 'plane':
      return planePlane(p, q, tol, win);
    case 'sphere':
      return ok(planeSphere(p, q, tol));
    case 'cylinder':
      return planeCylinder(p, q, tol, win);
    case 'cone':
      return planeCone(p, q, tol, win);
    case 'torus':
      return ok(planeTorus(p, q, tol));
  }
}
