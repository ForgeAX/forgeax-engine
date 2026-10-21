import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import type { MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';
import { Vector3 } from 'three/src/Three.Core.js';
import { invalid } from './errors';

/** Matcap's native path consumes vertex normals. Split its flat triangles at
 * source projection; Standard keeps its native derivative-based flat shading. */
export function projectFlatNormals(
  input: MeshAsset,
  slots: ReadonlySet<number>,
  weights: readonly number[] = [],
): MeshAsset {
  const { morphTargets, ...rest } = input;
  const attributes = { ...input.attributes };
  if (morphTargets !== undefined)
    for (const name of ['position', 'normal'] as const) {
      const values = (attributes[name] as Float32Array).slice();
      for (let index = 0; index < morphTargets.length; index++) {
        const delta = morphTargets[index]?.[name],
          weight = weights[index] ?? 0;
        if (!Number.isFinite(weight)) return invalid('Mesh.morphTargetInfluences').unwrap();
        if (delta !== undefined)
          for (let lane = 0; lane < values.length; lane++)
            values[lane] = (values[lane] ?? 0) + (delta[lane] ?? 0) * weight;
      }
      attributes[name] = values;
    }
  const mesh = { ...rest, attributes };
  const sourceCount = (mesh.attributes.position as Float32Array).length / 3;
  const arrays = Object.fromEntries(
    Object.entries(mesh.attributes).map(([name, data]) => [name, Array.from(data as Float32Array)]),
  );
  const positions = arrays.position;
  if (positions === undefined) return invalid('Flat geometry position').unwrap();
  const indices = Array.from(mesh.indices as Uint16Array | Uint32Array);
  const position = mesh.attributes.position as Float32Array,
    a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  for (const submesh of mesh.submeshes) {
    if (!slots.has(submesh.materialSlot ?? 0)) continue;
    for (
      let cursor = submesh.indexOffset;
      cursor + 2 < submesh.indexOffset + submesh.indexCount;
      cursor += 3
    ) {
      a.fromArray(position, (indices[cursor] ?? 0) * 3);
      b.fromArray(position, (indices[cursor + 1] ?? 0) * 3);
      c.fromArray(position, (indices[cursor + 2] ?? 0) * 3);
      const normal = b.sub(a).cross(c.sub(a)).normalize();
      if (normal.lengthSq() === 0) normal.set(0, 1, 0);
      for (let corner = 0; corner < 3; corner++) {
        const source = indices[cursor + corner] ?? 0,
          target = positions.length / 3;
        for (const [name, output] of Object.entries(arrays)) {
          const typed = mesh.attributes[name as keyof typeof mesh.attributes] as Float32Array,
            width = typed.length / sourceCount;
          output.push(
            ...(name === 'normal'
              ? normal.toArray()
              : typed.subarray(source * width, (source + 1) * width)),
          );
        }
        indices[cursor + corner] = target;
      }
    }
  }
  const packedAttributes = Object.fromEntries(
    Object.entries(arrays).map(([name, values]) => [
      name,
      name === 'skinIndex' ? new Uint16Array(values) : new Float32Array(values),
    ]),
  ) as VertexAttributeMap;
  const count = positions.length / 3;
  return {
    ...mesh,
    attributes: packedAttributes,
    vertices: packInterleavedVertexAttributes(packedAttributes, count).unwrap().vertices,
    indices: count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    aabb: box3.fromPositions(box3.create(), packedAttributes.position as Float32Array),
    submeshes: mesh.submeshes.map((submesh) => ({ ...submesh, vertexCount: count })),
  };
}
