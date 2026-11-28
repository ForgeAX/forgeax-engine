import { describe, expect, it } from 'vitest';
import { must } from '../../../examples/brep-heal/damage';
import { extrude } from '../build';
import { faceLoops } from '../faces';
import type { QuadResult } from '../quad';
import { quadrangulate } from '../quad';
import { roundRectOf } from '../quad-rrect';
import type { Shape } from '../types';

/** Rounded rectangle polygon: `n` chord segments per corner, counter-clockwise from the right side. */
function roundedRect(w: number, h: number, r: number, n: number): [number, number][] {
  const centres: [number, number][] = [
    [w / 2 - r, h / 2 - r],
    [-(w / 2 - r), h / 2 - r],
    [-(w / 2 - r), -(h / 2 - r)],
    [w / 2 - r, -(h / 2 - r)],
  ];
  const out: [number, number][] = [];
  centres.forEach(([cx, cy], k) => {
    for (let i = 0; i <= n; i++) {
      const a = (Math.PI / 2) * (k + i / n);
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  });
  return out;
}

function trianglesPerFace(shape: Shape, q: QuadResult): number[] {
  return shape.faces.map((_, f) => {
    const [a, b] = q.faceRanges[f] as [number, number];
    let t = 0;
    for (let m = a; m < b; m++) {
      if (q.mesh.isFaceAlive(m) && q.mesh.faceVertices(m).length === 3) t++;
    }
    return t;
  });
}

function mesh(profile: [number, number][], depth: number, size: number) {
  const shape = must(extrude({ profile, depth, label: 'rr' }));
  const r = quadrangulate(shape, { size, trimmed: 'quad-dominant', isoQuadric: true });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return { shape, q: r.value };
}

describe('rounded-rectangle planar caps mesh as all quads', () => {
  for (const [name, w, h, rad, n, size] of [
    ['9x10 r3, 5 segments per corner (odd arcs)', 9, 10, 3, 5, 0.35],
    ['3.6x5 r1.4, 8 segments per corner', 3.6, 5, 1.4, 8, 0.35],
    ['20x12 r4, 8 segments per corner, coarse', 20, 12, 4, 8, 0.9],
    ['6x6 r2.4, 6 segments per corner (square)', 6, 6, 2.4, 6, 0.35],
    ['7.3x11.9 r2.9, 7 segments per corner (odd, unequal sides)', 7.3, 11.9, 2.9, 7, 0.41],
  ] as const) {
    it(`${name}: caps have no triangle and the shell stays closed`, () => {
      const { shape, q } = mesh(roundedRect(w, h, rad, n), 2, size);
      const caps = shape.faces.map((_, i) => i).filter((i) => faceLoops(shape, i).outer.length > 4);
      expect(caps.length).toBe(2);
      const tri = trianglesPerFace(shape, q);
      for (const i of caps) expect(tri[i]).toBe(0);
      expect(q.report.openEdges).toBe(0);
      expect(q.report.nonManifoldEdges).toBe(0);
      expect(q.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.25);
    });
  }
});

describe('rounded-rectangle detection', () => {
  /** First face whose outer loop has exactly `edges` coedges. */
  function faceWith(shape: Shape, edges: number): number {
    return shape.faces.findIndex((_, i) => faceLoops(shape, i).outer.length === edges);
  }
  const prism = (profile: [number, number][]) => must(extrude({ profile, depth: 1, label: 'p' }));

  it('accepts a rounded rectangle cap', () => {
    const shape = prism(roundedRect(6, 4, 1, 4));
    expect(roundRectOf(shape, faceWith(shape, 20))).toBeDefined();
  });

  it('rejects a rectangle and an L, which have no corner runs', () => {
    const box = prism([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
    expect(roundRectOf(box, faceWith(box, 4))).toBeUndefined();
    const ell = prism([
      [0, 0],
      [6, 0],
      [6, 2],
      [2, 2],
      [2, 6],
      [0, 6],
    ]);
    expect(roundRectOf(ell, faceWith(ell, 6))).toBeUndefined();
  });
});
