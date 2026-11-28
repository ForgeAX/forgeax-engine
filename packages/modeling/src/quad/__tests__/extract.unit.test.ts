import { describe, expect, it } from 'vitest';
import { extractQuads } from '../extract';
import { finestLevel } from '../hierarchy';
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

function run(mesh: TriMesh, pureQuad: boolean) {
  const solved = instantMeshesField(mesh, { iterations: 12 });
  if (!solved.ok) throw new Error(`field failed: ${solved.error.code}`);
  const graph = finestLevel(mesh).graph;
  return extractQuads(solved.value.field, graph, { pureQuad, removeSpurious: false });
}

/** Share of face tuples whose four vertex ids are distinct; a degenerate tuple is not a quad. */
function quadRatio(quads: Uint32Array): number {
  let good = 0;
  const n = quads.length / 4;
  for (let q = 0; q < quads.length; q += 4) {
    const v = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]];
    if (new Set(v).size === 4) good++;
  }
  return n === 0 ? 0 : good / n;
}

describe('extractQuads', () => {
  it('emits quads that index valid vertices on a flat grid', () => {
    const out = run(grid(24), false);
    const nv = out.positions.length / 3;
    expect(out.quads.length).toBeGreaterThan(0);
    expect(out.quads.length % 4).toBe(0);
    for (const v of out.quads) expect(v).toBeLessThan(nv);
  });

  it('flat grid traces only four-sided faces (diagonal offsets are not quad links)', () => {
    const out = run(grid(24), false);
    expect(out.split).toBeLessThan(out.traced / 20);
    expect(quadRatio(out.quads)).toBe(1);
    expect(out.quads.length / 4).toBeGreaterThan(400);
  });

  it('pure-quad output has four-sided faces only and four children per quad', () => {
    const base = run(grid(24), false);
    const pure = run(grid(24), true);
    expect(pure.quads.length % 4).toBe(0);
    expect(pure.quads.length).toBe(4 * (base.quads.length / 4) * 4);
  });

  it('falsifier: pure-quad subdivision changes the face count, so the flag is not a no-op', () => {
    const base = run(grid(24), false);
    const pure = run(grid(24), true);
    expect(pure.quads.length).not.toBe(base.quads.length);
  });

  it('pure-quad ratio is 1 on the flat grid, and a broken subdivision turns it red', () => {
    const pure = run(grid(24), true);
    expect(quadRatio(pure.quads)).toBe(1);
    // Mutant: collapse one face to a triangle by repeating a vertex, as a broken split would.
    const broken = Uint32Array.from(pure.quads);
    broken[3] = broken[0] as number;
    expect(quadRatio(broken)).toBeLessThan(1);
  });
});
