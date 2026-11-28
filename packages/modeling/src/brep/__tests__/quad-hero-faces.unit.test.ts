import { describe, expect, it } from 'vitest';
import { boltPlate, moduleSlot, triggerBlade } from '../../../examples/qf-m6d/cases';
import { faceLoops } from '../faces';
import { type QuadResult, quadrangulate } from '../quad';
import { hexEdges } from '../quad-hex';
import { roundRectOf } from '../quad-rrect';
import type { Shape } from '../types';

function mesh(shape: Shape): QuadResult {
  const r = quadrangulate(shape, { size: 0.35, trimmed: 'quad-dominant', isoQuadric: true });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function triangles(q: QuadResult, faces: readonly number[]): number {
  let t = 0;
  for (const f of faces) {
    const [a, b] = q.faceRanges[f] as [number, number];
    for (let m = a; m < b; m++)
      if (q.mesh.isFaceAlive(m) && q.mesh.faceVertices(m).length === 3) t++;
  }
  return t;
}

describe('arc-cornered quadrilateral faces (tapered trigger blade)', () => {
  const shape = triggerBlade();
  const faces = shape.faces.map((_, f) => f).filter((f) => faceLoops(shape, f).outer.length === 8);

  it('are detected as rounded rectangles with four sides and four arc corners', () => {
    expect(faces.length).toBe(2);
    for (const f of faces) {
      const rr = roundRectOf(shape, f);
      expect(rr?.sides.length).toBe(4);
      expect(rr?.corners.length).toBe(4);
    }
  });

  it('mesh as all quads and the shell stays closed', () => {
    const q = mesh(shape);
    expect(triangles(q, faces)).toBe(0);
    expect(q.report.triangles).toBe(0);
    expect(q.report.openEdges).toBe(0);
    expect(q.report.nonManifoldEdges).toBe(0);
    expect(q.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.15);
  });
});

describe('notched rectilinear and hexagonal slot faces (module slot)', () => {
  const shape = moduleSlot();
  const hexes = shape.faces.map((_, f) => f).filter((f) => hexEdges(shape, f) !== undefined);

  it('finds the two hexagonal flanks and no rectilinear face', () => {
    expect(hexes.length).toBe(2);
    for (const f of hexes) expect(faceLoops(shape, f).outer.length).toBe(6);
  });

  it('mesh without a triangle, notched face included, and stay closed', () => {
    const q = mesh(shape);
    expect(q.report.triangles).toBe(0);
    expect(q.report.openEdges).toBe(0);
    expect(q.report.nonManifoldEdges).toBe(0);
    expect(q.report.scaledJacobian.min).toBeGreaterThanOrEqual(0.1);
  });
});

describe('faces outside the new layouts keep their route', () => {
  it('the bolt plate (holed side panel) still meshes and stays closed', () => {
    const q = mesh(boltPlate());
    expect(q.report.openEdges).toBe(0);
    expect(q.report.nonManifoldEdges).toBe(0);
  });
});
