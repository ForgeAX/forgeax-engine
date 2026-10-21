import { type MeshAsset, type MeshDistanceField, ok, type Result } from '@forgeax/engine-types';
import {
  type DistanceFieldError,
  distanceFieldFailure,
  distanceFieldMeshDigest,
  MESH_DISTANCE_FIELD_GENERATION_VERSION,
} from './distance-field';
import { decodeMeshDistanceField, validateMeshDistanceField } from './distance-field-artifact';
import { visibilityDistanceFieldSourceDigest } from './visibility-distance-field';

/** Existing asset codec profile binds this builder policy without a second identity field. */
export const MESH_VISIBILITY_DISTANCE_FIELD_CODEC = {
  name: 'mesh-distance-field',
  version: '4',
  profile: `sampled-visibility/${MESH_DISTANCE_FIELD_GENERATION_VERSION}`,
} as const;
export const MESH_GEOMETRIC_DISTANCE_FIELD_CODEC = {
  ...MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  profile: `geometric/${MESH_DISTANCE_FIELD_GENERATION_VERSION}`,
} as const;

/** Geometry-independent source policy, carried once by the ordinary Mesh publication. */
export interface MeshDistanceFieldDescriptor {
  readonly sectionSidedness: readonly (0 | 1)[];
}

/** Canonical triangle coverage shared by the producer and the ordinary asset loader. */
export function meshDistanceFieldSource(
  mesh: MeshAsset,
  descriptor: unknown,
): Result<
  {
    positions: Float32Array;
    indices: Uint16Array | Uint32Array;
    triangleSidedness: Uint8Array;
    descriptor: MeshDistanceFieldDescriptor;
  },
  DistanceFieldError
> {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor))
    return distanceFieldFailure('mesh distance field requires its source section sidedness');
  const data = descriptor as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => key !== 'sectionSidedness') ||
    !Array.isArray(data.sectionSidedness) ||
    data.sectionSidedness.length !== mesh.submeshes.length ||
    data.sectionSidedness.some((v) => v !== 0 && v !== 1)
  )
    return distanceFieldFailure('distance field section sidedness must cover every mesh section');
  const positions = mesh.attributes.position;
  if (
    !(positions instanceof Float32Array) ||
    positions.length < 9 ||
    positions.length % 3 ||
    mesh.morphTargets !== undefined ||
    mesh.attributes.skinIndex !== undefined ||
    mesh.attributes.skinWeight !== undefined
  )
    return distanceFieldFailure('mesh distance fields require static float32 triangle geometry');
  const indices = mesh.indices ?? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  if (indices.length % 3 || indices.length > 3_145_728 || positions.length > 3_145_728)
    return distanceFieldFailure('distance field source exceeds triangle geometry limits');
  const flags = new Uint8Array(indices.length / 3);
  let end = 0;
  for (const [index, section] of mesh.submeshes.entries()) {
    const count = mesh.indices ? section.indexCount : section.vertexCount;
    const offset = mesh.indices ? section.indexOffset : end;
    if (
      section.topology !== 'triangle-list' ||
      offset !== end ||
      count < 3 ||
      count % 3 ||
      offset + count > indices.length
    )
      return distanceFieldFailure('distance field sections must partition the triangle buffer');
    flags.fill(data.sectionSidedness[index], offset / 3, (offset + count) / 3);
    end += count;
  }
  if (
    end !== indices.length ||
    !positions.every(Number.isFinite) ||
    indices.some((i) => i >= positions.length / 3)
  )
    return distanceFieldFailure('distance field source has incomplete or invalid geometry');
  return ok({
    positions,
    indices,
    triangleSidedness: flags,
    descriptor: data as unknown as MeshDistanceFieldDescriptor,
  });
}

export async function validateMeshDistanceFieldAttachment(
  mesh: MeshAsset,
  descriptor: unknown,
  field: MeshDistanceField,
): Promise<Result<void, DistanceFieldError>> {
  const source = meshDistanceFieldSource(mesh, descriptor);
  if (!source.ok) return source;
  const valid = validateMeshDistanceField(field);
  if (!valid.ok) return valid;
  const meshDigest = await distanceFieldMeshDigest(source.value.positions, source.value.indices);
  return validateSourceIdentity(field, meshDigest, source.value.triangleSidedness);
}

async function validateSourceIdentity(
  field: MeshDistanceField,
  meshDigest: string,
  triangleSidedness: Uint8Array,
): Promise<Result<void, DistanceFieldError>> {
  if (
    field.meshDigest !== meshDigest ||
    (field.policy.kind === 'sampled-visibility'
      ? field.policy.sourceDigest !==
          (await visibilityDistanceFieldSourceDigest(meshDigest, triangleSidedness)) ||
        field.policy.mostlyTwoSided !==
          triangleSidedness.reduce((sum, flag) => sum + flag, 0) * 4 >= triangleSidedness.length
      : !triangleSidedness.every((flag) => flag === Number(field.policy.kind === 'two-sided')))
  )
    return distanceFieldFailure(
      'distance field geometry or source sidedness policy is stale; recook the mesh',
    );
  return ok(undefined);
}

/** Decode one complete attachment from already admitted mesh source and artifact bytes. */
export async function decodeMeshDistanceFieldAttachment(
  mesh: MeshAsset,
  descriptor: unknown,
  bytes: Uint8Array,
): Promise<Result<NonNullable<MeshAsset['distanceField']>, DistanceFieldError>> {
  const source = meshDistanceFieldSource(mesh, descriptor);
  if (!source.ok) return source;
  const digest = await distanceFieldMeshDigest(source.value.positions, source.value.indices);
  const decoded = await decodeMeshDistanceField(bytes, digest);
  if (!decoded.ok) return decoded;
  const valid = await validateSourceIdentity(decoded.value, digest, source.value.triangleSidedness);
  if (!valid.ok) return valid;
  return ok({ ...decoded.value, sectionSidedness: source.value.descriptor.sectionSidedness });
}
