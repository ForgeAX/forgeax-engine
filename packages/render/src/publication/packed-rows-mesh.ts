import {
  deriveVertexCount,
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import type { MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';

/**
 * Render-realm mesh representation whose canonical CPU channels are carried
 * only by the packed interleaved `vertices` rows.
 *
 * Every attribute key stays present as a zero-length typed array of its
 * canonical storage type, so the layout mask, stride and digest are exactly
 * those of the full mesh. The marker is an in-band data field: it survives
 * structured clone, transfer, receiver copies and patch spreads, so a trimmed
 * value is never mistaken for a full one. Managed asset admission still
 * requires complete channels; this form exists only between a dynamic-geometry
 * preparation and its Render receiver.
 */
export const PACKED_ROWS_STORAGE = 'packed-rows';

export type PackedRowsMesh = MeshAsset & { readonly renderAttributeStorage: 'packed-rows' };

/** Opt-in request on a dynamic-geometry preparation input. */
export type DynamicGeometryRenderAttributes = 'full' | 'packed-rows';

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
  for (const key of keys) {
    const value = (mesh.attributes as Record<string, unknown>)[key];
    if (!RASTER_FLOAT_KEYS.has(key) || !(value instanceof Float32Array)) return false;
  }
  const vertexCount = deriveVertexCount(
    mesh.vertices,
    deriveVertexLayoutProjection(mesh.attributes),
  );
  return vertexCount !== undefined && vertexCount > 0;
}

export function isPackedRowsMesh(mesh: MeshAsset): mesh is PackedRowsMesh {
  return (
    (mesh as { readonly renderAttributeStorage?: unknown }).renderAttributeStorage ===
    PACKED_ROWS_STORAGE
  );
}

/** Bytes of canonical channel storage the packed-rows form does not carry. */
export function attributeChannelBytes(mesh: MeshAsset): number {
  let bytes = 0;
  for (const value of Object.values(mesh.attributes))
    if (value !== undefined) bytes += value.byteLength;
  return bytes;
}

/**
 * Private packed-rows copy of an eligible borrowed mesh. Binary rows are copied
 * into fresh owned buffers (transferable); every channel becomes a zero-length
 * view of its canonical type. The borrowed source is never mutated.
 */
export function trimToPackedRows(mesh: MeshAsset, copy: <T>(value: T) => T): PackedRowsMesh {
  const attributes: Record<string, Float32Array> = {};
  for (const key of Object.keys(mesh.attributes)) attributes[key] = new Float32Array(0);
  const { attributes: _channels, ...rest } = mesh;
  return {
    ...copy(rest),
    attributes: attributes as VertexAttributeMap,
    renderAttributeStorage: PACKED_ROWS_STORAGE,
  } as PackedRowsMesh;
}

/** Explicit validation of the trimmed representation; undefined when valid. */
export function packedRowsMeshError(mesh: MeshAsset): string | undefined {
  if (!isPackedRowsMesh(mesh)) return 'packed-rows marker';
  const attributes = mesh.attributes as Record<string, unknown>;
  const keys = Object.keys(attributes);
  if (!keys.includes('position')) return 'packed-rows position key';
  for (const key of keys) {
    const value = attributes[key];
    if (!RASTER_FLOAT_KEYS.has(key) || !(value instanceof Float32Array) || value.length !== 0)
      return `packed-rows channel ${key} must be an empty float32 layout key`;
  }
  if (
    !(mesh.vertices instanceof Float32Array) ||
    mesh.indices === undefined ||
    mesh.aabb === undefined ||
    mesh.submeshes.length === 0 ||
    mesh.submeshes.some((submesh) => submesh.topology !== 'triangle-list') ||
    mesh.cardLayout !== undefined ||
    mesh.distanceField !== undefined ||
    mesh.lods !== undefined ||
    mesh.morphTargets !== undefined ||
    mesh.morphWeights !== undefined
  )
    return 'packed-rows static raster triangle mesh';
  const count = deriveVertexCount(mesh.vertices, deriveVertexLayoutProjection(mesh.attributes));
  if (count === undefined || count === 0) return 'packed-rows whole interleaved vertex rows';
  return undefined;
}

const unpacked = new WeakMap<object, VertexAttributeMap>();

/**
 * Canonical channels for any mesh. A packed-rows mesh rebuilds them exactly
 * from its interleaved rows on first use (cold paths such as runtime GI or
 * transport projection); the hot raster path never calls this. A full mesh
 * returns its own attributes.
 */
export function meshAttributeChannels(mesh: MeshAsset): VertexAttributeMap {
  if (!isPackedRowsMesh(mesh)) return mesh.attributes;
  const cached = unpacked.get(mesh);
  if (cached !== undefined) return cached;
  const channels = unpackPackedRows(mesh);
  unpacked.set(mesh, channels);
  return channels;
}

/** Uncached exact rebuild, for one-off comparisons that must not retain channels. */
export function unpackPackedRows(mesh: PackedRowsMesh): VertexAttributeMap {
  const channels = unpackInterleavedVertexAttributes(
    mesh.vertices,
    deriveVertexLayoutProjection(mesh.attributes),
  );
  if (channels === undefined)
    throw new Error('packed-rows mesh vertices do not match their attribute layout');
  return channels;
}

/** In-place row writes on this exact value invalidate its derived channels. */
export function forgetMeshAttributeChannels(mesh: MeshAsset): void {
  unpacked.delete(mesh);
}
