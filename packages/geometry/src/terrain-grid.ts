import type { MeshAsset } from '@forgeax/engine-types';
import { createPrimitiveAttributes, finishPrimitiveMesh } from './primitive-attributes';

/** One shared rule grid; all integer LODs retain the same vertex bytes. */
export function createTerrainGrids(vertices: number): readonly MeshAsset[] {
  if (
    !Number.isInteger(vertices) ||
    vertices < 2 ||
    vertices > 128 ||
    (vertices & (vertices - 1)) !== 0
  )
    throw new RangeError('terrain grid requires power-of-two 2..128 vertices');
  const attributes = createPrimitiveAttributes(vertices * vertices);
  for (let z = 0; z < vertices; z++)
    for (let x = 0; x < vertices; x++) {
      const i = z * vertices + x;
      attributes.position[i * 3] = x;
      attributes.position[i * 3 + 2] = z;
      attributes.normal[i * 3 + 1] = 1;
      attributes.uv[i * 2] = x / (vertices - 1);
      attributes.uv[i * 2 + 1] = z / (vertices - 1);
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
    const mesh = finishPrimitiveMesh(attributes, indices).unwrap();
    const base = grids[0];
    grids.push(base ? { ...mesh, vertices: base.vertices, attributes: base.attributes } : mesh);
  }
  return grids;
}
