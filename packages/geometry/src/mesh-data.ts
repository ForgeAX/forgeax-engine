import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  MESH_BIN_HEADER_BYTES,
  MESH_BIN_MORPH_CHANNELS,
  type MeshBinContractError,
  type MeshBinHeader,
  writeMeshBinHeader,
} from '@forgeax/engine-pack/mesh-bin-contract';
import {
  err,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { admitsMeshCardLayout, validateMeshCardLayout } from './mesh-card-artifact';
import { validateMeshCollisionAttachment } from './mesh-collision';
import { deriveVertexLayoutProjection } from './vertex-attribute-layout.js';

const nativeLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

type MeshPayloadIn = { readonly [Key in keyof MeshAsset]?: MeshAsset[Key] | undefined } & {
  readonly vertexCount?: number;
};

export type MeshBinEncodeError =
  | MeshBinContractError
  | {
      readonly code: 'mesh-bin-payload-invalid';
      readonly subject: 'mesh-bin';
      readonly sourceKey: string;
      readonly expected: string;
      readonly actual: string;
      readonly recovery: string;
    };

function failure(sourceKey: string, expected: string, actual: string): MeshBinEncodeError {
  return {
    code: 'mesh-bin-payload-invalid',
    subject: 'mesh-bin',
    sourceKey,
    expected,
    actual,
    recovery: 're-cook the source with its Meta sidecar through the build-time importer',
  };
}

function asAttributeMap(value: unknown): VertexAttributeMap {
  return (value ?? {}) as VertexAttributeMap;
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Float32Array || value instanceof Uint16Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, jsonValue(nested)]),
    );
  }
  return value;
}

function refsMeta(
  payload: MeshPayloadIn,
  refs: readonly string[],
  morphTargetMasks?: readonly number[],
): Record<string, unknown> {
  if (payload.submeshes?.some((submesh) => 'cardLayout' in submesh))
    throw new Error('section-owned card layouts are obsolete; recook the whole mesh');
  if (payload.cardLayout !== undefined) {
    const valid = validateMeshCardLayout(payload.cardLayout);
    if (!valid.ok) throw valid.error;
    if (
      !payload.submeshes?.length ||
      !admitsMeshCardLayout({
        submeshes: payload.submeshes,
        morphTargets: payload.morphTargets,
        skinIndex: payload.attributes?.skinIndex,
      })
    )
      throw new Error('card layouts require static triangle-list geometry');
  }
  if (payload.collision !== undefined) {
    const valid = validateMeshCollisionAttachment(payload as MeshAsset, payload.collision);
    if (!valid.ok) throw valid.error;
  }
  const materialSlots = (payload.materialSlots ?? [{ slotName: 'Default' }]).map(
    (slot, slotIndex) => {
      const defaultMaterial = slot.defaultMaterial;
      let defaultMaterialRef: number | undefined;
      if (defaultMaterial !== undefined) {
        const guid = AssetGuid.format(defaultMaterial);
        defaultMaterialRef = refs.findIndex((candidate) => candidate.toLowerCase() === guid);
        if (defaultMaterialRef < 0) {
          throw new Error(
            `material slot ${slotIndex} default material ${guid} is absent from refs`,
          );
        }
      }
      return {
        slotName: slot.slotName,
        ...(slot.sourceKey === undefined ? {} : { sourceKey: slot.sourceKey }),
        ...(defaultMaterialRef === undefined ? {} : { defaultMaterialRef }),
      };
    },
  );
  if (payload.lods !== undefined && payload.lods.length > 7) {
    throw new Error('MeshAsset LOD chain supports at most seven lower-detail levels');
  }
  let previousCoverage = 1;
  const seenLodGuids = new Set<string>();
  const lods = payload.lods?.map((lod, lodIndex) => {
    const guid = AssetGuid.format(lod.mesh).toLowerCase();
    const meshRef = refs.findIndex((candidate) => candidate.toLowerCase() === guid);
    if (meshRef < 0) {
      throw new Error(`LOD ${lodIndex} mesh ${guid} is absent from refs`);
    }
    if (seenLodGuids.has(guid)) {
      throw new Error(`LOD ${lodIndex} mesh ${guid} is duplicated`);
    }
    if (
      !Number.isFinite(lod.screenCoverage) ||
      lod.screenCoverage <= 0 ||
      lod.screenCoverage > 1 ||
      lod.screenCoverage >= previousCoverage
    ) {
      throw new Error(
        `LOD ${lodIndex} screenCoverage must be finite, in (0, 1], and strictly decreasing`,
      );
    }
    seenLodGuids.add(guid);
    previousCoverage = lod.screenCoverage;
    return { meshRef, screenCoverage: lod.screenCoverage };
  });
  if (
    payload.lodHysteresis !== undefined &&
    (!Number.isFinite(payload.lodHysteresis) ||
      payload.lodHysteresis < 0 ||
      payload.lodHysteresis >= 1)
  ) {
    throw new Error('lodHysteresis must be finite and in [0, 1)');
  }
  return {
    submeshes:
      payload.submeshes === undefined || payload.submeshes.length === 0
        ? [{ indexOffset: 0, indexCount: payload.indices?.length ?? 0, materialSlot: 0 }]
        : payload.submeshes,
    materialSlots,
    ...(payload.collision === undefined
      ? {}
      : {
          collision: {
            positions: Array.from(payload.collision.positions),
            indices: Array.from(payload.collision.indices),
          },
        }),
    ...(payload.cardLayout === undefined ? {} : { cardLayout: payload.cardLayout }),
    ...(payload.aabb === undefined ? {} : { aabb: jsonValue(payload.aabb) }),
    ...(morphTargetMasks === undefined ? {} : { morphTargetMasks }),
    ...(payload.morphWeights === undefined
      ? {}
      : { morphWeights: jsonValue(payload.morphWeights) }),
    ...(lods === undefined ? {} : { lods }),
    ...(payload.lodHysteresis === undefined ? {} : { lodHysteresis: payload.lodHysteresis }),
  };
}

