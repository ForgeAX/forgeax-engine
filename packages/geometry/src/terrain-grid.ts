import type { MeshAsset } from '@forgeax/engine-types';
import { meshFromInterleaved } from './box.js';

/** One shared rule grid; all integer LODs retain the same vertex bytes. */
export function createTerrainGrids(vertices: number): readonly MeshAsset[] {
  if (
    !Number.isInteger(vertices) ||
    vertices < 2 ||
    vertices > 128 ||
    (vertices & (vertices - 1)) !== 0
  )
    throw new RangeError('terrain grid requires power-of-two 2..128 vertices');
  const data = new Float32Array(vertices * vertices * 8);
  for (let z = 0; z < vertices; z++)
    for (let x = 0; x < vertices; x++) {
      const i = (z * vertices + x) * 8;
      data.set([x, 0, z, 0, 1, 0, x / (vertices - 1), z / (vertices - 1)], i);
    }
  const grids: MeshAsset[] = [];
  for (let step = 1; step < vertices; step *= 2) {
    const n = vertices / step;
    const indices = new Uint32Array((n - 1) ** 2 * 6);
    let i = 0;
    for (let z = 0; z < n - 1; z++)
      for (let x = 0; x < n - 1; x++) {
        const a = z * step * vertices + x * step;
        const b = a + step;
        const c = a + step * vertices;
        const d = c + step;
        indices.set([a, c, b, b, c, d], i);
        i += 6;
      }
    const mesh = meshFromInterleaved(data, indices).unwrap();
    const base = grids[0];
    grids.push(base ? { ...mesh, vertices: base.vertices, attributes: base.attributes } : mesh);
  }
  return grids;
}
