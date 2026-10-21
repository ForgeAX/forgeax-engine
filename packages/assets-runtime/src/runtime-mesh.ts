import {
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { AssetError, err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';

function invalid(expected: string): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: 'supply complete finite mesh channels matching the canonical geometry layout',
    }),
  );
}

/** Complete buffer edits derive the other representation before any consumer sees either. */
export function prepareRuntimeMeshPatch(
  current: MeshAsset,
  patch: Partial<MeshAsset>,
): Result<Record<string, unknown>, AssetError> {
  let derived = patch;
  if (patch.attributes !== undefined && patch.vertices === undefined) {
    const position = patch.attributes.position;
    const length =
      position instanceof Float32Array
        ? position.length
        : position instanceof ArrayBuffer
          ? position.byteLength / 4
          : undefined;
    if (length === undefined) return invalid('a Float32 position channel');
    const packed = packInterleavedVertexAttributes(patch.attributes, length / 3);
    if (!packed.ok) return invalid(packed.error.message);
    derived = { ...patch, vertices: packed.value.vertices };
  } else if (patch.vertices !== undefined && patch.attributes === undefined) {
    if (!(patch.vertices instanceof Float32Array)) return invalid('Float32 interleaved vertices');
    const attributes = unpackInterleavedVertexAttributes(
      patch.vertices,
      deriveVertexLayoutProjection(current.attributes),
    );
    if (attributes === undefined) return invalid('complete interleaved vertex rows');
    derived = { ...patch, attributes };
  }
  const changedGeometry = ['attributes', 'vertices', 'indices', 'submeshes', 'morphTargets'].some(
    (field) => Object.hasOwn(patch, field),
  );
  if (!changedGeometry) return ok({ ...derived });
  // Full validation follows through prepareRuntimeAsset, once for the complete candidate.
  // Derived offline attachments belong to the old geometry, even when supplied in a patch.
  return ok({ ...derived, collision: undefined, cardLayout: undefined, distanceField: undefined });
}

export type MeshRange =
  | {
      readonly attribute: Exclude<
        keyof import('@forgeax/engine-types').VertexAttributeMap,
        'skinIndex'
      >;
      readonly first: number;
      readonly values: Float32Array;
    }
  | { readonly attribute: 'skinIndex'; readonly first: number; readonly values: Uint16Array }
  | { readonly first: number; readonly indices: Uint16Array | Uint32Array };

/** The source buffers were validated on admission; a range validates only its new lanes. */
export function prepareRuntimeMeshRange(
  current: unknown,
  input: MeshRange,
): Result<import('./internal/asset-records').PreparedAssetRanges, AssetError> {
  if (
    current === null ||
    typeof current !== 'object' ||
    !('kind' in current) ||
    current.kind !== 'mesh'
  )
    return invalid('a managed Mesh reference');
  if (input === null || typeof input !== 'object') return invalid('a mesh attribute range');
  const mesh = current as MeshAsset;
  const layout = deriveVertexLayoutProjection(mesh.attributes);
  const vertexCount = mesh.vertices.byteLength / layout.arrayStride;
  const remove = ['collision', 'distanceField', 'cardLayout'].filter((field) =>
    Object.hasOwn(mesh, field),
  );
  if ('indices' in input) {
    const indices = input.indices;
    if (
      mesh.indices === undefined ||
      (mesh.indices instanceof Uint16Array
        ? !(indices instanceof Uint16Array)
        : !(indices instanceof Uint32Array)) ||
      !Number.isSafeInteger(input.first) ||
      input.first < 0 ||
      input.first + indices.length > mesh.indices.length
    )
      return invalid('an in-bounds index range matching the existing index storage');
    for (const index of indices)
      if (index >= vertexCount) return invalid('indices within the mesh vertex count');
    if (indices.length === 0) return ok({ writes: [] });
    return ok({
      writes: [
        {
          path: ['indices'],
          byteOffset: input.first * indices.BYTES_PER_ELEMENT,
          bytes: new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength),
        },
      ],
      remove,
    });
  }
  const attribute = layout.attributes.find((entry) => entry.key === input.attribute);
  if (attribute === undefined) return invalid('an existing mesh attribute');
  const integer = attribute.format === 'uint16x4';
  const values = input.values;
  if (
    (integer && !(values instanceof Uint16Array)) ||
    (!integer && !(values instanceof Float32Array))
  )
    return invalid('range values with the attribute storage type');
  const count = values.byteLength / attribute.byteLength;
  if (
    !Number.isSafeInteger(input.first) ||
    input.first < 0 ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(input.first + count) ||
    input.first + count > vertexCount
  )
    return invalid('a whole-vertex range within the existing mesh');
  for (const value of values)
    if (!Number.isFinite(value)) return invalid('finite mesh attribute values');
  if (count === 0) return ok({ writes: [] });
  const fields: Record<string, unknown> = {};
  if (input.attribute === 'position') {
    if (mesh.aabb === undefined) return invalid('admitted conservative mesh bounds');
    const bounds = mesh.aabb.slice();
    for (let i = 0; i < values.length; i += 3)
      for (let axis = 0; axis < 3; axis++) {
        const value = values[i + axis] as number;
        bounds[axis] = Math.min(bounds[axis] as number, value);
        bounds[axis + 3] = Math.max(bounds[axis + 3] as number, value);
      }
    if (bounds.some((value, index) => value !== mesh.aabb?.[index])) fields.aabb = bounds;
  }
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  return ok({
    writes: [
      {
        path: ['attributes', input.attribute],
        byteOffset: input.first * attribute.byteLength,
        bytes,
      },
      {
        path: ['vertices'],
        byteOffset: input.first * layout.arrayStride + attribute.offset,
        bytes,
        rowBytes: attribute.byteLength,
        byteStride: layout.arrayStride,
      },
    ],
    fields,
    remove,
  });
}