interface PreparedMeshData {
  readonly projection: ReturnType<typeof deriveVertexLayoutProjection>;
  readonly attributes: VertexAttributeMap;
  readonly vertexCount: number;
  readonly vertexBytes: number;
  readonly indexCount: number;
  readonly indexWidth: 0 | 2 | 4;
  readonly indexBytes: number;
  readonly indices: MeshAsset['indices'] | undefined;
  readonly streams: readonly Float32Array[];
  readonly morphBytes: number;
  readonly metadata: Record<string, unknown>;
}

/** Canonical fields are finite and agree bit-for-bit with their interleaved projection. */
function validateMeshInterleaving(
  vertices: Float32Array,
  attributes: VertexAttributeMap,
  projection: ReturnType<typeof deriveVertexLayoutProjection>,
): void {
  const floats = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
  const shorts = new Uint16Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 2);
  for (const attribute of projection.attributes) {
    const value = attributes[attribute.key] as Float32Array | Uint16Array;
    const short = attribute.format === 'uint16x4';
    const width = short ? 2 : 4;
    const source = short
      ? value
      : new Uint32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    const target = short ? shorts : floats;
    const components = attribute.byteLength / width;
    const stride = projection.arrayStride / width;
    let index = 0;
    for (let base = attribute.offset / width; index < source.length; base += stride)
      for (let component = 0; component < components; component++, index++) {
        if (!short && !Number.isFinite(value[index]))
          throw new TypeError(`non-finite ${attribute.key}`);
        if (target[base + component] !== source[index])
          throw new TypeError(`inconsistent ${attribute.key} interleaving`);
      }
  }
}

