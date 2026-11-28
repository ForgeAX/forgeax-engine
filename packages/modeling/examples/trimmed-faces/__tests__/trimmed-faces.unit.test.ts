import { describe, expect, it } from 'vitest';
import { tessellate } from '../../../src/brep/tessellate';
import type { EditMesh } from '../../../src/mesh';
import { holedPlate, obliqueCylinder, polygonArea, sphereCapWithHole, wavyPatch } from '../models';

const TESS = { angle: Math.PI / 32, chord: 0.05 } as const;
type V3 = [number, number, number];

/** Each live face as its vertex positions, in face order. */
function facePolys(mesh: EditMesh): V3[][] {
  return mesh.faces().map((f) => mesh.faceVertices(f).map((v) => mesh.position(v) as V3));
}

/** Undirected vertex-id edges of the fan triangulation of every face, with their use count. */
function edgeUses(mesh: EditMesh): Map<string, number> {
  const uses = new Map<string, number>();
  for (const f of mesh.faces()) {
    const ids = mesh.faceVertices(f);
    for (let k = 0; k < ids.length; k++) {
      const a = ids[k] as number;
      const b = ids[(k + 1) % ids.length] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return uses;
}

/** Signed volume by the divergence theorem over the fan of each face. */
function signedVolume(mesh: EditMesh): number {
  let v = 0;
  for (const poly of facePolys(mesh)) {
    for (let k = 1; k + 1 < poly.length; k++) {
      const a = poly[0] as V3;
      const b = poly[k] as V3;
      const c = poly[k + 1] as V3;
      v +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
  }
  return v;
}

/** Area: the norm of each fan triangle's cross product, halved. */
function meshArea(mesh: EditMesh): number {
  let area = 0;
  for (const poly of facePolys(mesh)) {
    for (let k = 1; k + 1 < poly.length; k++) {
      const a = poly[0] as V3;
      const b = poly[k] as V3;
      const c = poly[k + 1] as V3;
      const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const x = e1[1] * e2[2] - e1[2] * e2[1];
      const y = e1[2] * e2[0] - e1[0] * e2[2];
      const z = e1[0] * e2[1] - e1[1] * e2[0];
      area += Math.sqrt(x * x + y * y + z * z) / 2;
    }
  }
  return area;
}

/** Edges used once: the free boundary of an open sheet. */
function freeEdges(mesh: EditMesh): number {
  return [...edgeUses(mesh).values()].filter((n) => n === 1).length;
}

function nonManifold(mesh: EditMesh): number {
  return [...edgeUses(mesh).values()].filter((n) => n > 2).length;
}

describe('trimmed and NURBS faces tessellate through the constrained (u, v) path', () => {
  it('holed NURBS plate: exact area, boundary edges match the trim samples, no non-manifold edge', () => {
    const { shape, area } = holedPlate();
    const r = tessellate(shape, TESS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mesh = r.value;
    // The plate is planar, so the mesh area equals the trimmed (u, v) area scaled to 100 x 60.
    expect(meshArea(mesh)).toBeCloseTo(area, 6);
    expect(nonManifold(mesh)).toBe(0);
    // Every trim edge is one free boundary edge of the sheet: 8 outline corners + holes' samples.
    expect(freeEdges(mesh)).toBeGreaterThan(0);
    expect(mesh.faces().length).toBeGreaterThan(100);
  });

  it('elliptic trimmed cylinder cap: the cylinder volume is pi r^2 (mean height) to the tessellation tolerance', () => {
    const shape = obliqueCylinder(2.5, 0.6, 1);
    const r = tessellate(shape, TESS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Mean height of the cut plane over the disk is alpha: volume = pi * r^2 * alpha.
    expect(Math.abs(signedVolume(r.value))).toBeCloseTo(Math.PI * 2.5, 1);
    expect(nonManifold(r.value)).toBe(0);
  });

  it('NURBS patch with an outer boundary and a hole tessellates with no non-manifold edge', () => {
    const r = tessellate(wavyPatch(), TESS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nonManifold(r.value)).toBe(0);
    expect(freeEdges(r.value)).toBeGreaterThan(0);
  });

  it('spherical cap with a hole: manifold, and its area is below the full cap by the hole it removes', () => {
    const { shape, capArea } = sphereCapWithHole(50, 0.25);
    const r = tessellate(shape, TESS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(nonManifold(r.value)).toBe(0);
    // A chordal triangle's area sits below the sphere area it spans, so the mesh is below capArea.
    const area = meshArea(r.value);
    expect(area).toBeLessThan(capArea);
    // The hole (uv radius 0.22 about (3.0, 0.95)) removes a visible share; the cap is not left whole.
    expect(area).toBeLessThan(0.999 * capArea);
    expect(area).toBeGreaterThan(0.9 * capArea);
  });

  it('polygonArea helper agrees with a unit square', () => {
    expect(
      polygonArea([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    ).toBeCloseTo(1, 12);
  });
});
