import {
  encodeMeshDistanceField,
  MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  type MeshDistanceFieldDescriptor,
  meshDistanceFieldSource,
  validateMeshDistanceFieldAttachment,
} from '@forgeax/engine-geometry';
import type { ImportedArtifactBody, MeshAsset } from '@forgeax/engine-types';
import { createMeshDistanceFieldCooker } from './distance-field-cooker';

export interface MeshDistanceFieldProduct {
  readonly payload: MeshDistanceFieldDescriptor;
  readonly artifacts: Readonly<Record<'distance-field.bin', ImportedArtifactBody>>;
}

/** Explicit build-time source operation; the mesh retains its existing GUID. */
export async function cookMeshDistanceFieldProduct(
  mesh: MeshAsset,
  meshGuid: string,
  sampling: number | { readonly resolution: number },
  sectionSidedness: readonly (0 | 1)[],
): Promise<MeshDistanceFieldProduct> {
  const geometric = typeof sampling !== 'number';
  const payload = { sectionSidedness };
  const source = meshDistanceFieldSource(mesh, payload);
  if (!source.ok) throw new TypeError(source.error.detail.reason);
  if (geometric && !sectionSidedness.every((flag) => flag === sectionSidedness[0]))
    throw new TypeError('geometric fields require homogeneous signed-solid or two-sided coverage');
  const cooked = await createMeshDistanceFieldCooker().cook({
    meshGuid,
    positions: source.value.positions,
    indices: source.value.indices,
    ...(typeof sampling === 'number'
      ? {
          policy: 'sampled-visibility' as const,
          voxelSize: sampling,
          triangleSidedness: source.value.triangleSidedness,
        }
      : {
          policy: 'geometric' as const,
          resolution: sampling.resolution,
          twoSided: sectionSidedness[0] === 1,
        }),
  });
  const body = cooked.artifacts['distance-field.bin'];
  if (!body) throw new TypeError('distance field cooker omitted its artifact');
  return {
    payload,
    artifacts: {
      'distance-field.bin': {
        ...body,
        assetCodec: geometric
          ? MESH_GEOMETRIC_DISTANCE_FIELD_CODEC
          : MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
      },
    },
  };
}

/** Re-publication uses the same asset-local artifact and validates against current geometry. */
export async function encodeMeshDistanceFieldProduct(
  mesh: MeshAsset,
): Promise<MeshDistanceFieldProduct | undefined> {
  const field = mesh.distanceField;
  if (field === undefined) return undefined;
  // Publication identity describes encoded bytes; it must never become part of those bytes.
  const { sectionSidedness, artifact: _, ...data } = field;
  const geometric = data.policy.kind !== 'sampled-visibility';
  const payload = { sectionSidedness };
  const valid = await validateMeshDistanceFieldAttachment(mesh, payload, data);
  if (!valid.ok) throw new TypeError(valid.error.detail.reason);
  const encoded = await encodeMeshDistanceField(data);
  if (!encoded.ok) throw new TypeError(encoded.error.detail.reason);
  return {
    payload,
    artifacts: {
      'distance-field.bin': {
        mediaType: 'application/octet-stream',
        assetCodec: geometric
          ? MESH_GEOMETRIC_DISTANCE_FIELD_CODEC
          : MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
        bytes: encoded.value,
      },
    },
  };
}
