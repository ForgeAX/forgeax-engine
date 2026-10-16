import {
  deriveVertexLayoutProjectionFromMask,
  type MeshCardLayout,
  unpackInterleavedVertexAttributes,
  type VertexLayoutProjection,
  validateMeshCardLayout,
} from '@forgeax/engine-geometry';
import {
  decodeMeshBinHeader,
  decodeMeshBinMorphs,
  MESH_BIN_HEADER_BYTES,
  type MeshBinHeader,
} from '@forgeax/engine-pack';
import { err, ok, type Result, type VertexAttributeMap } from '@forgeax/engine-types';
import { MeshBinAssetError } from '../errors/asset';

export interface UnpackedMeshBin {
  readonly version: 4 | 5;
  readonly projection: VertexLayoutProjection;
  readonly vertices: Float32Array;
  readonly attributes: VertexAttributeMap;
  readonly indices?: Uint16Array | Uint32Array;
  readonly submeshes: ReadonlyArray<Record<string, unknown>>;
  readonly cardLayout?: MeshCardLayout;
  readonly materialSlots: readonly {
    readonly slotName: string;
    readonly sourceKey?: string;
    readonly defaultMaterialRef?: number;
  }[];
  readonly aabb?: Float32Array;
  readonly morphTargets?: ReadonlyArray<Record<string, Float32Array>>;
  readonly morphWeights?: Float32Array;
  /** Lower-detail mesh references encoded as indexes into the enclosing pack refs table. */
  readonly lods?: readonly {
    readonly meshRef: number;
    readonly screenCoverage: number;
  }[];
  readonly lodHysteresis?: number;
}

