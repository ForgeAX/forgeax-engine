import { describe, expect, it } from 'vitest';
import { buildHierarchy, finestLevel } from '../hierarchy';
import { coordinateSystem, solveOrientation } from '../orientation-field';
import type { TriMesh } from '../trimesh';

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

/** Absolute dot between direction i and the unit axis (ax, ay, az) on a flat grid. */
function alignment(Q: Float64Array, i: number, axis: [number, number, number]): number {
  return Math.abs(
    (Q[3 * i] as number) * axis[0] +
      (Q[3 * i + 1] as number) * axis[1] +
      (Q[3 * i + 2] as number) * axis[2],
  );
}

describe('coordinateSystem', () => {
  it('returns an orthonormal tangent pair for a normal', () => {
    for (const n of [
      [0, 0, 1],
      [1, 0, 0],
      [0.6, 0.0, -0.8],
    ] as const) {
      const [s, t] = coordinateSystem([n[0], n[1], n[2]]);
      const dot = (a: readonly number[], b: readonly number[]) =>
        (a[0] as number) * (b[0] as number) +
        (a[1] as number) * (b[1] as number) +
        (a[2] as number) * (b[2] as number);
      expect(dot(s, n)).toBeCloseTo(0, 9);
      expect(dot(t, n)).toBeCloseTo(0, 9);
      expect(dot(s, t)).toBeCloseTo(0, 9);
      expect(dot(s, s)).toBeCloseTo(1, 9);
    }
  });
});

describe('solveOrientation', () => {
  it('aligns all directions on a flat plane (unconstrained)', () => {
    const h = buildHierarchy(finestLevel(grid(6)));
    const r = solveOrientation(h, { iterations: 6 });
    const nv = r.direction.length / 3;
    // A flat plane has one smooth 4-RoSy solution: every vertex's direction is one of the four
    // rotations of a common axis, so |dot| with x or y is 1 for every vertex.
    let aligned = 0;
    for (let i = 0; i < nv; i++) {
      const ax = alignment(r.direction, i, [1, 0, 0]);
      const ay = alignment(r.direction, i, [0, 1, 0]);
      if (Math.max(ax, ay) > 0.99) aligned++;
    }
    expect(aligned / nv).toBeGreaterThan(0.95);
  });

  it('falsifier: a constraint steers the field toward the constrained axis', () => {
    const mesh = grid(6);
    const h = buildHierarchy(finestLevel(mesh));
    const nv = mesh.positions.length / 3;
    const direction = new Float64Array(3 * nv);
    const weight = new Float64Array(nv);
    for (let i = 0; i < nv; i++) {
      direction[3 * i] = 1;
      weight[i] = 1;
    }
    const constrained = solveOrientation(h, {
      iterations: 6,
      constraint: { direction, weight },
    });
    let mean = 0;
    for (let i = 0; i < nv; i++) mean += alignment(constrained.direction, i, [1, 0, 0]);
    // The +X constraint pins the field to the x axis; without it the solution is symmetric.
    expect(mean / nv).toBeGreaterThan(0.99);
  });
});
