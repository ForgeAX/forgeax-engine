import { describe, expect, it } from 'vitest';
import {
  bracket,
  brepSphere,
  brepTorus,
  chamferBox,
  flangedTee,
  lumpy,
} from '../../../examples/quad-field/models';
import { type CrossFieldOptions, crossField } from '../cross-field';
import { conjugateGradient, Triplets } from '../sparse';
import { type TriMesh, triTopology } from '../trimesh';

function solve(mesh: TriMesh, options: CrossFieldOptions = {}) {
  const r = crossField(mesh, options);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function code(mesh: TriMesh, options: CrossFieldOptions = {}) {
  const r = crossField(mesh, options);
  return r.ok ? 'ok' : [r.error.code, (r.error.detail as { reason?: string } | undefined)?.reason];
}

const tetra = (): TriMesh => ({
  positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  triangles: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
});

describe('crossField index theorem', () => {
  it('sphere: eight +1 quarter-turn singularities, sum 4 chi = 8', () => {
    const { field, report } = solve(brepSphere());
    expect(report.chi).toBe(2);
    expect(report.indexSum).toBe(8);
    expect(field.singularities.map((s) => s.index)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(report.indexRounding).toBeLessThan(1e-9);
  });

  it('torus: index sum 0; curvature alignment gives no singularities', () => {
    const smooth = solve(brepTorus());
    expect(smooth.report.chi).toBe(0);
    expect(smooth.report.indexSum).toBe(0);
    const aligned = solve(brepTorus(), { curvatureAlignment: 1 });
    expect(aligned.report.solves.map((s) => s.kind)).toEqual(['aligned']);
    expect(aligned.field.singularities).toEqual([]);
  });

  it('pure smoothest field on the r/R = 0.3 torus prefers singularities (paper behavior, not a bug)', () => {
    // The parallel-aligned singularity-free field costs about 3x this energy (measured 294 vs 99).
    const smooth = solve(brepTorus());
    expect(smooth.field.singularities.length).toBe(12);
  });

  it.each([
    ['lumpy', lumpy],
    ['chamferBox', chamferBox],
    ['bracket', bracket],
    ['flangedTee', flangedTee],
  ] as const)('%s: index sum is 4 chi', (_name, make) => {
    const { field, report } = solve(make());
    expect(report.indexSum).toBe(4 * (report.chi as number));
    expect(field.singularities.reduce((s, x) => s + x.index, 0)).toBe(report.indexSum);
  });
});

describe('crossField feature alignment', () => {
  it.each([
    ['chamferBox', chamferBox],
    ['bracket', bracket],
    ['flangedTee', flangedTee],
  ] as const)('%s: feature angle error <= 1e-9 rad, and dropping constraints raises it', (_n, make) => {
    const mesh = make();
    const held = solve(mesh);
    expect(held.report.featureAngleError.samples).toBeGreaterThan(0);
    expect(held.report.featureAngleError.max).toBeLessThanOrEqual(1e-9);
    const free = solve(mesh, { constrain: false });
    expect(free.report.constrainedTriangles).toBe(0);
    expect(free.report.featureAngleError.max).toBeGreaterThan(1e-3);
  });

  it('splits corner triangles whose feature edges disagree, keeping the original features', () => {
    const { field, report } = solve(tetra());
    expect(report.splitTriangles).toBe(4);
    expect(report.featureEdges).toBe(6);
    expect(field.mesh.triangles.length / 3).toBe(12);
    expect(report.featureAngleError.max).toBeLessThanOrEqual(1e-9);
    expect(report.indexSum).toBe(8);
  });

  it('directions are unit and tangent', () => {
    const { field } = solve(bracket());
    for (let t = 0; t < field.direction.length / 3; t++) {
      let dd = 0;
      let dn = 0;
      for (let k = 0; k < 3; k++) {
        const d = field.direction[3 * t + k] as number;
        dd += d * d;
        dn += d * (field.normal[3 * t + k] as number);
      }
      expect(Math.abs(dd - 1)).toBeLessThan(1e-12);
      expect(Math.abs(dn)).toBeLessThan(1e-12);
    }
  });

  it('is deterministic', () => {
    const a = solve(brepSphere());
    const b = solve(brepSphere());
    expect(Array.from(a.field.direction)).toEqual(Array.from(b.field.direction));
  });
});

describe('crossField fails closed', () => {
  it('rejects bad inputs with structured reasons', () => {
    const t = tetra();
    const nan = { ...t, positions: Float64Array.from(t.positions) };
    nan.positions[4] = Number.NaN;
    expect(code(nan)).toEqual(['model-invalid-argument', 'non-finite']);
    const flat = { ...t, positions: Float64Array.from(t.positions) };
    flat.positions.set([0.5, 0.5, 0], 9);
    flat.positions.set([0.5, 0.5, 0], 6);
    expect(code(flat)).toEqual(['model-degenerate', 'degenerate-triangle']);
    const twice = { ...t, triangles: new Uint32Array([...t.triangles, 0, 2, 1]) };
    expect(code(twice)).toEqual(['model-precondition', 'non-manifold-edge']);
    const far = { ...t, positions: t.positions.map((x) => x + 1e7) };
    expect(code(far)).toEqual(['model-invalid-argument', 'out-of-range']);
    expect(code(t, { edges: [[0, 9]] })).toEqual([
      'model-invalid-argument',
      'unknown-feature-edge',
    ]);
    expect(code(t, { curvatureAlignment: 0 })).toEqual([
      'model-invalid-argument',
      'bad-curvature-alignment',
    ]);
    expect(code(t, { sharpDegrees: 200 })).toEqual(['model-invalid-argument', 'bad-sharp-degrees']);
  });

  it('topology: Euler characteristic and closedness', () => {
    const topo = triTopology(tetra());
    expect(topo.ok && topo.value.chi).toBe(2);
    expect(topo.ok && topo.value.closed).toBe(true);
  });
});

describe('conjugateGradient', () => {
  it('solves an SPD system to the requested residual', () => {
    const n = 50;
    const a = new Triplets(n);
    for (let i = 0; i < n; i++) {
      a.add(i, i, 2.5);
      if (i > 0) a.add(i, i - 1, -1);
      if (i + 1 < n) a.add(i, i + 1, -1);
    }
    const b = Float64Array.from({ length: n }, (_, i) => (i % 7) - 3);
    const r = conjugateGradient(a.build(), b, { tolerance: 1e-13 });
    expect(r.ok && r.value.residual).toBeLessThanOrEqual(1e-11);
  });

  it('fails closed on an indefinite system', () => {
    const a = new Triplets(2);
    a.add(0, 0, 1);
    a.add(0, 1, 3);
    a.add(1, 0, 3);
    a.add(1, 1, 1);
    const r = conjugateGradient(a.build(), new Float64Array([1, 0]));
    expect(!r.ok && r.error.code).toBe('model-solver-diverged');
  });
});
