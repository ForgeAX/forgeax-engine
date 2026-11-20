import type { AssetGuid, MeshAsset, Submesh } from '@forgeax/engine-types';
import {
  deriveVertexLayoutProjection,
  type VertexLayoutProjection,
} from './vertex-attribute-layout';

/** Draw metadata from a mesh revision. May outlive its vertex and index buffers. */
export interface MeshDrawDescription
  extends Pick<MeshAsset, 'materialSlots' | 'lods' | 'lodHysteresis'> {
  readonly guid?: string;
  readonly layout: VertexLayoutProjection;
  readonly indexFormat: 'none' | 'uint16' | 'uint32';
  readonly submeshes: readonly Submesh[];
  readonly vertexWordCount: number;
  readonly indexCount: number;
  readonly aabb?: Float32Array;
}

const staticMeshFields = new Set([
  'kind',
  'vertices',
  'attributeStorage',
  'indices',
  'attributes',
  'aabb',
  'submeshes',
  'materialSlots',
  'lods',
  'lodHysteresis',
]);

/** A standalone geometry body preserves the complete supported static Mesh shape. */
export function isStandaloneStaticMesh(mesh: MeshAsset): boolean {
  return (
    Object.keys(mesh).every((field) => staticMeshFields.has(field)) &&
    mesh.attributes.skinIndex === undefined &&
    mesh.attributes.skinWeight === undefined &&
    mesh.submeshes.every(
      (range) => range.topology === 'triangle-list' || range.topology === 'triangle-strip',
    )
  );
}

function ownReference<T extends AssetGuid | number | undefined>(reference: T): T {
  return reference instanceof Uint8Array ? (reference.slice() as T) : reference;
}

/** Project a mesh's draw facts without reading or retaining its bulk payload. */
export function describeMeshDraw(mesh: MeshAsset): MeshDrawDescription {
  const guid = (mesh as { readonly guid?: string }).guid;
  return {
    ...(guid === undefined ? {} : { guid }),
    layout: deriveVertexLayoutProjection(mesh.attributes),
    indexFormat:
      mesh.indices === undefined
        ? 'none'
        : mesh.indices instanceof Uint16Array
          ? 'uint16'
          : 'uint32',
    submeshes: mesh.submeshes,
    vertexWordCount: mesh.vertices.length,
    indexCount: mesh.indices?.length ?? 0,
    materialSlots: Array.isArray(mesh.materialSlots)
      ? mesh.materialSlots.map((slot) =>
          typeof slot.defaultMaterial === 'object'
            ? { ...slot, defaultMaterial: ownReference(slot.defaultMaterial) }
            : slot,
        )
      : mesh.materialSlots,
    ...(mesh.lods === undefined
      ? {}
      : { lods: mesh.lods.map((lod) => ({ ...lod, mesh: ownReference(lod.mesh) })) }),
    ...(mesh.lodHysteresis === undefined ? {} : { lodHysteresis: mesh.lodHysteresis }),
    ...(mesh.aabb === undefined ? {} : { aabb: mesh.aabb.slice() }),
  };
}
