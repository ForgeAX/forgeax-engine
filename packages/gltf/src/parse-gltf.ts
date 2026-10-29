import type { ImportSubAsset } from '@forgeax/engine-types';
import { COMPONENT_TYPE } from './accessor/layout.js';
import {
  type DracoCompressionJson,
  type GltfDracoDecodeCapability,
  projectDracoPrimitives,
} from './draco-decode.js';
import { type GltfCameraIr, type GltfCameraJson, parseCamera } from './parse-camera';

// parse-gltf.ts - JSON-side glTF importer entry.
// The public parse, GLB, asset-pack, mesh, and scene helpers live here.

import { reconcileMeshLodMeta } from '@forgeax/engine-import';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import {
  createMeshMaterialSlotTable,
  IMPORT_ERROR_HINTS,
  ImportError,
  MESH_MATERIAL_SLOT_SOURCE_OVERRIDE_PAYLOAD_SCHEMA,
  type MeshMaterialSlotTopologyEntry,
  reconcileMeshMaterialSlotTopology,
  type SkeletonPod,
} from '@forgeax/engine-types';
import {
  type AccessorJson,
  type BufferViewJson,
  decodeAccessor,
} from './accessor/decode-accessor.js';
import { decodeColorAccessor } from './accessor/decode-color.js';
import { checkExtensions, type GltfExtensionsJson } from './check-extensions.js';
import { Base64DecodeError, dataUriBase64Payload, decodeBase64 } from './data-uri.js';
import {
  err,
  type GltfError,
  type GltfMorphInvalidDetail,
  gltfErr,
  ok,
  type Result,
} from './errors.js';
import { type GltfImageIr, type GltfImageJson, parseGltfImages } from './extract-image-bytes.js';

export type { GltfImageIr } from './extract-image-bytes.js';

import { withFlatNormals } from './flat-normals.js';
import { type GltfLodRelation, parseGltfLodExtension } from './lod/parse-lod.js';
import {
  type GltfMaterialIr,
  type GltfMaterialJson,
  type GltfSamplerIr,
  type GltfTextureIr,
  parseMaterial,
} from './material/parse-material.js';
import {
  type GltfBufferViewDecodeCapability,
  type MeshoptBufferViewJson,
  projectMeshoptBufferViews,
} from './meshopt-decode.js';
import { type GltfAnimationClipRecord, parseAnimation } from './parse-animation.js';
import { parseGlbChunks } from './parse-glb-chunks.js';
import { parseGltfHeader } from './parse-gltf-header.js';
import { parseSkin } from './parse-skin.js';
import { type GltfDocItem, type GltfMetaJson, reimportReuseMeta } from './reimport-reuse-meta.js';
import type { GltfSourceKeyError } from './source-key.js';
import { type DecomposedTransform, decomposeNodeTransform } from './transform.js';

export type {
  GltfMaterialIr,
  GltfMaterialJson,
  GltfNormalTextureInfoIr,
  GltfOcclusionTextureInfoIr,
  GltfSamplerIr,
  GltfTextureInfoIr,
  GltfTextureIr,
  GltfTextureTransformIr,
  NormalTextureInfoJson,
  OcclusionTextureInfoJson,
  TextureInfoJson,
} from './material/parse-material.js';

export interface MeshPrimitiveJson {
  readonly extensions?: { readonly KHR_draco_mesh_compression?: DracoCompressionJson };
  readonly attributes?: Record<string, number>;
  readonly indices?: number;
  readonly material?: number;
  readonly mode?: number;
  readonly targets?: ReadonlyArray<Record<string, number>>;
}

export interface MeshJson {
  readonly name?: string;
  readonly weights?: readonly number[];
  readonly primitives: readonly MeshPrimitiveJson[];
}

// Tier-B IR: validated glTF JSON projected into downstream POD records.

interface InstancingAttributes {
  readonly TRANSLATION?: number;
  readonly ROTATION?: number;
  readonly SCALE?: number;
}

/**
 * Decode EXT_mesh_gpu_instancing attributes for a single node.
 *
 * Cross-validates that all present TRS accessor counts agree (spec
 * MUST clause "Extending nodes with instance attributes"). Missing
 * accessors fall back to identity (translation=(0,0,0),
 * rotation=(0,0,0,1), scale=(1,1,1)). Composes N column-major mat4 via
 * @forgeax/engine-math `mat4.compose`, packing them into a single
 * Float32Array of length N*16. Pure function: no fs / fetch / throw.
 */