/** Canonical mesh validation shared by file encoding and runtime preparation. */
export function prepareMeshData(
  payload: MeshPayloadIn,
  sourceKey: string,
  refs: readonly string[] = [],
): Result<PreparedMeshData, MeshBinEncodeError> {
  try {
    const vertices = payload.vertices;
    const indices = payload.indices;
    if (!(vertices instanceof Float32Array)) {
      return err(
        failure(sourceKey, 'Float32Array interleaved vertices', 'vertices is not Float32Array'),
      );
    }
    if (
      indices !== undefined &&
      !(indices instanceof Uint16Array || indices instanceof Uint32Array)
    ) {
      return err(
        failure(sourceKey, 'Uint16Array or Uint32Array indices', 'indices has an unsupported type'),
      );
    }
    const attributes = asAttributeMap(payload.attributes);
    const projection = deriveVertexLayoutProjection(attributes);
    if (projection.attributes.length === 0 || projection.arrayStride === 0) {
      return err(
        failure(
          sourceKey,
          'a non-empty canonical geometry projection',
          'projection has no attributes',
        ),
      );
    }
    const vertexCount = payload.vertexCount ?? vertices.byteLength / projection.arrayStride;
    if (!Number.isSafeInteger(vertexCount) || vertexCount < 0) {
      return err(
        failure(sourceKey, 'a non-negative safe vertex cardinality', `vertexCount=${vertexCount}`),
      );
    }
    if (vertices.byteLength !== vertexCount * projection.arrayStride) {
      return err(
        failure(
          sourceKey,
          `vertices.byteLength=${vertexCount * projection.arrayStride}`,
          `vertices.byteLength=${vertices.byteLength}; stride=${projection.arrayStride}`,
        ),
      );
    }
    for (const attribute of projection.attributes) {
      const value = attributes[attribute.key];
      const components = attribute.byteLength / (attribute.format === 'uint16x4' ? 2 : 4);
      if (
        value === undefined ||
        (!(value instanceof Float32Array) && !(value instanceof Uint16Array)) ||
        (attribute.format === 'uint16x4'
          ? !(value instanceof Uint16Array)
          : !(value instanceof Float32Array)) ||
        value.length !== vertexCount * components
      ) {
        return err(
          failure(
            sourceKey,
            `${attribute.key} cardinality=${vertexCount * components}`,
            `${attribute.key} cardinality=${value?.byteLength ?? 'missing'}`,
          ),
        );
      }
    }
    validateMeshInterleaving(vertices, attributes, projection);
    const vertexBytes = vertexCount * projection.arrayStride;
    const indexCount = indices?.length ?? 0;
    const indexWidth = indices === undefined || indexCount === 0 ? 0 : indices.BYTES_PER_ELEMENT;
    const indexBytes = indexCount * indexWidth;
    if (!Number.isSafeInteger(indexBytes) || indexBytes > 0xffffffff) {
      return err(failure(sourceKey, 'safe index payload byte length', `indexBytes=${indexBytes}`));
    }
    const streams: Float32Array[] = [];
    let morphBytes = 0;
    if (
      payload.morphTargets !== undefined &&
      (payload.morphTargets.length < 1 || payload.morphTargets.length > 8)
    )
      throw new TypeError('expected one to eight morph targets');
    const morphTargetMasks = payload.morphTargets?.map((target) => {
      let mask = 0;
      for (const key of Object.keys(target))
        if (!MESH_BIN_MORPH_CHANNELS.some((channel) => channel.key === key))
          throw new TypeError(`unknown morph channel ${key}`);
      for (const channel of MESH_BIN_MORPH_CHANNELS) {
        const values = target[channel.key];
        if (values === undefined) continue;
        if (!(values instanceof Float32Array) || values.length !== vertexCount * channel.components)
          throw new TypeError(`invalid morph ${channel.key} cardinality`);
        let zero = true;
        for (let i = 0; i < values.length; i++) {
          const value = values[i];
          if (!Number.isFinite(value)) throw new TypeError(`non-finite morph ${channel.key}`);
          if (zero && (value !== 0 || Object.is(value, -0))) zero = false;
        }
        mask |= channel.mask;
        if (zero) mask |= channel.mask << 3;
        else {
          streams.push(values);
          morphBytes += values.byteLength;
        }
      }
      if (!mask) throw new TypeError('empty morph target');
      return mask;
    });
    const weights = payload.morphWeights;
    if (
      weights !== undefined &&
      (!(weights instanceof Float32Array) ||
        (morphTargetMasks !== undefined && weights.length !== morphTargetMasks.length) ||
        !weights.every(Number.isFinite))
    )
      throw new TypeError('invalid morph weights');
    const metadata = refsMeta(payload, refs, morphTargetMasks);
    return ok({
      projection,
      attributes,
      vertexCount,
      vertexBytes,
      indexCount,
      indexWidth: indexWidth as 0 | 2 | 4,
      indexBytes,
      indices,
      streams,
      morphBytes,
      metadata,
    });
  } catch (error) {
    return err(
      failure(
        sourceKey,
        'valid canonical mesh payload',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

/** Encode canonical v5 bytes; published v4 assets remain readable. */
export function packMeshBin(
  payload: MeshPayloadIn,
  sourceKey: string,
  refs: readonly string[] = [],
): Result<Uint8Array, MeshBinEncodeError> {
  if (payload.distanceField !== undefined)
    return err(
      failure(
        sourceKey,
        'complete Mesh publication for distance field artifacts',
        'use the Mesh output producer to preserve the distance field attachment',
      ),
    );
  try {
    const prepared = prepareMeshData(payload, sourceKey, refs);
    if (!prepared.ok) return prepared;
    const {
      projection,
      attributes,
      vertexCount,
      vertexBytes,
      indexCount,
      indexWidth,
      indexBytes,
      indices,
      streams,
      morphBytes,
      metadata,
    } = prepared.value;
    const meta = new TextEncoder().encode(JSON.stringify(metadata));
    const header: MeshBinHeader = {
      version: 5,
      projectionVersion: projection.schemaVersion,
      mask: projection.mask,
      digest: projection.digest,
      stride: projection.arrayStride,
      vertexCount,
      vertexBytes,
      indexCount,
      indexWidth: indexWidth as 0 | 2 | 4,
      indexBytes,
      jsonBytes: meta.byteLength,
      morphBytes,
    };
    const total = MESH_BIN_HEADER_BYTES + vertexBytes + morphBytes + indexBytes + meta.byteLength;
    if (!Number.isSafeInteger(total) || total > 0xffffffff) {
      return err(failure(sourceKey, 'safe mesh binary byte length', `total=${total}`));
    }
    const out = new Uint8Array(total);
    writeMeshBinHeader(header, out);
    const interleaved = out.subarray(MESH_BIN_HEADER_BYTES, MESH_BIN_HEADER_BYTES + vertexBytes);
    if (nativeLittleEndian) {
      // Preparation proved every lane finite and bit-identical to attributes.
      // The canonical layout is packed, so the existing interleaving is the wire body.
      const vertices = payload.vertices as Float32Array;
      interleaved.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertexBytes));
    } else {
      const view = new DataView(interleaved.buffer, interleaved.byteOffset, vertexBytes);
      for (const attribute of projection.attributes) {
        const value = attributes[attribute.key] as Float32Array | Uint16Array;
        const short = attribute.format === 'uint16x4';
        const width = short ? 2 : 4;
        const components = attribute.byteLength / width;
        for (let vertex = 0; vertex < vertexCount; vertex++) {
          for (let component = 0; component < components; component++) {
            const offset = vertex * projection.arrayStride + attribute.offset + component * width;
            const scalar = value[vertex * components + component] as number;
            if (short) view.setUint16(offset, scalar, true);
            else view.setFloat32(offset, scalar, true);
          }
        }
      }
    }
    let offset = MESH_BIN_HEADER_BYTES + vertexBytes;
    const target = new DataView(out.buffer);
    for (const values of streams) {
      if (nativeLittleEndian)
        out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), offset);
      else
        for (let i = 0; i < values.length; i++)
          target.setFloat32(offset + i * 4, values[i] as number, true);
      offset += values.byteLength;
    }
    if (indices !== undefined && indexBytes > 0) {
      out.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset);
      offset += indexBytes;
    }
    out.set(meta, offset);
    return ok(out);
  } catch (error) {
    return err(
      failure(
        sourceKey,
        'valid canonical mesh payload',
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}
