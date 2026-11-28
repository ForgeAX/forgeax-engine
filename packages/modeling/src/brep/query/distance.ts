import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../../arrays';
import type { ModelingError } from '../../errors';
import { faceLoops } from '../faces';
import { brepError, type Coedge, type Shape } from '../types';
import type { P3 } from '../vec';
import { closedShells, insideAt } from './inside';
import { obbDistance } from './obb';
import { type PairResult, type SearchOptions, searchPairs } from './pair-search';
import { edgeRoots, type Foot, faceRoots, type Piece, pointPiece, vertexRoots } from './pieces';
import { trimIndexOf } from './trim-index';

export type { SearchOptions } from './pair-search';
export type { Foot } from './pieces';

/** The nearest point of a face, an edge or a shape to a probe point. */
export interface Closest {
  readonly distance: number;
  /** The true distance lies in `[distance - errorBound, distance]`. */
  readonly errorBound: number;
  readonly point: P3;
  readonly foot: Foot;
  /** Piece-pair expansions the search spent (a cost figure, not a result). */
  readonly work: number;
}

function rangeError(what: 'face' | 'edge', id: number): ModelingError {
  return brepError('brep-index-range', `a ${what} index inside the shape`, {
    reason: 'distance-index',
    [what]: id,
  });
}

function facePieces(shape: Shape, f: number): Result<Piece[], ModelingError> {
  const index = trimIndexOf(shape, f);
  if (!index.ok) return index;
  const pieces = faceRoots(shape, f, index.value);
  const { outer, holes } = faceLoops(shape, f);
  const seen = new Set<number>();
  for (const ring of [outer, ...holes])
    for (const c of ring) {
      const e = (shape.coedges[c] as Coedge).edge;
      if (seen.has(e)) continue;
      seen.add(e);
      pushAll(pieces, edgeRoots(shape, e));
      const edge = shape.edges[e] as Shape['edges'][number];
      for (const v of [edge.v0, edge.v1]) pieces.push(vertexPiece(shape, v));
    }
  return ok(pieces);
}

function vertexPiece(shape: Shape, id: number): Piece {
  const p = (shape.vertices[id] as Shape['vertices'][number]).p;
  return pointPiece(p, { kind: 'vertex', id, point: p });
}

function toClosest(r: PairResult): Closest {
  return {
    distance: r.distance,
    errorBound: r.errorBound,
    point: r.pointB,
    foot: r.footB,
    work: r.expansions,
  };
}

function closestTo(
  p: P3,
  pieces: readonly Piece[],
  options?: SearchOptions,
): Result<Closest, ModelingError> {
  const r = searchPairs([pointPiece(p)], pieces, options);
  return r.ok ? ok(toClosest(r.value)) : r;
}

/** Closest point of one face (its trimmed interior and its boundary edges) to `p`. */
export function closestOnFace(
  shape: Shape,
  face: number,
  p: P3,
  options?: SearchOptions,
): Result<Closest, ModelingError> {
  if (!Number.isInteger(face) || face < 0 || face >= shape.faces.length)
    return err(rangeError('face', face));
  const pieces = facePieces(shape, face);
  return pieces.ok ? closestTo(p, pieces.value, options) : pieces;
}

/** Closest point of one edge to `p`. */
export function closestOnEdge(
  shape: Shape,
  edge: number,
  p: P3,
  options?: SearchOptions,
): Result<Closest, ModelingError> {
  if (!Number.isInteger(edge) || edge < 0 || edge >= shape.edges.length)
    return err(rangeError('edge', edge));
  return closestTo(p, edgeRoots(shape, edge), options);
}

// Shapes are immutable values, so the pieces of one shape are built once and reused by every probe.
const PIECE_CACHE = new WeakMap<Shape, Piece[]>();

export function shapePieces(shape: Shape): Result<Piece[], ModelingError> {
  const cached = PIECE_CACHE.get(shape);
  if (cached !== undefined) return ok(cached);
  const out: Piece[] = [];
  for (let f = 0; f < shape.faces.length; f++) {
    const index = trimIndexOf(shape, f);
    if (!index.ok) return index;
    pushAll(out, faceRoots(shape, f, index.value));
  }
  for (let e = 0; e < shape.edges.length; e++) pushAll(out, edgeRoots(shape, e));
  pushAll(out, vertexRoots(shape));
  PIECE_CACHE.set(shape, out);
  return ok(out);
}

/** Closest point of the whole shape (surface, not solid) to `p`. */
export function closestOnShape(
  shape: Shape,
  p: P3,
  options?: SearchOptions,
): Result<Closest, ModelingError> {
  const pieces = shapePieces(shape);
  return pieces.ok ? closestTo(p, pieces.value, options) : pieces;
}

// ---- shape to shape ----------------------------------------------------------------------

export type Contact =
  | { readonly kind: 'separate' }
  /** The two surfaces meet within the shapes' tolerance; `gap` is the measured closest distance. */
  | { readonly kind: 'contact'; readonly gap: number }
  /** The surfaces are apart but one closed shape lies inside the other; `clearance` is the gap between them. */
  | { readonly kind: 'containment'; readonly inner: 'a' | 'b'; readonly clearance: number };

export interface ShapeDistance {
  /** 0 when the shapes touch or overlap (see `contact`), else the minimum surface distance. */
  readonly distance: number;
  readonly errorBound: number;
  readonly contact: Contact;
  readonly pointA: P3;
  readonly pointB: P3;
  readonly footA: Foot;
  readonly footB: Foot;
}

function insideOf(shape: Shape, p: P3): Result<boolean, ModelingError> {
  const s = signedDistance(shape, p);
  return s.ok ? ok(s.value.value < 0) : s;
}

