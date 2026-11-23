import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  MESH_BIN_HEADER_BYTES,
  MESH_BIN_MORPH_CHANNELS,
  MESH_BIN_VERSION,
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
import { isStandaloneStaticMesh } from './mesh-draw-description';
import {
  copyMeshAttributeStorage,
  interleavedMesh,
  interleavedMeshFiniteFailure,
  staticMeshStreamsFiniteFailure,
} from './mesh-storage';
import {
  deriveVertexLayoutProjection,
  elementView,
  prepareStaticMeshVertexStreams,
  projectStaticMeshVertexStreams,
  type VertexLayoutProjection,
  vertexAttributeArrayType,
} from './vertex-attribute-layout.js';

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
  if (value instanceof Float32Array || value instanceof Uint16Array || value instanceof Uint32Array)
    return Array.from(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, jsonValue(nested)]),
    );
  }
  return value;
}

function validateMeshMetadata(payload: MeshPayloadIn): void {
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

  if ((payload.lods?.length ?? 0) > 7)
    throw new TypeError('MeshAsset LOD chain supports at most seven lower-detail levels');
  let previous = 1;
  const seen = new Set<string | number>();
  for (const lod of payload.lods ?? []) {
    if (
      typeof lod.mesh === 'number'
        ? !Number.isSafeInteger(lod.mesh) || lod.mesh <= 0 || lod.mesh > 0xffff_ffff
        : !(lod.mesh instanceof Uint8Array) || lod.mesh.byteLength !== 16
    )
      throw new TypeError('MeshAsset LOD references require a runtime handle or a source GUID');
    const identity =
      typeof lod.mesh === 'number' ? lod.mesh : AssetGuid.format(lod.mesh).toLowerCase();
    if (seen.has(identity)) throw new TypeError('MeshAsset LOD references must be unique');
    seen.add(identity);
    if (
      !Number.isFinite(lod.screenCoverage) ||
      lod.screenCoverage <= 0 ||
      lod.screenCoverage >= previous
    )
      throw new TypeError(
        'LOD screenCoverage must be finite, positive and strictly decreasing below one',
      );
    previous = lod.screenCoverage;
  }
  if (
    payload.lodHysteresis !== undefined &&
    (!Number.isFinite(payload.lodHysteresis) ||
      payload.lodHysteresis < 0 ||
      payload.lodHysteresis >= 1)
  )
    throw new TypeError('lodHysteresis must be finite and in [0, 1)');
}