function fail(
  sourceKey: string,
  expected: string,
  actual: string,
  header?: Partial<MeshBinHeader>,
  reason: import('@forgeax/engine-types').AssetMeshBinContractViolationReason = 'header-invalid',
  expectedFacts?: import('@forgeax/engine-types').AssetMeshBinContractFacts,
  actualFacts?: import('@forgeax/engine-types').AssetMeshBinContractFacts,
): Result<UnpackedMeshBin, MeshBinAssetError> {
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

export function unpackMeshBin(
  bytes: Uint8Array,
  sourceKey: string,
): Result<UnpackedMeshBin, MeshBinAssetError> {
  const headerResult = decodeMeshBinHeader(bytes, sourceKey);
  if (!headerResult.ok) {
    const reason =
      headerResult.error.code === 'mesh-bin-header-truncated'
        ? 'header-truncated'
        : headerResult.error.code === 'mesh-bin-version-unsupported'
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
      headerResult.error.expected,
      headerResult.error.actual,
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
  const header = headerResult.value;
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
  const payloadBytes =
    header.vertexBytes + header.morphBytes + header.indexBytes + header.jsonBytes;
  if (MESH_BIN_HEADER_BYTES + payloadBytes !== bytes.byteLength) {
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
  let meta: {
    submeshes?: ReadonlyArray<Record<string, unknown>>;
    cardLayout?: MeshCardLayout;
    materialSlots?: readonly {
      readonly slotName: string;
      readonly sourceKey?: string;
      readonly defaultMaterialRef?: number;
    }[];
    aabb?: readonly number[];
    morphTargets?: ReadonlyArray<Record<string, readonly number[]>>;
    morphWeights?: readonly number[];
    morphTargetMasks?: unknown;
    lods?: readonly {
      readonly meshRef?: unknown;
      readonly screenCoverage?: unknown;
    }[];
    lodHysteresis?: unknown;
  };
  try {
    meta = JSON.parse(new TextDecoder().decode(jsonBytes)) as typeof meta;
  } catch (error) {
    return fail(
      sourceKey,
      'valid mesh-bin JSON metadata',
      error instanceof Error ? error.message : String(error),
      header,
      'metadata-invalid',
      { field: 'metadata' },
      { field: 'metadata' },
    );
  }
  if (
    meta === null ||
    typeof meta !== 'object' ||
    Array.isArray(meta) ||
    !Array.isArray(meta.submeshes) ||
    meta.submeshes.length === 0 ||
    !Array.isArray(meta.materialSlots)
  ) {
    return fail(
      sourceKey,
      'non-empty submeshes and materialSlots metadata',
      'metadata table missing',
      header,
      'metadata-invalid',
      { field: 'metadata' },
      { field: 'metadata' },
    );
  }
  let lods:
    | readonly {
        readonly meshRef: number;
        readonly screenCoverage: number;
      }[]
    | undefined;
  if (meta.lods !== undefined) {
    if (!Array.isArray(meta.lods) || meta.lods.length > 7) {
      return fail(
        sourceKey,
        'LOD metadata to contain at most seven lower-detail levels',
        'lods is not an array or exceeds the level limit',
        header,
        'metadata-invalid',
        { field: 'metadata' },
        { field: 'metadata' },
      );
    }
    let previousCoverage = 1;
    const decodedLods: {
      readonly meshRef: number;
      readonly screenCoverage: number;
    }[] = [];
    for (const [lodIndex, rawLod] of meta.lods.entries()) {
      if (rawLod === null || typeof rawLod !== 'object') {
        return fail(
          sourceKey,
          `LOD ${lodIndex} metadata object`,
          'LOD entry is not an object',
          header,
          'metadata-invalid',
          { field: 'metadata' },
          { field: 'metadata' },
        );
      }
      const meshRef = rawLod.meshRef;
      const screenCoverage = rawLod.screenCoverage;
      if (!Number.isInteger(meshRef) || (meshRef as number) < 0) {
        return fail(
          sourceKey,
          `LOD ${lodIndex} meshRef to be a non-negative integer`,
          `meshRef=${String(meshRef)}`,
          header,
          'metadata-invalid',
          { field: 'metadata' },
          { field: 'metadata' },
        );
      }
      if (
        typeof screenCoverage !== 'number' ||
        !Number.isFinite(screenCoverage) ||
        screenCoverage <= 0 ||
        screenCoverage > 1 ||
        screenCoverage >= previousCoverage
      ) {
        return fail(
          sourceKey,
          `LOD ${lodIndex} screenCoverage to be finite, in (0, 1], and strictly decreasing`,
          `screenCoverage=${String(screenCoverage)}`,
          header,
          'metadata-invalid',
          { field: 'metadata' },
          { field: 'metadata' },
        );
      }
      decodedLods.push({ meshRef: meshRef as number, screenCoverage });
      previousCoverage = screenCoverage;
    }
    lods = decodedLods;
  }
  let lodHysteresis: number | undefined;
  if (meta.lodHysteresis !== undefined) {
    if (
      typeof meta.lodHysteresis !== 'number' ||
      !Number.isFinite(meta.lodHysteresis) ||
      meta.lodHysteresis < 0 ||
      meta.lodHysteresis >= 1
    ) {
      return fail(
        sourceKey,
        'lodHysteresis to be finite and in [0, 1)',
        `lodHysteresis=${String(meta.lodHysteresis)}`,
        header,
        'metadata-invalid',
        { field: 'metadata' },
        { field: 'metadata' },
      );
    }
    lodHysteresis = meta.lodHysteresis;
  }
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
            actualValue: Number.isNaN(component)
              ? 'nan'
              : component === Number.POSITIVE_INFINITY
                ? 'positive-infinity'
                : 'negative-infinity',
          },
        );
    }
  }
  let morphTargets: ReadonlyArray<Record<string, Float32Array>> | undefined;
  try {
    if (header.version === 5) {
      if (meta.morphTargets !== undefined)
        throw new TypeError('v5 morph targets must use binary lanes');
      morphTargets = decodeMeshBinMorphs(morphBytes, header.vertexCount, meta.morphTargetMasks);
    } else {
      if (meta.morphTargetMasks !== undefined)
        throw new TypeError('v4 cannot declare binary morph lanes');
      morphTargets = meta.morphTargets?.map((target) =>
        Object.fromEntries(
          Object.entries(target).map(([key, value]) => [key, new Float32Array(value)]),
        ),
      );
    }
  } catch (error) {
    return fail(
      sourceKey,
      'valid morph lane metadata and finite values',
      String(error),
      header,
      'metadata-invalid',
    );
  }
  if (
    meta.morphWeights !== undefined &&
    (!Array.isArray(meta.morphWeights) ||
      !meta.morphWeights.every(
        (value) => typeof value === 'number' && Number.isFinite(Math.fround(value)),
      ) ||
      (morphTargets !== undefined && meta.morphWeights.length !== morphTargets.length))
  )
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
  const mesh: UnpackedMeshBin = {
    version: header.version,
    projection,
    vertices,
    attributes,
    ...(indices === undefined ? {} : { indices }),
    submeshes: meta.submeshes,
    ...(meta.cardLayout === undefined ? {} : { cardLayout: meta.cardLayout }),
    materialSlots: meta.materialSlots,
    ...(meta.aabb === undefined ? {} : { aabb: new Float32Array(meta.aabb) }),
    ...(morphTargets === undefined ? {} : { morphTargets }),
    ...(meta.morphWeights === undefined
      ? {}
      : { morphWeights: new Float32Array(meta.morphWeights) }),
    ...(lods === undefined ? {} : { lods }),
    ...(lodHysteresis === undefined ? {} : { lodHysteresis }),
  };
  return ok(mesh);
}
