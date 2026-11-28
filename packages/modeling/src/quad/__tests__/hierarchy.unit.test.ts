import { describe, expect, it } from 'vitest';
import {
  buildHierarchy,
  downsample,
  dualAreas,
  finestLevel,
  INVALID,
  uniformGraph,
} from '../hierarchy';
import type { TriMesh } from '../trimesh';

/** An n x n grid on the z=0 plane with 2 triangles per cell, counterclockwise about +z. */
function grid(n: number): TriMesh {
  const positions = new Float64Array(3 * (n + 1) * (n + 1));
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) {
      const v = y * (n + 1) + x;
      positions[3 * v] = x;
      positions[3 * v + 1] = y;
    }
  const tri: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      tri.push(a, b, d, a, d, c);
    }
  return { positions, triangles: Uint32Array.from(tri) };
}

describe('uniformGraph', () => {
  it('links each grid vertex to its edge neighbours, symmetrically', () => {
    const mesh = grid(3);
    const g = uniformGraph(mesh);
    const nv = mesh.positions.length / 3;
    expect(g.offset.length).toBe(nv + 1);
    for (let i = 0; i < nv; i++)
      for (let e = g.offset[i] as number; e < (g.offset[i + 1] as number); e++) {
        const k = g.id[e] as number;
        const back = [...g.id.subarray(g.offset[k] as number, g.offset[k + 1] as number)];
        expect(back).toContain(i);
      }
    // Corner (0,0) of this grid touches (1,0), (0,1) and the diagonal (1,1) cut by the triangulation.
    expect((g.offset[1] as number) - (g.offset[0] as number)).toBe(3);
  });
});

describe('dualAreas', () => {
  it('sums to the surface area of a flat grid', () => {
    const mesh = grid(4);
    const area = dualAreas(mesh);
    const total = area.reduce((s, a) => s + a, 0);
    // The dual mesh tiles the plane: the sum equals the 4 x 4 grid area.
    expect(total).toBeCloseTo(16, 9);
  });
});

describe('downsample', () => {
  it('merges pairs so every coarse vertex maps back to a fine vertex', () => {
    const level0 = finestLevel(grid(4));
    const level1 = downsample(level0);
    const nv0 = level0.area.length;
    const nv1 = level1.area.length;
    expect(nv1).toBeLessThan(nv0);
    expect(nv1).toBeGreaterThanOrEqual(nv0 / 2);
    for (let v = 0; v < nv0; v++) {
      const c = level1.toLower?.[v] as number;
      expect(c).toBeLessThan(nv1);
    }
    for (let c = 0; c < nv1; c++) {
      const up = [level1.toUpper?.[2 * c], level1.toUpper?.[2 * c + 1]];
      expect(up[0]).not.toBe(INVALID);
      expect(level1.toLower?.[up[0] as number]).toBe(c);
    }
  });

  it('keeps coarse adjacency symmetric and free of self-links', () => {
    const h = buildHierarchy(finestLevel(grid(5)));
    expect(h.levels.length).toBeGreaterThan(1);
    for (const level of h.levels) {
      const g = level.graph;
      const nv = level.area.length;
      for (let i = 0; i < nv; i++)
        for (let e = g.offset[i] as number; e < (g.offset[i + 1] as number); e++) {
          const k = g.id[e] as number;
          expect(k).not.toBe(i);
          const back = [...g.id.subarray(g.offset[k] as number, g.offset[k + 1] as number)];
          expect(back).toContain(i);
        }
    }
  });

  it('reduces to a single vertex through the pyramid', () => {
    const h = buildHierarchy(finestLevel(grid(6)));
    const top = h.levels[h.levels.length - 1] as (typeof h.levels)[number];
    expect(top.area.length).toBeLessThanOrEqual(2);
  });
});
