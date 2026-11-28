import { describe, expect, it } from 'vitest';
import { box } from '../build';
import { boundarySites, splitFaceAlongChord } from '../face-chord';
import type { Coedge, Face, Loop, Shape } from '../types';
import { validate } from '../validate';

function must(r: { ok: true; value: Shape } | { ok: false; error: unknown }): Shape {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function ends(s: Shape, co: Coedge): [number, number] {
  const e = s.edges[co.edge];
  if (!e) throw new Error('edge');
  return co.reversed ? [e.v1, e.v0] : [e.v0, e.v1];
}

function loopsClosed(s: Shape): boolean {
  for (const loop of s.loops) {
    const n = loop.coedges.length;
    for (let k = 0; k < n; k++) {
      const a = s.coedges[loop.coedges[k] as number] as Coedge;
      const b = s.coedges[loop.coedges[(k + 1) % n] as number] as Coedge;
      if (ends(s, a)[1] !== ends(s, b)[0]) return false;
    }
  }
  return true;
}

function useCounts(s: Shape): Map<number, number> {
  const uses = new Map<number, number>();
  for (const co of s.coedges) uses.set(co.edge, (uses.get(co.edge) ?? 0) + 1);
  return uses;
}

/** Shoelace area of a planar face loop, using its vertex positions in traversal order. */
function faceArea(s: Shape, fi: number, n: [number, number, number]): number {
  const face = s.faces[fi] as Face;
  const loop = s.loops[face.loops[0] as number] as Loop;
  const pts = loop.coedges.map((ci) => s.vertices[ends(s, s.coedges[ci] as Coedge)[0]]?.p);
  let area: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const q = pts[(k + 1) % pts.length];
    if (!p || !q) throw new Error('vertex');
    const c: [number, number, number] = [
      p[1] * q[2] - p[2] * q[1],
      p[2] * q[0] - p[0] * q[2],
      p[0] * q[1] - p[1] * q[0],
    ];
    area = [area[0] + c[0], area[1] + c[1], area[2] + c[2]];
  }
  return Math.abs(area[0] * n[0] + area[1] * n[1] + area[2] * n[2]) / 2;
}

/** The face whose every vertex lies on the plane y = 1 (a side face of the 2x2x2 box). */
function sideFaceAtY1(s: Shape): number {
  return s.faces.findIndex((f) => {
    const loop = s.loops[f.loops[0] as number];
    if (!loop) return false;
    return loop.coedges.every((ci) => {
      const v = s.vertices[ends(s, s.coedges[ci] as Coedge)[0]];
      return v !== undefined && Math.abs(v.p[1] - 1) < 1e-9;
    });
  });
}

const SIZE = { size: [2, 2, 2] as [number, number, number] };
/** Section on the plane y = 1 at z = 0, running along x: crosses the vertical edges at x = +-1. */
const HORIZONTAL = {
  o: [0, 1, 0] as [number, number, number],
  d: [1, 0, 0] as [number, number, number],
};

describe('boundarySites', () => {
  it('finds the two straight boundary crossings of a section across a box side face', () => {
    const b = must(box(SIZE));
    const fi = sideFaceAtY1(b);
    expect(fi).toBeGreaterThanOrEqual(0);
    const r = boundarySites(b, fi, HORIZONTAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0].edge).not.toBe(r.value[1].edge);
  });

  it('refuses a section through a corner (a vertex, not an edge point)', () => {
    const b = must(box(SIZE));
    const fi = sideFaceAtY1(b);
    const corner = {
      o: [1, 1, 1] as [number, number, number],
      d: [1, 0, -1] as [number, number, number],
    };
    const r = boundarySites(b, fi, { o: corner.o, d: unitDiagonal(corner.d) });
    expect(r.ok).toBe(false);
  });

  it('refuses a section collinear with a boundary edge', () => {
    const b = must(box(SIZE));
    const fi = sideFaceAtY1(b);
    const onEdge = {
      o: [0, 1, 1] as [number, number, number],
      d: [1, 0, 0] as [number, number, number],
    };
    expect(boundarySites(b, fi, onEdge).ok).toBe(false);
  });
});

describe('splitFaceAlongChord', () => {
  it('cuts a box side face in two; loops close, each edge is used twice, validate is clean', () => {
    const b = must(box(SIZE));
    const fi = sideFaceAtY1(b);
    const sites = boundarySites(b, fi, HORIZONTAL);
    if (!sites.ok) throw new Error('sites');
    const r = splitFaceAlongChord(b, fi, sites.value[0], sites.value[1]);
    expect(r.ok, r.ok ? '' : JSON.stringify(r.error)).toBe(true);
    if (!r.ok) return;
    const s = r.value.shape;
    expect(loopsClosed(s)).toBe(true);
    for (const [, n] of useCounts(s)) expect(n).toBe(2);
    const report = validate(s);
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    // Two pieces, areas 2 and 2 (the square side of 2 cut at its mid-height).
    const [fa, fb] = r.value.faces;
    expect(faceArea(s, fa, [0, 1, 0])).toBeCloseTo(2, 9);
    expect(faceArea(s, fb, [0, 1, 0])).toBeCloseTo(2, 9);
    // The box still has six faces: one side split into two, the rest unchanged.
    expect(s.faces.length).toBe(b.faces.length + 1);
  });

  it('deliberate break: dropping the chord from one piece is caught by validate', () => {
    const b = must(box(SIZE));
    const fi = sideFaceAtY1(b);
    const sites = boundarySites(b, fi, HORIZONTAL);
    if (!sites.ok) throw new Error('sites');
    const r = splitFaceAlongChord(b, fi, sites.value[0], sites.value[1]);
    if (!r.ok) throw new Error('split');
    const s = r.value.shape;
    const [fa] = r.value.faces;
    const loopIndex = (s.faces[fa] as Face).loops[0] as number;
    const loop = s.loops[loopIndex] as Loop;
    // Skip the chord half of piece A: the loop no longer closes.
    const broken: Shape = {
      ...s,
      loops: s.loops.map((l, i) =>
        i === loopIndex ? { ...l, coedges: l.coedges.slice(0, -1) } : l,
      ),
    };
    expect(loop.coedges.length).toBeGreaterThan(1);
    expect(loopsClosed(broken)).toBe(false);
    expect(validate(broken).ok).toBe(false);
  });
});

function unitDiagonal(d: [number, number, number]): [number, number, number] {
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}
