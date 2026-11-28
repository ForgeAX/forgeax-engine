import { cos, sin } from '../../dmath';
import {
  curveDerivatives,
  domain as curveDomain,
  type NurbsCurve,
  type NurbsSurface,
  surfaceDomain as nurbsDomain,
  splitCurve,
  surfaceDerivatives,
} from '../../nurbs';
import { surfaceSplit } from '../../nurbs-surface';
import { curvePoint } from '../curves';
import { surfaceInverse, surfaceNormal, surfacePoint } from '../surfaces';
import type { Curve, Shape, Surface } from '../types';
import { dist3, dot3, HALF_PI, len3, type P2, type P3, sub3 } from '../vec';
import { type Obb, obbOfPoints, orthoFrame } from './obb';
import type { TrimIndex } from './trim-index';

/** Where a query result touches a Shape: a face at (u, v) or an edge at parameter t. */
export type Foot =
  | {
      readonly kind: 'face';
      readonly id: number;
      readonly u: number;
      readonly v: number;
      readonly point: P3;
    }
  | { readonly kind: 'edge'; readonly id: number; readonly t: number; readonly point: P3 }
  | { readonly kind: 'vertex'; readonly id: number; readonly point: P3 };

/**
 * What a stationary (locally closest) configuration requires of the connecting direction `w`:
 * on a face `w` is parallel to the normal, on an edge `w` is perpendicular to the tangent. `spread`
 * bounds how far `dir` turns anywhere in the piece; absent means the piece is never excluded.
 */
export interface Stationarity {
  readonly kind: 'normal' | 'tangent';
  readonly dir: P3;
  readonly spread: number;
}

/**
 * One bounded part of a face, an edge or a probe point. `bound` holds every point of the part
 * (a control-hull box, so it tightens quadratically under `split`); `point` is an actual point of
 * the part and is a usable upper bound only when `valid` (inside the face's trim).
 */
export interface Piece {
  readonly bound: Obb;
  readonly depth: number;
  readonly point: P3;
  readonly valid: boolean;
  /** Radius of a ball around `point` that holds the whole piece. */
  readonly radius: number;
  readonly stationarity?: Stationarity;
  split(): readonly Piece[] | undefined;
  foot(): Foot;
  /** The nearest point of this part to `p` by Newton from the centre; absent when it does not improve. */
  polish?(p: P3): { readonly point: P3; readonly foot: Foot } | undefined;
}

type Net = readonly (readonly P3[])[];

function hullBound(net: Net): Obb {
  const rows = net.length;
  const cols = (net[0] as readonly P3[]).length;
  const first = (net[0] as readonly P3[])[0] as P3;
  let a: P3 = [0, 0, 0];
  let b: P3 = [0, 0, 0];
  for (let j = 0; j < cols; j++) {
    const d = sub3((net[rows - 1] as readonly P3[])[j] as P3, (net[0] as readonly P3[])[j] as P3);
    if (len3(d) > len3(a)) a = d;
  }
  for (let i = 0; i < rows; i++) {
    const row = net[i] as readonly P3[];
    const d = sub3(row[cols - 1] as P3, row[0] as P3);
    if (len3(d) > len3(b)) b = d;
  }
  return obbOfPoints(orthoFrame(a, b), first, net.flat());
}

/** Distance from `p` to the farthest corner of the box: a ball around `p` that holds the box. */
function boundRadius(b: Obb, p: P3): number {
  const d = len3(sub3(p, b.c));
  return d + len3([b.r[0], b.r[1], b.r[2]]);
}

/** Control points of the unit-circle quadratic rational arc from `a` to `b` (`b - a` < pi). */
function arc3(a: number, b: number): readonly [P2, P2, P2] {
  const k = 1 / cos((b - a) / 2);
  const m = (a + b) / 2;
  return [
    [cos(a), sin(a)],
    [k * cos(m), k * sin(m)],
    [cos(b), sin(b)],
  ];
}

