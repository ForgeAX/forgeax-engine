import { decodeMeshBinary, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import type { MeshAsset, WaterBodyAsset, WaterBrushIslandActor } from '@forgeax/engine-types';
import { canonicalJson, err, ok, type Result } from '@forgeax/engine-types';
import {
  validateWaterRuntimeBody,
  type WaterBrushTerrainManifest,
  waterBrushBodyCaptureInputDigest,
} from '@forgeax/engine-water';
import { requireWaterValue } from '@forgeax/engine-water/internal';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export type WaterBrushPackMeshPayload = Readonly<{
  meshGuid: string;
  payloadBytes: Uint8Array;
  refs: readonly string[];
}>;

export type WaterBrushDecodedPackMesh = WaterBrushPackMeshPayload &
  Readonly<{ decoded: MeshAsset }>;

export type WaterBrushFrozenActorInput =
  | Readonly<{
      kind: 'body';
      actorId: string;
      bodyGuid: string;
      /** Canonical UTF-8 JSON bytes of the frozen Pack WaterBody payload. */
      sourcePayloadBytes: Uint8Array;
      meshes: readonly WaterBrushPackMeshPayload[];
    }>
  | Readonly<{
      kind: 'island';
      actorId: string;
      sourceKey: string;
      spline: WaterBrushIslandActor['spline'];
      heightOffsetM: number;
    }>;

export type WaterBrushValidatedActor = Readonly<{
  actorId: string;
  kind: 'body' | 'island';
  sourceDigest: string;
  captureGeneration: number;
  body?: WaterBodyAsset;
  packMeshes: readonly WaterBrushDecodedPackMesh[];
  islandSpline?: WaterBrushIslandActor['spline'];
  heightOffsetM?: number;
  worldMatrixM: readonly number[];
}>;

function digest(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function closeMatrix(a: readonly number[], b: readonly number[]): boolean {
  return (
    a.length === 16 &&
    b.length === 16 &&
    a.every(
      (value, index) =>
        Number.isFinite(value) && Math.abs(value - requireWaterValue(b[index])) <= 1e-7,
    )
  );
}

function validMesh(mesh: MeshAsset): boolean {
  const floatsPerVertex =
    deriveVertexLayoutProjection(mesh.attributes).arrayStride / Float32Array.BYTES_PER_ELEMENT;
  if (
    mesh.kind !== 'mesh' ||
    floatsPerVertex === 0 ||
    mesh.vertices.length === 0 ||
    mesh.vertices.length % floatsPerVertex !== 0 ||
    mesh.vertices.some((value) => !Number.isFinite(value))
  )
    return false;
  const vertexCount = mesh.vertices.length / floatsPerVertex;
  if (mesh.indices?.some((index) => index >= vertexCount)) return false;
  return (
    mesh.indices !== undefined &&
    mesh.submeshes.length > 0 &&
    mesh.submeshes.every(
      (submesh) =>
        submesh.topology === 'triangle-list' &&
        submesh.indexCount > 0 &&
        submesh.indexCount % 3 === 0 &&
        submesh.indexOffset + submesh.indexCount <= requireWaterValue(mesh.indices).length,
    )
  );
}

/** Verify frozen Pack bytes and decoded geometry against the actor provenance before creating GPU resources. */
export function validateWaterBrushFrozenActor(
  manifest: WaterBrushTerrainManifest,
  input: WaterBrushFrozenActorInput,
  captureGeneration: number,
): Result<WaterBrushValidatedActor, Error> {
  const cache = manifest.actorCaches.find((item) => item.actorId === input.actorId);
  if (!cache || !Number.isSafeInteger(captureGeneration) || captureGeneration < 1)
    return err(
      new Error(`Water Brush actor or capture generation is absent/invalid: ${input.actorId}`),
    );
  const provenance = cache.captureProvenance;
  if (
    provenance.worldMatrixM.length !== 16 ||
    provenance.worldMatrixM.some((value) => !Number.isFinite(value))
  )
    return err(new Error(`Water Brush actor capture pose is invalid: ${input.actorId}`));
  if (input.kind === 'body') {
    const validateFrozenBodyActor = (
      input: Extract<WaterBrushFrozenActorInput, { kind: 'body' }>,
    ) => {
      let source: WaterBodyAsset;
      try {
        const parsed: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(input.sourcePayloadBytes),
        );
        const checked = validateWaterRuntimeBody(parsed);
        if (!checked.ok)
          return err(
            new Error(
              `Water Brush Pack WaterBody payload failed runtime validation: ${input.actorId}`,
            ),
          );
        source = checked.value;
        if (
          canonicalJson(source) !==
          new TextDecoder('utf-8', { fatal: true }).decode(input.sourcePayloadBytes)
        )
          return err(
            new Error(`Water Brush Pack WaterBody payload is not canonical JSON: ${input.actorId}`),
          );
      } catch {
        return err(
          new Error(
            `Water Brush Pack WaterBody payload is not canonical UTF-8 JSON: ${input.actorId}`,
          ),
        );
      }
      if (
        cache.actorCapture.kind !== 'body' ||
        source.kind !== 'water-body' ||
        input.bodyGuid !== cache.actorCapture.bodyGuid ||
        source.type !== cache.actorCapture.bodyType ||
        canonicalJson(source.spline) !== canonicalJson(cache.actorCapture.spline) ||
        provenance.source !== 'pack-mesh' ||
        digest(input.sourcePayloadBytes) !== provenance.sourcePayloadDigest ||
        waterBrushBodyCaptureInputDigest(source) !== cache.sourceInputDigest
      )
        return err(
          new Error(
            `Water Brush frozen Body source does not match its manifest identity/digest: ${input.actorId}`,
          ),
        );
      if (
        source.geometryAuthoringWorldMatrixM !== undefined &&
        !closeMatrix(source.geometryAuthoringWorldMatrixM, provenance.worldMatrixM)
      )
        return err(
          new Error(
            `Water Brush Body pose differs from frozen Pack geometry pose: ${input.actorId}`,
          ),
        );
      const validateFrozenBodyMeshes = (
        actorCapture: Extract<typeof cache.actorCapture, { kind: 'body' }>,
      ) => {
        const expectedMeshes =
          actorCapture.bodyType === 'river'
            ? provenance.riverSegmentMeshes?.map(({ meshGuid, meshDigest }) => ({
                meshGuid,
                meshDigest,
              }))
            : provenance.meshGuid && provenance.meshDigest
              ? [{ meshGuid: provenance.meshGuid, meshDigest: provenance.meshDigest }]
              : undefined;
        const sourceMeshGuids =
          actorCapture.bodyType === 'river'
            ? source.riverSegmentMeshGuids
            : [source.brushShapeMeshGuid];
        const decodedMeshes = input.meshes.map((item) =>
          decodeMeshBinary(item.payloadBytes, item.refs),
        );
        if (
          !expectedMeshes ||
          !sourceMeshGuids ||
          expectedMeshes.length !== input.meshes.length ||
          sourceMeshGuids.length !== input.meshes.length ||
          input.meshes.some((item, index) => {
            const expected = requireWaterValue(expectedMeshes[index]);
            const decoded = decodedMeshes[index];
            return (
              item.meshGuid !== expected.meshGuid ||
              sourceMeshGuids[index] !== item.meshGuid ||
              digest(item.payloadBytes) !== expected.meshDigest ||
              decoded === undefined ||
              !validMesh(decoded)
            );
          })
        )
          return err(
            new Error(
              `Water Brush frozen Pack mesh GUID/order/digest or decoded MeshAsset is invalid: ${input.actorId}`,
            ),
          );
        return ok(decodedMeshes);
      };
      const checkedMeshes = validateFrozenBodyMeshes(cache.actorCapture);
      if (!checkedMeshes.ok) return checkedMeshes;
      const decodedMeshes = checkedMeshes.value;
      const packMeshes = input.meshes.map((item, index) =>
        Object.freeze({ ...item, decoded: requireWaterValue(decodedMeshes[index]) }),
      );
      return ok(
        Object.freeze({
          actorId: input.actorId,
          kind: 'body',
          sourceDigest: cache.sourceInputDigest,
          captureGeneration,
          body: source,
          packMeshes: Object.freeze(packMeshes),
          worldMatrixM: provenance.worldMatrixM,
        }),
      );
    };
    return validateFrozenBodyActor(input);
  }
  if (
    cache.actorCapture.kind !== 'island' ||
    provenance.source !== 'island-spline' ||
    input.actorId === '' ||
    input.actorId !== cache.actorId ||
    input.sourceKey !== cache.actorCapture.sourceKey ||
    canonicalJson(input.spline) !== canonicalJson(cache.actorCapture.spline) ||
    input.heightOffsetM !== cache.actorCapture.heightOffsetM ||
    digest(new TextEncoder().encode(canonicalJson(input.spline))) !== provenance.splineDigest
  )
    return err(
      new Error(
        `Water Brush frozen Island spline/offset does not match its manifest provenance: ${input.actorId}`,
      ),
    );
  return ok(
    Object.freeze({
      actorId: input.actorId,
      kind: 'island',
      sourceDigest: cache.sourceInputDigest,
      captureGeneration,
      packMeshes: Object.freeze([]),
      islandSpline: input.spline,
      heightOffsetM: input.heightOffsetM,
      worldMatrixM: provenance.worldMatrixM,
    }),
  );
}
