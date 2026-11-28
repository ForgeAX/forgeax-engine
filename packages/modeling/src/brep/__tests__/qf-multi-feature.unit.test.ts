import { describe, expect, it } from 'vitest';
import { buildAssembly } from '../../../examples/qf-curved-baseline/multi-feature';

describe('multi-feature assembly in iso mode', () => {
  const built = buildAssembly();
  it('lays out a cylinder, torus, sphere, cone and planar holed face together', () => {
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.rows.map((r) => r.surface).sort()).toEqual([
      'cone',
      'cylinder',
      'plane',
      'sphere',
      'torus',
    ]);
    for (const r of built.value.rows) {
      expect(r.openEdges).toBe(0);
      expect(r.nonManifoldEdges).toBe(0);
    }
  });

  it('holds every hole, planar included, to an orthogonal quad row and keeps triangles to the poles', () => {
    if (!built.ok) throw new Error('assembly failed');
    expect(built.value.rows.filter((r) => r.surface !== 'plane').length).toBe(4);
    for (const r of built.value.rows) {
      expect(r.boundary.rowOnly).toBe(1);
      expect(r.boundary.coverage).toBe(1);
      expect(r.minSj).toBeGreaterThanOrEqual(0.3);
      expect(r.triangles > 0).toBe(r.surface === 'sphere' || r.surface === 'cone');
    }
  });

  it('reports unified numbers that are the sums and extremes of the parts', () => {
    if (!built.ok) throw new Error('assembly failed');
    const { rows, unified } = built.value;
    expect(unified.quads).toBe(rows.reduce((n, r) => n + r.quads, 0));
    expect(unified.minSj).toBe(Math.min(...rows.map((r) => r.minSj)));
    expect(unified.aspectMax).toBe(Math.max(...rows.map((r) => r.shape.aspectMax)));
    expect(unified.rowOnlyMin).toBe(Math.min(...rows.map((r) => r.boundary.rowOnly)));
    expect(built.value.meshes.length).toBe(5);
  });
});