/** `[lo, hi]` cut into equal chunks of at most `span`. */
function chunks(lo: number, hi: number, span: number): [number, number][] {
  const n = Math.max(1, Math.ceil((hi - lo) / span - 1e-12));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) out.push([lo + ((hi - lo) * i) / n, lo + ((hi - lo) * (i + 1)) / n]);
  return out;
}

export const MAX_DEPTH = 64;

// ---- probe point -----------------------------------------------------------------------

export function pointPiece(point: P3, owner?: Foot): Piece {
  return {
    bound: {
      c: point,
      e: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      r: [0, 0, 0],
    },
    depth: 0,
    point,
    valid: true,
    radius: 0,
    split: () => undefined,
    foot: () => owner ?? { kind: 'vertex', id: -1, point },
  };
}

// ---- analytic and NURBS faces ----------------------------------------------------------

type Analytic = Exclude<Surface, { kind: 'nurbs' }>;
type Rect = readonly [number, number, number, number];

function faceNet(s: Analytic, [u0, u1, v0, v1]: Rect): Net {
  const f = s.frame;
  const at = (a: P2, rho: number, z: number): P3 => [
    f.o[0] + rho * (a[0] * f.x[0] + a[1] * f.y[0]) + z * f.z[0],
    f.o[1] + rho * (a[0] * f.x[1] + a[1] * f.y[1]) + z * f.z[1],
    f.o[2] + rho * (a[0] * f.x[2] + a[1] * f.y[2]) + z * f.z[2],
  ];
  if (s.kind === 'plane')
    return [u0, u1].map((u) =>
      [v0, v1].map(
        (v): P3 => [
          f.o[0] + u * f.x[0] + v * f.y[0],
          f.o[1] + u * f.x[1] + v * f.y[1],
          f.o[2] + u * f.x[2] + v * f.y[2],
        ],
      ),
    );
  const A = arc3(u0, u1);
  if (s.kind === 'cylinder') return A.map((a) => [v0, v1].map((v) => at(a, s.radius, v)));
  if (s.kind === 'cone') {
    const sa = sin(s.halfAngle);
    const ca = cos(s.halfAngle);
    return A.map((a) => [v0, v1].map((v) => at(a, s.radius + v * sa, v * ca)));
  }
  const B = arc3(v0, v1);
  if (s.kind === 'sphere')
    return A.map((a) => B.map((b) => at(a, s.radius * b[0], s.radius * b[1])));
  return A.map((a) => B.map((b) => at(a, s.major + s.minor * b[0], s.minor * b[1])));
}

/** Control-polygon lengths along each parameter direction choose the next split. */
function netSpans(net: Net): [number, number] {
  const rows = net.length;
  const cols = (net[0] as readonly P3[]).length;
  let lu = 0;
  let lv = 0;
  for (let i = 0; i < rows - 1; i++) {
    let span = 0;
    for (let j = 0; j < cols; j++)
      span = Math.max(
        span,
        dist3((net[i] as readonly P3[])[j] as P3, (net[i + 1] as readonly P3[])[j] as P3),
      );
    lu += span;
  }
  for (let j = 0; j < cols - 1; j++) {
    let span = 0;
    for (let i = 0; i < rows; i++)
      span = Math.max(
        span,
        dist3((net[i] as readonly P3[])[j] as P3, (net[i] as readonly P3[])[j + 1] as P3),
      );
    lv += span;
  }
  return [lu, lv];
}

const ARC_PER_CHORD = 1.1107;

/** Largest principal curvature over the rect, or Infinity near a cone apex. */
function maxCurvature(s: Analytic, [, , v0, v1]: Rect): number {
  switch (s.kind) {
    case 'plane':
      return 0;
    case 'cylinder':
    case 'sphere':
      return 1 / s.radius;
    case 'torus':
      return Math.max(1 / s.minor, 1 / (s.major - s.minor));
    case 'cone': {
      const sa = sin(s.halfAngle);
      const rho = Math.min(Math.abs(s.radius + v0 * sa), Math.abs(s.radius + v1 * sa));
      const crossing = (s.radius + v0 * sa) * (s.radius + v1 * sa) <= 0;
      return crossing || rho === 0 ? Infinity : cos(s.halfAngle) / rho;
    }
  }
}

