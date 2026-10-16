import { BUILTIN_CUBE } from '@forgeax/engine-assets-runtime';
import { createMeshBuilder } from '@forgeax/engine-geometry';

/** LearnOpenGL face-local UV axes; an interior also reverses normals/winding. */
export function createSceneCubeMesh(inward: boolean) {
  const { attributes, indices } = BUILTIN_CUBE;
  const normal = attributes?.normal;
  const tangent = attributes?.tangent;
  const position = attributes?.position;
  if (!(normal instanceof Float32Array) || !(tangent instanceof Float32Array) ||
      !(position instanceof Float32Array) || indices === undefined) {
    throw new Error('The canonical cube must publish positions, normals, tangents and indices.');
  }
  const normals = normal.map((value) => inward ? -value : value);
  const tangents = new Float32Array(tangent.length);
  const uv = new Float32Array(position.length / 3 * 2);
  for (let vertex = 0; vertex < position.length / 3; vertex++) {
    const x = position[vertex * 3] ?? 0;
    const y = position[vertex * 3 + 1] ?? 0;
    const z = position[vertex * 3 + 2] ?? 0;
    const nx = normal[vertex * 3] ?? 0;
    const ny = normal[vertex * 3 + 1] ?? 0;
    const nz = normal[vertex * 3 + 2] ?? 0;
    uv[vertex * 2] = (nx === 0 ? x : y) + 0.5;
    uv[vertex * 2 + 1] = nz === 0 ? 0.5 - z : y + 0.5;
    tangents[vertex * 4 + (nx === 0 ? 0 : 1)] = 1;
    tangents[vertex * 4 + 3] = (nx === 0 ? ny + nz : -nx) * (inward ? -1 : 1);
  }
  const triangles = Array.from(indices);
  for (let index = 0; inward && index < triangles.length; index += 3) {
    const second = triangles[index + 1];
    const third = triangles[index + 2];
    if (second === undefined || third === undefined) throw new Error('Incomplete cube triangle.');
    triangles[index + 1] = third;
    triangles[index + 2] = second;
  }
  return createMeshBuilder({
    attributes: { ...attributes, normal: normals, tangent: tangents, uv },
    indices: triangles,
  }).build().unwrap();
}
