import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import { atan2, cos, sin } from '../dmath';
import type { ModelingError } from '../errors';
import { splitCurve } from '../nurbs';
import { edgeUses, shellOfFaces } from './adjacency';
import { curvePoint, pcurveFor, pcurvePoint } from './curves';
import { coedgeEnds, coedgeGreen, gridOf, UV_TOL } from './faces';
import {
  alignOrdered,
  badEdit,
  chainLoops,
  checkEditable,
  composeProvenance,
  type Draft,
  type DraftFace,
  draftOf,
  draftUses,
  type EditResult,
  endVertex,
  finishDraft,
  type Provenance,
  partial,
  setFaceLoops,
} from './rebuild';
import { surfacePoint } from './surfaces';
import type { Coedge, Curve, Edge, PCurve, Shape, Surface } from './types';
import { add3, cross3, dist3, dot3, madd3, type P3, scale3, sub3, unit3 } from './vec';

export type { EditResult, Provenance } from './rebuild';

function identity(shape: Shape): Provenance {
  return {
    faces: shape.faces.map((_, i) => [i]),
    edges: shape.edges.map((_, i) => [i]),
    vertices: shape.vertices.map((_, i) => [i]),
  };
}

const PARAM_TOL = 1e-9;

function faceIndex(shape: Shape, f: number, op: string): ModelingError | undefined {
  return Number.isInteger(f) && f >= 0 && f < shape.faces.length
    ? undefined
    : badEdit(op, 'face-out-of-range', { face: f });
}

function edgeIndex(shape: Shape, e: number, op: string): ModelingError | undefined {
  return Number.isInteger(e) && e >= 0 && e < shape.edges.length
    ? undefined
    : badEdit(op, 'edge-out-of-range', { edge: e });
}

/** Remove faces from their shells; the result is an open shell wherever a deleted face had a neighbor. */
export function deleteFaces(
  shape: Shape,
  faces: readonly number[],
): Result<EditResult, ModelingError> {
  const op = 'deleteFaces';
  if (faces.length === 0) return err(badEdit(op, 'no-faces'));
  for (const f of faces) {
    const bad = faceIndex(shape, f, op);
    if (bad !== undefined) return err(bad);
  }
  const open = checkEditable(shape, op);
  if (!open.ok) return open;
  const gone = new Set(faces);
  const d = draftOf(shape);
  d.shells = d.shells.map((s) => s.filter((f) => !gone.has(f)));
  return finishDraft(d, op, true);
}

// ---- co-surface faces -------------------------------------------------------------------------

interface Affine {
  readonly m: readonly [number, number, number, number];
  readonly t: readonly [number, number];
  readonly flip: boolean;
}

