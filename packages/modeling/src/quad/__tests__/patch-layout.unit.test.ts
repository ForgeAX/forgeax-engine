import { describe, expect, it } from 'vitest';
import { layoutPatches } from '../patch-layout';
import type { TriMesh } from '../trimesh';

/** Closed cylinder: n-segment tube plus two triangle-fan caps. */
function cylinder(n: number): TriMesh {
  const pos: number[] = [];
  const tri: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pos.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 1);
  }
  const bottomC = 2 * n;
  const topC = 2 * n + 1;
  pos.push(0, 0, 0, 0, 0, 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1);
    tri.push(bottomC, 2 * j, 2 * i);
    tri.push(topC, 2 * i + 1, 2 * j + 1);
  }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tri) };
}

describe('feature-bounded patch layout', () => {
  it('cylinder splits into side and two caps with every feature edge on a boundary', () => {
    const layout = layoutPatches(cylinder(24));
    expect(layout.patchCount).toBe(3);
    expect(layout.featureEdges.length).toBe(48);
    expect(layout.featureCoverage).toBe(1);
  });

  it('a flat grid has no features and one patch (falsifier: a cut on smooth area would split it)', () => {
    const flat: TriMesh = {
      positions: Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    };
    const layout = layoutPatches(flat);
    expect(layout.featureEdges.length).toBe(0);
    expect(layout.patchCount).toBe(1);
  });
});
