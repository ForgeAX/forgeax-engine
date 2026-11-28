import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { curvePoint } from './curves';
import { splitEdgeAt } from './edge-split';
import { splitPlanarPolygon } from './planar-split';
import type { Coedge, Curve, Edge, Face, Loop, PCurve, Shape, Surface, Vertex } from './types';
import { brepFail } from './types';
import { cross3, dist3, dot3, len3, type P3, sub3, unit3 } from './vec';

/**
 * E1d B2: cut one planar face in two along a straight section whose ends lie on two of its
 * straight boundary edges. Pure: the input Shape is never mutated. Each boundary end is first
 * inserted as a vertex (edge-split.ts), then the outer loop is split at those vertices and a new
 * line edge (the chord) closes both pieces. The chord is used once by each piece, opposite ways.
 */

/** A point on a boundary edge, by the edge's own parameter. */
export interface EdgeSite {
  readonly edge: number;
  readonly t: number;
}

const refuse = (reason: string, ids: Record<string, unknown> = {}): Result<never, ModelingError> =>
  brepFail('brep-ssi-unsupported', reason, { reason: 'face-chord', ...ids });

/** Start point of coedge `ci` in traversal order (its tail is the next coedge's start). */
function startVertex(shape: Shape, ci: number): number {
  const co = shape.coedges[ci] as Coedge;
  const e = shape.edges[co.edge] as Edge;
  return co.reversed ? e.v1 : e.v0;
}

/**
 * Where the infinite section line `o + s d` (unit d) crosses the straight boundary of planar face
 * `faceIndex`. Exactly two crossings at interior edge points are required; a crossing at an edge
 * end (a vertex) or any curved boundary edge is refused, as is a section collinear with an edge.
 */
export function boundarySites(
  shape: Shape,
  faceIndex: number,
  section: { readonly o: P3; readonly d: P3 },
): Result<readonly [EdgeSite, EdgeSite], ModelingError> {
  const face = shape.faces[faceIndex] as Face | undefined;
  if (!face) return brepFail('brep-index-range', 'a face index inside the shape', { faceIndex });
  if (face.loops.length !== 1) return refuse('chord-face-with-holes', { faceIndex });
  const loop = shape.loops[face.loops[0] as number] as Loop;
  const sites: EdgeSite[] = [];
  for (const ci of loop.coedges) {
    const co = shape.coedges[ci] as Coedge;
    const e = shape.edges[co.edge] as Edge;
    if (e.curve < 0) return refuse('chord-degenerate-boundary', { coedge: ci });
    const edgeCurve = shape.curves[e.curve] as Curve;
    if (edgeCurve.kind !== 'line') return refuse('chord-boundary-kind', { kind: edgeCurve.kind });
    // Closest approach of the section line and the edge line; both lie in the face plane.
    const w = sub3(section.o, edgeCurve.o);
    const b = dot3(section.d, edgeCurve.d);
    const dd = dot3(section.d, w);
    const ee = dot3(edgeCurve.d, w);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-12) {
      // Parallel: the section is collinear with this edge when it passes through the edge line.
      if (len3(cross3(w, section.d)) <= shape.tol)
        return refuse('chord-collinear-edge', { coedge: ci });
      continue;
    }
    const s = (b * ee - dd) / denom;
    const t = (ee - b * dd) / denom;
    const pOnSection = [
      section.o[0] + s * section.d[0],
      section.o[1] + s * section.d[1],
      section.o[2] + s * section.d[2],
    ] as P3;
    if (dist3(pOnSection, curvePoint(edgeCurve, t)) > shape.tol) continue;
    if (t < e.t0 - shape.tol || t > e.t1 + shape.tol) continue;
    if (Math.abs(t - e.t0) <= shape.tol || Math.abs(t - e.t1) <= shape.tol)
      return refuse('chord-through-vertex', { coedge: ci });
    sites.push({ edge: co.edge, t });
  }
  if (sites.length !== 2) return refuse('chord-boundary-count', { count: sites.length, faceIndex });
  const [a, c] = sites as [EdgeSite, EdgeSite];
  if (a.edge === c.edge) return refuse('chord-both-ends-on-one-edge', { edge: a.edge });
  return ok([a, c] as const);
}

/** Two faces that replace the split one, in the shape they come back in. */
export interface FaceChordSplit {
  readonly shape: Shape;
  readonly faces: readonly [number, number];
}

/**
 * Split planar face `faceIndex` along the chord between two boundary sites. The shape is rebuilt
 * without the old face and its loop; the two pieces are appended, and every shell that held the
 * old face now holds both. Any invalid chord (leaving the face, touching a corner, degenerate
 * piece) is refused by the polygon split and nothing is returned.
 */
export function splitFaceAlongChord(
  shape: Shape,
  faceIndex: number,
  a: EdgeSite,
  c: EdgeSite,
): Result<FaceChordSplit, ModelingError> {
  const face = shape.faces[faceIndex] as Face | undefined;
  if (!face) return brepFail('brep-index-range', 'a face index inside the shape', { faceIndex });
  const surface = shape.surfaces[face.surface] as Surface;
  if (surface.kind !== 'plane')
    return brepFail('brep-pcurve-unsupported', 'a planar face to split by chord', {
      reason: 'chord-surface-kind',
      kind: surface.kind,
    });
  if (face.loops.length !== 1) return refuse('chord-face-with-holes', { faceIndex });

  const first = splitEdgeAt(shape, a.edge, a.t);
  if (!first.ok) return first;
  const second = splitEdgeAt(first.value.shape, c.edge, c.t);
  if (!second.ok) return second;
  return splitFaceAtVertices(
    second.value.shape,
    faceIndex,
    first.value.vertex,
    second.value.vertex,
  );
}

