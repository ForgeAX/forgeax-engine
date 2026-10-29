import { describe, expect, it } from 'vitest';
import type { MeshAsset } from '@forgeax/engine/types';
import pack from '../uv-primitives.pack.ts';

async function meshes(): Promise<Record<string, MeshAsset>> {
  const result = await pack.build(undefined as never);
  if (!result.ok) throw result.error;
  return result.value as Record<string, MeshAsset>;
}

type Point = readonly [number, number];
function overlap(a: readonly Point[], b: readonly Point[]): boolean {
  for (const triangle of [a, b]) {
    for (let edge = 0; edge < 3; edge += 1) {
      const start = triangle[edge]!;
      const end = triangle[(edge + 1) % 3]!;
      const axis = [end[1] - start[1], start[0] - end[0]];
      const project = (points: readonly Point[]) => points.map(([u, v]) => u * axis[0]! + v * axis[1]!);
      const pa = project(a);
      const pb = project(b);
      if (Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= 1e-9) return false;
    }
  }
  return true;
}

describe('UV primitives authoring', () => {
  it('produces exactly three deterministic fixed meshes', async () => {
    const first = await meshes();
    expect(Object.keys(first)).toEqual(['mesh/triangular-ramp', 'mesh/half-cylinder', 'mesh/quarter-cylinder']);
    expect(await meshes()).toEqual(first);
  });

  for (const [key, count, volume, islandCount] of [
    ['mesh/triangular-ramp', 8, 4, 5],
    ['mesh/half-cylinder', 132, 32 * Math.sin(Math.PI / 32), 4],
    ['mesh/quarter-cylinder', 68, 16 * Math.sin(Math.PI / 32), 5],
  ] as const) {
    it(`${key}: closed, outward, nondegenerate, with separated proportional UV islands`, async () => {
      const mesh = (await meshes())[key]!;
      const positions = mesh.attributes.position as Float32Array;
      const normals = mesh.attributes.normal as Float32Array;
      const uv = mesh.attributes.uv as Float32Array;
      const indices = mesh.indices!;
      expect(indices.length / 3).toBe(count);
      for (const value of uv) expect(value).toBeGreaterThan(0);
      for (const value of uv) expect(value).toBeLessThan(1);
      const triangles: Point[][] = [];
      const edges = new Map<string, number>();
      const density: number[] = [];
      const parent = Array.from({ length: positions.length / 3 }, (_, i) => i);
      const root = (i: number): number => parent[i] === i ? i : root(parent[i]!);
      const pointKey = (i: number) => Array.from(positions.slice(i * 3, i * 3 + 3), (v) => v.toFixed(5)).join(',');
      let signedVolume = 0;
      for (let index = 0; index < indices.length; index += 3) {
        const ids = [indices[index]!, indices[index + 1]!, indices[index + 2]!];
        const [a, b, c] = ids.map((id) => Array.from(positions.slice(id * 3, id * 3 + 3)));
        const ab = b!.map((v, axis) => v - a![axis]!);
        const ac = c!.map((v, axis) => v - a![axis]!);
        const cross = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
        const area = Math.hypot(...cross) / 2;
        expect(area).toBeGreaterThan(1e-6);
        expect(cross.reduce((sum, v, axis) => sum + v * normals[ids[0]! * 3 + axis]!, 0)).toBeGreaterThan(0);
        signedVolume += (a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) + a![1]! * (b![2]! * c![0]! - b![0]! * c![2]!) + a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!)) / 6;
        const triangle: Point[] = ids.map((id) => [uv[id * 2]!, uv[id * 2 + 1]!]);
        const [u, v, w] = triangle;
        const uvArea = Math.abs((v![0] - u![0]) * (w![1] - u![1]) - (v![1] - u![1]) * (w![0] - u![0])) / 2;
        expect(uvArea).toBeGreaterThan(1e-7);
        density.push(uvArea / area);
        triangles.push(triangle);
        for (let edge = 0; edge < 3; edge += 1) {
          const current = ids[edge]!;
          const next = ids[(edge + 1) % 3]!;
          parent[root(current)] = root(next);
          const edgeKey = [pointKey(current), pointKey(next)].sort().join('|');
          edges.set(edgeKey, (edges.get(edgeKey) ?? 0) + 1);
        }
      }
      expect(signedVolume).toBeCloseTo(volume, 5);
      expect([...edges.values()].every((uses) => uses === 2)).toBe(true);
      expect(new Set(parent.map((_, i) => root(i))).size).toBe(islandCount);
      expect(Math.max(...density) / Math.min(...density)).toBeLessThan(1.003);
      for (let a = 0; a < triangles.length; a += 1) {
        for (let b = a + 1; b < triangles.length; b += 1) expect(overlap(triangles[a]!, triangles[b]!)).toBe(false);
      }
    });
  }
});
