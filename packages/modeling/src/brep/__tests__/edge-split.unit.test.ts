import { describe, expect, it } from 'vitest';
import { box, cylinder } from '../build';
import { splitEdgeAt } from '../edge-split';
import type { Coedge, Shape } from '../types';
import { validate } from '../validate';

function must(r: { ok: true; value: Shape } | { ok: false; error: unknown }): Shape {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

/** Head and tail vertex of a coedge in traversal order. */
function ends(s: Shape, co: Coedge): [number, number] {
  const e = s.edges[co.edge];
  if (!e) throw new Error('edge');
  return co.reversed ? [e.v1, e.v0] : [e.v0, e.v1];
}

/** Every loop closes head to tail; every non-degenerate edge is used exactly twice. */
function conforming(s: Shape): { loopsClosed: boolean; uses: Map<number, number> } {
  let loopsClosed = true;
  for (const loop of s.loops) {
    const n = loop.coedges.length;
    for (let k = 0; k < n; k++) {
      const a = s.coedges[loop.coedges[k] as number] as Coedge;
      const b = s.coedges[loop.coedges[(k + 1) % n] as number] as Coedge;
      if (ends(s, a)[1] !== ends(s, b)[0]) loopsClosed = false;
    }
  }
  const uses = new Map<number, number>();
  for (const co of s.coedges) uses.set(co.edge, (uses.get(co.edge) ?? 0) + 1);
  return { loopsClosed, uses };
}

/** Index of the first edge shared by two faces (every box edge is one). */
function sharedEdge(s: Shape): number {
  const e = s.coedges[0];
  if (!e) throw new Error('coedges');
  return e.edge;
}

/** Index of the face whose loop uses the coedge `ci`. */
function faceOf(s: Shape, ci: number): number {
  return s.faces.findIndex((f) => f.loops.some((l) => s.loops[l]?.coedges.includes(ci)));
}

const SIZE = { size: [2, 2, 2] as [number, number, number] };

describe('splitEdgeAt', () => {
  it('splits a box edge shared by two cap-side faces; both stay conforming and validate clean', () => {
    const b = must(box(SIZE));
    const edge = sharedEdge(b);
    // Parameter midway through the edge: a point on the box boundary, between its two vertices.
    const e = b.edges[edge];
    if (!e) throw new Error('edge');
    const r = splitEdgeAt(b, edge, (e.t0 + e.t1) / 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.shape;
    const c = conforming(s);
    expect(c.loopsClosed).toBe(true);
    for (const [, n] of c.uses) expect(n).toBe(2);
    expect(validate(s).ok, JSON.stringify(validate(s).issues)).toBe(true);
    // The two faces that shared the edge each gained one coedge; the vertex count went up by one.
    expect(s.vertices.length).toBe(b.vertices.length + 1);
    expect(s.edges.length).toBe(b.edges.length + 1);
  });

  it('splits two boundary edges of one cap, leaving the cap loop head to tail', () => {
    const b = must(box(SIZE));
    // Two coedges of one face, on different edges: the cap boundary points a plane chord would use.
    const face = b.faces[0];
    if (!face) throw new Error('face');
    const loop = b.loops[face.loops[0] as number];
    if (!loop) throw new Error('loop');
    const first = loop.coedges[0] as number;
    const second = loop.coedges[2] as number;
    const e1 = b.edges[b.coedges[first]?.edge as number];
    const e2 = b.edges[b.coedges[second]?.edge as number];
    if (!e1 || !e2) throw new Error('edges');
    const r1 = splitEdgeAt(b, b.coedges[first]?.edge as number, (e1.t0 + e1.t1) / 2);
    if (!r1.ok) throw new Error('first split');
    const s1 = r1.value.shape;
    const edge2 = s1.coedges[second]?.edge as number;
    const r2 = splitEdgeAt(s1, edge2, (e2.t0 + e2.t1) / 2);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const s = r2.value.shape;
    expect(conforming(s).loopsClosed).toBe(true);
    expect(validate(s).ok, JSON.stringify(validate(s).issues)).toBe(true);
  });

  it('splits a circle edge of a cylinder and keeps the shell valid', () => {
    const c = must(cylinder({ radius: 3, height: 2 }));
    const edge = c.edges.findIndex((e) => e.curve >= 0 && c.curves[e.curve]?.kind === 'circle');
    expect(edge).toBeGreaterThanOrEqual(0);
    const e = c.edges[edge];
    if (!e) throw new Error('edge');
    const r = splitEdgeAt(c, edge, (e.t0 + e.t1) / 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(validate(r.value.shape).ok, JSON.stringify(validate(r.value.shape).issues)).toBe(true);
  });

  it('refuses a parameter at an edge end (the vertex already exists there)', () => {
    const b = must(box(SIZE));
    const e = b.edges[0];
    if (!e) throw new Error('edge');
    expect(splitEdgeAt(b, 0, e.t0).ok).toBe(false);
    expect(splitEdgeAt(b, 0, e.t1).ok).toBe(false);
  });

  it('refuses an out-of-range edge index', () => {
    const b = must(box(SIZE));
    expect(splitEdgeAt(b, b.edges.length, 0.5).ok).toBe(false);
  });

  it('deliberate break: dropping one split coedge from a face loop is caught by validate', () => {
    const b = must(box(SIZE));
    const edge = sharedEdge(b);
    const e = b.edges[edge];
    if (!e) throw new Error('edge');
    const r = splitEdgeAt(b, edge, (e.t0 + e.t1) / 2);
    if (!r.ok) throw new Error('split');
    const s = r.value.shape;
    // Simulate a skipped pcurve split: one face keeps only one of the two halves of the split edge.
    const victim = s.coedges.findIndex(
      (co, ci) => co.edge === r.value.shape.edges.length - 1 && faceOf(s, ci) >= 0,
    );
    const owner = faceOf(s, victim);
    const face = s.faces[owner];
    if (!face) throw new Error('face');
    const loopIndex = face.loops[0] as number;
    const loop = s.loops[loopIndex];
    if (!loop) throw new Error('loop');
    const broken: Shape = {
      ...s,
      loops: s.loops.map((l, i) =>
        i === loopIndex ? { ...l, coedges: l.coedges.filter((ci) => ci !== victim) } : l,
      ),
    };
    expect(conforming(broken).loopsClosed).toBe(false);
    expect(validate(broken).ok).toBe(false);
  });
});