function analyticFace(
  faceId: number,
  surface: Analytic,
  trim: TrimIndex,
  rect: Rect,
  depth: number,
): Piece {
  const net = faceNet(surface, rect);
  const [lu, lv] = netSpans(net);
  const uc = (rect[0] + rect[1]) / 2;
  const vc = (rect[2] + rect[3]) / 2;
  const point = surfacePoint(surface, uc, vc);
  const bound = hullBound(net);
  return {
    bound,
    depth,
    point,
    valid: trim.contains(uc, vc),
    radius: boundRadius(bound, point),
    stationarity: {
      kind: 'normal',
      dir: surfaceNormal(surface, uc, vc),
      spread: maxCurvature(surface, rect) * ARC_PER_CHORD * (lu + lv),
    },
    split() {
      if (depth >= MAX_DEPTH) return undefined;
      const [u0, u1, v0, v1] = rect;
      const kids: Rect[] =
        lu >= lv
          ? [
              [u0, uc, v0, v1],
              [uc, u1, v0, v1],
            ]
          : [
              [u0, u1, v0, vc],
              [u0, u1, vc, v1],
            ];
      return kids
        .filter((r) => trim.mayTouch([r[0], r[2]], [r[1], r[3]]))
        .map((r) => analyticFace(faceId, surface, trim, r, depth + 1));
    },
    foot: () => ({ kind: 'face', id: faceId, u: uc, v: vc, point }),
    polish(p) {
      const q = surfaceInverse(surface, p);
      if (!trim.contains(q.u, q.v)) return undefined;
      const foot = surfacePoint(surface, q.u, q.v);
      return { point: foot, foot: { kind: 'face', id: faceId, u: q.u, v: q.v, point: foot } };
    },
  };
}

function nurbsNet(s: NurbsSurface): Net {
  return s.points.map((row) => row.map((q): P3 => [q[0], q[1], q[2]]));
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number)
  );
}

/** Newton on the squared distance to `p` over one parameter rectangle; returns the best (u, v) seen. */
function newtonSurface(s: NurbsSurface, p: P3, rect: Rect, u: number, v: number): [number, number] {
  const dist2 = (a: number, b: number): number => {
    const q = surfacePoint({ kind: 'nurbs', surface: s }, a, b);
    return dot(sub3(q, p), sub3(q, p));
  };
  let cur = dist2(u, v);
  for (let it = 0; it < 40; it++) {
    const d = surfaceDerivatives(s, u, v, 2);
    const S = (d[0] as readonly number[][])[0] as number[];
    const Su = (d[1] as readonly number[][])[0] as number[];
    const Sv = (d[0] as readonly number[][])[1] as number[];
    const r = [(S[0] as number) - p[0], (S[1] as number) - p[1], (S[2] as number) - p[2]];
    const f = dot(Su, r);
    const g = dot(Sv, r);
    const a = dot(Su, Su) + dot((d[2] as number[][])[0] as number[], r);
    const b = dot(Su, Sv) + dot((d[1] as number[][])[1] as number[], r);
    const c = dot(Sv, Sv) + dot((d[0] as number[][])[2] as number[], r);
    const det = a * c - b * b;
    let du =
      Math.abs(det) > 0 && det > 0 && a > 0 ? -(c * f - b * g) / det : -f / (dot(Su, Su) || 1);
    let dv =
      Math.abs(det) > 0 && det > 0 && a > 0 ? -(a * g - b * f) / det : -g / (dot(Sv, Sv) || 1);
    let moved = false;
    for (let k = 0; k < 24; k++) {
      const nu = Math.min(rect[1], Math.max(rect[0], u + du));
      const nv = Math.min(rect[3], Math.max(rect[2], v + dv));
      const nd = dist2(nu, nv);
      if (nd <= cur) {
        moved = nu !== u || nv !== v;
        u = nu;
        v = nv;
        cur = nd;
        break;
      }
      du /= 2;
      dv /= 2;
    }
    if (!moved) break;
  }
  return [u, v];
}

