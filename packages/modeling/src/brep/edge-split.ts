import { ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { curvePoint } from './curves';
import type { Coedge, Curve, Edge, Loop, Shape, Vertex } from './types';
import { brepFail } from './types';
import { dist3 } from './vec';

/**
 * E1d B1: insert a vertex in the interior of one edge. Pure: the input Shape is never mutated and
 * every face that uses the edge is split in the same result, so both sides stay conforming.
 *
 * A pcurve is parameterized by the edge parameter, so splitting an edge at `t` leaves each pcurve
 * object unchanged: the two halves reuse it and only the edge ranges change. That holds for the
 * line and circle pcurves accepted here; NURBS pcurves and NURBS edge curves are refused, since
 * their knot domains would need their own split.
 */
export interface EdgeSplit {
  readonly shape: Shape;
  /** Index of the inserted vertex in `shape.vertices`. */
  readonly vertex: number;
}

const SPLITTABLE_CURVE: ReadonlySet<Curve['kind']> = new Set(['line', 'circle', 'ellipse']);

export function splitEdgeAt(
  shape: Shape,
  edge: number,
  t: number,
): Result<EdgeSplit, ModelingError> {
  const e = shape.edges[edge] as Edge | undefined;
  if (!e) return brepFail('brep-index-range', 'an edge index inside the shape', { edge });
  if (e.curve < 0) return brepFail('brep-bad-argument', 'a non-degenerate edge to split', { edge });
  const curve = shape.curves[e.curve] as Curve;
  if (!SPLITTABLE_CURVE.has(curve.kind))
    return brepFail('brep-pcurve-unsupported', 'a line, circle or ellipse edge', {
      reason: 'edge-split-curve-kind',
      kind: curve.kind,
    });
  if (!(e.t0 < t && t < e.t1))
    return brepFail('brep-bad-argument', 'a split parameter strictly inside the edge', {
      edge,
      t,
    });

  const p = curvePoint(curve, t);
  const v0 = shape.vertices[e.v0] as Vertex;
  const v1 = shape.vertices[e.v1] as Vertex;
  if (dist3(p, v0.p) <= shape.tol || dist3(p, v1.p) <= shape.tol)
    return brepFail('brep-bad-argument', 'a split point away from the edge ends', { edge, t });

  // Every use of the edge must be a pcurve whose parameter is the edge parameter (line or circle).
  const uses: number[] = [];
  shape.coedges.forEach((co: Coedge, ci) => {
    if (co.edge !== edge) return;
    uses.push(ci);
  });
  for (const ci of uses) {
    const co = shape.coedges[ci] as Coedge;
    if (co.pcurve.kind === 'nurbs')
      return brepFail('brep-pcurve-unsupported', 'a line or circle pcurve on the split edge', {
        reason: 'edge-split-pcurve-kind',
        kind: co.pcurve.kind,
        coedge: ci,
      });
  }

  const vertex = shape.vertices.length;
  const tail = shape.edges.length;
  const vertices: Vertex[] = [...shape.vertices, { p, tol: shape.tol }];
  const edges: Edge[] = shape.edges.map((old, i) =>
    i === edge ? { ...old, t1: t, v1: vertex } : old,
  );
  edges.push({ curve: e.curve, t0: t, t1: e.t1, v0: vertex, v1: e.v1, tol: e.tol });

  // Each old coedge becomes two in traversal order. A reversed coedge walks t1 -> t0, so its first
  // half is the tail edge reversed; a forward coedge's first half is the original edge.
  const coedges: Coedge[] = [];
  const replaced = new Map<number, number[]>();
  shape.coedges.forEach((co: Coedge, ci) => {
    if (co.edge !== edge) {
      replaced.set(ci, [coedges.length]);
      coedges.push(co);
      return;
    }
    const first: Coedge = co.reversed
      ? { edge: tail, reversed: true, pcurve: co.pcurve }
      : { edge, reversed: false, pcurve: co.pcurve };
    const second: Coedge = co.reversed
      ? { edge, reversed: true, pcurve: co.pcurve }
      : { edge: tail, reversed: false, pcurve: co.pcurve };
    replaced.set(ci, [coedges.length, coedges.length + 1]);
    coedges.push(first, second);
  });

  const loops: Loop[] = shape.loops.map((loop) => ({
    coedges: loop.coedges.flatMap((ci) => replaced.get(ci) ?? []),
    outer: loop.outer,
  }));

  return ok({
    shape: {
      tol: shape.tol,
      maxTol: shape.maxTol,
      vertices,
      curves: shape.curves,
      surfaces: shape.surfaces,
      edges,
      coedges,
      loops,
      faces: shape.faces,
      shells: shape.shells,
    },
    vertex,
  });
}
