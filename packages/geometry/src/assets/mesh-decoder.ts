import {
  type AssetDecoder,
  type AssetDecoderContribution,
  type AssetKind,
  type AssetLoadError,
  err,
  type MeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { prepareMeshData } from '../mesh-data';
import {
  decodeMeshDistanceFieldAttachment,
  MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
} from '../mesh-distance-field-product';
import { decodeMeshBinary, normalizeMeshPayload } from './mesh-binary';
import { createProceduralMesh } from './primitive-mesh';

export const meshAssetKind: AssetKind<MeshAsset, 'mesh'> = {
  kind: 'mesh',
} as AssetKind<MeshAsset, 'mesh'>;

function proceduralMesh(payload: unknown): Result<MeshAsset, AssetLoadError> | undefined {
  const result = createProceduralMesh(payload);
  if (result === undefined) return undefined;
  if (result.ok) return result;
  return err({
    code: 'asset-package-invalid',
    expected: result.error.expected,
    hint: 'recook the authored procedural mesh descriptor',
    detail: { guid: '', reason: 'procedural mesh creation failed' },
  });
}

/** Geometry validates mesh payload shape before any render owner consumes it. */
export const meshAssetDecoder: AssetDecoder<MeshAsset> = {
  async decode({ envelope, artifacts }): Promise<Result<MeshAsset, AssetLoadError>> {
    const invalid = (reason: string): Result<MeshAsset, AssetLoadError> =>
      err({
        code: 'asset-package-invalid',
        expected: 'one validated Mesh geometry with complete matching attachments',
        hint: 'recook and publish the mesh with its complete source dependency closure',
        detail: { guid: envelope.guid, reason },
      });
    if (
      envelope.payload === null ||
      typeof envelope.payload !== 'object' ||
      Array.isArray(envelope.payload)
    )
      return invalid('mesh payload must be an object');
    const { distanceField, ...payload } = envelope.payload;
    const body = envelope.artifacts.body;
    if (body !== undefined && Object.keys(payload).some((key) => key !== 'kind'))
      return invalid('native mesh data and a geometry body artifact cannot coexist');
    if (
      body === undefined &&
      'geometry' in payload &&
      Object.keys(payload).some((key) => key !== 'kind' && key !== 'geometry')
    )
      return invalid('procedural descriptors and native mesh data cannot coexist');
    let mesh: MeshAsset | undefined;
    const procedural = body === undefined ? proceduralMesh(payload) : undefined;
    if (procedural !== undefined) {
      if (!procedural.ok) {
        return err<AssetLoadError>({
          code: 'asset-package-invalid',
          expected: procedural.error.expected,
          hint: procedural.error.hint,
          detail: { guid: envelope.guid, reason: 'procedural mesh creation failed' },
        });
      }
      mesh = procedural.value;
    }
    if (body !== undefined) {
      const bytes = await artifacts.read(body);
      if (!bytes.ok) return err<AssetLoadError>(bytes.error);
      mesh = decodeMeshBinary(bytes.value, envelope.refs);
      if (mesh === undefined) return invalid('mesh binary decode failed');
    } else if (mesh === undefined) {
      if (payload.vertices instanceof Float32Array) {
        const prepared = prepareMeshData(payload, envelope.guid);
        if (!prepared.ok) return invalid(prepared.error.actual);
        mesh = payload;
      } else {
        mesh = normalizeMeshPayload(payload, envelope.refs);
      }
    }
    if (mesh === undefined) return invalid('mesh geometry validation failed');
    const fieldDescriptor = envelope.artifacts['distance-field.bin'];
    if (distanceField === undefined && fieldDescriptor === undefined) return ok(mesh);
    if (fieldDescriptor === undefined) return invalid('mesh distance field artifact is missing');
    const { assetCodec, integrity } = fieldDescriptor;
    if (
      assetCodec?.name !== MESH_VISIBILITY_DISTANCE_FIELD_CODEC.name ||
      assetCodec.version !== MESH_VISIBILITY_DISTANCE_FIELD_CODEC.version ||
      (assetCodec.profile !== MESH_VISIBILITY_DISTANCE_FIELD_CODEC.profile &&
        assetCodec.profile !== MESH_GEOMETRIC_DISTANCE_FIELD_CODEC.profile)
    )
      return invalid('unsupported mesh distance field artifact codec');
    if (integrity === undefined)
      return invalid('mesh distance field artifact integrity is missing');
    const artifact = { integrity: { ...integrity }, assetCodec: { ...assetCodec } };
    const read = await artifacts.read(fieldDescriptor);
    if (!read.ok) return read;
    const attached = await decodeMeshDistanceFieldAttachment(mesh, distanceField, read.value);
    if (!attached.ok) return invalid(attached.error.detail.reason);
    const field = attached.value;
    const codec =
      field.policy.kind === 'sampled-visibility'
        ? MESH_VISIBILITY_DISTANCE_FIELD_CODEC
        : MESH_GEOMETRIC_DISTANCE_FIELD_CODEC;
    if (artifact.assetCodec.profile !== codec.profile)
      return invalid('mesh distance field codec policy mismatch');
    return ok({ ...mesh, distanceField: { ...field, artifact } });
  },
};

export const meshAssetContribution: AssetDecoderContribution<MeshAsset, 'mesh'> = {
  kind: meshAssetKind,
  decoder: meshAssetDecoder,
  consumer: 'Geometry',
};