function nurbsFace(
  faceId: number,
  whole: NurbsSurface,
  part: NurbsSurface,
  trim: TrimIndex,
  rect: Rect,
  depth: number,
): Piece {
  const net = nurbsNet(part);
  const [lu, lv] = netSpans(net);
  const uc = (rect[0] + rect[1]) / 2;
  const vc = (rect[2] + rect[3]) / 2;
  const ns: Surface = { kind: 'nurbs', surface: whole };
  const point = surfacePoint(ns, uc, vc);
  const bound = hullBound(net);
  const normal = surfaceNormal(ns, uc, vc);
  return {
    bound,
    depth,
    point,
    valid: trim.contains(uc, vc),
    radius: boundRadius(bound, point),
    stationarity: { kind: 'normal', dir: normal, spread: Infinity },
    split() {
      if (depth >= MAX_DEPTH) return undefined;
      const [u0, u1, v0, v1] = rect;
      const dir = lu >= lv ? 'u' : 'v';
      const mid = dir === 'u' ? uc : vc;
      const cutAt = surfaceSplit(part, dir, mid);
      if (!cutAt.ok) return undefined;
      const rects: Rect[] =
        dir === 'u'
          ? [
              [u0, mid, v0, v1],
              [mid, u1, v0, v1],
            ]
          : [
              [u0, u1, v0, mid],
              [u0, u1, mid, v1],
            ];
      const out: Piece[] = [];
      for (let k = 0; k < 2; k++) {
        const r = rects[k] as Rect;
        if (trim.mayTouch([r[0], r[2]], [r[1], r[3]]))
          out.push(nurbsFace(faceId, whole, cutAt.value[k] as NurbsSurface, trim, r, depth + 1));
      }
      return out;
    },
    foot: () => ({ kind: 'face', id: faceId, u: uc, v: vc, point }),
    polish(p) {
      const [u, v] = newtonSurface(whole, p, rect, uc, vc);
      if (!trim.contains(u, v)) return undefined;
      const foot = surfacePoint(ns, u, v);
      return { point: foot, foot: { kind: 'face', id: faceId, u, v, point: foot } };
    },
  };
}

function nurbsRoots(faceId: number, s: NurbsSurface, trim: TrimIndex): Piece[] {
  const [[u0, u1], [v0, v1]] = nurbsDomain(s);
  return trim.mayTouch([u0, v0], [u1, v1])
    ? [nurbsFace(faceId, s, s, trim, [u0, u1, v0, v1], 0)]
    : [];
}

/** Analytic faces start as a grid of quarter-turn patches, so every arc net stays a proper quadratic arc. */
export function faceRoots(shape: Shape, f: number, trim: TrimIndex): Piece[] {
  const s = shape.surfaces[(shape.faces[f] as Shape['faces'][number]).surface] as Surface;
  if (s.kind === 'nurbs') return nurbsRoots(f, s.surface, trim);
  const vLo = s.kind === 'sphere' ? Math.max(trim.lo[1], -HALF_PI) : trim.lo[1];
  const vHi = s.kind === 'sphere' ? Math.min(trim.hi[1], HALF_PI) : trim.hi[1];
  const us =
    s.kind === 'plane'
      ? [[trim.lo[0], trim.hi[0]] as [number, number]]
      : chunks(trim.lo[0], trim.hi[0], HALF_PI);
  const vs =
    s.kind === 'sphere' || s.kind === 'torus'
      ? chunks(vLo, vHi, HALF_PI)
      : [[vLo, vHi] as [number, number]];
  const out: Piece[] = [];
  for (const [a, b] of us)
    for (const [c, d] of vs)
      if (trim.mayTouch([a, c], [b, d])) out.push(analyticFace(f, s, trim, [a, b, c, d], 0));
  return out;
}

