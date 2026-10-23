import {
  decodeMeshBinHeader,
  decodeMeshBinMorphs,
  MESH_BIN_HEADER_BYTES,
  type MeshBinHeader,
} from '@forgeax/engine-pack/mesh-bin-contract';
import {
  err,
  ok,
  type Result,
  type ResultErr,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { validateMeshCardLayout } from '../mesh-card-artifact';
import type { MeshCardLayout } from '../mesh-card-layout';
import {
  deriveVertexLayoutProjectionFromMask,
  unpackInterleavedVertexAttributes,
  type VertexLayoutProjection,
} from '../vertex-attribute-layout';
import { MeshBinAssetError } from './mesh-bin-error';

export interface UnpackedMeshBin {
  readonly version: 4 | 5;
  readonly projection: VertexLayoutProjection;
  readonly vertices: Float32Array;
  readonly attributes: VertexAttributeMap;
  readonly indices?: Uint16Array | Uint32Array;
  readonly submeshes: ReadonlyArray<Record<string, unknown>>;
  readonly cardLayout?: MeshCardLayout;
  /** Raw attachment; the ordinary Mesh loader validates it against decoded geometry. */
  readonly collision?: unknown;
  readonly materialSlots: readonly {
    readonly slotName: string;
    readonly sourceKey?: string;
    readonly defaultMaterialRef?: number;
  }[];
  readonly aabb?: Float32Array;
  readonly morphTargets?: ReadonlyArray<Record<string, Float32Array>>;
  readonly morphWeights?: Float32Array;
  /** Lower-detail mesh references encoded as indexes into the enclosing pack refs table. */
  readonly lods?: readonly MeshBinLod[];
  readonly lodHysteresis?: number;
}

interface MeshBinLod {
  readonly meshRef: number;
  readonly screenCoverage: number;
}

type MeshBinFailure = ResultErr<MeshBinAssetError>;

function fail(
  sourceKey: string,
  expected: string,
  actual: string,
  header?: Partial<MeshBinHeader>,
  reason: import('@forgeax/engine-types').AssetMeshBinContractViolationReason = 'header-invalid',
  expectedFacts?: import('@forgeax/engine-types').AssetMeshBinContractFacts,
  actualFacts?: import('@forgeax/engine-types').AssetMeshBinContractFacts,
): MeshBinFailure {
  return err(
    new MeshBinAssetError({
      sourceKey,
      expected,
      actual,
      ...(header === undefined ? {} : { header }),
      reason,
      ...(expectedFacts === undefined ? {} : { expectedFacts }),
      ...(actualFacts === undefined ? {} : { actualFacts }),
    }),
  );
}

function metadataFailure(
  sourceKey: string,
  expected: string,
  actual: string,
  header: MeshBinHeader,
): MeshBinFailure {
  return fail(
    sourceKey,
    expected,
    actual,
    header,
    'metadata-invalid',
    { field: 'metadata' },
    { field: 'metadata' },
  );
}

interface MeshBinMetadata {
  submeshes?: ReadonlyArray<Record<string, unknown>>;
  cardLayout?: MeshCardLayout;
  collision?: unknown;
  materialSlots?: UnpackedMeshBin['materialSlots'];
  aabb?: readonly number[];
  morphTargets?: ReadonlyArray<Record<string, readonly number[]>>;
  morphWeights?: readonly number[];
  morphTargetMasks?: unknown;
  lods?: readonly {
    readonly meshRef?: unknown;
    readonly screenCoverage?: unknown;
  }[];
  lodHysteresis?: unknown;
}

interface MeshBinTables extends MeshBinMetadata {
  submeshes: ReadonlyArray<Record<string, unknown>>;
  materialSlots: UnpackedMeshBin['materialSlots'];
}

interface MeshBinPayload {
  readonly vertices: Float32Array;
  readonly morphBytes: Uint8Array;
  readonly indices: Uint16Array | Uint32Array | undefined;
  readonly jsonBytes: Uint8Array;
}

function headerFailure(
  bytes: Uint8Array,
  sourceKey: string,
  error: { readonly code: string; readonly expected: string; readonly actual: string },
): MeshBinFailure {
  const reason =
    error.code === 'mesh-bin-header-truncated'
      ? 'header-truncated'
      : error.code === 'mesh-bin-version-unsupported'
        ? 'version-unsupported'
        : 'header-invalid';
  const actualFacts = {
    byteLength: bytes.byteLength,
    ...(bytes.byteLength >= 4
      ? {
          version: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
            0,
            true,
          ),
        }
      : {}),
  };
  return fail(
    sourceKey,
    error.expected,
    error.actual,
    undefined,
    reason,
    reason === 'header-truncated'
      ? { field: 'byteLength', byteLength: MESH_BIN_HEADER_BYTES }
      : reason === 'version-unsupported'
        ? { field: 'version', version: 5 }
        : undefined,
    actualFacts,
  );
}

