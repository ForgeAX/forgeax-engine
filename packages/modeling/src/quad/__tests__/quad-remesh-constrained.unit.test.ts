import { describe, expect, it } from 'vitest';
import { EditMesh } from '../../mesh';
import { constraintSegments, type FeatureConstraint, featureDeviation } from '../features';
import { quadRemesh } from '../remesh';

/** Two triangles over a unit square whose far corners lift by h: the diagonal bends, so only a constraint keeps it. */
function featuredSquare(h: number): { mesh: EditMesh; diagonal: FeatureConstraint['polyline'] } {
  const mesh = new EditMesh();
  const a = mesh.addVertex(0, 0, 0);
  const b = mesh.addVertex(1, 0, h);
  const c = mesh.addVertex(1, 1, 0);
  const d = mesh.addVertex(0, 1, h);
  mesh.addFace([a, b, c]);
  mesh.addFace([a, c, d]);
  return {
    mesh,
    diagonal: [
      [0, 0, 0],
      [1, 1, 0],
    ],
  };
}

describe('quadRemesh constrained vs unconstrained on a featured mesh', () => {
  it('reports residual triangles on the output report', () => {
    const { mesh } = featuredSquare(0.0185);
    const r = quadRemesh(mesh, mesh.faces(), { constraints: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.residualTriangles).toBe(0);
  });

  it('keeps the crease within tolerance when the constraint names it', () => {
    const { mesh, diagonal } = featuredSquare(0.0185);
    const r = quadRemesh(mesh, mesh.faces(), {
      constraints: [{ id: 'crease', polyline: diagonal, tolerance: 1e-3 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.featureDeviation.byConstraint.crease as number).toBeLessThan(1e-3);
  });

  it('drops the constraint: the unconstrained output drifts off the crease (falsifier)', () => {
    const { mesh, diagonal } = featuredSquare(0.0185);
    const free = quadRemesh(mesh, mesh.faces(), { constraints: [] });
    expect(free.ok).toBe(true);
    if (!free.ok) return;
    const drift = featureDeviation(
      free.value.mesh,
      constraintSegments([{ id: 'crease', polyline: diagonal, tolerance: 1e-3 }]),
    );
    expect(drift.unresolved).toEqual(['crease']);
  });

  it('fails closed with model-partial and a reason when the constraint is off the selected faces', () => {
    const { mesh } = featuredSquare(0.0185);
    const first = mesh.faces()[0] as number;
    const r = quadRemesh(mesh, [first], {
      constraints: [
        {
          id: 'other-half',
          polyline: [
            [1, 1, 0],
            [0, 1, 0.0185],
          ],
          tolerance: 1e-6,
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
    expect(r.error.detail?.reason).toBe('feature-outside-selection');
  });

  it('fails closed with a feature-off-mesh reason when the polyline misses the mesh', () => {
    const { mesh } = featuredSquare(0.0185);
    const r = quadRemesh(mesh, mesh.faces(), {
      constraints: [
        {
          id: 'floating',
          polyline: [
            [5, 5, 5],
            [6, 5, 5],
          ],
          tolerance: 1e-3,
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.detail?.reason).toBe('feature-off-mesh');
  });
});

function grid2x2(): EditMesh {
  const mesh = new EditMesh();
  const id: number[][] = [];
  for (let i = 0; i < 3; i++) {
    id.push([]);
    for (let j = 0; j < 3; j++) id[i]?.push(mesh.addVertex(i, j, 0));
  }
  const at = (i: number, j: number) => id[i]?.[j] as number;
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++)
      mesh.addFace([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  return mesh;
}

describe('quadRemesh residual provenance', () => {
  it('does not count input quads as residual triangles (all-quad 2x2 grid reports 0)', () => {
    const mesh = grid2x2();
    const r = quadRemesh(mesh, mesh.faces());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.residualTriangles).toBe(0);
    expect(r.value.provenance.filter((p) => p.kind === 'residual')).toEqual([]);
    expect(r.value.provenance.filter((p) => p.kind === 'passthrough')).toHaveLength(4);
  });

  it('counts only unpaired triangles: a quad plus a paired triangle couple reports 0', () => {
    const mesh = new EditMesh();
    const a = mesh.addVertex(0, 0, 0);
    const b = mesh.addVertex(1, 0, 0);
    const c = mesh.addVertex(1, 1, 0);
    const d = mesh.addVertex(0, 1, 0);
    const e = mesh.addVertex(2, 0, 0);
    const f = mesh.addVertex(2, 1, 0);
    mesh.addFace([a, b, c, d]);
    mesh.addFace([b, e, f]);
    mesh.addFace([b, f, c]);
    const r = quadRemesh(mesh, mesh.faces());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.residualTriangles).toBe(0);
    expect(r.value.provenance.filter((p) => p.kind === 'passthrough')).toHaveLength(1);
  });

  it('still counts a lone triangle as residual', () => {
    const mesh = new EditMesh();
    mesh.addFace([mesh.addVertex(0, 0, 0), mesh.addVertex(1, 0, 0), mesh.addVertex(0, 1, 0)]);
    const r = quadRemesh(mesh, mesh.faces());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report.residualTriangles).toBe(1);
  });
});

describe('quadRemesh unresolved reason is decided against the input surface', () => {
  it('a polyline lying on an input edge is not feature-off-mesh even when the output drops that edge', () => {
    const { mesh } = featuredSquare(0);
    const r = quadRemesh(mesh, mesh.faces(), {
      constraints: [
        {
          id: 'half',
          polyline: [
            [0, 0, 0],
            [0.5, 0.5, 0],
          ],
          tolerance: 1e-3,
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-partial');
    expect(r.error.detail?.reason).not.toBe('feature-off-mesh');
  });
});