/** A rigorous lower bound of the distance between two shapes: the nearest pair of root bounding boxes. */
export function shapeLowerBound(a: Shape, b: Shape): Result<number, ModelingError> {
  const pa = shapePieces(a);
  if (!pa.ok) return pa;
  const pb = shapePieces(b);
  if (!pb.ok) return pb;
  let lb = Infinity;
  for (const x of pa.value)
    for (const y of pb.value) lb = Math.min(lb, obbDistance(x.bound, y.bound));
  return ok(lb);
}

export function shapeDistance(
  a: Shape,
  b: Shape,
  options?: SearchOptions,
): Result<ShapeDistance, ModelingError> {
  const pa = shapePieces(a);
  if (!pa.ok) return pa;
  const pb = shapePieces(b);
  if (!pb.ok) return pb;
  // An actual pair within the contact tolerance already decides `contact`; no need to refine further.
  const r = searchPairs(pa.value, pb.value, { stopBelow: a.tol + b.tol, ...options });
  if (!r.ok) return r;
  const v = r.value;
  const base = {
    errorBound: v.errorBound,
    pointA: v.pointA,
    pointB: v.pointB,
    footA: v.footA,
    footB: v.footB,
  };
  const touch = a.tol + b.tol;
  if (v.distance <= touch)
    return ok({ ...base, distance: 0, contact: { kind: 'contact', gap: v.distance } });
  if (closedShells(a) && closedShells(b)) {
    const aInB = insideOf(b, v.pointA);
    if (!aInB.ok) return aInB;
    const bInA = insideOf(a, v.pointB);
    if (!bInA.ok) return bInA;
    if (aInB.value || bInA.value)
      return ok({
        ...base,
        distance: 0,
        contact: { kind: 'containment', inner: aInB.value ? 'a' : 'b', clearance: v.distance },
      });
  }
  return ok({ ...base, distance: v.distance, contact: { kind: 'separate' } });
}

/** Distance to the closed shape's surface, negative inside; 0 within the shape's tolerance of the surface. */
export interface SignedDistance {
  readonly value: number;
  /** `|true value|` lies in `[|value| - errorBound, |value|]`. */
  readonly errorBound: number;
  readonly point: P3;
  readonly foot: Foot;
}

export function signedDistance(
  shape: Shape,
  p: P3,
  options?: SearchOptions,
): Result<SignedDistance, ModelingError> {
  if (!closedShells(shape))
    return err(
      brepError('brep-tol-exceeded', 'a closed shape (every edge used by two faces)', {
        reason: 'containment-open-shape',
      }),
    );
  const near = closestOnShape(shape, p, options);
  if (!near.ok) return near;
  const n = near.value;
  const base = { errorBound: n.errorBound, point: n.point, foot: n.foot };
  if (n.distance <= shape.tol) return ok({ ...base, value: 0 });
  let inside = insideAt(shape, p, n);
  if (!inside.ok && isSingularFoot(inside.error))
    inside = insideNearby(shape, p, n, options, inside);
  return inside.ok ? ok({ ...base, value: inside.value ? -n.distance : n.distance }) : inside;
}

function isSingularFoot(e: ModelingError): boolean {
  const reason = (e.detail as { reason?: string } | undefined)?.reason;
  return reason === 'containment-vertex-foot';
}

const NUDGE_DIRECTIONS: readonly P3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const NUDGE_FRACTIONS = [0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.85];

const unit3 = (v: P3): P3 | undefined => {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : undefined;
};

/** Axes, then the directions along and across the edges meeting at the vertex foot (diagonal ribs). */
function nudgeDirections(shape: Shape, foot: Foot): P3[] {
  const out: P3[] = [...NUDGE_DIRECTIONS];
  if (foot.kind !== 'vertex') return out;
  const at = (shape.vertices[foot.id] as { p: P3 }).p;
  const along: P3[] = [];
  shape.edges.forEach((e) => {
    const other = e.v0 === foot.id ? e.v1 : e.v1 === foot.id ? e.v0 : -1;
    if (other < 0 || other === foot.id) return;
    const w = (shape.vertices[other] as { p: P3 }).p;
    const d = unit3([w[0] - at[0], w[1] - at[1], w[2] - at[2]]);
    if (d !== undefined) along.push(d);
  });
  for (const d of along) out.push(d, [-d[0], -d[1], -d[2]]);
  for (let i = 0; i < along.length; i++)
    for (let j = i + 1; j < along.length; j++) {
      const a = along[i] as P3;
      const b = along[j] as P3;
      const c = unit3([
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ]);
      if (c !== undefined) out.push(c, [-c[0], -c[1], -c[2]]);
    }
  return out;
}

/**
 * A vertex foot has no normal, but the surface is at least `distance - errorBound` from `p`, so every
 * point within that radius is on the same side. Nudge `p` inside that ball until its own nearest
 * feature is an edge or face, and read the side there.
 */
function insideNearby(
  shape: Shape,
  p: P3,
  n: Closest,
  options: SearchOptions | undefined,
  failure: Result<boolean, ModelingError>,
): Result<boolean, ModelingError> {
  const clear = n.distance - n.errorBound;
  const directions = nudgeDirections(shape, n.foot);
  for (const k of NUDGE_FRACTIONS)
    for (const d of directions) {
      const q: P3 = [p[0] + d[0] * k * clear, p[1] + d[1] * k * clear, p[2] + d[2] * k * clear];
      const m = closestOnShape(shape, q, options);
      if (!m.ok || m.value.foot.kind === 'vertex') continue;
      const r = insideAt(shape, q, m.value);
      if (r.ok) return r;
    }
  return failure;
}