/** The header's vertex projection must be the one geometry derives from its mask. */
function projectionFor(
  header: MeshBinHeader,
  sourceKey: string,
): Result<VertexLayoutProjection, MeshBinAssetError> {
  const projectionResult = deriveVertexLayoutProjectionFromMask(header.mask);
  if (!projectionResult.ok) {
    return fail(
      sourceKey,
      projectionResult.error.expected,
      `mask=${header.mask}`,
      header,
      'projection-mismatch',
      {
        field: 'mask',
        mask: projectionResult.error.detail.knownMask,
      },
      {
        field: 'mask',
        mask: header.mask,
        projectionVersion: header.projectionVersion,
        stride: header.stride,
        digest: header.digest,
      },
    );
  }
  const projection = projectionResult.value;
  if (
    projection.schemaVersion !== header.projectionVersion ||
    projection.arrayStride !== header.stride ||
    projection.digest !== header.digest
  ) {
    return fail(
      sourceKey,
      'wire projection version, mask, stride, and digest to match geometry projection',
      `projection=${projection.schemaVersion}/${projection.arrayStride}/${projection.digest}; wire=${header.projectionVersion}/${header.stride}/${header.digest}`,
      header,
      'projection-mismatch',
      {
        field: 'projectionVersion',
        projectionVersion: projection.schemaVersion,
        mask: projection.mask,
        stride: projection.arrayStride,
        digest: projection.digest,
      },
    );
  }
  return ok(projection);
}

function payloadLengthFailure(
  bytes: Uint8Array,
  header: MeshBinHeader,
  sourceKey: string,
): MeshBinFailure | undefined {
  const payloadBytes =
    header.vertexBytes + header.morphBytes + header.indexBytes + header.jsonBytes;
  if (MESH_BIN_HEADER_BYTES + payloadBytes === bytes.byteLength) return undefined;
  return fail(
    sourceKey,
    `exactly ${MESH_BIN_HEADER_BYTES + payloadBytes} bytes`,
    `${bytes.byteLength} bytes`,
    header,
    'payload-length-mismatch',
    { field: 'byteLength', byteLength: MESH_BIN_HEADER_BYTES + payloadBytes },
    {
      field: 'byteLength',
      byteLength: bytes.byteLength,
      vertexBytes: header.vertexBytes,
      indexBytes: header.indexBytes,
      jsonBytes: header.jsonBytes,
    },
  );
}

/** Copies the length-checked vertex, morph, index and JSON sections out of the container. */
function splitPayload(bytes: Uint8Array, header: MeshBinHeader): MeshBinPayload {
  let offset = MESH_BIN_HEADER_BYTES;
  const vertexBytes = bytes.subarray(offset, offset + header.vertexBytes);
  const vertices = new Float32Array(vertexBytes.byteLength / 4);
  new Uint8Array(vertices.buffer).set(vertexBytes);
  offset += header.vertexBytes;
  const morphBytes = bytes.subarray(offset, offset + header.morphBytes);
  offset += header.morphBytes;
  let indices: Uint16Array | Uint32Array | undefined;
  if (header.indexCount > 0) {
    const indexBytes = bytes.subarray(offset, offset + header.indexBytes);
    if (header.indexWidth === 2) {
      indices = new Uint16Array(header.indexCount);
      new Uint8Array(indices.buffer).set(indexBytes);
    } else {
      indices = new Uint32Array(header.indexCount);
      new Uint8Array(indices.buffer).set(indexBytes);
    }
    offset += header.indexBytes;
  }
  const jsonBytes = bytes.subarray(offset, offset + header.jsonBytes);
  return { vertices, morphBytes, indices, jsonBytes };
}

function hasMeshBinTables(meta: MeshBinMetadata): meta is MeshBinTables {
  return (
    meta !== null &&
    typeof meta === 'object' &&
    !Array.isArray(meta) &&
    Array.isArray(meta.submeshes) &&
    meta.submeshes.length > 0 &&
    Array.isArray(meta.materialSlots)
  );
}

