import { curvePoint } from '../../src/brep/curves.ts';
import { splitEdge, splitFace } from '../../src/brep/edit.ts';
import { compact, draftOf, draftUses } from '../../src/brep/rebuild.ts';
import type { Coedge, Curve, Edge, Shape } from '../../src/brep/types.ts';
import { dist3, type P3 } from '../../src/brep/vec.ts';

export function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** Rebuild a draft into a Shape without validating it: damage is meant to be invalid. */
function build(d: ReturnType<typeof draftOf>): Shape {
  return must(compact(d)).shape;
}

export function vertexAt(shape: Shape, p: P3): number {
  let best = 0;
  let bestDist = Infinity;
  shape.vertices.forEach((v, i) => {
    const d = dist3(v.p, p);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  if (bestDist > 1e-6) throw new Error(`no vertex at ${p.join(',')}`);
  return best;
}

function mid(shape: Shape, e: Edge): P3 {
  return curvePoint(shape.curves[e.curve] as Curve, 0.5 * (e.t0 + e.t1));
}

/** The edge whose midpoint is nearest `p`. */
export function edgeNear(shape: Shape, p: P3): number {
  let best = -1;
  let bestDist = Infinity;
  shape.edges.forEach((e, i) => {
    if (e.curve < 0) return;
    const d = dist3(mid(shape, e), p);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/** Move a vertex off its curves by `delta`: a vertex gap. */
export function displaceVertex(shape: Shape, v: number, delta: P3): Shape {
  const d = draftOf(shape);
  const old = d.vertices[v] as { p: P3; tol: number };
  d.vertices[v] = {
    p: [old.p[0] + delta[0], old.p[1] + delta[1], old.p[2] + delta[2]],
    tol: old.tol,
  };
  return build(d);
}

/** Give `edges` their own copy of vertex `v`, at the same position: a duplicate vertex. */
export function duplicateVertex(shape: Shape, v: number, edges: readonly number[]): Shape {
  const d = draftOf(shape);
  d.vertices.push(d.vertices[v] as { p: P3; tol: number });
  d.vertexFrom.push([]);
  const copy = d.vertices.length - 1;
  for (const e of edges) {
    const ed = d.edges[e] as Edge;
    d.edges[e] = { ...ed, v0: ed.v0 === v ? copy : ed.v0, v1: ed.v1 === v ? copy : ed.v1 };
  }
  return build(d);
}

/** Cut the seam of `edge`: its second face gets a coincident copy with copies of both vertices. */
export function unsewEdge(shape: Shape, edge: number): Shape {
  const d = draftOf(shape);
  const uses = draftUses(d).get(edge) ?? [];
  const second = uses[1];
  if (second === undefined) throw new Error(`edge ${edge} has no second use`);
  const e = d.edges[edge] as Edge;
  d.vertices.push(d.vertices[e.v0] as { p: P3; tol: number });
  d.vertices.push(d.vertices[e.v1] as { p: P3; tol: number });
  d.vertexFrom.push([], []);
  const n = d.vertices.length;
  d.edges.push({ ...e, v0: n - 2, v1: n - 1 });
  d.edgeFrom.push([]);
  d.coedges[second.coedge] = { ...(d.coedges[second.coedge] as Coedge), edge: d.edges.length - 1 };
  return build(d);
}

/** Move an edge's curve by `delta` without touching the faces: the edge no longer lies on them. */
export function shiftEdgeCurve(shape: Shape, edge: number, delta: P3): Shape {
  const d = draftOf(shape);
  const e = d.edges[edge] as Edge;
  const c = d.curves[e.curve] as Curve;
  if (c.kind === 'nurbs') throw new Error('shiftEdgeCurve: NURBS curve');
  const o: P3 = c.kind === 'line' ? c.o : c.frame.o;
  const moved: P3 = [o[0] + delta[0], o[1] + delta[1], o[2] + delta[2]];
  d.curves.push(c.kind === 'line' ? { ...c, o: moved } : { ...c, frame: { ...c.frame, o: moved } });
  d.edges[edge] = { ...e, curve: d.curves.length - 1 };
  return build(d);
}

/** Split `edge` so its first piece is `length` long: a sliver edge. */
export function sliverEdge(shape: Shape, edge: number, length: number): Shape {
  const e = shape.edges[edge] as Edge;
  const c = shape.curves[e.curve] as Curve;
  const speed = c.kind === 'line' ? 1 : c.kind === 'circle' ? c.radius : 1;
  return must(splitEdge(shape, edge, e.t0 + length / speed)).shape;
}

/** Cut a thin strip `width` wide off the `u = low` end of a rectangular planar face: a sliver face. */
export function sliverFace(shape: Shape, face: number, width: number): Shape {
  return must(splitFace(shape, face, { axis: 'u', at: width })).shape;
}
