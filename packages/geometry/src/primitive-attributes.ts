import { box3 } from '@forgeax/engine-math';
import {
  type AssetError,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { computeTangentVec4 } from './tangent';
import { packInterleavedVertexAttributes } from './vertex-attribute-layout';

interface PrimitiveAttributes {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
}

/** Fixed-cardinality primitives write the canonical attribute arrays directly. */
export function createPrimitiveAttributes(vertexCount: number): PrimitiveAttributes {
  return {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
  };
}

/** Internal primitive topology is complete; the public interleaved adapter preflights its input. */
export function finishPrimitiveMesh(
  source: PrimitiveAttributes,
  indices: Uint16Array | Uint32Array,
): Result<MeshAsset, AssetError> {
  const { position: positions, normal: normals, uv: uvs } = source;
  const vertexCount = positions.length / 3;
  const tangentResult = computeTangentVec4(positions, normals, uvs, indices);
  if (!tangentResult.ok) return tangentResult;
  const tangents = tangentResult.value;
  const attributes: VertexAttributeMap = {
    position: positions,
    normal: normals,
    uv: uvs,
    tangent: tangents,
  };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount);
  if (!packed.ok) return packed;
  return ok({
    kind: 'mesh',
    vertices: packed.value.vertices,
    indices,
    attributes,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
    // Procedural meshes carry their own local-space AABB: after feat-20260614
    // (D-15) `allocSharedRef` stores the payload verbatim -- there is no
    // `withMeshAabb` pass like the old `register`/`catalog` path -- so the cull
    // + pick path can only read an AABB the POD already holds.
    aabb: box3.fromPositions(box3.create(), positions),
  });
}