function parseMetadata(
  jsonBytes: Uint8Array,
  header: MeshBinHeader,
  sourceKey: string,
): Result<MeshBinTables, MeshBinAssetError> {
  let meta: MeshBinMetadata;
  try {
    meta = JSON.parse(new TextDecoder().decode(jsonBytes)) as MeshBinMetadata;
  } catch (error) {
    return metadataFailure(
      sourceKey,
      'valid mesh-bin JSON metadata',
      error instanceof Error ? error.message : String(error),
      header,
    );
  }
  if (!hasMeshBinTables(meta)) {
    return metadataFailure(
      sourceKey,
      'non-empty submeshes and materialSlots metadata',
      'metadata table missing',
      header,
    );
  }
  return ok(meta);
}

function isScreenCoverageBelow(value: unknown, previousCoverage: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 1 &&
    value < previousCoverage
  );
}

function decodeLods(
  raw: MeshBinMetadata['lods'],
  header: MeshBinHeader,
  sourceKey: string,
): Result<readonly MeshBinLod[] | undefined, MeshBinAssetError> {
  if (raw === undefined) return ok(undefined);
  if (!Array.isArray(raw) || raw.length > 7) {
    return metadataFailure(
      sourceKey,
      'LOD metadata to contain at most seven lower-detail levels',
      'lods is not an array or exceeds the level limit',
      header,
    );
  }
  let previousCoverage = 1;
  const decodedLods: MeshBinLod[] = [];
  for (const [lodIndex, rawLod] of raw.entries()) {
    if (rawLod === null || typeof rawLod !== 'object') {
      return metadataFailure(
        sourceKey,
        `LOD ${lodIndex} metadata object`,
        'LOD entry is not an object',
        header,
      );
    }
    const meshRef = rawLod.meshRef;
    const screenCoverage = rawLod.screenCoverage;
    if (!Number.isInteger(meshRef) || (meshRef as number) < 0) {
      return metadataFailure(
        sourceKey,
        `LOD ${lodIndex} meshRef to be a non-negative integer`,
        `meshRef=${String(meshRef)}`,
        header,
      );
    }
    if (!isScreenCoverageBelow(screenCoverage, previousCoverage)) {
      return metadataFailure(
        sourceKey,
        `LOD ${lodIndex} screenCoverage to be finite, in (0, 1], and strictly decreasing`,
        `screenCoverage=${String(screenCoverage)}`,
        header,
      );
    }
    decodedLods.push({ meshRef: meshRef as number, screenCoverage });
    previousCoverage = screenCoverage;
  }
  return ok(decodedLods);
}

function decodeLodHysteresis(
  value: unknown,
  header: MeshBinHeader,
  sourceKey: string,
): Result<number | undefined, MeshBinAssetError> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    return metadataFailure(
      sourceKey,
      'lodHysteresis to be finite and in [0, 1)',
      `lodHysteresis=${String(value)}`,
      header,
    );
  }
  return ok(value);
}

function nonFiniteKind(component: number): 'nan' | 'positive-infinity' | 'negative-infinity' {
  if (Number.isNaN(component)) return 'nan';
  return component === Number.POSITIVE_INFINITY ? 'positive-infinity' : 'negative-infinity';
}

/** Every projected attribute must decode, and every numeric component must be finite. */
function decodeAttributes(
  vertices: Float32Array,
  projection: VertexLayoutProjection,
  header: MeshBinHeader,
  sourceKey: string,
): Result<VertexAttributeMap, MeshBinAssetError> {
  const attributes = unpackInterleavedVertexAttributes(vertices, projection);
  if (attributes === undefined)
    return fail(
      sourceKey,
      'whole canonical vertices',
      'vertex stride mismatch',
      header,
      'attribute-invalid',
    );
  for (const attribute of projection.attributes) {
    const value = attributes[attribute.key];
    if (value === undefined)
      return fail(
        sourceKey,
        `decoded ${attribute.key} attribute`,
        'attribute missing',
        header,
        'attribute-invalid',
        {
          field: 'attribute',
          attribute: attribute.key,
          expectedLength:
            header.vertexCount * (attribute.byteLength / (attribute.format === 'uint16x4' ? 2 : 4)),
        },
        {
          field: 'attribute',
          attribute: attribute.key,
          mask: header.mask,
          stride: header.stride,
          vertexCount: header.vertexCount,
        },
      );
    if (value instanceof ArrayBuffer) continue;
    for (let elementIndex = 0; elementIndex < value.length; elementIndex++) {
      const component = value[elementIndex] as number;
      if (!Number.isFinite(component))
        return fail(
          sourceKey,
          'finite vertex payload',
          `non-finite ${attribute.key}`,
          header,
          'payload-non-finite',
          { field: 'attribute', attribute: attribute.key },
          {
            field: 'attribute',
            attribute: attribute.key,
            mask: header.mask,
            stride: header.stride,
            vertexCount: header.vertexCount,
            elementIndex,
            actualValue: nonFiniteKind(component),
          },
        );
    }
  }
  return ok(attributes);
}