function decodeNodeInstancing(
  nodeIndex: number,
  attributes: InstancingAttributes,
  accessors: readonly AccessorJson[],
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<NodeInstancingIr, GltfError> {
  const tIdx = attributes.TRANSLATION;
  const rIdx = attributes.ROTATION;
  const sIdx = attributes.SCALE;

  let count: number | undefined;
  const setOrCheck = (label: 'TRANSLATION' | 'ROTATION' | 'SCALE', n: number): GltfError | null => {
    if (count === undefined) {
      count = n;
      return null;
    }
    if (n !== count) {
      return gltfErr('gltf-instancing-count-mismatch', {
        nodeIndex,
        accessor: label,
        expectedCount: count,
        actualCount: n,
      });
    }
    return null;
  };

  let tValues: Float32Array | undefined;
  if (tIdx !== undefined) {
    const acc = accessors[tIdx];
    if (acc === undefined) return err(unknownAccessor(tIdx));
    const e = setOrCheck('TRANSLATION', acc.count);
    if (e !== null) return err(e);
    const decoded = decodeAttributeAccessor(tIdx, acc, bufferViews, buffers);
    if (!decoded.ok) return err(decoded.error);
    tValues = decoded.value;
  }
  let rValues: Float32Array | undefined;
  if (rIdx !== undefined) {
    const acc = accessors[rIdx];
    if (acc === undefined) return err(unknownAccessor(rIdx));
    const e = setOrCheck('ROTATION', acc.count);
    if (e !== null) return err(e);
    const decoded = decodeAttributeAccessor(rIdx, acc, bufferViews, buffers);
    if (!decoded.ok) return err(decoded.error);
    rValues = decoded.value;
  }
  let sValues: Float32Array | undefined;
  if (sIdx !== undefined) {
    const acc = accessors[sIdx];
    if (acc === undefined) return err(unknownAccessor(sIdx));
    const e = setOrCheck('SCALE', acc.count);
    if (e !== null) return err(e);
    const decoded = decodeAttributeAccessor(sIdx, acc, bufferViews, buffers);
    if (!decoded.ok) return err(decoded.error);
    sValues = decoded.value;
  }

  const n = count ?? 0;
  const transforms = new Float32Array(n * 16);
  const tmp = mat4.create();
  const tv = vec3.create();
  const rv = quat.create();
  rv[3] = 1;
  const sv = vec3.create(1, 1, 1);
  for (let i = 0; i < n; i++) {
    if (tValues !== undefined) {
      tv[0] = tValues[i * 3] ?? 0;
      tv[1] = tValues[i * 3 + 1] ?? 0;
      tv[2] = tValues[i * 3 + 2] ?? 0;
    } else {
      tv[0] = 0;
      tv[1] = 0;
      tv[2] = 0;
    }
    if (rValues !== undefined) {
      rv[0] = rValues[i * 4] ?? 0;
      rv[1] = rValues[i * 4 + 1] ?? 0;
      rv[2] = rValues[i * 4 + 2] ?? 0;
      rv[3] = rValues[i * 4 + 3] ?? 1;
    } else {
      rv[0] = 0;
      rv[1] = 0;
      rv[2] = 0;
      rv[3] = 1;
    }
    if (sValues !== undefined) {
      sv[0] = sValues[i * 3] ?? 1;
      sv[1] = sValues[i * 3 + 1] ?? 1;
      sv[2] = sValues[i * 3 + 2] ?? 1;
    } else {
      sv[0] = 1;
      sv[1] = 1;
      sv[2] = 1;
    }
    mat4.compose(tmp, tv, rv, sv);
    for (let k = 0; k < 16; k++) {
      transforms[i * 16 + k] = tmp[k] ?? 0;
    }
  }

  return ok({ count: n, transforms });
}

function unknownAccessor(accessorIndex: number): GltfError {
  return gltfErr('gltf-accessor-type-mismatch', {
    accessorIndex,
    reason: 'unknownComponentType',
  });
}

function decodeAttributeAccessor(
  accessorIndex: number,
  accessor: AccessorJson,
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<Float32Array, GltfError> {
  const decoded = decodeAccessor({
    accessorIndex,
    accessor,
    bufferViews,
    buffers,
    role: 'attribute',
  });
  if (!decoded.ok) return err(decoded.error);
  if (decoded.value.kind !== 'f32') return err(unknownAccessor(accessorIndex));
  return ok(decoded.value.data);
}

export interface GltfMeshIr {
  readonly name?: string;
  readonly positions: Float32Array;
  readonly normals?: Float32Array;
  readonly texcoord0?: Float32Array;
  /** TEXCOORD_1 per-vertex UV set 1. */
  readonly texcoord1?: Float32Array;
  /** TEXCOORD_2 per-vertex UV set 2. */
  readonly texcoord2?: Float32Array;
  /** TEXCOORD_3 per-vertex UV set 3. */
  readonly texcoord3?: Float32Array;
  /** TEXCOORD_4 per-vertex UV set 4. */
  readonly texcoord4?: Float32Array;
  /** TEXCOORD_5 per-vertex UV set 5. */
  readonly texcoord5?: Float32Array;
  /** TEXCOORD_6 per-vertex UV set 6. */
  readonly texcoord6?: Float32Array;
  /** TEXCOORD_7 per-vertex UV set 7. */
  readonly texcoord7?: Float32Array;
  readonly tangents?: Float32Array;
  /** COLOR_0 importer carrier. */
  readonly colors0?: Float32Array;
  /** JOINTS_0 per-vertex joint indices. */
  readonly joints0?: Uint16Array;
  /** WEIGHTS_0 per-vertex skin weights. */
  readonly weights0?: Float32Array;
  readonly morphTargets?: readonly {
    readonly position?: Float32Array;
    readonly normal?: Float32Array;
    readonly tangent?: Float32Array;
  }[];
  readonly morphWeights?: Float32Array;
  /** Undefined means non-indexed; otherwise source width is preserved. */
  readonly indices?: Uint16Array | Uint32Array;
  readonly materialIndex: number | null;
  /** Owning glTF mesh index; multiple IR rows may share it after flattening. */
  readonly meshIndex: number;
}

/** glTF TEXCOORD_n sets carried on {@link GltfMeshIr} as `texcoord<n>`. */
export const GLTF_UV_SET_COUNT = 8;
type GltfUvSetField = `texcoord${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}`;

/** The mesh's TEXCOORD_<set> values; undefined when absent or out of range. */
export function gltfMeshUvSet(mesh: GltfMeshIr, set: number): Float32Array | undefined {
  return mesh[`texcoord${set}` as GltfUvSetField];
}

export interface NodeInstancingIr {
  /** Number of instances. */
  readonly count: number;
  /** Column-major transforms packed into one Float32Array. */
  readonly transforms: Float32Array;
}

export type GltfPunctualLightType = 'directional' | 'point' | 'spot';

export interface GltfPunctualLightIr {
  readonly type: GltfPunctualLightType;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly range?: number;
  readonly spot?: {
    readonly innerConeAngle: number;
    readonly outerConeAngle: number;
  };
}

export interface GltfNodeIr {
  readonly name?: string;
  readonly transform: DecomposedTransform;
  readonly meshIndex: number | null;
  /** Node-authored morph weights override mesh defaults. */
  readonly morphWeights?: Float32Array;
  readonly skinIndex: number | null;
  readonly children: readonly number[];
  readonly instancing?: NodeInstancingIr;
  readonly camera: GltfCameraIr | null;
  readonly lightIndex?: number | null;
}

export interface GltfSceneIr {
  readonly name?: string;
  readonly nodes: readonly number[];
}

export interface GltfDiagnosticsIr {
  readonly nodeNames: readonly string[];
  readonly unsupportedExtensions: readonly string[];
  readonly matrixTrsCoexistNodes: readonly number[];
}

export interface GltfDoc {
  readonly meshes: readonly GltfMeshIr[];
  readonly materials: readonly GltfMaterialIr[];
  readonly nodes: readonly GltfNodeIr[];
  readonly scenes: readonly GltfSceneIr[];
  readonly textures: readonly GltfTextureIr[] | undefined;
  readonly images: readonly GltfImageIr[] | undefined;
  readonly samplers: readonly GltfSamplerIr[] | undefined;
  readonly skeletons: readonly SkeletonPod[];
  readonly animationClips: readonly GltfAnimationClipRecord[];
  readonly defaultSceneIndex: number;
  readonly diagnostics: GltfDiagnosticsIr;
  /** KHR_lights_punctual author facts, kept in source units for the bridge. */
  readonly lights?: readonly GltfPunctualLightIr[];
  /** Raw extension projection retained for bridge-only hand-constructed docs. */
  readonly extensions?: {
    readonly KHR_lights_punctual?: {
      readonly lights?: readonly GltfPunctualLightIr[];
    };
  };
  readonly lod?: GltfLodRelation;
}

interface BuffersJson {
  readonly byteLength: number;
  readonly uri?: string;
}

interface RootGltfJson extends GltfExtensionsJson {
  readonly asset?: { readonly version?: string };
  readonly scene?: number;
  readonly scenes?: ReadonlyArray<{ readonly name?: string; readonly nodes?: readonly number[] }>;
  readonly nodes?: ReadonlyArray<{
    readonly name?: string;
    readonly mesh?: number;
    readonly skin?: number;
    readonly camera?: number;
    readonly children?: readonly number[];
    readonly matrix?: readonly number[];
    readonly translation?: readonly number[];
    readonly rotation?: readonly number[];
    readonly scale?: readonly number[];
    readonly weights?: readonly number[];
    readonly extras?: { readonly MSFT_screencoverage?: readonly number[] };
    readonly extensions?: {
      readonly KHR_lights_punctual?: {
        readonly light?: number;
      };
      readonly EXT_mesh_gpu_instancing?: {
        readonly attributes?: {
          readonly TRANSLATION?: number;
          readonly ROTATION?: number;
          readonly SCALE?: number;
        };
      };
      readonly MSFT_lod?: { readonly ids?: readonly number[] };
    };
  }>;
  readonly extensions?: {
    readonly KHR_lights_punctual?: {
      readonly lights?: ReadonlyArray<{
        readonly type?: string;
        readonly color?: readonly number[];
        readonly intensity?: number;
        readonly range?: number;
        readonly spot?: {
          readonly innerConeAngle?: number;
          readonly outerConeAngle?: number;
        };
      }>;
    };
    readonly MSFT_screencoverage?: { readonly scales?: readonly number[] };
  };
  readonly skins?: ReadonlyArray<{
    readonly name?: string;
    readonly joints: readonly number[];
    readonly inverseBindMatrices?: number;
    readonly extras?: {
      readonly forgeax?: {
        readonly conservativeAnimatedBounds?: unknown;
      };
    };
  }>;
  readonly meshes?: readonly MeshJson[];
  readonly cameras?: readonly GltfCameraJson[];
  readonly materials?: ReadonlyArray<GltfMaterialJson>;
  readonly textures?: ReadonlyArray<{
    readonly sampler?: number;
    readonly source?: number;
    readonly name?: string;
  }>;
  readonly images?: readonly GltfImageJson[];
  readonly samplers?: ReadonlyArray<{
    readonly magFilter?: number;
    readonly minFilter?: number;
    readonly wrapS?: number;
    readonly wrapT?: number;
    readonly name?: string;
  }>;
  readonly accessors?: readonly AccessorJson[];
  readonly bufferViews?: readonly BufferViewJson[];
  readonly buffers?: readonly BuffersJson[];
  readonly animations?: ReadonlyArray<{
    readonly name?: string;
    readonly channels: ReadonlyArray<{
      readonly sampler: number;
      readonly target: {
        readonly node?: number;
        readonly path: string;
      };
    }>;
    readonly samplers: ReadonlyArray<{
      readonly input: number;
      readonly output: number;
      readonly interpolation?: string;
    }>;
  }>;
}

export type ExternalLoader = (uri: string) => Promise<ArrayBuffer>;

async function resolveBuffer(
  buf: BuffersJson,
  externalLoader: ExternalLoader,
  binChunk: Uint8Array | undefined,
): Promise<Uint8Array> {
  if (buf.uri === undefined) {
    // GLB BIN chunk slot.
    if (binChunk === undefined) {
      throw new Error('parseGltf: buffer 0 has no uri and no GLB BIN chunk available');
    }
    return binChunk;
  }
  const dataPayload = dataUriBase64Payload(buf.uri);
  if (dataPayload !== undefined) {
    return decodeBase64(dataPayload);
  }
  const arrayBuffer = await externalLoader(buf.uri);
  return new Uint8Array(arrayBuffer);
}

interface ParseGltfInternalsContext {
  readonly externalLoader: ExternalLoader;
  readonly binChunk?: Uint8Array;
  readonly filePath: string;
  readonly meshopt?: GltfBufferViewDecodeCapability;
  readonly draco?: GltfDracoDecodeCapability;
}

export type GltfParseError = GltfError | ImportError;

function invalidBufferDataUriError(
  filePath: string,
  bufferIndex: number,
  cause: Base64DecodeError,
): ImportError {
  return new ImportError({
    code: 'source-validation-failed',
    expected: `glTF buffer ${bufferIndex} data URI to contain a valid base64 payload`,
    hint: IMPORT_ERROR_HINTS['source-validation-failed'],
    detail: {
      diagnostics: [
        {
          code: 'gltf-buffer-data-uri-invalid',
          severity: 'error',
          sourcePath: filePath,
          sourceRange: { start: 0, end: 0, line: 1, column: 1 },
          rule: 'gltf-buffer-data-uri-base64',
          expected: 'a valid base64 payload after ;base64,',
          actual: `buffer ${bufferIndex}: ${cause.message}`,
          hint: 'repair the buffer data URI or provide a valid external .bin sibling',
        },
      ],
    },
  });
}

export interface GltfParseOptions {
  readonly meshopt?: GltfBufferViewDecodeCapability;
  readonly draco?: GltfDracoDecodeCapability;
}

function parsePunctualLights(
  json: RootGltfJson,
  filePath: string,
): Result<readonly GltfPunctualLightIr[], GltfError> {
  const source = json.extensions?.KHR_lights_punctual?.lights ?? [];
  const lights: GltfPunctualLightIr[] = [];
  for (const light of source) {
    const type = light?.type;
    if (type !== 'directional' && type !== 'point' && type !== 'spot') {
      return err(gltfErr('gltf-malformed-header', { filePath, byteOffset: 0 }));
    }
    const color = light.color ?? [1, 1, 1];
    if (
      color.length < 3 ||
      color
        .slice(0, 3)
        .some(
          (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1,
        )
    ) {
      return err(gltfErr('gltf-malformed-header', { filePath, byteOffset: 0 }));
    }
    const intensity = light.intensity ?? 1;
    if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0) {
      return err(gltfErr('gltf-malformed-header', { filePath, byteOffset: 0 }));
    }
    const range = light.range;
    if (
      range !== undefined &&
      (typeof range !== 'number' || !Number.isFinite(range) || range < 0)
    ) {
      return err(gltfErr('gltf-malformed-header', { filePath, byteOffset: 0 }));
    }
    let spot: GltfPunctualLightIr['spot'];
    if (type === 'spot') {
      const innerConeAngle = light.spot?.innerConeAngle ?? 0;
      const outerConeAngle = light.spot?.outerConeAngle ?? Math.PI / 4;
      if (
        !Number.isFinite(innerConeAngle) ||
        !Number.isFinite(outerConeAngle) ||
        innerConeAngle < 0 ||
        innerConeAngle >= outerConeAngle ||
        outerConeAngle > Math.PI / 2
      ) {
        return err(gltfErr('gltf-malformed-header', { filePath, byteOffset: 0 }));
      }
      spot = { innerConeAngle, outerConeAngle };
    }
    lights.push({
      type,
      color: [color[0] ?? 1, color[1] ?? 1, color[2] ?? 1],
      intensity,
      ...(range === undefined || range === 0 ? {} : { range }),
      ...(spot === undefined ? {} : { spot }),
    });
  }
  return ok(lights);
}

/** Accessor, buffer-view and buffer tables after compressed-geometry projection. */
interface AccessorTables {
  readonly accessors: readonly AccessorJson[];
  readonly bufferViews: readonly BufferViewJson[];
  readonly buffers: readonly Uint8Array[];
}

interface ProjectedGeometry extends AccessorTables {
  readonly meshes: readonly MeshJson[];
}

type MorphTargetIr = NonNullable<GltfMeshIr['morphTargets']>[number];
type MorphInvalidReason = GltfMorphInvalidDetail['reason'];
type NodeJson = NonNullable<RootGltfJson['nodes']>[number];
type GltfParseDiagnostics = {
  nodeNames: string[];
  unsupportedExtensions: string[];
  matrixTrsCoexistNodes: number[];
};

/** Resolve buffers (data: URI / external / GLB BIN chunk). */
async function resolveBuffers(
  buffersJson: readonly BuffersJson[],
  ctx: ParseGltfInternalsContext,
): Promise<Result<Uint8Array[], GltfParseError>> {
  const buffers: Uint8Array[] = [];
  for (let i = 0; i < buffersJson.length; i++) {
    const bufJson = buffersJson[i];
    if (bufJson === undefined) continue;
    try {
      buffers.push(await resolveBuffer(bufJson, ctx.externalLoader, ctx.binChunk));
    } catch (e) {
      if (e instanceof Base64DecodeError) {
        return err(invalidBufferDataUriError(ctx.filePath, i, e));
      }
      return err(
        gltfErr('gltf-malformed-header', {
          filePath: ctx.filePath,
          byteOffset: 0,
        }),
      );
    }
  }
  return ok(buffers);
}

/** Decode EXT_meshopt buffer views, then KHR_draco primitives, into plain accessor tables. */
async function projectCompressedGeometry(
  json: RootGltfJson,
  buffers: readonly Uint8Array[],
  ctx: ParseGltfInternalsContext,
): Promise<Result<ProjectedGeometry, GltfError>> {
  const required = json.extensionsRequired ?? [];
  const projected = await projectMeshoptBufferViews(
    (json.bufferViews ?? []) as readonly MeshoptBufferViewJson[],
    buffers,
    required,
    ctx.meshopt,
  );
  if (!projected.ok) return err(projected.error);
  return projectDracoPrimitives(
    json.meshes ?? [],
    json.accessors ?? [],
    projected.value.bufferViews,
    projected.value.buffers,
    required,
    ctx.draco,
  );
}

function decodePositions(
  prim: MeshPrimitiveJson,
  tables: AccessorTables,
): Result<{ readonly positions: Float32Array; readonly vertexCount: number }, GltfError> {
  const positionAccessorIndex = prim.attributes?.POSITION;
  if (positionAccessorIndex === undefined) {
    return err(
      gltfErr('gltf-accessor-type-mismatch', {
        accessorIndex: -1,
        reason: 'unknownComponentType',
      }),
    );
  }
  const positionAccessor = tables.accessors[positionAccessorIndex];
  if (positionAccessor === undefined) return err(unknownAccessor(positionAccessorIndex));
  const positionDecoded = decodeAccessor({
    accessorIndex: positionAccessorIndex,
    accessor: positionAccessor,
    bufferViews: tables.bufferViews,
    buffers: tables.buffers,
    role: 'attribute',
  });
  if (!positionDecoded.ok) return err(positionDecoded.error);
  if (positionDecoded.value.kind !== 'f32') {
    return err(unknownAccessor(positionAccessorIndex));
  }
  return ok({ positions: positionDecoded.value.data, vertexCount: positionAccessor.count });
}

function decodeColors0(
  attrs: Readonly<Record<string, number>>,
  positions: Float32Array,
  tables: AccessorTables,
): Result<Float32Array | undefined, GltfError> {
  const colorIdx = attrs.COLOR_0;
  if (colorIdx === undefined) return ok(undefined);
  const colorAccessor = tables.accessors[colorIdx];
  if (colorAccessor === undefined)
    return err(
      gltfErr('gltf-color-accessor-malformed', {
        semantic: 'COLOR_0',
        accessorIndex: colorIdx,
        reason: 'reference',
      }),
    );
  const decoded = decodeColorAccessor({
    accessorIndex: colorIdx,
    accessor: colorAccessor,
    bufferViews: tables.bufferViews,
    buffers: tables.buffers,
    semantic: 'COLOR_0',
  });
  if (!decoded.ok) return err(decoded.error);
  if (decoded.value.length !== (positions.length / 3) * 4) {
    return err(
      gltfErr('gltf-color-accessor-malformed', {
        semantic: 'COLOR_0',
        accessorIndex: colorIdx,
        reason: 'count',
      }),
    );
  }
  return ok(decoded.value);
}

/** Decode one optional per-vertex float attribute whose type and count must match the primitive. */
function decodeVertexAttribute(
  attrs: Readonly<Record<string, number>>,
  semantic: string,
  type: string,
  vertexCount: number,
  tables: AccessorTables,
): Result<Float32Array | undefined, GltfError> {
  const index = attrs[semantic];
  if (index === undefined) return ok(undefined);
  const accessor = tables.accessors[index];
  if (accessor === undefined) return err(unknownAccessor(index));
  if (accessor.type !== type || accessor.count !== vertexCount)
    return err(gltfErr('gltf-accessor-type-mismatch', { accessorIndex: index, reason: 'layout' }));
  return decodeAttributeAccessor(index, accessor, tables.bufferViews, tables.buffers);
}

function decodeUvSets(
  attrs: Readonly<Record<string, number>>,
  vertexCount: number,
  tables: AccessorTables,
): Result<{ -readonly [K in GltfUvSetField]?: Float32Array }, GltfError> {
  const uvSets: { -readonly [K in GltfUvSetField]?: Float32Array } = {};
  for (let set = 0; set < GLTF_UV_SET_COUNT; set++) {
    const result = decodeVertexAttribute(attrs, `TEXCOORD_${set}`, 'VEC2', vertexCount, tables);
    if (!result.ok) return result;
    if (result.value !== undefined) uvSets[`texcoord${set}` as GltfUvSetField] = result.value;
  }
  return ok(uvSets);
}

function decodeMorphAttribute(
  accessorIndex: number,
  positions: Float32Array,
  tables: AccessorTables,
): Result<Float32Array, MorphInvalidReason> {
  const targetAccessor = tables.accessors[accessorIndex];
  if (targetAccessor === undefined) return err('attribute-length-mismatch');
  const decoded = decodeAttributeAccessor(
    accessorIndex,
    targetAccessor,
    tables.bufferViews,
    tables.buffers,
  );
  if (!decoded.ok) {
    return err(
      decoded.error.code === 'gltf-accessor-type-mismatch'
        ? 'sparse-or-unsupported-accessor'
        : 'attribute-length-mismatch',
    );
  }
  if (targetAccessor.type !== 'VEC3' || targetAccessor.componentType !== 5126)
    return err('attribute-length-mismatch');
  if (decoded.value.length !== positions.length) return err('attribute-length-mismatch');
  return ok(decoded.value);
}

/** Morph tangents carry XYZ deltas; widen them to the XYZW tangent stride. */
function widenMorphTangent(deltas: Float32Array, vertexCount: number): Float32Array {
  const tangent = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++)
    tangent.set(deltas.subarray(vertex * 3, vertex * 3 + 3), vertex * 4);
  return tangent;
}

function decodeMorphTarget(
  target: Readonly<Record<string, number>>,
  positions: Float32Array,
  tables: AccessorTables,
): Result<MorphTargetIr, MorphInvalidReason> {
  const output: { position?: Float32Array; normal?: Float32Array; tangent?: Float32Array } = {};
  for (const [key, accessorIndex] of Object.entries(target)) {
    if (key !== 'POSITION' && key !== 'NORMAL' && key !== 'TANGENT') continue;
    const decoded = decodeMorphAttribute(accessorIndex, positions, tables);
    if (!decoded.ok) return decoded;
    if (key === 'POSITION') output.position = decoded.value;
    else if (key === 'NORMAL') output.normal = decoded.value;
    else output.tangent = widenMorphTangent(decoded.value, positions.length / 3);
  }
  return ok(output);
}

function decodeMorphTargetList(
  rawTargets: ReadonlyArray<Readonly<Record<string, number>>>,
  attributeCount: number,
  meshWeights: readonly number[] | undefined,
  positions: Float32Array,
  tables: AccessorTables,
): Result<MorphTargetIr[], MorphInvalidReason> {
  if (rawTargets.length > 8) return err('target-count-exceeded');
  if (attributeCount > 8) return err('attribute-count-exceeded');
  const morphTargets: MorphTargetIr[] = [];
  for (const target of rawTargets) {
    const decoded = decodeMorphTarget(target, positions, tables);
    if (!decoded.ok) return decoded;
    morphTargets.push(decoded.value);
  }
  if (meshWeights !== undefined && meshWeights.length !== rawTargets.length) {
    return err('weights-length-mismatch');
  }
  return ok(morphTargets);
}

function decodeMorphTargets(
  meshIndex: number,
  meshJson: MeshJson,
  prim: MeshPrimitiveJson,
  positions: Float32Array,
  tables: AccessorTables,
): Result<MorphTargetIr[], GltfError> {
  const rawTargets = prim.targets ?? [];
  for (const target of rawTargets) {
    const colorTarget = target.COLOR_0;
    if (colorTarget !== undefined) {
      return err(
        gltfErr('gltf-color-accessor-unsupported', {
          semantic: 'COLOR_0',
          accessorIndex: colorTarget,
          reason: 'morph',
        }),
      );
    }
  }
  const attributeCount = rawTargets.reduce(
    (count, target) =>
      count +
      (target.POSITION === undefined ? 0 : 1) +
      (target.NORMAL === undefined ? 0 : 1) +
      (target.TANGENT === undefined ? 0 : 1),
    0,
  );
  const decoded = decodeMorphTargetList(
    rawTargets,
    attributeCount,
    meshJson.weights,
    positions,
    tables,
  );
  if (decoded.ok) return decoded;
  return err(
    gltfErr('gltf-morph-invalid', {
      meshIndex,
      primitiveIndex: meshJson.primitives.indexOf(prim),
      reason: decoded.error,
      targetCount: rawTargets.length,
      attributeCount,
      vertexCount: positions.length / 3,
    }),
  );
}

// JOINTS_0 / WEIGHTS_0 (feat-20260611 M1 w1): paired skinning attributes.
// glTF 2.0 spec section 3.7.2.1 requires the pair to appear together for
// any skinned primitive; lone presence -> gltf-skin-attr-asymmetric.
// JOINTS_0 componentType: UBYTE(5121) widen->U16 via decodeAccessor
// role='joints' (D-3 width-convert at parse), or USHORT(5123) standard
// U16 path. WEIGHTS_0 componentType: FLOAT(5126) standard F32 path.
function decodeSkinAttributes(
  meshIndex: number,
  meshJson: MeshJson,
  prim: MeshPrimitiveJson,
  tables: AccessorTables,
): Result<{ readonly joints0?: Uint16Array; readonly weights0?: Float32Array }, GltfError> {
  const jointsIdx = prim.attributes?.JOINTS_0;
  const weightsIdx = prim.attributes?.WEIGHTS_0;
  const hasJoints = jointsIdx !== undefined;
  const hasWeights = weightsIdx !== undefined;
  if (hasJoints !== hasWeights) {
    return err(
      gltfErr('gltf-skin-attr-asymmetric', {
        meshIndex,
        primitiveIndex: meshJson.primitives.indexOf(prim),
        hasJoints,
        hasWeights,
      }),
    );
  }
  if (jointsIdx === undefined || weightsIdx === undefined) return ok({});
  const joints0 = decodeJoints(jointsIdx, tables);
  if (!joints0.ok) return joints0;
  const weightsAccessor = tables.accessors[weightsIdx];
  if (weightsAccessor === undefined) return err(unknownAccessor(weightsIdx));
  const weights0 = decodeAttributeAccessor(
    weightsIdx,
    weightsAccessor,
    tables.bufferViews,
    tables.buffers,
  );
  if (!weights0.ok) return err(weights0.error);
  return ok({ joints0: joints0.value, weights0: weights0.value });
}

function decodeJoints(jointsIdx: number, tables: AccessorTables): Result<Uint16Array, GltfError> {
  const jointsAccessor = tables.accessors[jointsIdx];
  if (jointsAccessor === undefined) return err(unknownAccessor(jointsIdx));
  const jointsDecoded = decodeAccessor({
    accessorIndex: jointsIdx,
    accessor: jointsAccessor,
    role: 'joints',
    bufferViews: tables.bufferViews,
    buffers: tables.buffers,
  });
  if (!jointsDecoded.ok) return err(jointsDecoded.error);
  if (jointsDecoded.value.kind !== 'u16') return err(unknownAccessor(jointsIdx));
  return ok(jointsDecoded.value.data);
}

// bug-20260612 hello-skin visual layered gate: glTF spec marks
// primitive.indices optional; undefined means non-indexed geometry.
// Leave indices undefined here; bridge.ts handles the non-indexed
// path by routing MeshAsset.indices to undefined.
function decodeIndices(
  prim: MeshPrimitiveJson,
  tables: AccessorTables,
): Result<Uint16Array | Uint32Array | undefined, GltfError> {
  if (prim.indices === undefined) return ok(undefined);
  const indexAccessor = tables.accessors[prim.indices];
  if (indexAccessor === undefined) return err(unknownAccessor(prim.indices));
  const indexDecoded = decodeAccessor({
    accessorIndex: prim.indices,
    accessor: indexAccessor,
    bufferViews: tables.bufferViews,
    buffers: tables.buffers,
    role: 'indices',
  });
  if (!indexDecoded.ok) return err(indexDecoded.error);
  if (indexDecoded.value.kind === 'f32') return err(unknownAccessor(prim.indices));
  return ok(indexDecoded.value.data);
}

/** Decode one triangle-list primitive into its IR row; decoding order is the error precedence. */
function parsePrimitive(
  meshIndex: number,
  meshJson: MeshJson,
  prim: MeshPrimitiveJson,
  tables: AccessorTables,
): Result<GltfMeshIr, GltfError> {
  const position = decodePositions(prim, tables);
  if (!position.ok) return position;
  const { positions, vertexCount } = position.value;
  const attrs = prim.attributes ?? {};
  const colors0 = decodeColors0(attrs, positions, tables);
  if (!colors0.ok) return colors0;
  const normal = decodeVertexAttribute(attrs, 'NORMAL', 'VEC3', vertexCount, tables);
  if (!normal.ok) return normal;
  const tangent = decodeVertexAttribute(attrs, 'TANGENT', 'VEC4', vertexCount, tables);
  if (!tangent.ok) return tangent;
  const uvSets = decodeUvSets(attrs, vertexCount, tables);
  if (!uvSets.ok) return uvSets;
  const morphTargets = decodeMorphTargets(meshIndex, meshJson, prim, positions, tables);
  if (!morphTargets.ok) return morphTargets;
  const skin = decodeSkinAttributes(meshIndex, meshJson, prim, tables);
  if (!skin.ok) return skin;
  const indices = decodeIndices(prim, tables);
  if (!indices.ok) return indices;
  const normals = normal.value;
  const meshIr: GltfMeshIr = {
    ...(meshJson.name === undefined ? {} : { name: meshJson.name }),
    positions,
    ...(normals === undefined ? {} : { normals }),
    ...uvSets.value,
    ...(tangent.value === undefined ? {} : { tangents: tangent.value }),
    ...(colors0.value === undefined ? {} : { colors0: colors0.value }),
    ...skin.value,
    ...(morphTargets.value.length === 0 ? {} : { morphTargets: morphTargets.value }),
    ...(meshJson.weights === undefined ? {} : { morphWeights: new Float32Array(meshJson.weights) }),
    ...(indices.value === undefined ? {} : { indices: indices.value }),
    materialIndex: prim.material ?? null,
    meshIndex,
  };
  return ok(withTriangleNormals(meshIr, prim.mode));
}

/** Triangle lists (mode 4, the default) without authored normals get flat normals. */
function withTriangleNormals(mesh: GltfMeshIr, mode: number | undefined): GltfMeshIr {
  return mesh.normals === undefined && (mode === undefined || mode === 4)
    ? withFlatNormals(mesh)
    : mesh;
}

function parseMeshes(geometry: ProjectedGeometry): Result<GltfMeshIr[], GltfError> {
  const meshes: GltfMeshIr[] = [];
  for (let meshIndex = 0; meshIndex < geometry.meshes.length; meshIndex++) {
    const meshJson = geometry.meshes[meshIndex];
    if (meshJson === undefined) continue;
    for (const prim of meshJson.primitives) {
      if (prim === undefined) continue;
      const mesh = parsePrimitive(meshIndex, meshJson, prim, geometry);
      if (!mesh.ok) return mesh;
      meshes.push(mesh.value);
    }
  }
  return ok(meshes);
}

function parseTextures(texturesJson: NonNullable<RootGltfJson['textures']>): GltfTextureIr[] {
  return texturesJson.map((texJson) => ({
    source: texJson.source ?? -1,
    ...(texJson.sampler === undefined ? {} : { sampler: texJson.sampler }),
    ...(texJson.name === undefined ? {} : { name: texJson.name }),
  }));
}

function parseSamplers(samplersJson: NonNullable<RootGltfJson['samplers']>): GltfSamplerIr[] {
  return samplersJson.map((sampJson) => ({
    ...(sampJson.magFilter === undefined ? {} : { magFilter: sampJson.magFilter }),
    ...(sampJson.minFilter === undefined ? {} : { minFilter: sampJson.minFilter }),
    wrapS: sampJson.wrapS ?? 10497, // REPEAT (glTF default)
    wrapT: sampJson.wrapT ?? 10497,
    ...(sampJson.name === undefined ? {} : { name: sampJson.name }),
  }));
}

/** Materials are normalized by the material parser owner before entering the IR. */
function parseMaterials(
  materialsJson: readonly GltfMaterialJson[],
  textures: readonly GltfTextureIr[],
): Result<GltfMaterialIr[], GltfError> {
  const materials: GltfMaterialIr[] = [];
  for (const material of materialsJson) {
    const parsedMaterial = parseMaterial(material, textures);
    if (!parsedMaterial.ok) return err(parsedMaterial.error);
    materials.push(parsedMaterial.value);
  }
  return ok(materials);
}

/** Textures, images, samplers and materials; empty top-level arrays project to undefined. */
async function parseSurfaceInputs(
  json: RootGltfJson,
  buffers: readonly Uint8Array[],
  ctx: ParseGltfInternalsContext,
): Promise<
  Result<Pick<GltfDoc, 'materials' | 'textures' | 'images' | 'samplers'>, GltfParseError>
> {
  const textures = parseTextures(json.textures ?? []);
  const images = await parseGltfImages(
    json.images ?? [],
    json.bufferViews ?? [],
    buffers,
    ctx.externalLoader,
  );
  if (!images.ok) return images;
  const samplers = parseSamplers(json.samplers ?? []);
  const materials = parseMaterials(json.materials ?? [], textures);
  if (!materials.ok) return materials;
  return ok({
    materials: materials.value,
    textures: textures.length > 0 ? textures : undefined,
    images: images.value.length > 0 ? images.value : undefined,
    samplers: samplers.length > 0 ? samplers : undefined,
  });
}

function parseNodeCamera(
  cameras: RootGltfJson['cameras'],
  cameraIndex: number | undefined,
): Result<GltfCameraIr | null, GltfError> {
  if (cameraIndex === undefined) return ok(null);
  if (!Number.isSafeInteger(cameraIndex) || cameraIndex < 0)
    return err(gltfErr('gltf-camera-invalid', { cameraIndex }));
  return parseCamera(cameras?.[cameraIndex], cameraIndex);
}

function parseNodeInstancing(
  nodeIndex: number,
  nodeJson: NodeJson,
  tables: AccessorTables,
): Result<NodeInstancingIr | undefined, GltfError> {
  const instancingExt = nodeJson.extensions?.EXT_mesh_gpu_instancing;
  if (instancingExt === undefined) return ok(undefined);
  return decodeNodeInstancing(
    nodeIndex,
    instancingExt.attributes ?? {},
    tables.accessors,
    tables.bufferViews,
    tables.buffers,
  );
}

function parseNode(
  json: RootGltfJson,
  nodeJson: NodeJson,
  nodeIndex: number,
  tables: AccessorTables,
  diagnostics: GltfParseDiagnostics,
): Result<GltfNodeIr, GltfError> {
  const transform = decomposeNodeTransform(nodeJson, nodeIndex, diagnostics);
  if (nodeJson.name !== undefined) diagnostics.nodeNames.push(nodeJson.name);
  const instancing = parseNodeInstancing(nodeIndex, nodeJson, tables);
  if (!instancing.ok) return err(instancing.error);
  const nodeMorphWeights =
    nodeJson.weights === undefined ? undefined : new Float32Array(nodeJson.weights);
  const camera = parseNodeCamera(json.cameras, nodeJson.camera);
  if (!camera.ok) return camera;
  return ok({
    ...(nodeJson.name === undefined ? {} : { name: nodeJson.name }),
    transform,
    meshIndex: nodeJson.mesh ?? null,
    skinIndex: nodeJson.skin ?? null,
    children: nodeJson.children ?? [],
    camera: camera.value,
    lightIndex: nodeJson.extensions?.KHR_lights_punctual?.light ?? null,
    ...(instancing.value === undefined ? {} : { instancing: instancing.value }),
    ...(nodeMorphWeights === undefined ? {} : { morphWeights: nodeMorphWeights }),
  });
}

function parseNodes(
  json: RootGltfJson,
  tables: AccessorTables,
  diagnostics: GltfParseDiagnostics,
): Result<GltfNodeIr[], GltfError> {
  const nodes: GltfNodeIr[] = [];
  const nodesJson = json.nodes ?? [];
  for (let nodeIndex = 0; nodeIndex < nodesJson.length; nodeIndex++) {
    const nodeJson = nodesJson[nodeIndex];
    if (nodeJson === undefined) continue;
    const node = parseNode(json, nodeJson, nodeIndex, tables, diagnostics);
    if (!node.ok) return node;
    nodes.push(node.value);
  }
  return ok(nodes);
}

async function parseGltfWithBin(
  json: RootGltfJson,
  ctx: ParseGltfInternalsContext,
): Promise<Result<GltfDoc, GltfParseError>> {
  const headerResult = parseGltfHeader(json, ctx.filePath);
  if (!headerResult.ok) return err(headerResult.error);

  const extResult = checkExtensions(json);
  if (!extResult.ok) return err(extResult.error);
  const lodResult = parseGltfLodExtension(json);
  if (!lodResult.ok) return err(lodResult.error);
  const lightsResult = parsePunctualLights(json, ctx.filePath);
  if (!lightsResult.ok) return err(lightsResult.error);

  const resolvedBuffers = await resolveBuffers(json.buffers ?? [], ctx);
  if (!resolvedBuffers.ok) return resolvedBuffers;
  const projected = await projectCompressedGeometry(json, resolvedBuffers.value, ctx);
  if (!projected.ok) return err(projected.error);
  const geometry = projected.value;
  const meshes = parseMeshes(geometry);
  if (!meshes.ok) return meshes;

  const surfaces = await parseSurfaceInputs(json, geometry.buffers, ctx);
  if (!surfaces.ok) return surfaces;

  const diagnostics: GltfParseDiagnostics = {
    nodeNames: [],
    unsupportedExtensions: [...extResult.value.unsupportedUsed],
    matrixTrsCoexistNodes: [],
  };
  const nodes = parseNodes(json, geometry, diagnostics);
  if (!nodes.ok) return nodes;
  const scenes: GltfSceneIr[] = (json.scenes ?? []).map((s) => ({
    ...(s.name === undefined ? {} : { name: s.name }),
    nodes: s.nodes ?? [],
  }));

  // Skins and animations (feat-20260523-skin-skeleton-animation M0).
  const nodesJson = json.nodes ?? [];
  const { accessors, bufferViews, buffers } = geometry;
  const skinResult = parseSkin(json.skins, nodesJson, accessors, bufferViews, buffers);
  if (!skinResult.ok) return err(skinResult.error);
  const animResult = parseAnimation(json.animations, nodesJson, accessors, bufferViews, buffers);
  if (!animResult.ok) return err(animResult.error);

  return ok({
    meshes: meshes.value,
    materials: surfaces.value.materials,
    nodes: nodes.value,
    scenes,
    skeletons: skinResult.value,
    animationClips: animResult.value,
    textures: surfaces.value.textures,
    images: surfaces.value.images,
    samplers: surfaces.value.samplers,
    defaultSceneIndex: json.scene ?? 0,
    diagnostics: {
      nodeNames: diagnostics.nodeNames,
      unsupportedExtensions: diagnostics.unsupportedExtensions,
      matrixTrsCoexistNodes: diagnostics.matrixTrsCoexistNodes,
    },
    lights: lightsResult.value,
    ...(lodResult.value.lodNodeIds.length === 0 ? {} : { lod: lodResult.value }),
  });
}

/**
 * Parse a glTF 2.0 JSON document. The `externalLoader` resolves
 * `buffers[].uri` references that are NOT data: URIs (callers in Node
 * land typically wrap fs.readFile; browser callers wrap fetch).
 *
 * Pure function modulo `externalLoader` (caller-provided I/O is the
 * only side effect). No global state, no fs / network direct call.
 */
export async function parseGltf(
  json: unknown,
  externalLoader: ExternalLoader,
  filePath: string,
  options: GltfParseOptions = {},
): Promise<Result<GltfDoc, GltfParseError>> {
  if (json === null || typeof json !== 'object') {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 0,
      }),
    );
  }
  return parseGltfWithBin(json as RootGltfJson, {
    externalLoader,
    filePath,
    ...(options.meshopt === undefined ? {} : { meshopt: options.meshopt }),
    ...(options.draco === undefined ? {} : { draco: options.draco }),
  });
}