function refsMeta(
  payload: MeshPayloadIn,
  refs: readonly string[],
  morphTargetMasks?: readonly number[],
): Record<string, unknown> {
  const materialSlots = (payload.materialSlots ?? [{ slotName: 'Default' }]).map(
    (slot, slotIndex) => {
      const defaultMaterial = slot.defaultMaterial;
      let defaultMaterialRef: number | undefined;
      if (defaultMaterial !== undefined) {
        if (typeof defaultMaterial === 'number')
          throw new TypeError('Pack Mesh material references require source GUIDs');
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
  const lods = payload.lods?.map((lod, lodIndex) => {
    if (typeof lod.mesh === 'number')
      throw new TypeError('Pack Mesh LOD references require source GUIDs');
    const guid = AssetGuid.format(lod.mesh).toLowerCase();
    const meshRef = refs.findIndex((candidate) => candidate.toLowerCase() === guid);
    if (meshRef < 0) throw new Error(`LOD ${lodIndex} mesh ${guid} is absent from refs`);
    return { meshRef, screenCoverage: lod.screenCoverage };
  });
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
  readonly morphTargetMasks: readonly number[] | undefined;
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
    const value = elementView(attributes[attribute.key], attribute.format);
    if (value === undefined) throw new TypeError(`invalid ${attribute.key} storage`);
    // Monomorphic integer loops: one array kind per loop keeps this linear pass
    // on the fast path for large runtime meshes (it runs on every mesh create).
    if (attribute.format === 'unorm8x4') {
      if (!(value instanceof Uint8Array)) throw new TypeError('invalid skinWeight storage');
      const target = new Uint8Array(vertices.buffer, vertices.byteOffset, vertices.byteLength);
      for (let row = 0; row < value.length / 4; row++)
        for (let lane = 0; lane < 4; lane++)
          if (
            value[row * 4 + lane] !== target[row * projection.arrayStride + attribute.offset + lane]
          )
            throw new TypeError('inconsistent skinWeight interleaving');
      continue;
    }
    if (attribute.format === 'uint16x4' || attribute.format === 'unorm16x4') {
      if (!(value instanceof Uint16Array)) throw new TypeError(`invalid ${attribute.key} storage`);
      const stride = projection.arrayStride / 2;
      if (!sameShortChannel(shorts, value, attribute.offset / 2, stride, attribute.byteLength / 2))
        throw new TypeError(`inconsistent ${attribute.key} interleaving`);
      continue;
    }
    const source = new Uint32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    if (attribute.format === 'uint32') {
      for (let i = 0; i < source.length; i++)
        if (source[i] !== floats[attribute.offset / 4 + (i * projection.arrayStride) / 4])
          throw new TypeError('inconsistent tangentFrame interleaving');
      continue;
    }
    const failure = floatChannelFailure(
      floats,
      source,
      attribute.offset / 4,
      projection.arrayStride / 4,
      attribute.byteLength / 4,
    );
    if (failure === 1) throw new TypeError(`non-finite ${attribute.key}`);
    if (failure === 2) throw new TypeError(`inconsistent ${attribute.key} interleaving`);
  }
}

/** 0 when every float32 bit pattern is finite and equals its interleaved copy; 1 non-finite; 2 mismatch. */
function floatChannelFailure(
  target: Uint32Array,
  source: Uint32Array,
  base: number,
  stride: number,
  components: number,
): 0 | 1 | 2 {
  const length = source.length;
  // A valid channel is the only hot case (this runs on every runtime mesh
  // create), so the common component counts are scanned without a branch per
  // value: an all-ones exponent carries into the sign bit of `exponent`, and any
  // differing bit survives in `difference`. Callers have already matched both
  // cardinalities, so every row read is in bounds.
  let exponent = 0;
  let difference = 0;
  if (components === 3) {
    for (let index = 0, row = base; index < length; index += 3, row += stride) {
      const x = source[index] as number;
      const y = source[index + 1] as number;
      const z = source[index + 2] as number;
      exponent |=
        ((x & 0x7f800000) + 0x00800000) |
        ((y & 0x7f800000) + 0x00800000) |
        ((z & 0x7f800000) + 0x00800000);
      difference |=
        ((target[row] as number) ^ x) |
        ((target[row + 1] as number) ^ y) |
        ((target[row + 2] as number) ^ z);
    }
  } else if (components === 2) {
    for (let index = 0, row = base; index < length; index += 2, row += stride) {
      const x = source[index] as number;
      const y = source[index + 1] as number;
      exponent |= ((x & 0x7f800000) + 0x00800000) | ((y & 0x7f800000) + 0x00800000);
      difference |= ((target[row] as number) ^ x) | ((target[row + 1] as number) ^ y);
    }
  } else if (components === 4) {
    for (let index = 0, row = base; index < length; index += 4, row += stride) {
      const x = source[index] as number;
      const y = source[index + 1] as number;
      const z = source[index + 2] as number;
      const w = source[index + 3] as number;
      exponent |=
        ((x & 0x7f800000) + 0x00800000) |
        ((y & 0x7f800000) + 0x00800000) |
        ((z & 0x7f800000) + 0x00800000) |
        ((w & 0x7f800000) + 0x00800000);
      difference |=
        ((target[row] as number) ^ x) |
        ((target[row + 1] as number) ^ y) |
        ((target[row + 2] as number) ^ z) |
        ((target[row + 3] as number) ^ w);
    }
  } else {
    exponent = -1;
  }
  if (exponent >= 0 && difference === 0) return 0;
  // Rare path: name the first failure in channel order.
  let index = 0;
  for (let row = base; index < length; row += stride)
    for (let component = 0; component < components; component++, index++) {
      const bits = source[index] as number;
      // An all-ones exponent is Infinity or NaN; Number.isFinite rejects both.
      if ((bits & 0x7f800000) === 0x7f800000) return 1;
      if (target[row + component] !== bits) return 2;
    }
  return 0;
}

function sameShortChannel(
  target: Uint16Array,
  source: Uint16Array,
  base: number,
  stride: number,
  components: number,
): boolean {
  const length = source.length;
  let index = 0;
  for (let row = base; index < length; row += stride)
    for (let component = 0; component < components; component++, index++)
      if (target[row + component] !== source[index]) return false;
  return true;
}

/** Runtime declarations carry layout only; validate their packed float lanes once. */
function validatePackedStorage(
  vertices: Float32Array,
  attributes: VertexAttributeMap,
  projection: VertexLayoutProjection,
  staticStreams: boolean,
): void {
  for (const attribute of projection.attributes) {
    const value = attributes[attribute.key];
    const ArrayType = vertexAttributeArrayType(attribute.format);
    if (!(value instanceof ArrayType) || value.length !== 0 || value.buffer.byteLength !== 0)
      throw new TypeError(`packed ${attribute.key} requires an empty canonical layout declaration`);
  }
  // Integer skin lanes can contain float NaN bit patterns.
  const nonfinite = staticStreams
    ? staticMeshStreamsFiniteFailure(vertices, projection)
    : interleavedMeshFiniteFailure(vertices, projection);
  if (nonfinite !== undefined) throw new TypeError(`non-finite ${nonfinite}`);
}

/** Authored channels must cover every vertex before packed-row parity is checked. */
function validateAuthoredCardinality(
  attributes: VertexAttributeMap,
  projection: VertexLayoutProjection,
  vertexCount: number,
  sourceKey: string,
): Result<void, MeshBinEncodeError> {
  for (const attribute of projection.attributes) {
    const value = elementView(attributes[attribute.key], attribute.format);
    const ArrayType = vertexAttributeArrayType(attribute.format);
    const components = attribute.byteLength / ArrayType.BYTES_PER_ELEMENT;
    if (!(value instanceof ArrayType) || value.length !== vertexCount * components)
      return err(
        failure(
          sourceKey,
          `${attribute.key} cardinality=${vertexCount * components}`,
          `${attribute.key} cardinality=${value?.byteLength ?? 'missing'}`,
        ),
      );
  }
  return ok(undefined);
}

function hasConflictingDirectionChannels(attributes: VertexAttributeMap): boolean {
  return (
    attributes.tangentFrame !== undefined &&
    (attributes.normal !== undefined || attributes.tangent !== undefined)
  );
}

function validateVertexStorage(
  payload: MeshPayloadIn,
  vertices: Float32Array,
  attributes: VertexAttributeMap,
  projection: VertexLayoutProjection,
  vertexCount: number,
  sourceKey: string,
): Result<void, MeshBinEncodeError> {
  const storage = payload.attributeStorage;
  if (storage !== undefined && storage !== 'interleaved' && storage !== 'static-streams')
    throw new TypeError('unsupported mesh attribute storage');
  if (
    storage === 'static-streams' &&
    (payload.kind !== 'mesh' || !isStandaloneStaticMesh(payload as MeshAsset))
  )
    throw new TypeError('static streams require standalone rigid triangle geometry');
  if (storage !== undefined) {
    validatePackedStorage(vertices, attributes, projection, storage === 'static-streams');
  } else {
    const cardinality = validateAuthoredCardinality(attributes, projection, vertexCount, sourceKey);
    if (!cardinality.ok) return cardinality;
    validateMeshInterleaving(vertices, attributes, projection);
  }
  return ok(undefined);
}

/** Canonical mesh validation shared by file encoding and runtime preparation. */
export function prepareMeshData(
  payload: MeshPayloadIn,
  sourceKey: string,
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
    if (hasConflictingDirectionChannels(attributes))
      return err(
        failure(
          sourceKey,
          'one canonical tangent-frame representation',
          'packed and float direction channels coexist',
        ),
      );
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
    const storage = validateVertexStorage(
      payload,
      vertices,
      attributes,
      projection,
      vertexCount,
      sourceKey,
    );
    if (!storage.ok) return storage;
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
    validateMeshMetadata(payload);
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
      morphTargetMasks,
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

function writeMeshVertexBody(
  payload: MeshPayloadIn,
  prepared: PreparedMeshData,
  interleaved: Uint8Array,
): void {
  const { vertexBytes, projection, attributes, vertexCount } = prepared;
  if (nativeLittleEndian) {
    // Preparation proved every lane finite and bit-identical to attributes.
    // The canonical layout is packed, so the existing interleaving is the wire body.
    const vertices = payload.vertices as Float32Array;
    interleaved.set(new Uint8Array(vertices.buffer, vertices.byteOffset, vertexBytes));
  } else {
    const view = new DataView(interleaved.buffer, interleaved.byteOffset, vertexBytes);
    for (const attribute of projection.attributes) {
      const value =
        payload.attributeStorage === 'interleaved'
          ? copyMeshAttributeStorage(payload as MeshAsset, attribute.key)
          : elementView(attributes[attribute.key], attribute.format);
      if (value === undefined) throw new TypeError(`invalid ${attribute.key} storage`);
      const ArrayType = vertexAttributeArrayType(attribute.format);
      const width = ArrayType.BYTES_PER_ELEMENT;
      const components = attribute.byteLength / width;
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        for (let component = 0; component < components; component++) {
          const offset = vertex * projection.arrayStride + attribute.offset + component * width;
          const scalar = value[vertex * components + component] as number;
          if (attribute.format === 'uint32') view.setUint32(offset, scalar, true);
          else if (width === 1) view.setUint8(offset, scalar);
          else if (width === 2) view.setUint16(offset, scalar, true);
          else view.setFloat32(offset, scalar, true);
        }
      }
    }
  }
}

function writePhysicalMeshVertices(
  payload: MeshPayloadIn,
  prepared: PreparedMeshData,
  target: Uint8Array,
  split: boolean,
): void {
  const alreadySplit = payload.attributeStorage === 'static-streams';
  if (!split) {
    const canonical = alreadySplit ? interleavedMesh(payload as MeshAsset) : payload;
    writeMeshVertexBody(canonical, prepared, target);
    return;
  }
  const source = payload.vertices as Float32Array;
  if (alreadySplit) {
    target.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    return;
  }
  const plan = prepareStaticMeshVertexStreams(source, prepared.projection);
  if (plan === undefined) throw new TypeError('invalid static stream layout');
  plan.pack(undefined, new Uint32Array(target.buffer, target.byteOffset, source.length));
}

function physicalMeshVersion(
  attributes: VertexAttributeMap,
  hasStreams: boolean,
): MeshBinHeader['version'] {
  if (hasStreams) return 7;
  if (attributes.skinWeight instanceof Uint8Array || attributes.skinWeight instanceof Uint16Array)
    return MESH_BIN_VERSION;
  return attributes.tangentFrame === undefined ? 5 : 6;
}

/** Encode file-backed mesh bytes with explicit physical stream versioning. */
export function packMeshBin(
  payload: MeshPayloadIn,
  sourceKey: string,
  refs: readonly string[] = [],
  storage: 'interleaved' | 'static-streams' = 'interleaved',
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
    const prepared = prepareMeshData(payload, sourceKey);
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
      morphTargetMasks,
    } = prepared.value;
    const wantsStreams =
      nativeLittleEndian &&
      storage === 'static-streams' &&
      payload.kind === 'mesh' &&
      isStandaloneStaticMesh(payload as MeshAsset);
    const streamsPlan = wantsStreams
      ? projectStaticMeshVertexStreams(projection, vertexCount)
      : undefined;
    const metadata = refsMeta(payload, refs, morphTargetMasks);
    const meta = new TextEncoder().encode(JSON.stringify(metadata));
    const header: MeshBinHeader = {
      version: physicalMeshVersion(attributes, streamsPlan !== undefined),
      projectionVersion: projection.schemaVersion,
      mask: projection.mask,
      digest: streamsPlan?.layout.digest ?? projection.digest,
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
    const vertexBody = out.subarray(MESH_BIN_HEADER_BYTES, MESH_BIN_HEADER_BYTES + vertexBytes);
    writePhysicalMeshVertices(payload, prepared.value, vertexBody, streamsPlan !== undefined);
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
