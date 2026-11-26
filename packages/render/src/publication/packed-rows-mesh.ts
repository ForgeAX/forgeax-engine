import {
  deriveVertexCount,
  deriveVertexLayoutProjection,
  interleavedMesh,
  meshAttributeChannels,
  prepareMeshData,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';

/** The renderer consumes the same single-row representation as managed assets. */
export type PackedRowsMesh = MeshAsset & { readonly attributeStorage: 'interleaved' };
/** Explicit dynamic preparation request; runtime assets already use rows. */
export type DynamicGeometryRenderAttributes = 'full' | 'packed-rows';
export { meshAttributeChannels };

const RASTER_FLOAT_KEYS: ReadonlySet<string> = new Set([
  'position',
  'normal',
  'uv',
  'tangent',
  'uv1',
  'uv2',
  'uv3',
  'uv4',
  'uv5',
  'uv6',
  'uv7',
  'color',
]);

/**
 * Pure mesh-derived eligibility: a static raster-only triangle mesh whose
 * Render consumers need only its packed rows, indices, bounds and key set.
 * Skin, morph, LOD, surface-card and distance-field meshes keep full channels
 * because their CPU consumers read channel data directly.
 */
export function packedRowsEligible(mesh: MeshAsset): boolean {
  if (
    mesh.kind !== 'mesh' ||
    !(mesh.vertices instanceof Float32Array) ||
    mesh.vertices.length === 0 ||
    mesh.indices === undefined ||
    mesh.aabb === undefined ||
    mesh.submeshes.length === 0 ||
    mesh.cardLayout !== undefined ||
    mesh.distanceField !== undefined ||
    mesh.lods !== undefined ||
    mesh.morphTargets !== undefined ||
    mesh.morphWeights !== undefined
  )
    return false;
  for (const submesh of mesh.submeshes) if (submesh.topology !== 'triangle-list') return false;
  const keys = Object.keys(mesh.attributes);
  if (!keys.includes('position')) return false;
  if (!hasRasterAttributes(mesh, keys)) return false;
  const vertexCount = deriveVertexCount(
    mesh.vertices,
    deriveVertexLayoutProjection(mesh.attributes),
  );
  return vertexCount !== undefined && vertexCount > 0;
}

export function isPackedRowsMesh(mesh: MeshAsset): mesh is PackedRowsMesh {
  return mesh.attributeStorage === 'interleaved';
}

export function attributeChannelBytes(mesh: MeshAsset): number {
  let bytes = 0;
  for (const value of Object.values(mesh.attributes))
    if (value !== undefined) bytes += value.byteLength;
  return bytes;
}

/** Copy only canonical rows and metadata. Never copy channels merely to discard them. */
export function trimToPackedRows(mesh: MeshAsset, copy: <T>(value: T) => T): PackedRowsMesh {
  return copy(interleavedMesh(mesh)) as PackedRowsMesh;
}

export function packedRowsMeshError(mesh: MeshAsset): string | undefined {
  if (!isPackedRowsMesh(mesh)) return 'packed-rows marker';
  const valid = prepareMeshData(mesh, '<render-mesh>');
  return valid.ok ? undefined : valid.error.actual;
}

function hasRasterAttributes(mesh: MeshAsset, keys: readonly string[]): boolean {
  for (const key of keys) {
    const value = (mesh.attributes as Record<string, unknown>)[key];
    if (key === 'tangentFrame' && value instanceof Uint32Array) continue;
    if (!RASTER_FLOAT_KEYS.has(key) || !(value instanceof Float32Array)) return false;
  }
  return true;
}
