import {
  type AssetError,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import {
  deriveVertexCount,
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
} from './vertex-attribute-layout';

/**
 * Return a copy of `mesh` whose every vertex carries one constant linear RGBA
 * `color`. The interleaved buffer is repacked from the canonical attribute map,
 * so layout, bounds and submeshes stay derived from the same source.
 */
export function withVertexColor(
  mesh: MeshAsset,
  rgbaLinear: readonly [number, number, number, number],
): Result<MeshAsset, AssetError> {
  // An inconsistent source buffer surfaces as the packer's vertex-count error.
  const vertexCount =
    deriveVertexCount(mesh.vertices, deriveVertexLayoutProjection(mesh.attributes)) ?? -1;
  const color = new Float32Array(Math.max(0, vertexCount) * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) color.set(rgbaLinear, vertex * 4);
  const attributes: VertexAttributeMap = { ...mesh.attributes, color };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount);
  if (!packed.ok) return packed;
  return ok({ ...mesh, vertices: packed.value.vertices, attributes });
}