/**
 * Parse a GLB 2.0 binary container: split into JSON + BIN chunks via
 * `parseGlbChunks`, then run the JSON document through `parseGltf` with
 * the BIN chunk wired in as buffer-0 backing storage.
 */
export async function parseGlb(
  buffer: ArrayBuffer,
  filePath: string,
  options: GltfParseOptions = {},
): Promise<Result<GltfDoc, GltfParseError>> {
  const chunksResult = parseGlbChunks(buffer, filePath);
  if (!chunksResult.ok) return err(chunksResult.error);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(chunksResult.value.jsonChunk));
  } catch (_e) {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 12,
      }),
    );
  }
  if (json === null || typeof json !== 'object') {
    return err(
      gltfErr('gltf-malformed-header', {
        filePath,
        byteOffset: 12,
      }),
    );
  }
  const externalLoader: ExternalLoader = async (uri: string) => {
    throw new Error(`parseGlb: GLB containers must not reference external URIs (got ${uri})`);
  };
  return parseGltfWithBin(json as RootGltfJson, {
    externalLoader,
    ...(chunksResult.value.binChunk === undefined ? {} : { binChunk: chunksResult.value.binChunk }),
    filePath,
    ...(options.meshopt === undefined ? {} : { meshopt: options.meshopt }),
    ...(options.draco === undefined ? {} : { draco: options.draco }),
  });
}

