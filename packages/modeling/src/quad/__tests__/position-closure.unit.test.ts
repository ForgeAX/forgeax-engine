import { describe, expect, it } from 'vitest';
import { matchPosition } from '../field';
import { instantMeshesField } from '../instant-meshes';
import type { TriMesh } from '../trimesh';

// Closure: around every triangle the lattice offsets of its three edges must sum to zero.
// A non-zero sum means the rounded position lattice is not phase-consistent across the edge chain.
function cylinder(n: number, rows: number): TriMesh {
  const pos: number[] = [];
  const tri: number[] = [];
  for (let r = 0; r <= rows; r++)
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      pos.push(Math.cos(a), Math.sin(a), (r / rows) * 2);
    }
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < n; k++) {
      const a = r * n + k;
      const b = r * n + ((k + 1) % n);
      const c = a + n;
      const d = b + n;
      tri.push(a, b, d, a, d, c);
    }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tri) };
}

function solveCylinder(): ReturnType<typeof instantMeshesField> & { ok: true } {
  const solved = instantMeshesField(cylinder(24, 8));
  if (!solved.ok) throw new Error('position field solve failed');
  return solved as ReturnType<typeof instantMeshesField> & { ok: true };
}

describe('position lattice closure', () => {
  it('cylinder 24x8 has at most the ratcheted count of inconsistent triangles', () => {
    // Ratchet: lower this bound when the position solve closes more triangles. Was 22 before the canonical edge order.
    const tri = cylinder(24, 8);
    const field = solveCylinder().value.field;
    let bad = 0;
    for (let t = 0; t < tri.triangles.length / 3; t++) {
      const v = [
        tri.triangles[3 * t],
        tri.triangles[3 * t + 1],
        tri.triangles[3 * t + 2],
      ] as number[];
      let sx = 0;
      let sy = 0;
      for (let k = 0; k < 3; k++) {
        const m = matchPosition(field, v[k] as number, v[(k + 1) % 3] as number);
        sx += m.offset[0];
        sy += m.offset[1];
      }
      if (sx !== 0 || sy !== 0) bad++;
    }
    expect(bad).toBeLessThanOrEqual(15);
  });

  it('matchPosition is antisymmetric on every directed cylinder edge', () => {
    const tri = cylinder(24, 8);
    const field = solveCylinder().value.field;
    let violations = 0;
    for (let t = 0; t < tri.triangles.length / 3; t++)
      for (let k = 0; k < 3; k++) {
        const i = tri.triangles[3 * t + k] as number;
        const j = tri.triangles[3 * t + ((k + 1) % 3)] as number;
        const a = matchPosition(field, i, j);
        const b = matchPosition(field, j, i);
        if (a.offset[0] !== -b.offset[0] || a.offset[1] !== -b.offset[1]) violations++;
      }
    expect(violations).toBe(0);
  });
});
