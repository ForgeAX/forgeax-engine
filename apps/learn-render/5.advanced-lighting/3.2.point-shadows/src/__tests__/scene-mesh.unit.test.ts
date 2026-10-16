import { describe, expect, it } from 'vitest';
import { createSceneCubeMesh } from '../scene-mesh';

describe('point-shadow reference geometry', () => {
  it.each([false, true])('keeps winding, normals and tangent frame consistent (interior=%s)', (inward) => {
    const mesh = createSceneCubeMesh(inward);
    const positions = mesh.attributes?.position;
    const normals = mesh.attributes?.normal;
    const tangents = mesh.attributes?.tangent;
    const uv = mesh.attributes?.uv;
    const indices = mesh.indices;
    if (!(positions instanceof Float32Array) || !(normals instanceof Float32Array) ||
        !(tangents instanceof Float32Array) || !(uv instanceof Float32Array) || indices === undefined) {
      throw new Error('Missing canonical mesh facts');
    }
    for (let index = 0; index < indices.length; index += 3) {
      const a = (indices[index] ?? 0) * 3;
      const b = (indices[index + 1] ?? 0) * 3;
      const c = (indices[index + 2] ?? 0) * 3;
      const edge = (to: number) => [0, 1, 2].map(axis => (positions[to + axis] ?? 0) - (positions[a + axis] ?? 0));
      const [ux = 0, uy = 0, uz = 0] = edge(b);
      const [vx = 0, vy = 0, vz = 0] = edge(c);
      const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      expect(cross.reduce((sum, value, axis) => sum + value * (normals[a + axis] ?? 0), 0)).toBeGreaterThan(0);
      const radial = [0, 1, 2].reduce((sum, axis) => sum + (normals[a + axis] ?? 0) * (positions[a + axis] ?? 0), 0);
      expect(radial * (inward ? -1 : 1)).toBeGreaterThan(0);
    }
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      const nx = normals[vertex * 3] ?? 0;
      const nz = normals[vertex * 3 + 2] ?? 0;
      expect(uv[vertex * 2]).toBe((positions[vertex * 3 + (nx === 0 ? 0 : 1)] ?? 0) + 0.5);
      expect(uv[vertex * 2 + 1]).toBe(nz === 0 ? 0.5 - (positions[vertex * 3 + 2] ?? 0) : (positions[vertex * 3 + 1] ?? 0) + 0.5);
      expect(Math.abs(tangents[vertex * 4 + 3] ?? 0)).toBe(1);
    }
  });
});
