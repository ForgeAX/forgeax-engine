import { describe, expect, it } from 'vitest';
import { matchPosition } from '../field';
import { instantMeshesField } from '../instant-meshes';
import type { TriMesh } from '../trimesh';

function grid(n: number, spacing = 1): TriMesh {
  const positions = new Float64Array(3 * (n + 1) * (n + 1));
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) {
      const v = y * (n + 1) + x;
      positions[3 * v] = x * spacing;
      positions[3 * v + 1] = y * spacing;
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

/** Mean squared lattice disagreement over all mesh edges, the solver's objective. */
function meanEdgeError(mesh: TriMesh, field: ReturnType<typeof unwrap>): number {
  let sum = 0;
  let count = 0;
  const seen = new Set<string>();
  for (let t = 0; t < mesh.triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = mesh.triangles[t + k] as number;
      const b = mesh.triangles[t + ((k + 1) % 3)] as number;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sum += matchPosition(field, a, b).error;
      count++;
    }
  return sum / count;
}

function unwrap(r: ReturnType<typeof instantMeshesField>) {
  if (!r.ok) throw new Error(`instantMeshesField failed: ${r.error.code}`);
  return r.value.field;
}

describe('instantMeshesField', () => {
  it('returns a PositionField with one origin per vertex on a flat grid', () => {
    const mesh = grid(4);
    const r = instantMeshesField(mesh, { iterations: 6 });
    expect(r.ok).toBe(true);
    const field = unwrap(r);
    expect(field.origin.length).toBe(mesh.positions.length);
    expect(field.vertexSource.length).toBe(mesh.positions.length / 3);
    expect(field.scale).toBeGreaterThan(0);
  });

  it('keeps neighbouring lattices in agreement after the solve', () => {
    const mesh = grid(5);
    const field = unwrap(instantMeshesField(mesh, { iterations: 6 }));
    const err = meanEdgeError(mesh, field);
    // On a flat grid with spacing equal to the target scale, the solve should lock lattices together.
    expect(Number.isFinite(err)).toBe(true);
    expect(err).toBeLessThan(field.scale * field.scale);
  });

  it('rejects a non-positive scale with a structured error', () => {
    const r = instantMeshesField(grid(2), { scale: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });

  it('falsifier: zero iterations leave origins at the vertex positions', () => {
    const mesh = grid(3);
    const field = unwrap(instantMeshesField(mesh, { iterations: 0 }));
    for (let i = 0; i < mesh.positions.length; i++) expect(field.origin[i]).toBe(mesh.positions[i]);
  });
});