/** v5 carries morphs in binary lanes; v4 carries them as JSON number arrays. */
function decodeMorphTargets(
  meta: MeshBinMetadata,
  morphBytes: Uint8Array,
  header: MeshBinHeader,
  sourceKey: string,
): Result<ReadonlyArray<Record<string, Float32Array>> | undefined, MeshBinAssetError> {
  try {
    if (header.version === 5) {
      if (meta.morphTargets !== undefined)
        throw new TypeError('v5 morph targets must use binary lanes');
      return ok(decodeMeshBinMorphs(morphBytes, header.vertexCount, meta.morphTargetMasks));
    }
    if (meta.morphTargetMasks !== undefined)
      throw new TypeError('v4 cannot declare binary morph lanes');
    return ok(
      meta.morphTargets?.map((target) =>
        Object.fromEntries(
          Object.entries(target).map(([key, value]) => [key, new Float32Array(value)]),
        ),
      ),
    );
  } catch (error) {
    return fail(
      sourceKey,
      'valid morph lane metadata and finite values',
      String(error),
      header,
      'metadata-invalid',
    );
  }
}

function morphWeightsMatch(
  weights: MeshBinMetadata['morphWeights'],
  morphTargets: ReadonlyArray<Record<string, Float32Array>> | undefined,
): boolean {
  return (
    weights === undefined ||
    (Array.isArray(weights) &&
      weights.every((value) => typeof value === 'number' && Number.isFinite(Math.fround(value))) &&
      (morphTargets === undefined || weights.length === morphTargets.length))
  );
}

export function unpackMeshBin(
  bytes: Uint8Array,
  sourceKey = '<unknown mesh source>',
): Result<UnpackedMeshBin, MeshBinAssetError> {
  const headerResult = decodeMeshBinHeader(bytes, sourceKey);
  if (!headerResult.ok) return headerFailure(bytes, sourceKey, headerResult.error);
  const header = headerResult.value;
  const projection = projectionFor(header, sourceKey);
  if (!projection.ok) return projection;
  const lengthFailure = payloadLengthFailure(bytes, header, sourceKey);
  if (lengthFailure !== undefined) return lengthFailure;
  const { vertices, morphBytes, indices, jsonBytes } = splitPayload(bytes, header);
  const metaResult = parseMetadata(jsonBytes, header, sourceKey);
  if (!metaResult.ok) return metaResult;
  const meta = metaResult.value;
  const lods = decodeLods(meta.lods, header, sourceKey);
  if (!lods.ok) return lods;
  const lodHysteresis = decodeLodHysteresis(meta.lodHysteresis, header, sourceKey);
  if (!lodHysteresis.ok) return lodHysteresis;
  const attributes = decodeAttributes(vertices, projection.value, header, sourceKey);
  if (!attributes.ok) return attributes;
  const morphTargets = decodeMorphTargets(meta, morphBytes, header, sourceKey);
  if (!morphTargets.ok) return morphTargets;
  if (!morphWeightsMatch(meta.morphWeights, morphTargets.value))
    return fail(
      sourceKey,
      'finite morph weights matching the target count',
      'invalid morph weights',
      header,
      'metadata-invalid',
    );
  if (meta.cardLayout !== undefined && !validateMeshCardLayout(meta.cardLayout).ok)
    return fail(
      sourceKey,
      'valid whole-mesh card layout',
      'invalid card metadata',
      header,
      'metadata-invalid',
    );
  return ok({
    version: header.version,
    projection: projection.value,
    vertices,
    attributes: attributes.value,
    ...(indices === undefined ? {} : { indices }),
    submeshes: meta.submeshes,
    ...(meta.cardLayout === undefined ? {} : { cardLayout: meta.cardLayout }),
    ...(meta.collision === undefined ? {} : { collision: meta.collision }),
    materialSlots: meta.materialSlots,
    ...(meta.aabb === undefined ? {} : { aabb: new Float32Array(meta.aabb) }),
    ...(morphTargets.value === undefined ? {} : { morphTargets: morphTargets.value }),
    ...(meta.morphWeights === undefined
      ? {}
      : { morphWeights: new Float32Array(meta.morphWeights) }),
    ...(lods.value === undefined ? {} : { lods: lods.value }),
    ...(lodHysteresis.value === undefined ? {} : { lodHysteresis: lodHysteresis.value }),
  });
}