/**
 * Split planar face `faceIndex` along a chord between two vertices already on its outer loop.
 * The vertices may come from earlier edge splits (a shared vertical edge split once serves both
 * faces it bounds); the chord line is the straight segment between them.
 */
export function splitFaceAtVertices(
  split: Shape,
  faceIndex: number,
  va: number,
  vb: number,
): Result<FaceChordSplit, ModelingError> {
  const face = split.faces[faceIndex] as Face | undefined;
  if (!face) return brepFail('brep-index-range', 'a face index inside the shape', { faceIndex });
  const surface = split.surfaces[face.surface] as Surface;
  if (surface.kind !== 'plane')
    return brepFail('brep-pcurve-unsupported', 'a planar face to split by chord', {
      reason: 'chord-surface-kind',
      kind: surface.kind,
    });
  if (face.loops.length !== 1) return refuse('chord-face-with-holes', { faceIndex });

  const loopIndex = face.loops[0] as number;
  const loop = split.loops[loopIndex] as Loop;
  const ia = loop.coedges.findIndex((ci) => startVertex(split, ci) === va);
  const ib = loop.coedges.findIndex((ci) => startVertex(split, ci) === vb);
  if (ia < 0 || ib < 0) return refuse('chord-vertex-not-on-loop', { faceIndex });
  const poly = loop.coedges.map((ci) => (split.vertices[startVertex(split, ci)] as Vertex).p);
  const cut = splitPlanarPolygon(poly, ia, ib, split.tol);
  if (!cut.ok) return cut;

  const pa = (split.vertices[va] as Vertex).p;
  const pb = (split.vertices[vb] as Vertex).p;
  const length = dist3(pa, pb);
  if (!(length > split.tol)) return refuse('chord-too-short', { faceIndex });
  const dir = unit3(sub3(pb, pa));
  const { o, x, y } = (surface as Extract<Surface, { kind: 'plane' }>).frame;
  const uv = (p: P3): [number, number] => [dot3(sub3(p, o), x), dot3(sub3(p, o), y)];
  const ua = uv(pa);
  const ub = uv(pb);
  const pcurve: PCurve = {
    kind: 'line',
    o: ua,
    d: [(ub[0] - ua[0]) / length, (ub[1] - ua[1]) / length],
  };

  const curves = [...split.curves, { kind: 'line' as const, o: pa, d: dir }];
  const chordCurve = curves.length - 1;
  const edges = [
    ...split.edges,
    { curve: chordCurve, t0: 0, t1: length, v0: va, v1: vb, tol: split.tol },
  ];
  const chord = edges.length - 1;
  const coedges = [...split.coedges];
  const fwd = coedges.length;
  coedges.push({ edge: chord, reversed: false, pcurve });
  const rev = coedges.length;
  coedges.push({ edge: chord, reversed: true, pcurve });

  // Piece A: boundary from va to vb, then the chord back to va. Piece B: boundary from vb to va,
  // then the chord forward. Both pieces keep the original loop orientation.
  const n = loop.coedges.length;
  const span = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let k = from; k !== to; k = (k + 1) % n) out.push(loop.coedges[k] as number);
    return out;
  };
  const pieceA = [...span(ia, ib), rev];
  const pieceB = [...span(ib, ia), fwd];

  // Drop the old face and its loop, appending the two pieces.
  const loopRemap = new Map<number, number>();
  const loops: Loop[] = [];
  split.loops.forEach((l, li) => {
    if (li === loopIndex) return;
    loopRemap.set(li, loops.length);
    loops.push(l);
  });
  const loopA = loops.length;
  loops.push({ coedges: pieceA, outer: true }, { coedges: pieceB, outer: true });

  const faceRemap = new Map<number, number>();
  const faces: Face[] = [];
  split.faces.forEach((f, fi) => {
    if (fi === faceIndex) return;
    faceRemap.set(fi, faces.length);
    faces.push({ ...f, loops: f.loops.map((l) => loopRemap.get(l) as number) });
  });
  const faceA = faces.length;
  faces.push(
    {
      surface: face.surface,
      loops: [loopA],
      reversed: face.reversed,
      label: face.label,
      role: face.role,
    },
    {
      surface: face.surface,
      loops: [loopA + 1],
      reversed: face.reversed,
      label: face.label,
      role: face.role,
    },
  );

  const shells = split.shells.map((s) => ({
    faces: s.faces.flatMap((fi) =>
      fi === faceIndex ? [faceA, faceA + 1] : [faceRemap.get(fi) as number],
    ),
  }));

  return ok({
    shape: {
      tol: split.tol,
      maxTol: split.maxTol,
      vertices: split.vertices,
      curves,
      surfaces: split.surfaces,
      edges,
      coedges,
      loops,
      faces,
      shells,
    },
    faces: [faceA, faceA + 1],
  });
}
