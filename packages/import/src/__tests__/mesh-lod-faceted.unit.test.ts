import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { generateMeshLods } from '../mesh-lod-generator.js';

const guid = (index: number) => {
  const parsed = AssetGuid.parse(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

/** UV sphere of 2 * rows * (rows - 1) triangles; the northern half is material section 1. */
function sphere(rows: number, faceted: boolean): MeshAsset {
  const cols = rows * 2;
  const grid: number[][] = [];
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++) {
      const theta = (r / rows) * Math.PI;
      const phi = (c / cols) * 2 * Math.PI;
      grid.push([
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ]);
    }
  const sections: number[][][] = [[], []];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + 1;
      const d = a + cols + 1;
      const e = d + 1;
      const half = r < rows / 2 ? 1 : 0;
      if (r > 0) sections[half]?.push([a, d, b]);
      if (r < rows - 1) sections[half]?.push([b, d, e]);
    }
  const position: number[] = [];
  const normal: number[] = [];
  const uv0: number[] = [];
  const indices: number[] = [];
  const base = new Map<number, number>();
  const submeshes: MeshAsset['submeshes'][number][] = [];
  for (const [slot, triangles] of sections.entries()) {
    submeshes.push({
      indexOffset: indices.length,
      indexCount: triangles.length * 3,
      vertexCount: 0,
      topology: 'triangle-list',
      materialSlot: slot,
    });
    for (const triangle of triangles)
      for (const vertex of triangle) {
        // Faceted: every corner owns its vertex and the face normal, like a flat-shaded export.
        let id = faceted ? undefined : base.get(vertex);
        if (id === undefined) {
          id = position.length / 3;
          const p = grid[vertex] as number[];
          const [a, b, c] = triangle.map((v) => grid[v] as number[]) as [
            number[],
            number[],
            number[],
          ];
          const u = [
            (b[0] as number) - (a[0] as number),
            (b[1] as number) - (a[1] as number),
            (b[2] as number) - (a[2] as number),
          ];
          const w = [
            (c[0] as number) - (a[0] as number),
            (c[1] as number) - (a[1] as number),
            (c[2] as number) - (a[2] as number),
          ];
          const n = [
            (u[1] as number) * (w[2] as number) - (u[2] as number) * (w[1] as number),
            (u[2] as number) * (w[0] as number) - (u[0] as number) * (w[2] as number),
            (u[0] as number) * (w[1] as number) - (u[1] as number) * (w[0] as number),
          ];
          const length = Math.hypot(...n) || 1;
          position.push(...p);
          normal.push(...(faceted ? n.map((x) => x / length) : p));
          uv0.push(p[0] as number, p[2] as number);
          base.set(vertex, id);
        }
        indices.push(id);
      }
  }
  const count = position.length / 3;
  const attributes = {
    position: new Float32Array(position),
    normal: new Float32Array(normal),
    uv0: new Float32Array(uv0),
  };
  return {
    kind: 'mesh',
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    indices: Uint32Array.from(indices),
    aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    submeshes: submeshes.map((section) => ({ ...section, vertexCount: count })),
    materialSlots: [{ name: 'south' }, { name: 'north' }],
  } as unknown as MeshAsset;
}

const edges = (mesh: MeshAsset) => {
  const positions = mesh.attributes.position as Float32Array;
  const classes = new Map<string, number>();
  const weld = Array.from({ length: positions.length / 3 }, (_, v) => {
    const key = [0, 1, 2].map((k) => positions[v * 3 + k]).join(',');
    if (!classes.has(key)) classes.set(key, classes.size);
    return classes.get(key) as number;
  });
  const uses = new Map<string, number>();
  const indices = mesh.indices as ArrayLike<number>;
  for (let i = 0; i < indices.length; i += 3)
    for (let e = 0; e < 3; e++) {
      const a = weld[indices[i + e] as number] as number;
      const b = weld[indices[i + ((e + 1) % 3)] as number] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  const counts = [...uses.values()];
  return {
    nonManifold: counts.filter((n) => n > 2).length,
    open: counts.filter((n) => n === 1).length,
  };
};

describe('Mesh LOD generation on attribute-split surfaces', () => {
  const levels = [
    { mesh: guid(1), screenCoverage: 0.5, triangleRatio: 0.5 },
    { mesh: guid(2), screenCoverage: 0.2, triangleRatio: 0.25 },
  ];

  for (const faceted of [true, false])
    it(`reduces a ${faceted ? 'flat-shaded' : 'smooth'} two-section sphere to each requested count`, async () => {
      const source = sphere(16, faceted);
      const triangles = (source.indices?.length ?? 0) / 3;
      const result = (await generateMeshLods(source, { levels, maxError: 1 })).unwrap();
      expect(edges(source).nonManifold).toBe(0);
      for (const [i, mesh] of result.meshes.entries()) {
        const requested = Math.floor(triangles * (levels[i]?.triangleRatio as number));
        expect(result.reports[i]?.targetReached).toBe(true);
        expect((mesh.indices?.length ?? 0) / 3).toBeLessThanOrEqual(requested);
        expect(edges(mesh)).toEqual(edges(source));
        expect(mesh.submeshes.every((section) => section.indexCount > 0)).toBe(true);
      }
    });
});
