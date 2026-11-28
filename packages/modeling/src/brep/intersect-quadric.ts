import { ok, type Result } from '@forgeax/engine-types';
import { atan2, cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import {
  hermiteLoop,
  type IntersectionWindow,
  lineRaw,
  loopOf,
  NOTHING,
  PAR,
  type RawBranch,
  type Section,
  type Touch,
  touching,
  UNSUPPORTED,
} from './intersect-plane';
import { makeFrame } from './surfaces';
import type { Surface } from './types';
import { add3, cross3, dot3, len3, madd3, type P3, scale3, sub3, TWO_PI, unit3 } from './vec';

const COAXIAL_SHARE = 0.5;
const ARC_SAMPLES = 64;

type Quadric = Exclude<Surface, { kind: 'plane' | 'nurbs' }>;
type Axis = { readonly o: P3; readonly z: P3 };

const RANK = { sphere: 0, cylinder: 1, cone: 2, torus: 3 } as const;

const sgn = (x: number): number => (x < 0 ? -1 : 1);

function acosC(c: number): number {
  const k = Math.max(-1, Math.min(1, c));
  return atan2(Math.sqrt(Math.max(0, (1 - k) * (1 + k))), k);
}

/** The axis every revolved surface shares, or undefined when the pair is not coaxial within tolerance. */
function sharedAxis(p: Quadric, q: Quadric, tol: number): Axis | undefined {
  const spun = [p, q].filter((s) => s.kind !== 'sphere');
  let axis: Axis;
  if (spun.length === 0) {
    const sep = sub3(q.frame.o, p.frame.o);
    axis = { o: p.frame.o, z: len3(sep) > PAR ? unit3(sep) : p.frame.z };
  } else {
    const ref = spun[0] as Quadric;
    axis = { o: ref.frame.o, z: ref.frame.z };
  }
  const reach = tol * COAXIAL_SHARE;
  for (const s of [p, q]) {
    const off = len3(cross3(sub3(s.frame.o, axis.o), axis.z));
    if (off > reach) return undefined;
    if (s.kind !== 'sphere' && len3(cross3(s.frame.z, axis.z)) > PAR) return undefined;
  }
  return axis;
}

interface Line {
  readonly kind: 'line';
  readonly a: number;
  readonly b: number;
  readonly c: number;
}
interface Circ {
  readonly kind: 'circle';
  readonly w: number;
  readonly r0: number;
  readonly rad: number;
}
type Prim = Line | Circ;

interface Hit {
  readonly w: number;
  readonly rho: number;
}

interface Meet {
  readonly hits: Hit[];
  readonly tans: Array<Hit & { readonly gap: number }>;
  readonly coincident: number[];
}

/** The half-plane profile `(w, rho)`, `rho >= 0`, of a surface of revolution about `axis`. */
function profile(s: Quadric, axis: Axis): Prim[] {
  const w0 = dot3(sub3(s.frame.o, axis.o), axis.z);
  switch (s.kind) {
    case 'sphere':
      return [{ kind: 'circle', w: w0, r0: 0, rad: s.radius }];
    case 'torus':
      return [{ kind: 'circle', w: w0, r0: s.major, rad: s.minor }];
    case 'cylinder':
      return [{ kind: 'line', a: 0, b: 1, c: s.radius }];
    case 'cone': {
      const k = (sin(s.halfAngle) / cos(s.halfAngle)) * sgn(dot3(s.frame.z, axis.z));
      const n = Math.sqrt(1 + k * k);
      return [
        { kind: 'line', a: -k / n, b: 1 / n, c: (s.radius - k * w0) / n },
        { kind: 'line', a: k / n, b: 1 / n, c: (k * w0 - s.radius) / n },
      ];
    }
  }
}

function lineLine(l: Line, m: Line, tol: number, out: Meet): void {
  const cross = l.a * m.b - m.a * l.b;
  if (Math.abs(cross) <= PAR) {
    const s = sgn(l.a * m.a + l.b * m.b);
    const off = Math.abs(l.c - s * m.c);
    if (off <= tol) out.coincident.push(off);
    return;
  }
  out.hits.push({ w: (l.c * m.b - m.c * l.b) / cross, rho: (l.a * m.c - m.a * l.c) / cross });
}

function lineCircle(l: Line, c: Circ, tol: number, out: Meet): void {
  const dist = l.a * c.w + l.b * c.r0 - l.c;
  const gap = Math.abs(dist) - c.rad;
  if (gap > tol) return;
  const foot = { w: c.w - dist * l.a, rho: c.r0 - dist * l.b };
  if (gap >= -tol) {
    out.tans.push({ ...foot, gap });
    return;
  }
  const h = Math.sqrt((c.rad - Math.abs(dist)) * (c.rad + Math.abs(dist)));
  out.hits.push({ w: foot.w - l.b * h, rho: foot.rho + l.a * h });
  out.hits.push({ w: foot.w + l.b * h, rho: foot.rho - l.a * h });
}

function circleCircle(c: Circ, e: Circ, tol: number, out: Meet): void {
  const dw = e.w - c.w;
  const dr = e.r0 - c.r0;
  const d = Math.sqrt(dw * dw + dr * dr);
  if (d <= PAR) {
    const off = Math.abs(c.rad - e.rad);
    if (off <= tol) out.coincident.push(off);
    return;
  }
  const ext = d - (c.rad + e.rad);
  const inner = d - Math.abs(c.rad - e.rad);
  const x = (d * d + c.rad * c.rad - e.rad * e.rad) / (2 * d);
  const ux = dw / d;
  const uy = dr / d;
  const base = { w: c.w + ux * x, rho: c.r0 + uy * x };
  const near = Math.abs(ext) <= Math.abs(inner) ? ext : inner;
  if (Math.abs(near) <= tol) {
    out.tans.push({ ...base, gap: near });
    return;
  }
  if (ext > 0 || inner < 0) return;
  const h = Math.sqrt(Math.max(0, (c.rad - x) * (c.rad + x)));
  out.hits.push({ w: base.w - uy * h, rho: base.rho + ux * h });
  out.hits.push({ w: base.w + uy * h, rho: base.rho - ux * h });
}

function meet(p: Prim, q: Prim, tol: number, out: Meet): void {
  if (p.kind === 'line' && q.kind === 'line') lineLine(p, q, tol, out);
  else if (p.kind === 'line') lineCircle(p, q as Circ, tol, out);
  else if (q.kind === 'line') lineCircle(q, p as Circ, tol, out);
  else circleCircle(p, q as Circ, tol, out);
}

/** Coaxial pairs: the profile curves meet in points; each point with `rho > 0` is a circle about the axis. */
function axisOffset(p: Quadric, q: Quadric, axis: Axis): number {
  const gap = (s: Quadric): number => len3(cross3(sub3(s.frame.o, axis.o), axis.z));
  return Math.max(gap(p), gap(q));
}

function withOffset(section: Section, offset: number): Section {
  return offset > PAR ? { ...section, offset } : section;
}

function coaxial(p: Quadric, q: Quadric, axis: Axis, tol: number): Section {
  const out: Meet = { hits: [], tans: [], coincident: [] };
  for (const a of profile(p, axis)) for (const b of profile(q, axis)) meet(a, b, tol, out);
  const hint = ([p, q].find((s) => s.kind !== 'sphere') ?? p).frame.x;
  const at = (w: number): P3 => madd3(axis.o, axis.z, w);
  const rim = (w: number, rho: number): P3 => {
    const f = makeFrame(at(w), axis.z, hint);
    return madd3(f.o, f.x, rho);
  };
  const rings = out.hits
    .filter((h) => h.rho > tol)
    .sort((a, b) => a.w - b.w || a.rho - b.rho)
    .map((h) => loopOf({ kind: 'circle', frame: makeFrame(at(h.w), axis.z, hint), radius: h.rho }));
  const touches: Touch[] = [];
  if (out.coincident.length > 0) {
    const gap = out.coincident.reduce((m, g) => Math.min(m, g), Infinity);
    touches.push({ code: 'brep-ssi-coincident', gap });
  }
  const seen: number[] = [];
  const touch = (w: number, gap: number, contact: P3): void => {
    if (seen.some((x) => Math.abs(x - w) <= tol)) return;
    seen.push(w);
    touches.push({ code: 'brep-ssi-tangent', gap, contact });
  };
  for (const h of out.hits.filter((x) => Math.abs(x.rho) <= tol)) touch(h.w, 0, at(h.w));
  for (const t of out.tans.filter((x) => x.rho >= -tol)) {
    touch(t.w, t.gap, rim(t.w, Math.max(0, t.rho)));
  }
  return { raws: rings, ...(touches.length > 0 ? { touches } : {}) };
}

function parallelCylinders(
  p: Surface & { kind: 'cylinder' },
  q: Surface & { kind: 'cylinder' },
  tol: number,
  win: IntersectionWindow | undefined,
): Result<Section, ModelingError> {
  const z = p.frame.z;
  const off = sub3(q.frame.o, p.frame.o);
  const dv = madd3(off, z, -dot3(off, z));
  const d = len3(dv);
  const ex = scale3(dv, 1 / d);
  const ey = cross3(z, ex);
  const ext = d - (p.radius + q.radius);
  const inner = d - Math.abs(p.radius - q.radius);
  const near = Math.abs(ext) <= Math.abs(inner) ? ext : inner;
  if (Math.abs(near) <= tol) {
    const way = Math.abs(ext) <= Math.abs(inner) || p.radius >= q.radius ? 1 : -1;
    return ok(touching(near, madd3(p.frame.o, ex, way * p.radius)));
  }
  if (ext > 0 || inner < 0) return ok(NOTHING);
  const x = (d * d + p.radius * p.radius - q.radius * q.radius) / (2 * d);
  const y = Math.sqrt((p.radius - x) * (p.radius + x));
  const a = lineRaw(add3(madd3(p.frame.o, ex, x), scale3(ey, y)), z, win);
  if (!a.ok) return a;
  const b = lineRaw(madd3(madd3(p.frame.o, ex, x), ey, -y), z, win);
  if (!b.ok) return b;
  return ok({ raws: [a.value, b.value] });
}

interface Graph {
  /** Base cylinder frame: radius `r`, in-plane axes `x`, `y`, axis `z`, origin `o`. */
  readonly o: P3;
  readonly x: P3;
  readonly y: P3;
  readonly z: P3;
  readonly r: number;
  /** Centre height of the two sheets `z0 +- sqrt(g(theta))`. */
  readonly z0: number;
  readonly g: (theta: number) => number;
  /** `g > 0` exactly where `lo < cos(theta) < hi`. */
  readonly lo: number;
  readonly hi: number;
  /** `g` touches zero exactly when `d` meets `ra + rb` or `|ra - rb|`: the sphere or cylinder radius against the axis offset. */
  readonly d: number;
  readonly ra: number;
  readonly rb: number;
}

function onBase(m: Graph, theta: number, z: number): P3 {
  const c = madd3(m.o, m.x, m.r * cos(theta));
  return madd3(madd3(c, m.y, m.r * sin(theta)), m.z, z);
}

/**
 * Two surfaces over a base cylinder: `z = z0 +- sqrt(g(theta))`. The topology comes from the roots of `g`
 * in `cos(theta)`, which are analytic. A touching configuration (`d` within tolerance of `ra + rb` or
 * `|ra - rb|`, so that `g` touches zero) and an arc too short or too thin to resolve are unsupported,
 * never a guessed topology.
 */
function graphSection(m: Graph, a: Surface, b: Surface, tol: number): Section {
  const ext = m.d - (m.ra + m.rb);
  const inner = m.d - Math.abs(m.ra - m.rb);
  if (Math.min(Math.abs(ext), Math.abs(inner)) <= tol) return UNSUPPORTED;
  const { lo, hi } = m;
  if (hi <= -1 || lo >= 1) return NOTHING;
  const eps = tol / 8;
  const sheet = (s: number): RawBranch =>
    hermiteLoop(
      (tau) => {
        const th = TWO_PI * tau;
        return onBase(m, th, m.z0 + s * Math.sqrt(Math.max(0, m.g(th))));
      },
      a,
      b,
      eps,
    );
  if (lo < -1 && hi > 1) return { raws: [sheet(1), sheet(-1)] };
  const arcs: Array<readonly [number, number]> =
    lo >= -1 && hi > 1
      ? [[-acosC(lo), acosC(lo)]]
      : lo < -1
        ? [[acosC(hi), TWO_PI - acosC(hi)]]
        : [
            [acosC(hi), acosC(lo)],
            [-acosC(lo), -acosC(hi)],
          ];
  for (const [t0, t1] of arcs) {
    if (m.r * (t1 - t0) <= tol) return UNSUPPORTED;
    let top = 0;
    for (let i = 0; i <= ARC_SAMPLES; i++) {
      top = Math.max(top, m.g(t0 + ((t1 - t0) * i) / ARC_SAMPLES));
    }
    if (Math.sqrt(top) <= tol) return UNSUPPORTED;
  }
  const loop = ([t0, t1]: readonly [number, number]): RawBranch => {
    const mid = (t0 + t1) / 2;
    const half = (t1 - t0) / 2;
    return hermiteLoop(
      (tau) => {
        const phi = -Math.PI / 2 + TWO_PI * tau;
        const th = mid + half * sin(phi);
        return onBase(m, th, m.z0 + sgn(cos(phi)) * Math.sqrt(Math.max(0, m.g(th))));
      },
      a,
      b,
      eps,
    );
  };
  return { raws: arcs.map(loop) };
}

function sphereCylinder(
  s: Surface & { kind: 'sphere' },
  c: Surface & { kind: 'cylinder' },
  tol: number,
): Section {
  const rel = sub3(s.frame.o, c.frame.o);
  const h = dot3(rel, c.frame.z);
  const perp = madd3(rel, c.frame.z, -h);
  const e = len3(perp);
  const x = scale3(perp, 1 / e);
  const R = s.radius;
  const r = c.radius;
  const graph: Graph = {
    o: c.frame.o,
    x,
    y: cross3(c.frame.z, x),
    z: c.frame.z,
    r,
    z0: h,
    g: (th) => R * R - r * r - e * e + 2 * e * r * cos(th),
    lo: (r * r + e * e - R * R) / (2 * e * r),
    hi: Number.POSITIVE_INFINITY,
    d: R,
    ra: e,
    rb: r,
  };
  return graphSection(graph, s, c, tol);
}

function perpendicularCylinders(
  p: Surface & { kind: 'cylinder' },
  q: Surface & { kind: 'cylinder' },
  tol: number,
): Section {
  const rel = sub3(q.frame.o, p.frame.o);
  const y = q.frame.z;
  let x = cross3(y, p.frame.z);
  let px = dot3(rel, x);
  if (px < 0) {
    x = scale3(x, -1);
    px = -px;
  }
  const r1 = p.radius;
  const r2 = q.radius;
  if (px <= tol && Math.abs(r1 - r2) <= tol) {
    return touching(r1 - r2, madd3(p.frame.o, x, r1));
  }
  const graph: Graph = {
    o: p.frame.o,
    x,
    y,
    z: p.frame.z,
    r: r1,
    z0: dot3(rel, p.frame.z),
    g: (th) => {
      const u = r1 * cos(th) - px;
      return (r2 - u) * (r2 + u);
    },
    lo: (px - r2) / r1,
    hi: (px + r2) / r1,
    d: px,
    ra: r1,
    rb: r2,
  };
  return graphSection(graph, p, q, tol);
}

/**
 * Two quadrics or tori with no plane. Supported: coaxial pairs (circles), cylinders with parallel axes
 * (lines), a sphere against an off-axis cylinder and cylinders with perpendicular axes (closed loops).
 * Every other position is unsupported.
 */
export function quadricSection(
  a: Quadric,
  b: Quadric,
  tol: number,
  win: IntersectionWindow | undefined,
): Result<Section, ModelingError> {
  const [p, q] = RANK[b.kind] < RANK[a.kind] ? [b, a] : [a, b];
  if (
    (p.kind === 'torus' && p.major - p.minor <= tol) ||
    (q.kind === 'torus' && q.major - q.minor <= tol)
  ) {
    return ok(UNSUPPORTED);
  }
  const axis = sharedAxis(p, q, tol);
  if (axis !== undefined) return ok(withOffset(coaxial(p, q, axis, tol), axisOffset(p, q, axis)));
  if (p.kind === 'cylinder' && q.kind === 'cylinder') {
    const turn = len3(cross3(p.frame.z, q.frame.z));
    if (turn <= PAR) return parallelCylinders(p, q, tol, win);
    if (Math.abs(dot3(p.frame.z, q.frame.z)) <= PAR) return ok(perpendicularCylinders(p, q, tol));
    return ok(UNSUPPORTED);
  }
  if (p.kind === 'sphere' && q.kind === 'cylinder') return ok(sphereCylinder(p, q, tol));
  return ok(UNSUPPORTED);
}