function applyAffine(p: PCurve, a: Affine): PCurve {
  const [m00, m01, m10, m11] = a.m;
  const map = (x: number, y: number): [number, number] => [
    m00 * x + m01 * y + a.t[0],
    m10 * x + m11 * y + a.t[1],
  ];
  const lin = (x: number, y: number): [number, number] => [m00 * x + m01 * y, m10 * x + m11 * y];
  switch (p.kind) {
    case 'line':
      return { kind: 'line', o: map(p.o[0], p.o[1]), d: lin(p.d[0], p.d[1]) };
    case 'circle': {
      const gamma = atan2(m10, m00);
      return {
        kind: 'circle',
        c: map(p.c[0], p.c[1]),
        r: p.r,
        phase: a.flip ? gamma - p.phase : p.phase + gamma,
        dir: a.flip ? (p.dir === 1 ? -1 : 1) : p.dir,
      };
    }
    case 'nurbs':
      return {
        kind: 'nurbs',
        curve: {
          ...p.curve,
          points: p.curve.points.map((q) => {
            const [x, y] = map(q[0], q[1]);
            return [x, y, q[2]] as const;
          }),
        },
      };
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** How to express the coedges of face `b` in the (u, v) of face `a`, or why that is not possible. */
function coSurface(
  d: Draft,
  a: number,
  b: number,
  op: string,
): Result<Affine | null, ModelingError> {
  const fa = d.faces[a] as DraftFace;
  const fb = d.faces[b] as DraftFace;
  const sa = d.surfaces[fa.surface] as Surface;
  const sb = d.surfaces[fb.surface] as Surface;
  if (fa.surface === fb.surface || sameValue(sa, sb)) {
    return fa.reversed === fb.reversed
      ? ok(null)
      : err(partial(op, 'opposite-orientation', { faces: [a, b] }));
  }
  if (sa.kind !== 'plane' || sb.kind !== 'plane') {
    return err(partial(op, 'surfaces-differ', { faces: [a, b], kinds: [sa.kind, sb.kind] }));
  }
  const fA = sa.frame;
  const fB = sb.frame;
  const na = scale3(fA.z, fa.reversed ? -1 : 1);
  const nb = scale3(fB.z, fb.reversed ? -1 : 1);
  if (dot3(na, nb) < 1 - 1e-9) return err(partial(op, 'not-coplanar', { faces: [a, b] }));
  if (Math.abs(dot3(sub3(fB.o, fA.o), fA.z)) > d.tol) {
    return err(partial(op, 'not-coplanar', { faces: [a, b] }));
  }
  const od = sub3(fB.o, fA.o);
  return ok({
    m: [dot3(fA.x, fB.x), dot3(fA.x, fB.y), dot3(fA.y, fB.x), dot3(fA.y, fB.y)],
    t: [dot3(od, fA.x), dot3(od, fA.y)],
    flip: dot3(fA.z, fB.z) < 0,
  });
}

/** Join two adjacent faces that lie on one surface (or on one plane) into a single face. */
export function mergeFaces(
  shape: Shape,
  faceA: number,
  faceB: number,
): Result<EditResult, ModelingError> {
  const op = 'mergeFaces';
  for (const f of [faceA, faceB]) {
    const bad = faceIndex(shape, f, op);
    if (bad !== undefined) return err(bad);
  }
  if (faceA === faceB) return err(badEdit(op, 'same-face', { face: faceA }));
  const open = checkEditable(shape, op);
  if (!open.ok) return open;
  return mergeFacesIn(shape, faceA, faceB, open.value);
}

/** Merge body for a shape the caller has already checked with `checkEditable`; `allowOpen` is that check's result. */
function mergeFacesIn(
  shape: Shape,
  faceA: number,
  faceB: number,
  allowOpen: boolean,
): Result<EditResult, ModelingError> {
  const op = 'mergeFaces';
  const shells = shellOfFaces(shape);
  if (shells[faceA] !== shells[faceB]) {
    return err(badEdit(op, 'faces-in-different-shells', { faces: [faceA, faceB] }));
  }
  const d = draftOf(shape);
  const uses = draftUses(d);
  const shared = new Set<number>();
  for (const [edge, list] of uses) {
    if (
      list.length === 2 &&
      list.some((u) => u.face === faceA) &&
      list.some((u) => u.face === faceB)
    ) {
      shared.add(edge);
    }
  }
  if (shared.size === 0) return err(badEdit(op, 'faces-not-adjacent', { faces: [faceA, faceB] }));
  const how = coSurface(d, faceA, faceB, op);
  if (!how.ok) return how;
  // A seam is shared by the two faces too, but its two pcurves sit a whole period apart; only the cut coincides in (u, v).
  for (const edge of [...shared]) {
    const e = d.edges[edge] as Edge;
    const pair = (uses.get(edge) ?? []).filter((u) => u.face === faceA || u.face === faceB);
    const a = pair.find((u) => u.face === faceA);
    const b = pair.find((u) => u.face === faceB);
    if (a === undefined || b === undefined || e.curve < 0) continue;
    const pa = (d.coedges[a.coedge] as Coedge).pcurve;
    const moved =
      how.value === null
        ? (d.coedges[b.coedge] as Coedge).pcurve
        : applyAffine((d.coedges[b.coedge] as Coedge).pcurve, how.value);
    const t = 0.5 * (e.t0 + e.t1);
    const x = pcurvePoint(pa, t);
    const y = pcurvePoint(moved, t);
    if (Math.abs(x[0] - y[0]) > 1e-7 || Math.abs(x[1] - y[1]) > 1e-7) shared.delete(edge);
  }
  if (shared.size === 0) return err(partial(op, 'only-seams-shared', { faces: [faceA, faceB] }));
  const keep: number[] = [];
  const take = (face: number, move: boolean) => {
    const flat: number[] = [];
    for (const l of (d.faces[face] as DraftFace).loops) {
      pushAll(flat, (d.loops[l] as { coedges: number[] }).coedges);
    }
    for (const c of flat) {
      const co = d.coedges[c] as Coedge;
      if (shared.has(co.edge)) continue;
      if (!move || how.value === null) {
        keep.push(c);
        continue;
      }
      d.coedges.push({
        edge: co.edge,
        reversed: how.value.flip ? !co.reversed : co.reversed,
        pcurve: applyAffine(co.pcurve, how.value),
      });
      keep.push(d.coedges.length - 1);
    }
  };
  take(faceA, false);
  take(faceB, true);
  if (keep.length === 0) return err(badEdit(op, 'nothing-left', { faces: [faceA, faceB] }));
  const surface = d.surfaces[(d.faces[faceA] as DraftFace).surface] as Surface;
  const chains = chainLoops(d, surface, keep, op);
  if (!chains.ok) return chains;
  const set = setFaceLoops(d, faceA, chains.value, op);
  if (!set.ok) return set;
  d.shells = d.shells.map((s) => s.filter((f) => f !== faceB));
  d.faceFrom[faceA] = [
    ...new Set([...(d.faceFrom[faceA] as number[]), ...(d.faceFrom[faceB] as number[])]),
  ].sort((x, y) => x - y);
  return finishDraft(d, op, allowOpen);
}

// ---- edges -----------------------------------------------------------------------------------

/** Where `b`'s parameter lands on `a`'s curve (`t = s + delta`), or `null` when the two do not lie on one curve. */
function joinDelta(d: Draft, a: Edge, b: Edge): number | null {
  if (a.curve === b.curve) return 0;
  const ca = d.curves[a.curve] as Curve;
  const cb = d.curves[b.curve] as Curve;
  if (sameValue(ca, cb)) return 0;
  if (ca.kind === 'line' && cb.kind === 'line' && dot3(ca.d, cb.d) > 1 - 1e-12) {
    const delta = dot3(sub3(cb.o, ca.o), ca.d);
    const off = sub3(sub3(cb.o, ca.o), scale3(ca.d, delta));
    return dist3(off, [0, 0, 0]) <= d.tol ? delta : null;
  }
  return null;
}

/** Join two edges that continue one curve through a vertex no other edge touches into a single edge. */
export function mergeEdges(
  shape: Shape,
  edgeA: number,
  edgeB: number,
): Result<EditResult, ModelingError> {
  const op = 'mergeEdges';
  for (const e of [edgeA, edgeB]) {
    const bad = edgeIndex(shape, e, op);
    if (bad !== undefined) return err(bad);
  }
  if (edgeA === edgeB) return err(badEdit(op, 'same-edge', { edge: edgeA }));
  const open = checkEditable(shape, op);
  if (!open.ok) return open;
  return mergeEdgesIn(draftOf(shape), edgeA, edgeB, op, open.value);
}

function mergeEdgesIn(
  d: Draft,
  edgeA: number,
  edgeB: number,
  op: string,
  allowOpen: boolean,
): Result<EditResult, ModelingError> {
  let first = edgeA;
  let second = edgeB;
  let delta: number | null = null;
  for (const [x, y] of [
    [edgeA, edgeB],
    [edgeB, edgeA],
  ] as const) {
    const ex = d.edges[x] as Edge;
    const ey = d.edges[y] as Edge;
    if (ex.curve < 0 || ey.curve < 0) return err(badEdit(op, 'degenerate-edge', { edge: x }));
    const j = joinDelta(d, ex, ey);
    if (
      j !== null &&
      ex.v1 === ey.v0 &&
      Math.abs(ex.t1 - (ey.t0 + j)) <= PARAM_TOL * (1 + Math.abs(ex.t1))
    ) {
      first = x;
      second = y;
      delta = j;
      break;
    }
  }
  if (delta === null) return err(partial(op, 'edges-not-continuous', { edges: [edgeA, edgeB] }));
  const a = d.edges[first] as Edge;
  const b = d.edges[second] as Edge;
  const uses = draftUses(d);
  const joint = a.v1;
  for (const [e, list] of uses) {
    if (e === first || e === second || list.length === 0) continue;
    const ed = d.edges[e] as Edge;
    if (ed.v0 === joint || ed.v1 === joint) {
      return err(partial(op, 'vertex-has-other-edges', { vertex: joint, edge: e }));
    }
  }
  const useA = uses.get(first) ?? [];
  const useB = uses.get(second) ?? [];
  if (useA.length !== useB.length)
    return err(partial(op, 'uneven-uses', { edges: [first, second] }));
  const drop = new Set<number>();
  for (const ua of useA) {
    const ca = d.coedges[ua.coedge] as Coedge;
    const loop = d.loops[ua.loop] as { coedges: number[] };
    const at = loop.coedges.indexOf(ua.coedge);
    const n = loop.coedges.length;
    const nextId = loop.coedges[(at + (ca.reversed ? -1 : 1) + n) % n] as number;
    const cb = d.coedges[nextId] as Coedge;
    if (cb.edge !== second || cb.reversed !== ca.reversed) {
      return err(partial(op, 'coedges-not-consecutive', { edges: [first, second] }));
    }
    if (ca.pcurve.kind === 'nurbs' || cb.pcurve.kind === 'nurbs') {
      return err(partial(op, 'nurbs-pcurve', { edges: [first, second] }));
    }
    for (let k = 0; k <= 4; k++) {
      const s = b.t0 + ((b.t1 - b.t0) * k) / 4;
      const p = pcurvePoint(ca.pcurve, s + delta);
      const q = pcurvePoint(cb.pcurve, s);
      if (Math.abs(p[0] - q[0]) > 1e-7 || Math.abs(p[1] - q[1]) > 1e-7) {
        return err(partial(op, 'pcurves-differ', { edges: [first, second], face: ua.face }));
      }
    }
    drop.add(nextId);
  }
  for (const l of new Set(useA.map((u) => u.loop))) {
    const loop = d.loops[l] as { coedges: number[] };
    loop.coedges = loop.coedges.filter((c) => !drop.has(c));
  }
  d.edges[first] = { ...a, t1: b.t1 + delta, v1: b.v1, tol: Math.max(a.tol, b.tol) };
  d.edgeFrom[first] = [
    ...new Set([...(d.edgeFrom[first] as number[]), ...(d.edgeFrom[second] as number[])]),
  ].sort((x, y) => x - y);
  return finishDraft(d, op, allowOpen);
}

/** Split an edge at curve parameter `t` (strictly inside its range); every face using it is split consistently. */
export function splitEdge(
  shape: Shape,
  edge: number,
  t: number,
): Result<EditResult, ModelingError> {
  const op = 'splitEdge';
  const bad = edgeIndex(shape, edge, op);
  if (bad !== undefined) return err(bad);
  const open = checkEditable(shape, op);
  if (!open.ok) return open;
  const e = shape.edges[edge] as Edge;
  if (e.curve < 0) return err(badEdit(op, 'degenerate-edge', { edge }));
  if (!Number.isFinite(t) || !(t - e.t0 > PARAM_TOL) || !(e.t1 - t > PARAM_TOL)) {
    return err(badEdit(op, 'parameter-outside-edge', { edge, t, range: [e.t0, e.t1] }));
  }
  const d = draftOf(shape);
  const curve = d.curves[e.curve] as Curve;
  const p = curvePoint(curve, t);
  if (
    dist3(p, (d.vertices[e.v0] as { p: P3 }).p) <= 2 * d.tol ||
    dist3(p, (d.vertices[e.v1] as { p: P3 }).p) <= 2 * d.tol
  ) {
    return err(badEdit(op, 'parameter-at-vertex', { edge, t }));
  }
  let curveA = e.curve;
  let curveB = e.curve;
  if (curve.kind === 'nurbs') {
    const cut = splitCurve(curve.curve, t);
    if (!cut.ok) return cut;
    d.curves.push({ kind: 'nurbs', curve: cut.value[0] }, { kind: 'nurbs', curve: cut.value[1] });
    curveA = d.curves.length - 2;
    curveB = d.curves.length - 1;
  }
  d.vertices.push({ p, tol: d.tol });
  d.vertexFrom.push([]);
  const mid = d.vertices.length - 1;
  d.edges[edge] = { ...e, curve: curveA, t1: t, v1: mid };
  d.edges.push({ ...e, curve: curveB, t0: t, v0: mid });
  d.edgeFrom.push([edge]);
  const second = d.edges.length - 1;
  for (const u of draftUses(d).get(edge) ?? []) {
    const co = d.coedges[u.coedge] as Coedge;
    let lead: PCurve = co.pcurve;
    let tail: PCurve = co.pcurve;
    if (co.pcurve.kind === 'nurbs') {
      const cut = splitCurve(co.pcurve.curve, t);
      if (!cut.ok) return cut;
      lead = { kind: 'nurbs', curve: cut.value[0] };
      tail = { kind: 'nurbs', curve: cut.value[1] };
    }
    d.coedges[u.coedge] = { edge, reversed: co.reversed, pcurve: lead };
    d.coedges.push({ edge: second, reversed: co.reversed, pcurve: tail });
    const added = d.coedges.length - 1;
    const loop = d.loops[u.loop] as { coedges: number[] };
    const at = loop.coedges.indexOf(u.coedge);
    loop.coedges.splice(co.reversed ? at : at + 1, 0, added);
  }
  return finishDraft(d, op, open.value);
}

// ---- faces -----------------------------------------------------------------------------------

export interface SplitFaceOptions {
  /** The parameter that stays constant along the new edge. */
  readonly axis: 'u' | 'v';
  readonly at: number;
}

interface IsoCurve {
  readonly curve: Curve;
  readonly t0: number;
  readonly t1: number;
}

/** The iso-curve `axis = at` over [lo, hi] of the other parameter, with the edge parameter set as documented per surface. */
function isoCurve(
  s: Surface,
  axis: 'u' | 'v',
  at: number,
  lo: number,
  hi: number,
): IsoCurve | undefined {
  if (s.kind === 'nurbs') return undefined;
  const f = s.frame;
  const radial = add3(scale3(f.x, cos(at)), scale3(f.y, sin(at)));
  const line = (o: P3, dir: P3, span: number): IsoCurve => ({
    curve: { kind: 'line', o, d: dir },
    t0: 0,
    t1: span,
  });
  const circle = (center: P3, radius: number): IsoCurve => ({
    curve: { kind: 'circle', frame: { ...f, o: center }, radius },
    t0: lo,
    t1: hi,
  });
  const meridian = (center: P3, radius: number): IsoCurve => ({
    curve: {
      kind: 'circle',
      frame: { o: center, x: radial, y: f.z, z: cross3(radial, f.z) },
      radius,
    },
    t0: lo,
    t1: hi,
  });
  switch (s.kind) {
    case 'plane':
      return axis === 'v'
        ? line(surfacePoint(s, lo, at), f.x, hi - lo)
        : line(surfacePoint(s, at, lo), f.y, hi - lo);
    case 'cylinder':
      return axis === 'v'
        ? circle(madd3(f.o, f.z, at), s.radius)
        : line(surfacePoint(s, at, lo), f.z, hi - lo);
    case 'cone': {
      if (axis === 'v') {
        const radius = s.radius + at * sin(s.halfAngle);
        return radius > 0 ? circle(madd3(f.o, f.z, at * cos(s.halfAngle)), radius) : undefined;
      }
      const dir = madd3(scale3(radial, sin(s.halfAngle)), f.z, cos(s.halfAngle));
      return line(surfacePoint(s, at, lo), unit3(dir), hi - lo);
    }
    case 'sphere':
      return axis === 'v'
        ? circle(madd3(f.o, f.z, s.radius * sin(at)), s.radius * cos(at))
        : meridian(f.o, s.radius);
    case 'torus':
      return axis === 'v'
        ? circle(madd3(f.o, f.z, s.minor * sin(at)), s.major + s.minor * cos(at))
        : meridian(madd3(f.o, radial, s.major), s.minor);
  }
}

function sideCoordinate(shape: Shape, c: number, axis: 0 | 1): { start: number; end: number } {
  const co = shape.coedges[c] as Coedge;
  const ends = coedgeEnds(shape.edges[co.edge] as Edge, co);
  return { start: ends.start[axis], end: ends.end[axis] };
}

/** The edge parameter at which a straight-line pcurve crosses `at` on `axis`, or `undefined` when it does not cross. */
function crossingParameter(
  shape: Shape,
  c: number,
  axis: 0 | 1,
  at: number,
): number | 'vertex' | 'none' | 'curved' {
  const { start, end } = sideCoordinate(shape, c, axis);
  if (Math.abs(start - at) <= UV_TOL || Math.abs(end - at) <= UV_TOL) return 'vertex';
  if ((start - at) * (end - at) > 0) return 'none';
  const co = shape.coedges[c] as Coedge;
  if (co.pcurve.kind !== 'line') return 'curved';
  const slope = co.pcurve.d[axis];
  return slope === 0 ? 'curved' : (at - co.pcurve.o[axis]) / slope;
}

/** Cut a face of an analytic surface along `u = at` or `v = at`; the face must be a rectangle in (u, v). */
export function splitFace(
  shape: Shape,
  face: number,
  options: SplitFaceOptions,
): Result<EditResult, ModelingError> {
  const op = 'splitFace';
  const bad = faceIndex(shape, face, op);
  if (bad !== undefined) return err(bad);
  const open = checkEditable(shape, op);
  if (!open.ok) return open;
  const surface = shape.surfaces[(shape.faces[face] as { surface: number }).surface] as Surface;
  if (surface.kind === 'nurbs') return err(partial(op, 'nurbs-face', { face }));
  const grid = gridOf(shape, face);
  if (!grid.ok) return grid;
  const vAxis = options.axis === 'v';
  const g = grid.value;
  const [lo, hi] = vAxis ? [g.v0, g.v1] : [g.u0, g.u1];
  if (!Number.isFinite(options.at) || !(options.at - lo > UV_TOL) || !(hi - options.at > UV_TOL)) {
    return err(badEdit(op, 'parameter-outside-face', { face, at: options.at, range: [lo, hi] }));
  }
  const crossing = vAxis
    ? [...g.right.coedges, ...g.left.coedges]
    : [...g.bottom.coedges, ...g.top.coedges];
  const axisIdx = vAxis ? 1 : 0;
  const cuts = new Map<number, number>();
  for (const c of crossing) {
    const at = crossingParameter(shape, c, axisIdx, options.at);
    if (at === 'curved') return err(partial(op, 'side-not-straight', { face, coedge: c }));
    if (typeof at === 'number') {
      const e = (shape.coedges[c] as Coedge).edge;
      if ((shape.edges[e] as Edge).curve < 0) return err(partial(op, 'cut-through-pole', { face }));
      if (!cuts.has(e)) cuts.set(e, at);
    }
  }
  let current = shape;
  let provenance = identity(shape);
  for (const [e, t] of cuts) {
    const cut = splitEdge(current, e, t);
    if (!cut.ok) return cut;
    current = cut.value.shape;
    provenance = composeProvenance(provenance, cut.value.provenance);
  }
  const done = cutGrid(current, face, options, op, open.value);
  if (!done.ok) return done;
  return ok({
    shape: done.value.shape,
    provenance: composeProvenance(provenance, done.value.provenance),
  });
}

function cutGrid(
  shape: Shape,
  face: number,
  options: SplitFaceOptions,
  op: string,
  allowOpen: boolean,
): Result<EditResult, ModelingError> {
  const grid = gridOf(shape, face);
  if (!grid.ok) return grid;
  const g = grid.value;
  const d = draftOf(shape);
  const f = d.faces[face] as DraftFace;
  const surface = d.surfaces[f.surface] as Surface;
  const vAxis = options.axis === 'v';
  const axisIdx = vAxis ? 1 : 0;
  const at = options.at;
  const stop = (run: readonly number[]): number =>
    run.findIndex((c) => Math.abs(sideCoordinate(shape, c, axisIdx).end - at) <= UV_TOL);
  const [runA, runB] = vAxis
    ? [g.right.coedges, g.left.coedges]
    : [g.bottom.coedges, g.top.coedges];
  const ia = stop(runA);
  const ib = stop(runB);
  if (ia < 0 || ib < 0) return err(partial(op, 'no-vertex-at-parameter', { face }));
  const vertexAfter = (c: number) => endVertex(d, d.coedges[c] as Coedge);
  const iso = vAxis
    ? isoCurve(surface, 'v', at, g.u0, g.u1)
    : isoCurve(surface, 'u', at, g.v0, g.v1);
  if (iso === undefined) return err(partial(op, 'no-iso-curve', { face }));
  // New edge runs +u at v = at (left to right) or +v at u = at (bottom to top).
  const from = vAxis ? vertexAfter(runB[ib] as number) : vertexAfter(runA[ia] as number);
  const to = vAxis ? vertexAfter(runA[ia] as number) : vertexAfter(runB[ib] as number);
  d.curves.push(iso.curve);
  d.edges.push({
    curve: d.curves.length - 1,
    t0: iso.t0,
    t1: iso.t1,
    v0: from,
    v1: to,
    tol: d.tol,
  });
  d.edgeFrom.push([]);
  const edge = d.edges.length - 1;
  const pc = pcurveFor(surface, iso.curve, iso.t0, iso.t1);
  if (!pc.ok) return pc;
  const mk = (reversed: boolean): number => {
    d.coedges.push({ edge, reversed, pcurve: pc.value });
    return d.coedges.length - 1;
  };
  const forward = mk(false);
  const backward = mk(true);
  const rot = (xs: readonly number[], a: number, b?: number) => xs.slice(a, b);
  let lower: number[];
  let upper: number[];
  if (vAxis) {
    lower = [
      ...g.bottom.coedges,
      ...rot(g.right.coedges, 0, ia + 1),
      backward,
      ...rot(g.left.coedges, ib + 1),
    ];
    upper = [
      ...rot(g.right.coedges, ia + 1),
      ...g.top.coedges,
      ...rot(g.left.coedges, 0, ib + 1),
      forward,
    ];
  } else {
    lower = [
      ...rot(g.bottom.coedges, 0, ia + 1),
      forward,
      ...rot(g.top.coedges, ib + 1),
      ...g.left.coedges,
    ];
    upper = [
      ...rot(g.bottom.coedges, ia + 1),
      ...g.right.coedges,
      ...rot(g.top.coedges, 0, ib + 1),
      backward,
    ];
  }
  const sA = d.surfaces[f.surface] as Surface;
  d.faces.push({ ...f, loops: [] });
  d.faceFrom.push([face]);
  const added = d.faces.length - 1;
  const shell = d.shells.find((s) => s.includes(face));
  (shell as number[]).push(added);
  for (const [target, ids] of [
    [face, lower],
    [added, upper],
  ] as const) {
    const aligned = alignOrdered(d, sA, ids, op);
    if (!aligned.ok) return aligned;
    const set = setFaceLoops(d, target, [aligned.value], op);
    if (!set.ok) return set;
  }
  return finishDraft(d, op, allowOpen);
}

/** Replace the surface under a face's boundary; pcurves come from closed forms unless given per coedge. */
export interface ReplaceFaceOptions {
  readonly surface: Surface;
  /** Required for a NURBS surface (and any edge without a closed form), keyed by input coedge index. */
  readonly pcurves?: Readonly<Record<number, PCurve>>;
}

/**
 * Move a face onto another surface that contains its boundary. The outward normal is kept: when the new frame
 * mirrors the old (u, v) winding, every coedge and the face flag flip together.
 */
export function replaceFace(
  shape: Shape,
  face: number,
  options: ReplaceFaceOptions,
): Result<EditResult, ModelingError> {
  const op = 'replaceFace';
  const bad = faceIndex(shape, face, op);
  if (bad !== undefined) return err(bad);
  const open = checkEditable(shape, op);
  if (!open.ok) return open;
  const d = draftOf(shape);
  const f = d.faces[face] as DraftFace;
  d.surfaces.push(options.surface);
  f.surface = d.surfaces.length - 1;
  const fresh: number[] = [];
  let outerCoedge = -1;
  for (const l of f.loops) {
    const loop = d.loops[l] as { coedges: number[]; outer: boolean };
    for (const c of loop.coedges) {
      const co = d.coedges[c] as Coedge;
      const e = d.edges[co.edge] as Edge;
      let pcurve = options.pcurves?.[c];
      if (pcurve === undefined) {
        if (e.curve < 0) return err(partial(op, 'degenerate-edge-needs-pcurve', { coedge: c }));
        const derived = pcurveFor(options.surface, d.curves[e.curve] as Curve, e.t0, e.t1);
        if (!derived.ok) return derived;
        pcurve = derived.value;
      }
      d.coedges.push({ edge: co.edge, reversed: co.reversed, pcurve });
      fresh.push(d.coedges.length - 1);
      if (loop.outer && outerCoedge < 0) outerCoedge = d.coedges.length - 1;
    }
  }
  let chains = chainLoops(d, options.surface, fresh, op);
  if (!chains.ok) return chains;
  const outerChain = chains.value.find((ch) => ch.includes(outerCoedge)) as number[];
  const winding = outerChain.reduce((a, c) => {
    const co = d.coedges[c] as Coedge;
    return a + coedgeGreen(d.edges[co.edge] as Edge, co);
  }, 0);
  if (winding < 0) {
    for (const c of fresh) {
      const co = d.coedges[c] as Coedge;
      d.coedges[c] = { ...co, reversed: !co.reversed };
    }
    f.reversed = !f.reversed;
    chains = chainLoops(d, options.surface, fresh, op);
    if (!chains.ok) return chains;
  }
  const set = setFaceLoops(d, face, chains.value, op);
  if (!set.ok) return set;
  return finishDraft(d, op, open.value);
}

// ---- holes -----------------------------------------------------------------------------------

/** The hole loops of a face as shape loop indices. */
export function holeLoops(shape: Shape, face: number): number[] {
  const f = shape.faces[face];
  return f === undefined
    ? []
    : f.loops.filter((l) => !(shape.loops[l] as { outer: boolean }).outer);
}

/**
 * Fill a hole: drop the hole loop, delete the faces that make its wall (everything reached across the loop's
 * edges), and drop the matching hole loop on the far side of a through hole. A wall that meets any outer
 * boundary is not a hole and the edit fails.
 */
export function removeHole(
  shape: Shape,
  face: number,
  loop: number,
): Result<EditResult, ModelingError> {
  const op = 'removeHole';
  const bad = faceIndex(shape, face, op);
  if (bad !== undefined) return err(bad);
  const target = shape.loops[loop];
  if (
    target === undefined ||
    !(shape.faces[face] as { loops: readonly number[] }).loops.includes(loop)
  ) {
    return err(badEdit(op, 'loop-not-on-face', { face, loop }));
  }
  if (target.outer) return err(badEdit(op, 'loop-is-outer', { face, loop }));
  const open = checkEditable(shape, op);
  if (!open.ok) return open;
  const uses = edgeUses(shape);
  const walls = new Set<number>();
  const dropped = new Map<number, number>([[loop, face]]);
  const queue: number[] = [];
  const cross = (l: number): ModelingError | undefined => {
    for (const c of (shape.loops[l] as { coedges: readonly number[] }).coedges) {
      const e = (shape.coedges[c] as Coedge).edge;
      const others = (uses[e] ?? []).filter((u) => u.coedge !== c);
      if (others.length !== 1) return partial(op, 'open-or-nonmanifold-wall', { edge: e });
      const next = others[0] as { face: number; loop: number };
      if (dropped.has(next.loop) || walls.has(next.face)) continue;
      if (next.face === face) return partial(op, 'wall-returns-to-face', { face, edge: e });
      if ((shape.loops[next.loop] as { outer: boolean }).outer) {
        walls.add(next.face);
        queue.push(next.face);
      } else {
        dropped.set(next.loop, next.face);
      }
    }
    return undefined;
  };
  let failure = cross(loop);
  while (failure === undefined && queue.length > 0) {
    for (const l of (shape.faces[queue.pop() as number] as { loops: readonly number[] }).loops) {
      failure ??= cross(l);
    }
  }
  if (failure !== undefined) return err(failure);
  if (walls.size === 0) return err(partial(op, 'hole-has-no-wall', { face, loop }));
  const d = draftOf(shape);
  for (const [l, owner] of dropped) {
    if (walls.has(owner)) continue;
    const f = d.faces[owner] as DraftFace;
    f.loops = f.loops.filter((x) => x !== l);
  }
  d.shells = d.shells.map((s) => s.filter((x) => !walls.has(x)));
  return finishDraft(d, op, open.value);
}

// ---- simplify --------------------------------------------------------------------------------

/** Merge every pair of adjacent co-surface faces, then every pair of edges that continue one curve through a bare vertex. */
export function simplify(shape: Shape): Result<EditResult, ModelingError> {
  let current = shape;
  let provenance = identity(shape);
  const adopt = (r: EditResult) => {
    current = r.shape;
    provenance = composeProvenance(provenance, r.provenance);
  };
  // One editability check per round: every candidate pair in a round sees the same shape, so validating it per pair
  // repeats the same full-shape measurement for each failing pair. An invalid input admits no merge at all.
  for (let progress = true; progress; ) {
    progress = false;
    const open = checkEditable(current, 'mergeFaces');
    if (!open.ok) break;
    const uses = edgeUses(current);
    for (const list of uses) {
      const [a, b] = list;
      if (list.length !== 2 || a === undefined || b === undefined || a.face === b.face) continue;
      const merged = mergeFacesIn(current, a.face, b.face, open.value);
      if (merged.ok) {
        adopt(merged.value);
        progress = true;
        break;
      }
    }
  }
  for (let progress = true; progress; ) {
    progress = false;
    const open = checkEditable(current, 'mergeEdges');
    if (!open.ok) break;
    const byVertex = new Map<number, number[]>();
    current.edges.forEach((e, i) => {
      if (e.curve < 0) return;
      for (const v of e.v0 === e.v1 ? [e.v0] : [e.v0, e.v1]) {
        byVertex.set(v, [...(byVertex.get(v) ?? []), i]);
      }
    });
    for (const list of byVertex.values()) {
      const [a, b] = list;
      if (list.length !== 2 || a === undefined || b === undefined) continue;
      const merged = mergeEdgesIn(draftOf(current), a, b, 'mergeEdges', open.value);
      if (merged.ok) {
        adopt(merged.value);
        progress = true;
        break;
      }
    }
  }
  return ok({ shape: current, provenance });
}