export interface GltfAssetPack {
  readonly meta: GltfMetaJson;
  readonly subAssets: readonly ImportSubAsset[];
}

export type GltfAssetPackResult = Result<GltfAssetPack, GltfSourceKeyError | GltfError>;

/**
 * Project a parsed `GltfDoc` into the disk-shape `<source>.meta.json` plus
 * the freshly minted `subAssets[]` list (UUIDv7 + reimport-reuse-meta
 * two-stage match per plan-strategy section 2.4). Source-key conflicts are
 * returned before GUID minting or serialization.
 *
 * `existingMeta` is the previously-written `<source>.meta.json` parsed back
 * into memory (callers typically read + JSON.parse it before invoking).
 * `undefined` triggers first-pass full-fresh GUID minting.
 *
 * Sub-asset ordering: meshes first, then materials, then scenes - the
 * order is stable across reimports so AC-13 byte-identical holds when
 * source content does not change. Stable semantic sourceKey values are
 * assigned by the producer reuse boundary; sourceIndex remains a locator.
 */
export function toAssetPack(
  doc: GltfDoc,
  existingMeta: GltfMetaJson | undefined,
  source: string,
): GltfAssetPackResult {
  const items: GltfDocItem[] = [];
  // Mesh sub-assets are keyed on the *original glTF mesh-index*, not on the
  // flat GltfMeshIr index. parseGltf flattens N glTF meshes with M_i primitives
  // into sum(M_i) GltfMeshIr rows (each carries its owning meshIndex). The
  // gltfImporter merges all primitives sharing a meshIndex into one MeshAsset
  // with M_i Submesh entries (one per primitive), so the meta sidecar must
  // emit exactly one `kind: 'mesh'` row per unique meshIndex — not one per
  // flat GltfMeshIr row, which would over-emit M_i sub-assets per glTF mesh and
  // desynchronise from runtime MeshRenderer.materials[].length.
  const seenMeshIndices = new Set<number>();
  for (const m of doc.meshes) {
    if (m === undefined) continue;
    if (seenMeshIndices.has(m.meshIndex)) continue;
    seenMeshIndices.add(m.meshIndex);
    items.push({
      kind: 'mesh',
      sourceIndex: m.meshIndex,
      ...(m.name === undefined ? {} : { name: m.name }),
    });
  }
  for (let i = 0; i < doc.materials.length; i++) {
    const m = doc.materials[i];
    if (m === undefined) continue;
    items.push({
      kind: 'material',
      sourceIndex: i,
      ...(m.name === undefined ? {} : { name: m.name }),
    });
  }
  for (let i = 0; i < doc.scenes.length; i++) {
    const s = doc.scenes[i];
    if (s === undefined) continue;
    items.push({
      kind: 'scene',
      sourceIndex: i,
      ...(s.name === undefined ? {} : { name: s.name }),
    });
  }
  // Texture sub-assets — one entry per `images[]` row (feat-20260608 M3 D-3,
  // requirements G-2 / AC-13). Orphan images (declared but unreferenced by
  // any `textures[]` row) still produce a sub-asset; the importer assigns
  // them colorSpace 'linear' (no colour-encoded purpose inferable). Without
  // this loop the meta carries no `kind: 'texture'` row, AssetRegistry
  // never imports the bytes, and the runtime renders a white box (G-2).
  const images = doc.images ?? [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img === undefined) continue;
    items.push({
      kind: 'texture',
      sourceIndex: i,
      ...(img.name === undefined ? {} : { name: img.name }),
    });
  }
  const samplers = doc.samplers ?? [];
  for (let i = 0; i < samplers.length; i++) {
    const sampler = samplers[i];
    if (sampler === undefined) continue;
    items.push({
      kind: 'sampler',
      sourceIndex: i,
      ...(sampler.name === undefined ? {} : { name: sampler.name }),
    });
  }
  // Skeletons (feat-20260523-skin-skeleton-animation M0).
  for (let i = 0; i < doc.skeletons.length; i++) {
    items.push({ kind: 'skeleton', sourceIndex: i });
  }
  // Skin bindings (feat-20260523-skin-skeleton-animation M0).
  // Emit one skin sub-asset per SkeletonPod (1:1 mapping).
  for (let i = 0; i < doc.skeletons.length; i++) {
    items.push({ kind: 'skin', sourceIndex: i });
  }
  // Animation clips (feat-20260523-skin-skeleton-animation M0).
  for (let i = 0; i < doc.animationClips.length; i++) {
    const clip = doc.animationClips[i];
    if (clip === undefined) continue;
    items.push({
      kind: 'animation-clip',
      sourceIndex: i,
      ...(clip.name === undefined ? {} : { name: clip.name }),
    });
  }

  const reuse = reimportReuseMeta(items, existingMeta);
  if (!reuse.ok) return reuse;
  const subAssetByKindIndex = new Map(
    reuse.value.subAssets.map((entry) => [`${entry.kind}:${entry.sourceIndex}`, entry]),
  );
  const sourceOverrides: Record<string, Readonly<Record<string, unknown>>> = {
    ...(existingMeta?.sourceOverrides ?? {}),
  };
  const lodGroups =
    doc.lod === undefined ? [] : doc.lod.groups.length > 0 ? doc.lod.groups : [doc.lod];
  for (const lodGroup of lodGroups) {
    if (lodGroup.lodNodeIds.length === 0) continue;
    const rootMeshIndex = doc.nodes[lodGroup.rootNode]?.meshIndex;
    const referencedMeshIndices = [
      rootMeshIndex,
      ...lodGroup.lodNodeIds.map((nodeIndex) => doc.nodes[nodeIndex]?.meshIndex),
    ];
    if (
      referencedMeshIndices.some(
        (meshIndex) =>
          !Number.isInteger(meshIndex) ||
          meshIndex === null ||
          meshIndex === undefined ||
          !seenMeshIndices.has(meshIndex as number),
      )
    ) {
      return err(
        gltfErr('gltf-lod-invalid', {
          rootNode: lodGroup.rootNode,
          ids: lodGroup.lodNodeIds,
          reason: 'missing-node',
        }),
      );
    }
    const rootOutput =
      rootMeshIndex === undefined || rootMeshIndex === null
        ? undefined
        : subAssetByKindIndex.get(`mesh:${rootMeshIndex}`);
    const levels = lodGroup.lodNodeIds.map((nodeIndex, index) => {
      const meshIndex = doc.nodes[nodeIndex]?.meshIndex;
      const output =
        meshIndex === undefined || meshIndex === null
          ? undefined
          : subAssetByKindIndex.get(`mesh:${meshIndex}`);
      return {
        sourceKey: output?.sourceKey ?? `mesh:${meshIndex ?? nodeIndex}`,
        meshGuid: output?.guid ?? '',
        ...(lodGroup.screenCoverages[index] === undefined
          ? {}
          : { screenCoverage: lodGroup.screenCoverages[index] }),
      };
    });
    if (rootOutput?.sourceKey !== undefined && levels.every((level) => level.meshGuid !== '')) {
      const projected = reconcileMeshLodMeta(
        existingMeta?.sourceOverrides?.[rootOutput.sourceKey]?.lods,
        levels,
      );
      if (!projected.ok)
        return err(
          gltfErr('gltf-lod-invalid', {
            rootNode: lodGroup.rootNode,
            ids: lodGroup.lodNodeIds,
            reason: 'coverage',
          }),
        );
      sourceOverrides[rootOutput.sourceKey] = {
        ...(sourceOverrides[rootOutput.sourceKey] ?? {}),
        lods: projected.value.lods,
      };
    }
  }
  const materialOutputs = reuse.value.subAssets.filter((entry) => entry.kind === 'material');
  const materialSources = {
    nameByIndex: new Map(
      doc.materials.flatMap((material, index) =>
        material.name === undefined ? [] : [[index, material.name] as const],
      ),
    ),
    guidByIndex: new Map(materialOutputs.map((entry) => [entry.sourceIndex, entry.guid])),
    sourceKeyByIndex: new Map(
      materialOutputs.flatMap((entry) =>
        entry.sourceKey === undefined ? [] : [[entry.sourceIndex, entry.sourceKey] as const],
      ),
    ),
  };
  for (const meshIndex of seenMeshIndices) {
    const meshOutput = subAssetByKindIndex.get(`mesh:${meshIndex}`);
    if (meshOutput?.sourceKey === undefined) continue;
    const primitives = doc.meshes.filter((mesh) => mesh.meshIndex === meshIndex);
    const materialTable = createMeshMaterialSlotTable('gltf', materialSources);
    for (const primitive of primitives) materialTable.slotFor(primitive.materialIndex);
    const materialSlots = materialTable.slots;
    const previousPayload = existingMeta?.sourceOverrides?.[meshOutput.sourceKey];
    const previousRaw = previousPayload?.materialSlots;
    const previous = Array.isArray(previousRaw)
      ? previousRaw.filter(
          (slot): slot is MeshMaterialSlotTopologyEntry =>
            slot !== null &&
            typeof slot === 'object' &&
            !Array.isArray(slot) &&
            typeof (slot as { slotName?: unknown }).slotName === 'string',
        )
      : [];
    const reconciled = reconcileMeshMaterialSlotTopology(materialSlots, previous);
    if (!reconciled.ok) {
      return err({
        code: 'mesh-material-slot-topology-change',
        expected: `unambiguous material slot identity for mesh ${meshOutput.guid}`,
        hint: reconciled.error.hint,
        detail: {
          sourceIndices: reconciled.error.nextIndices,
          previousIndices: reconciled.error.previousIndices,
        },
      });
    }
    sourceOverrides[meshOutput.sourceKey] = {
      ...(previousPayload ?? {}),
      materialSlots: reconciled.slots,
    };
  }
  const meta: GltfMetaJson = {
    schemaVersion: 1,
    kind: 'external-asset-package',
    importer: 'gltf',
    source,
    subAssets: reuse.value.subAssets,
    ...(Object.keys(sourceOverrides).length === 0 ? {} : { sourceOverrides }),
    sourceOverrideDescriptors: reuse.value.subAssets
      .filter((entry) => entry.kind === 'mesh' && entry.sourceKey !== undefined)
      .map((entry) => ({
        sourceKey: entry.sourceKey as string,
        semantic: 'mesh-material-slot-defaults' as const,
        payloadSchema: MESH_MATERIAL_SLOT_SOURCE_OVERRIDE_PAYLOAD_SCHEMA,
      })),
    importSettings: {
      defaultSceneIndex: doc.defaultSceneIndex,
      ...(typeof existingMeta?.importSettings.standardMaterialGuid === 'string'
        ? { standardMaterialGuid: existingMeta.importSettings.standardMaterialGuid }
        : {}),
      ...(existingMeta?.importSettings.downscaleMaxDimension !== undefined
        ? { downscaleMaxDimension: existingMeta.importSettings.downscaleMaxDimension }
        : {}),
      diagnostics: {
        nodeNames: doc.diagnostics.nodeNames,
        unsupportedExtensions: doc.diagnostics.unsupportedExtensions,
        matrixTrsCoexistNodes: doc.diagnostics.matrixTrsCoexistNodes,
      },
    },
  };
  return ok({ meta, subAssets: reuse.value.subAssets });
}

// Keep the component-type table available from this importer module.
export { COMPONENT_TYPE };