// ---- edges -----------------------------------------------------------------------------

function curveD(c: Curve, t: number): [P3, P3, P3] {
  switch (c.kind) {
    case 'line':
      return [curvePoint(c, t), c.d, [0, 0, 0]];
    case 'circle': {
      const f = c.frame;
      const ct = cos(t);
      const st = sin(t);
      const mk = (x: number, y: number): P3 => [
        c.radius * (x * f.x[0] + y * f.y[0]),
        c.radius * (x * f.x[1] + y * f.y[1]),
        c.radius * (x * f.x[2] + y * f.y[2]),
      ];
      return [curvePoint(c, t), mk(-st, ct), mk(-ct, -st)];
    }
    case 'ellipse': {
      const f = c.frame;
      const ct = cos(t);
      const st = sin(t);
      const mk = (x: number, y: number): P3 => [
        c.a * x * f.x[0] + c.b * y * f.y[0],
        c.a * x * f.x[1] + c.b * y * f.y[1],
        c.a * x * f.x[2] + c.b * y * f.y[2],
      ];
      return [curvePoint(c, t), mk(-st, ct), mk(-ct, -st)];
    }
    case 'nurbs': {
      const d = curveDerivatives(c.curve, t, 2);
      return d.map((q): P3 => [q[0], q[1], q[2]]) as [P3, P3, P3];
    }
  }
}

/** Newton on the squared distance from `p` to the curve over [lo, hi], damped so it never gets worse. */
function newtonCurve(c: Curve, p: P3, lo: number, hi: number, t: number): number {
  let cur = dot3Sq(sub3(curvePoint(c, t), p));
  for (let it = 0; it < 60; it++) {
    const [C, D1, D2] = curveD(c, t);
    const r = sub3(C, p);
    const f = dot(r, D1);
    const fp = dot(D1, D1) + dot(r, D2);
    let dt = fp > 0 ? -f / fp : -f / (dot(D1, D1) || 1);
    let moved = false;
    for (let k = 0; k < 24; k++) {
      const nt = Math.min(hi, Math.max(lo, t + dt));
      const nd = dot3Sq(sub3(curvePoint(c, nt), p));
      if (nd <= cur) {
        moved = nt !== t;
        t = nt;
        cur = nd;
        break;
      }
      dt /= 2;
    }
    if (!moved) break;
  }
  return t;
}

function dot3Sq(v: P3): number {
  return dot3(v, v);
}

function arcNet(c: Curve, t0: number, t1: number): P3[] {
  if (c.kind === 'line') return [curvePoint(c, t0), curvePoint(c, t1)];
  if (c.kind === 'nurbs') return [];
  const f = c.frame;
  const [ra, rb] = c.kind === 'circle' ? [c.radius, c.radius] : [c.a, c.b];
  return arc3(t0, t1).map(
    (a): P3 => [
      f.o[0] + ra * a[0] * f.x[0] + rb * a[1] * f.y[0],
      f.o[1] + ra * a[0] * f.x[1] + rb * a[1] * f.y[1],
      f.o[2] + ra * a[0] * f.x[2] + rb * a[1] * f.y[2],
    ],
  );
}

function polylineBound(points: readonly P3[]): Obb {
  const a = sub3(points[points.length - 1] as P3, points[0] as P3);
  return obbOfPoints(orthoFrame(a), points[0] as P3, points);
}

function curveCurvature(c: Curve): number {
  switch (c.kind) {
    case 'line':
      return 0;
    case 'circle':
      return 1 / c.radius;
    case 'ellipse':
      return Math.max(c.a, c.b) / (Math.min(c.a, c.b) * Math.min(c.a, c.b));
    case 'nurbs':
      return Infinity;
  }
}

function curveArc(
  edgeId: number,
  curve: Curve,
  part: NurbsCurve | undefined,
  t0: number,
  t1: number,
  depth: number,
): Piece {
  const tm = (t0 + t1) / 2;
  const point = curvePoint(curve, tm);
  const bound = polylineBound(
    part ? part.points.map((q): P3 => [q[0], q[1], q[2]]) : arcNet(curve, t0, t1),
  );
  const chord = dist3(curvePoint(curve, t0), curvePoint(curve, t1));
  const analytic = curve.kind !== 'nurbs';
  const tangent: P3 = analytic ? curveD(curve, tm)[1] : [0, 0, 0];
  const tangentLength = len3(tangent);
  return {
    bound,
    depth,
    point,
    valid: true,
    radius: boundRadius(bound, point),
    ...(analytic && tangentLength > 0
      ? {
          stationarity: {
            kind: 'tangent' as const,
            dir: [
              tangent[0] / tangentLength,
              tangent[1] / tangentLength,
              tangent[2] / tangentLength,
            ] as P3,
            spread:
              curveCurvature(curve) *
              ARC_PER_CHORD *
              Math.max(chord, 2 * (bound.r[0] + bound.r[1] + bound.r[2])),
          },
        }
      : {}),
    split() {
      if (depth >= MAX_DEPTH) return undefined;
      if (!part)
        return [
          curveArc(edgeId, curve, undefined, t0, tm, depth + 1),
          curveArc(edgeId, curve, undefined, tm, t1, depth + 1),
        ];
      const cut = splitCurve(part, tm);
      if (!cut.ok) return undefined;
      return [
        curveArc(edgeId, curve, cut.value[0], t0, tm, depth + 1),
        curveArc(edgeId, curve, cut.value[1], tm, t1, depth + 1),
      ];
    },
    foot: () => ({ kind: 'edge', id: edgeId, t: tm, point }),
    polish(p) {
      const t = newtonCurve(curve, p, t0, t1, tm);
      const foot = curvePoint(curve, t);
      return { point: foot, foot: { kind: 'edge', id: edgeId, t, point: foot } };
    },
  };
}

function nurbsPart(c: NurbsCurve, t0: number, t1: number): NurbsCurve | undefined {
  const [d0, d1] = curveDomain(c);
  let part = c;
  if (t0 > d0) {
    const cut = splitCurve(part, t0);
    if (!cut.ok) return undefined;
    part = cut.value[1];
  }
  if (t1 < d1) {
    const cut = splitCurve(part, t1);
    if (!cut.ok) return undefined;
    part = cut.value[0];
  }
  return part;
}

/** Arcs covering one edge; a degenerate edge is its vertex. */
export function edgeRoots(shape: Shape, e: number): Piece[] {
  const edge = shape.edges[e] as Shape['edges'][number];
  if (edge.curve < 0) {
    const p = (shape.vertices[edge.v0] as Shape['vertices'][number]).p;
    return [pointPiece(p, { kind: 'vertex', id: edge.v0, point: p })];
  }
  const c = shape.curves[edge.curve] as Curve;
  if (c.kind === 'line') return [curveArc(e, c, undefined, edge.t0, edge.t1, 0)];
  if (c.kind === 'nurbs') {
    const part = nurbsPart(c.curve, edge.t0, edge.t1);
    return part ? [curveArc(e, c, part, edge.t0, edge.t1, 0)] : [];
  }
  return chunks(edge.t0, edge.t1, HALF_PI).map(([a, b]) => curveArc(e, c, undefined, a, b, 0));
}

/** Every vertex as a point piece: edge ends and cone apexes are stationary without any tangent condition. */
export function vertexRoots(shape: Shape): Piece[] {
  return shape.vertices.map((v, id) => pointPiece(v.p, { kind: 'vertex', id, point: v.p }));
}
