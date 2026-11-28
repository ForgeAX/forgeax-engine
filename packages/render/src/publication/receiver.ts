import type { AssetRegistry, MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import {
  type AssetChange,
  type AssetReader,
  assetDataBytes,
} from '@forgeax/engine-assets-runtime/internal';
import {
  deriveVertexCount,
  deriveVertexLayoutProjection,
  prepareMeshData,
} from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  type Asset,
  AssetError,
  err,
  type MaterialAsset,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { isWaterMeshLayoutReceiptValid } from '@forgeax/engine-water/internal';
import { LIGHTING_CHANNELS_DEFAULT, validateChannelMask } from '../components/lighting-channels';
import { validatePointLightDecay } from '../components/point-light';
import { MeshResidencyError } from '../dynamic-geometry';
import {
  DEFAULT_DYNAMIC_GEOMETRY_MESH_BUDGET_BYTES,
  validateDynamicGeometryMeshBudget,
} from '../dynamic-geometry-budget';
import { isRenderFeatureTextureSource } from '../features/feature-texture-source';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';
import { isRenderFeatureSourceFailure } from '../features/source';
import type { RenderFeatureSubmission } from '../features/types';
import { MaterialResource } from '../material-resource';
import { isMaterialSourceSnapshot } from '../material-source';
import type { DispatchEntry, ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import { sameValue } from '../same-value';
import { ScenePoseWriter } from '../scene/captured-transform';
import { dispatchEntry } from '../scene/dispatch-entry';
import { FrameListBase } from '../scene/frame-list';
import { slotContent } from '../scene/mesh-draw';
import { captureMaterialOverrides } from '../scene/mesh-materials';
import type { RenderSceneApplyResult, RenderSceneOperation } from '../scene/render-scene-types';
import { SceneRows, type SceneRowWriteAccess, type WorldTransformSpan } from '../scene/scene-rows';
import { validatePublishedSurfaceDynamicInput } from '../surface/frame-source';
import { isCanvasTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import { isRenderTextureSourceToken, renderTextureSourceKey } from '../textures/source-token';
import { validTilemapSource } from '../tilemap-geometry';
import { ownWaterMeshAdmissionDraw } from '../water/mesh-source-admission';
import {
  type PreparedAssetPatch,
  type PublishedAssetPatch,
  prepareAssetPatch,
} from './asset-patch';
import { CanvasFrameReceiver, type PublishedCanvasFrame } from './canvas';
import {
  type PublishedAssetVersion,
  type PublishedMeshPreparation,
  type PublishedMeshTransferReservation,
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
  type RenderPublicationMetadata,
  type RenderPublicationRows,
  type RenderPublicationTemplate,
} from './contract';
import {
  collectMaterialDependencies,
  publicationDependencies,
  publicationFrameDependencies,
} from './dependencies';
import { stageDrawParameters } from './draw-parameters';
import {
  canOwnReceivedPublishedMesh,
  copyPublishedMesh,
  ownReceivedPublishedMesh,
  samePublishedMesh,
} from './mesh';
import { ownPublishedMeshBuffers } from './mesh-buffer-ownership';
import { isPackedRowsMesh, packedRowsMeshError } from './packed-rows-mesh';
import {
  installPublicationPrograms,
  PublicationMaterialProjectionAdmission,
  rebindPublicationMaterialSchemas,
} from './programs';
import { adoptWorkerMaterialSnapshot } from './received-materials';
import { decodeRenderPublication, type RenderPublicationMessage } from './record';
import type { RenderResourceScope } from './resource-scope';
import { SkinJointReferences } from './skin-joints';
import { RenderPublicationTargetReceiver, type RenderTargetAuthoring } from './targets';
import { PublicationTransformRows } from './transform-rows';

export interface PreparedRenderPublication {
  /** Fixed row indices into this packet, not a callback into later receiver state. */
  readonly skinJoints?: { readonly rows: readonly number[]; readonly retired: ReadonlySet<number> };
  readonly assetChanges: readonly AssetChange[];
  readonly materialUpdates: readonly MaterialResource[];
  readonly resources: RenderResourceScope;
  readonly packet: RenderPublication;
  readonly operations: readonly RenderSceneOperation[];
  readonly frame: ExtractedFrame;
  /**
   * The receiver's shared rows after this publication, the rows
   * revision it was applied on (-1 for a cold baseline) and its committed delta.
   * Views observe the delta; none of them copies or re-applies the rows.
   */
  readonly scene: PublicationScene;
  readonly onFeatureSourceSubmitted?: (
    identity: string,
    feedback: unknown,
    submission?: RenderFeatureSubmission,
  ) => void;
}

export interface PublicationScene {
  readonly rows: SceneRows;
  /** Shared composition may make staged edits through the receiving row owner. */
  readonly stageRows?: SceneRowWriteAccess;
  readonly before: number;
  readonly delta: RenderSceneApplyResult | undefined;
}

/** Renderer-level preparation of accepted rows before they enter the shared rows. */
export type PublicationRowPreparation = (
  prepared: PreparedRenderPublication,
) => PreparedRenderPublication;

function finiteFloats(values: Float32Array): boolean {
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) return false;
  }
  return true;
}

type AcceptedAssetRow = RenderPublication['assets'][number];

export type ClosedLevelAssetPayload = PublishedAssetVersion & { readonly guid?: string };

interface HeldLevelAsset extends ClosedLevelAssetPayload {
  current: boolean;
  holds: number;
}

export type ClosedLevelAssetPublication =
  | ClosedLevelAssetPayload
  | Pick<PublishedAssetVersion, 'handle' | 'revision'>;

export interface ClosedLevelAssetHold {
  readonly value: Asset;
  isCurrent(): boolean;
  release(): void;
}
type TemplateSnapshot = RenderPublicationTemplate['snapshot'];
type WaterMeshSource = NonNullable<TemplateSnapshot['waterMeshSource']>;
type WaterMeshLayoutReceipt = WaterMeshSource['views'][number]['draws'][number]['layout'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

const vertexAttributeNames = new Set<string>([
  'position',
  'normal',
  'uv',
  'tangent',
  'skinIndex',
  'skinWeight',
  'uv1',
  'uv2',
  'uv3',
  'uv4',
  'uv5',
  'uv6',
  'uv7',
  'color',
]);

function isVertexAttributeMap(value: unknown): value is VertexAttributeMap {
  if (!isRecord(value)) return false;
  for (const [name, attribute] of Object.entries(value)) {
    if (
      !vertexAttributeNames.has(name) ||
      (attribute !== undefined &&
        !(attribute instanceof ArrayBuffer) &&
        !(attribute instanceof Float32Array) &&
        !(attribute instanceof Uint16Array))
    )
      return false;
  }
  return true;
}

function isWaterMeshLayoutReceipt(value: unknown): value is WaterMeshLayoutReceipt {
  if (!isRecord(value) || !isRecord(value.offsets)) return false;
  return (
    typeof value.schemaVersion === 'number' &&
    Number.isSafeInteger(value.schemaVersion) &&
    typeof value.strideBytes === 'number' &&
    Number.isSafeInteger(value.strideBytes) &&
    typeof value.byteLength === 'number' &&
    Number.isSafeInteger(value.byteLength) &&
    typeof value.coverageByteLength === 'number' &&
    Number.isSafeInteger(value.coverageByteLength) &&
    Object.values(value.offsets).every(
      (offset) => typeof offset === 'number' && Number.isSafeInteger(offset),
    ) &&
    typeof value.layoutHash === 'string' &&
    typeof value.dataHash === 'string' &&
    typeof value.coverageDataHash === 'string'
  );
}
type FrameLights = RenderPublicationMetadata['lights'];
type SkinReferenceCandidate = ReturnType<SkinJointReferences['prepare']>;
type PatchedAssetRow = { readonly row: AcceptedAssetRow; commit(): void };

function shapeError(subject: string): RenderPublicationError {
  return new RenderPublicationError({ reason: 'shape', subject });
}

function rejectPublication(
  reason: RenderPublicationError['detail']['reason'],
  subject: string,
): Result<never, RenderPublicationError> {
  return err(new RenderPublicationError({ reason, subject }));
}

/** Handle/revision/payload shape, including an explicit packed-rows Mesh POD. */
function preparedMeshShapeError(input: PublishedMeshPreparation): string | undefined {
  if (
    !Number.isSafeInteger(input.meshHandle) ||
    input.mesh?.kind !== 'mesh' ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1
  )
    return 'prepared mesh handle/payload';
  if (input.mesh.attributeStorage === 'static-streams') {
    const prepared = prepareMeshData(input.mesh, 'render mesh publication');
    return prepared.ok ? undefined : 'invalid static vertex streams';
  }
  return isPackedRowsMesh(input.mesh) ? packedRowsMeshError(input.mesh) : undefined;
}

/** Frame-shaped numeric columns, lists and metadata. */
function packetColumnsError(packet: RenderPublication): RenderPublicationError | undefined {
  if (!numericColumnsValid(packet)) return shapeError('numeric columns');
  if (!publicationListsValid(packet) || !frameMetadataValid(packet))
    return shapeError('frame metadata');
  if (packet.surfaceDynamicInputs !== undefined) {
    if (!Array.isArray(packet.surfaceDynamicInputs) || packet.surfaceDynamicInputs.length > 1)
      return shapeError('one source Surface input page');
    for (const input of packet.surfaceDynamicInputs) {
      const valid = validatePublishedSurfaceDynamicInput(input);
      if (!valid.ok) return shapeError(`Surface input: ${valid.error.message}`);
    }
  }
  return undefined;
}

function numericColumnsValid(packet: RenderPublication): boolean {
  return (
    packet.upserts instanceof Uint32Array &&
    packet.upserts.length % 2 === 0 &&
    packet.removed instanceof Uint32Array &&
    packet.retiredJoints instanceof Uint32Array &&
    packet.transformEntities instanceof Uint32Array &&
    packet.transforms instanceof Float32Array &&
    packet.transforms.length === packet.transformEntities.length * 16 &&
    finiteFloats(packet.transforms) &&
    Number.isFinite(packet.sampleTimeSeconds)
  );
}

function publicationListsValid(packet: RenderPublication): boolean {
  return (
    Array.isArray(packet.videoFrames) &&
    Array.isArray(packet.targets) &&
    Array.isArray(packet.targetSources) &&
    Array.isArray(packet.features) &&
    Array.isArray(packet.templates) &&
    Array.isArray(packet.programs) &&
    Array.isArray(packet.assets) &&
    Array.isArray(packet.retiredAssets) &&
    Array.isArray(packet.assetPatches)
  );
}

function frameMetadataValid(packet: RenderPublication): boolean {
  const metadata = packet.metadata;
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    Array.isArray(metadata.cameras) &&
    metadata.lights !== null &&
    typeof metadata.lights === 'object' &&
    Array.isArray(metadata.lights.point) &&
    Array.isArray(metadata.lights.pointShadow) &&
    Array.isArray(metadata.lights.spot) &&
    Array.isArray(metadata.lights.rect) &&
    publicationTimeValid(packet.time)
  );
}

function invalidLightingChannels(
  light: { readonly lightingChannels?: number } | null | undefined,
): boolean {
  return (
    light !== undefined &&
    (light === null ||
      typeof light !== 'object' ||
      validateChannelMask(
        light.lightingChannels === undefined ? LIGHTING_CHANNELS_DEFAULT : light.lightingChannels,
      ) !== null)
  );
}

function lightingChannelsError(lights: FrameLights): RenderPublicationError | undefined {
  if (
    invalidLightingChannels(lights.directional) ||
    lights.point.some(invalidLightingChannels) ||
    lights.spot.some(invalidLightingChannels) ||
    lights.rect.some(invalidLightingChannels)
  )
    return shapeError('light lightingChannels');
  return undefined;
}

function invalidShadowCasterChannels(
  shadow: { readonly shadowCasterChannels?: number } | null | undefined,
): boolean {
  return (
    shadow !== undefined &&
    (shadow === null ||
      typeof shadow !== 'object' ||
      validateChannelMask(
        shadow.shadowCasterChannels === undefined ? 0xffffffff : shadow.shadowCasterChannels,
        'shadowCasterChannels',
      ) !== null)
  );
}

function shadowCasterChannelsError(lights: FrameLights): RenderPublicationError | undefined {
  if (
    invalidShadowCasterChannels(lights.directionalCsmConfig) ||
    lights.pointShadow.some(invalidShadowCasterChannels) ||
    lights.spot.some(invalidShadowCasterChannels)
  )
    return shapeError('light shadowCasterChannels');
  return undefined;
}

function punctualLightDecayError(lights: FrameLights): RenderPublicationError | undefined {
  for (const light of lights.point) {
    if (
      light === undefined ||
      validatePointLightDecay(light.decay === undefined ? 2 : light.decay) !== null
    )
      return shapeError('point light decay');
  }
  for (const light of lights.spot) {
    if (
      light === undefined ||
      validatePointLightDecay(light.decay === undefined ? 2 : light.decay, 'SpotLight') !== null
    )
      return shapeError('spot light decay');
  }
  return undefined;
}

function unusableVideoFrame(frame: unknown): boolean {
  return (
    typeof VideoFrame === 'undefined' ||
    !(frame instanceof VideoFrame) ||
    frame.displayWidth <= 0 ||
    frame.displayHeight <= 0
  );
}

// Shared answers for the common frame without these rows; never mutated.
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_TOKENS: ReadonlySet<object> = new Set();

function validCanvasPixels(row: PublishedCanvasFrame, canvases: CanvasFrameReceiver): boolean {
  switch (row.snapshot) {
    case undefined:
      return row.frame === undefined || (!row.disposed && !unusableVideoFrame(row.frame));
    case 'replace':
      return !row.disposed && !unusableVideoFrame(row.frame);
    case 'reuse':
      return !row.disposed && row.frame === undefined && canvases.hasSnapshot(row);
    default:
      return false;
  }
}

function admitCanvasFrameIds(
  rows: RenderPublication['canvasFrames'],
  canvases: CanvasFrameReceiver,
): Result<ReadonlySet<string>, RenderPublicationError> {
  if (rows !== undefined && !Array.isArray(rows))
    return rejectPublication('shape', 'canvas frames');
  if (rows === undefined || rows.length === 0) return ok(NO_KEYS);
  const canvasIds = new Set<string>();
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      typeof row.flipY !== 'boolean' ||
      canvasIds.has(row.id) ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      typeof row.disposed !== 'boolean' ||
      !validCanvasPixels(row, canvases)
    )
      return rejectPublication('shape', 'canvas frame');
    canvasIds.add(row.id);
  }
  return ok(canvasIds);
}

function videoFramesError(
  rows: RenderPublication['videoFrames'],
): RenderPublicationError | undefined {
  if (rows.length === 0) return undefined;
  const videoKeys = new Set<string>();
  for (const row of rows) {
    const key = `${row.entity}:${row.clip}`;
    if (
      !Number.isSafeInteger(row.entity) ||
      !Number.isSafeInteger(row.clip) ||
      unusableVideoFrame(row.frame) ||
      videoKeys.has(key)
    )
      return shapeError('video frame');
    videoKeys.add(key);
  }
  return undefined;
}

function admitTargetTokens(
  rows: RenderPublication['targets'],
): Result<ReadonlySet<object>, RenderPublicationError> {
  if (rows.length === 0) return ok(NO_TOKENS);
  const targetIds = new Set<number>();
  const targetTokens = new Set<object>();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      targetIds.has(row.id) ||
      typeof row.token !== 'object' ||
      row.token === null ||
      targetTokens.has(row.token) ||
      typeof row.descriptor !== 'object' ||
      row.descriptor === null
    )
      return rejectPublication('shape', 'target identity/descriptor');
    targetIds.add(row.id);
    targetTokens.add(row.token);
  }
  return ok(targetTokens);
}

/**
 * Every camera target is published, and each game planar reflection target has
 * one writer. A planar camera without a target uses an engine-owned lease.
 */
function cameraTargetsError(
  metadata: RenderPublicationMetadata,
  targetTokens: ReadonlySet<object>,
): RenderPublicationError | undefined {
  for (const camera of [...metadata.cameras, ...metadata.auxiliaryCameras]) {
    if (camera.orderOpaqueByLayer !== undefined && typeof camera.orderOpaqueByLayer !== 'boolean')
      return shapeError('camera orderOpaqueByLayer');
    if (
      camera.cullMask !== undefined &&
      (!Number.isInteger(camera.cullMask) || camera.cullMask < 0 || camera.cullMask > 0xffffffff)
    )
      return shapeError('camera cullMask');
  }
  const unpublished = (camera: { readonly target?: object }) =>
    camera.target !== undefined && !targetTokens.has(camera.target);
  if (
    metadata.cameras.some(unpublished) ||
    metadata.auxiliaryCameras.some(unpublished) ||
    metadata.cubeCameras.some(unpublished)
  )
    return shapeError('missing target descriptor');
  if (!metadata.auxiliaryCameras.some((camera) => camera.planarReflection !== undefined))
    return undefined;
  const cameraWriters = [
    ...metadata.cameras,
    ...metadata.auxiliaryCameras,
    ...metadata.cubeCameras,
  ];
  const planarTargets = new Set(
    metadata.auxiliaryCameras
      .filter((camera) => camera.planarReflection !== undefined)
      .map((camera) => camera.target),
  );
  for (const target of planarTargets) {
    if (target === undefined) continue;
    if (cameraWriters.filter((camera) => camera.target === target).length !== 1)
      return shapeError('duplicate planar target writer');
  }
  return undefined;
}

function admitTargetSourceKeys(
  rows: RenderPublication['targetSources'],
  targetTokens: ReadonlySet<object>,
): Result<ReadonlySet<string>, RenderPublicationError> {
  if (rows.length === 0) return ok(NO_KEYS);
  const sourceTokens = new Set<string>();
  for (const row of rows) {
    if (
      !targetTokens.has(row.target) ||
      !isRenderTextureSourceToken(row.token) ||
      row.token.source !== 'target' ||
      sourceTokens.has(renderTextureSourceKey(row.token))
    )
      return rejectPublication('shape', 'target source');
    sourceTokens.add(renderTextureSourceKey(row.token));
  }
  return ok(sourceTokens);
}

/** Canvas ids and target-source keys a material texture may reference in this frame. */
function admitFrameTextureSources(
  packet: RenderPublication,
  canvases: CanvasFrameReceiver,
): Result<
  { readonly canvasIds: ReadonlySet<string>; readonly sourceTokens: ReadonlySet<string> },
  RenderPublicationError
> {
  const lights = packet.metadata.lights;
  const lightError =
    lightingChannelsError(lights) ??
    shadowCasterChannelsError(lights) ??
    punctualLightDecayError(lights);
  if (lightError !== undefined) return err(lightError);
  const canvasIds = admitCanvasFrameIds(packet.canvasFrames, canvases);
  if (!canvasIds.ok) return canvasIds;
  const videoError = videoFramesError(packet.videoFrames);
  if (videoError !== undefined) return err(videoError);
  const targetTokens = admitTargetTokens(packet.targets);
  if (!targetTokens.ok) return targetTokens;
  const cameraError = cameraTargetsError(packet.metadata, targetTokens.value);
  if (cameraError !== undefined) return err(cameraError);
  const sourceTokens = admitTargetSourceKeys(packet.targetSources, targetTokens.value);
  if (!sourceTokens.ok) return sourceTokens;
  return ok({ canvasIds: canvasIds.value, sourceTokens: sourceTokens.value });
}

function versionKey(row: { handle: number; revision: number }): string {
  return `${row.handle}:${row.revision}`;
}

function validVersion(row: { handle: number; revision: number }): boolean {
  return (
    row !== null &&
    typeof row === 'object' &&
    Number.isSafeInteger(row.handle) &&
    row.handle > 0 &&
    row.handle <= 0xffffffff &&
    Number.isSafeInteger(row.revision) &&
    row.revision > 0
  );
}
function closedLevelAssetError(
  identity: RenderPublicationIdentity,
  row: ClosedLevelAssetPayload,
): string | undefined {
  if (
    !validVersion(row) ||
    row.value === null ||
    typeof row.value !== 'object' ||
    typeof row.value.kind !== 'string' ||
    (row.guid !== undefined && (typeof row.guid !== 'string' || !AssetGuid.parse(row.guid).ok))
  )
    return 'closed Level asset';
  if (row.value.kind !== 'mesh') return undefined;
  return preparedMeshShapeError({
    ...identity,
    meshHandle: row.handle as PublishedMeshPreparation['meshHandle'],
    revision: row.revision,
    mesh: row.value,
  });
}

function sameAssetPayload(left: Asset, right: Asset): boolean {
  if (left === right) return true;
  if (left.kind === 'mesh' && right.kind === 'mesh') return samePublishedMesh(left, right);
  return sameValue(left, right);
}

/** Program declarations own immutable JSON; numeric assets keep their exact view types. */
function ownAdmittedAssetValue(value: Asset): Asset {
  if (value.kind !== 'particle-effect' && value.kind !== 'material') return value;
  const owned = ownRenderFeatureProgramData(value);
  return isOwnedRenderFeatureProgramData(owned) ? owned : value;
}
function featureIdentitiesError(
  rows: RenderPublication['features'],
): RenderPublicationError | undefined {
  if (rows.length === 0) return undefined;
  const featureIdentities = new Set<string>();
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof row.identity !== 'string' ||
      featureIdentities.has(row.identity)
    )
      return shapeError('feature identity');
    if (
      row.hiddenEntities !== undefined &&
      (!Array.isArray(row.hiddenEntities) ||
        row.hiddenEntities.some(
          (report) =>
            report === null ||
            typeof report !== 'object' ||
            !Number.isInteger(report.entity) ||
            report.entity < 0 ||
            report.entity > 0xffff_ffff,
        ))
    )
      return shapeError('feature hidden entity');
    if (
      row.failure !== undefined &&
      (row.data !== undefined || !isRenderFeatureSourceFailure(row.failure))
    )
      return shapeError('feature source failure');
    featureIdentities.add(row.identity);
  }
  return undefined;
}

const NO_MATERIALS: ReadonlySet<number> = new Set();
const NO_ROWS: readonly never[] = Object.freeze([]);
const NO_GUID_CHANGES: ReadonlyMap<string, number | undefined> = new Map();
const NO_PROJECTIONS: ReadonlyMap<AcceptedAssetRow, MaterialRenderProjection> = new Map();
const NO_VERSIONS = Object.freeze({
  retired: NO_KEYS,
  admitted: new Map<string, FixedAssetVersion>() as ReadonlyMap<string, FixedAssetVersion>,
});

function validMaterialContext(
  context: RenderPublication['materials'][number]['value']['materialContext'],
): boolean {
  return (
    context === undefined ||
    (context !== null &&
      typeof context === 'object' &&
      ['mesh', 'skinned', 'sprite', 'sprite-instances', 'terrain'].includes(context.geometry) &&
      typeof context.vertexColor === 'boolean')
  );
}

function validSharedMaterialRow(row: RenderPublication['materials'][number]): boolean {
  return (
    typeof row === 'object' &&
    row !== null &&
    Number.isSafeInteger(row.id) &&
    row.id > 0 &&
    row.id <= 0xffffffff &&
    row.value !== null &&
    typeof row.value === 'object' &&
    Array.isArray(row.value.passes) &&
    ArrayBuffer.isView(row.value.baseColor) &&
    Number.isFinite(row.value.roughness) &&
    Number.isFinite(row.value.metallic) &&
    validMaterialContext(row.value.materialContext) &&
    (row.value.sourceAssets === undefined || isMaterialSourceSnapshot(row.value.sourceAssets))
  );
}

function stageSharedMaterials(
  materials: RenderPublication['materials'],
  retiredMaterials: ReadonlySet<number>,
  adoptValues?: typeof adoptWorkerMaterialSnapshot,
): Result<Map<number, MaterialResource>, RenderPublicationError> {
  const stagedMaterials = new Map<number, MaterialResource>();
  for (const row of materials) {
    if (!validSharedMaterialRow(row) || stagedMaterials.has(row.id) || retiredMaterials.has(row.id))
      return rejectPublication('shape', 'shared material');
    stagedMaterials.set(
      row.id,
      new MaterialResource(adoptValues === undefined ? row.value : adoptValues(row.value)),
    );
  }
  return ok(stagedMaterials);
}

function validGlyphSource(glyph: NonNullable<TemplateSnapshot['glyph']>): boolean {
  return (
    glyph !== null &&
    typeof glyph === 'object' &&
    Number.isInteger(glyph.font) &&
    glyph.font > 0 &&
    glyph.font <= 4294967295 &&
    typeof glyph.text === 'string' &&
    Number.isFinite(glyph.size) &&
    glyph.size > 0 &&
    typeof glyph.worldOriented === 'boolean' &&
    Array.isArray(glyph.color) &&
    glyph.color.length === 4 &&
    glyph.color.every(Number.isFinite)
  );
}

function validWaterGpuMeshDraw(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.zoneKey !== 'string' ||
    value.zoneKey.length === 0 ||
    value.viewIndex !== 0 ||
    value.viewCount !== 1 ||
    typeof value.materialCount !== 'number' ||
    !Number.isSafeInteger(value.materialCount) ||
    value.materialCount < 1 ||
    typeof value.materialBucket !== 'number' ||
    !Number.isSafeInteger(value.materialBucket) ||
    value.materialBucket < 0 ||
    value.materialBucket >= value.materialCount ||
    typeof value.tileCapacity !== 'number' ||
    !Number.isSafeInteger(value.tileCapacity) ||
    value.tileCapacity < 1 ||
    !isUnknownArray(value.sourceBodies) ||
    value.sourceBodies.length < 1 ||
    value.sourceBodies.length > 127
  )
    return false;
  const bodies = new Set<string>();
  return value.sourceBodies.every((body) => {
    if (
      !isRecord(body) ||
      typeof body.guid !== 'string' ||
      body.guid.length === 0 ||
      bodies.has(body.guid) ||
      typeof body.generation !== 'number' ||
      !Number.isSafeInteger(body.generation) ||
      body.generation < 0
    )
      return false;
    bodies.add(body.guid);
    return true;
  });
}

function validWaterMeshSource(sourceValue: unknown, materialCount: number): boolean {
  const materialStartIndex = isRecord(sourceValue) ? sourceValue.materialStartIndex : undefined;
  if (
    !isRecord(sourceValue) ||
    typeof sourceValue.guid !== 'string' ||
    typeof sourceValue.generation !== 'number' ||
    !Number.isSafeInteger(sourceValue.generation) ||
    sourceValue.generation < 0 ||
    typeof sourceValue.worldIdentity !== 'string' ||
    typeof sourceValue.zoneGuid !== 'string' ||
    typeof sourceValue.zoneGeneration !== 'number' ||
    !Number.isSafeInteger(sourceValue.zoneGeneration) ||
    sourceValue.zoneGeneration < 0 ||
    (sourceValue.targetFormat !== 'rgba16float' && sourceValue.targetFormat !== 'rgba32float') ||
    typeof materialStartIndex !== 'number' ||
    !Number.isSafeInteger(materialStartIndex) ||
    materialStartIndex < 0 ||
    materialStartIndex > materialCount ||
    !isUnknownArray(sourceValue.views)
  )
    return false;
  const viewIdentities = new Set<string>();
  const drawKeys = new Set<string>();
  return sourceValue.views.every((viewValue: unknown) => {
    if (
      !isRecord(viewValue) ||
      typeof viewValue.viewIdentity !== 'string' ||
      viewValue.viewIdentity.length === 0 ||
      viewIdentities.has(viewValue.viewIdentity) ||
      !isUnknownArray(viewValue.draws)
    )
      return false;
    viewIdentities.add(viewValue.viewIdentity);
    return viewValue.draws.every((drawValue: unknown) => {
      if (!isRecord(drawValue)) return false;
      const readCheckedWaterMesh = () => {
        const mesh = drawValue.mesh;
        if (
          !isRecord(mesh) ||
          mesh.kind !== 'mesh' ||
          !(mesh.vertices instanceof Float32Array) ||
          !isVertexAttributeMap(mesh.attributes)
        )
          return undefined;
        const position = mesh.attributes.position;
        if (
          !(position instanceof Float32Array) ||
          position.length === 0 ||
          position.length % 3 !== 0
        )
          return undefined;

        return {
          mesh: mesh as Record<string, unknown> & {
            vertices: Float32Array;
            attributes: import('@forgeax/engine-types').VertexAttributeMap;
          },
          position,
        };
      };
      const checkedWaterMesh = readCheckedWaterMesh();
      if (checkedWaterMesh === undefined) return false;
      const { mesh, position } = checkedWaterMesh;
      const vertexCount = deriveVertexCount(
        mesh.vertices,
        deriveVertexLayoutProjection(mesh.attributes),
      );
      const indices = mesh.indices;
      const submeshes = mesh.submeshes;
      const drawKey = drawValue.drawKey;
      const materialIndex = drawValue.materialIndex;
      const localAabb = drawValue.localAabb;
      const instanceCount = drawValue.instanceCount;
      const bytes = drawValue.bytes;
      const coverageBytes = drawValue.coverageBytes;
      const layout = drawValue.layout;
      const transitionTargets = drawValue.transitionTargets;

      const invalidWaterMeshVertices = (
        mesh: Record<string, unknown> & { vertices: Float32Array },
      ) =>
        mesh.vertices.length === 0 ||
        vertexCount === undefined ||
        vertexCount < 1 ||
        vertexCount !== position.length / 3 ||
        !finiteFloats(mesh.vertices);
      const invalidWaterMeshLocalBounds = (localAabb: Float32Array) =>
        localAabb.length !== 6 ||
        !finiteFloats(localAabb) ||
        (localAabb[0] as number) > (localAabb[3] as number) ||
        (localAabb[1] as number) > (localAabb[4] as number) ||
        (localAabb[2] as number) > (localAabb[5] as number);
      const invalidWaterMeshInstanceStorage = (
        bytes: Uint8Array,
        coverageBytes: Uint8Array,
        layout: WaterMeshLayoutReceipt,
        instanceCount: number,
      ) =>
        drawValue.gpu === undefined
          ? bytes.byteLength !== instanceCount * layout.strideBytes
          : !validWaterGpuMeshDraw(drawValue.gpu) ||
            instanceCount !== 1 ||
            bytes.byteLength !== 0 ||
            coverageBytes.byteLength !== 0;
      const validateWaterMeshDrawInput = (
        mesh: Record<string, unknown> & {
          vertices: Float32Array;
          attributes: import('@forgeax/engine-types').VertexAttributeMap;
        },
      ) => {
        const invalidWaterMeshDrawKey = (drawKey: string) =>
          drawKey.length === 0 || drawKeys.has(drawKey);
        const invalidWaterMeshMaterialIndex = (materialIndex: number) =>
          !Number.isSafeInteger(materialIndex) ||
          materialIndex < materialStartIndex ||
          materialIndex >= materialCount;
        if (
          typeof drawKey !== 'string' ||
          invalidWaterMeshDrawKey(drawKey) ||
          typeof materialIndex !== 'number' ||
          invalidWaterMeshMaterialIndex(materialIndex) ||
          invalidWaterMeshVertices(mesh as Record<string, unknown> & { vertices: Float32Array }) ||
          !isUnknownArray(submeshes) ||
          submeshes.length !== 1 ||
          !(indices instanceof Uint32Array) ||
          !(localAabb instanceof Float32Array) ||
          invalidWaterMeshLocalBounds(localAabb) ||
          typeof instanceCount !== 'number' ||
          !Number.isSafeInteger(instanceCount) ||
          instanceCount < 1 ||
          !(bytes instanceof Uint8Array) ||
          !(coverageBytes instanceof Uint8Array) ||
          !isWaterMeshLayoutReceipt(layout) ||
          !isWaterMeshLayoutReceiptValid(layout, bytes, coverageBytes) ||
          invalidWaterMeshInstanceStorage(bytes, coverageBytes, layout, instanceCount) ||
          !isUnknownArray(transitionTargets)
        )
          return false;
        const validateWaterMeshDrawTail = (
          submeshes: readonly unknown[],
          indices: Uint32Array,
          vertexCount: number,
          transitionTargets: readonly unknown[],
          instanceCount: number,
          drawKey: string,
        ) => {
          const submesh = submeshes.at(0);
          if (
            !isRecord(submesh) ||
            typeof submesh.indexOffset !== 'number' ||
            !Number.isSafeInteger(submesh.indexOffset) ||
            submesh.indexOffset !== 0 ||
            typeof submesh.indexCount !== 'number' ||
            !Number.isSafeInteger(submesh.indexCount) ||
            submesh.indexCount !== indices.length ||
            typeof submesh.vertexCount !== 'number' ||
            !Number.isSafeInteger(submesh.vertexCount) ||
            submesh.vertexCount !== vertexCount ||
            submesh.topology !== 'triangle-list' ||
            submesh.materialSlot !== 0
          )
            return false;
          const validTargets = transitionTargets.every((targetValue: unknown) => {
            if (!isRecord(targetValue)) return false;
            const instanceIndex = targetValue.instanceIndex;
            const bodyGeneration = targetValue.bodyGeneration;
            return (
              typeof instanceIndex === 'number' &&
              Number.isSafeInteger(instanceIndex) &&
              instanceIndex >= 0 &&
              instanceIndex < instanceCount &&
              typeof targetValue.bodyGuid === 'string' &&
              typeof bodyGeneration === 'number' &&
              Number.isSafeInteger(bodyGeneration) &&
              bodyGeneration >= 0
            );
          });
          if (!validTargets) return false;
          drawKeys.add(drawKey);
          return true;
        };
        return validateWaterMeshDrawTail(
          submeshes,
          indices,
          vertexCount as number,
          transitionTargets,
          instanceCount,
          drawKey,
        );
      };
      return validateWaterMeshDrawInput(mesh);
    });
  });
}

function ownWaterMeshSource(
  source: NonNullable<TemplateSnapshot['waterMeshSource']>,
): NonNullable<TemplateSnapshot['waterMeshSource']> {
  return Object.freeze({
    ...source,
    views: Object.freeze(
      source.views.map((view) =>
        Object.freeze({
          ...view,
          draws: Object.freeze(
            view.draws.map((draw) =>
              ownWaterMeshAdmissionDraw(source, view.viewIdentity, {
                ...draw,
                mesh: copyPublishedMesh(draw.mesh),
                localAabb: draw.localAabb.slice(),
                ...(draw.gpu === undefined
                  ? {}
                  : {
                      gpu: Object.freeze({
                        ...draw.gpu,
                        sourceBodies: Object.freeze(
                          draw.gpu.sourceBodies.map((body) => Object.freeze({ ...body })),
                        ),
                      }),
                    }),
              }),
            ),
          ),
        }),
      ),
    ),
  });
}

/** Tilemap, WaterMesh, GlyphText and sprite-region sources a template may draw. */
function templateGeometryError(snapshot: TemplateSnapshot): RenderPublicationError | undefined {
  const tilemap = snapshot.tilemap;
  if (tilemap !== undefined && (snapshot.assetHandle !== undefined || !validTilemapSource(tilemap)))
    return shapeError('Tilemap source');
  const waterMesh = snapshot.waterMeshSource;
  if (waterMesh !== undefined && !validWaterMeshSource(waterMesh, snapshot.materials.length))
    return shapeError('WaterMesh source');
  const glyph = snapshot.glyph;
  if (
    snapshot.generatedMesh !== undefined ||
    (glyph !== undefined && (snapshot.assetHandle !== undefined || !validGlyphSource(glyph)))
  )
    return shapeError('GlyphText source');
  const spriteRegion = snapshot.spriteRegion;
  if (
    spriteRegion !== undefined &&
    (!Array.isArray(spriteRegion) ||
      spriteRegion.length !== 4 ||
      spriteRegion.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
  )
    return shapeError('sprite region');
  return undefined;
}

/** Layer, preparation and channel facts a template binds to its materials. */
function templateBindingError(snapshot: TemplateSnapshot): RenderPublicationError | undefined {
  const gpuError = gpuVertexBindingError(snapshot);
  if (gpuError !== undefined) return gpuError;
  if (
    (snapshot.layer !== undefined &&
      (!Number.isInteger(snapshot.layer) ||
        snapshot.layer < -0x80000000 ||
        snapshot.layer > 0x7fffffff)) ||
    (snapshot.shadowCaster !== undefined && snapshot.shadowCaster !== false)
  )
    return shapeError('material binding');
  if (snapshot.pipelinePreparation !== undefined && !Array.isArray(snapshot.pipelinePreparation))
    return shapeError('pipeline preparation passes');
  if (snapshot.frustumCulled !== undefined && snapshot.frustumCulled !== false)
    return shapeError('receiver frustumCulled');
  if (
    snapshot.renderLayers !== undefined &&
    (!Number.isInteger(snapshot.renderLayers) ||
      snapshot.renderLayers < 0 ||
      snapshot.renderLayers > 0xffffffff)
  )
    return shapeError('receiver renderLayers');
  if (
    validateChannelMask(
      snapshot.lightingChannels === undefined
        ? LIGHTING_CHANNELS_DEFAULT
        : snapshot.lightingChannels,
    ) !== null
  )
    return shapeError('receiver lightingChannels');
  if (
    validateChannelMask(
      snapshot.shadowChannels === undefined ? 0xffffffff : snapshot.shadowChannels,
      'shadowChannels',
    ) !== null
  )
    return shapeError('receiver shadowChannels');
  return undefined;
}

function everyMaterialResolved(
  resources: (MaterialResource | undefined)[],
): resources is MaterialResource[] {
  return resources.every((resource) => resource !== undefined);
}

/** Resolve template material ids in publication order; staging order is material update order. */
function resolveTemplateMaterials(
  snapshot: TemplateSnapshot,
  material: (id: number) => MaterialResource | undefined,
): Result<
  {
    readonly first: MaterialResource;
    readonly resources: MaterialResource[];
    readonly overrides: readonly (MaterialResource | undefined)[] | undefined;
  },
  RenderPublicationError
> {
  const resources = snapshot.materials.map(material);
  if (snapshot.materialOverrides !== undefined && !Array.isArray(snapshot.materialOverrides))
    return rejectPublication('shape', 'material overrides');
  const overrides = snapshot.materialOverrides?.map((id: number) =>
    id === 0 ? undefined : material(id),
  );
  if (
    overrides?.some(
      (resource: MaterialResource | undefined, index: number) =>
        resource === undefined && snapshot.materialOverrides?.[index] !== 0,
    )
  )
    return rejectPublication('shape', 'missing material override');
  const first = material(snapshot.material);
  if (
    first === undefined ||
    !snapshot.materials.includes(snapshot.material) ||
    !everyMaterialResolved(resources)
  )
    return rejectPublication('shape', 'missing material reference');
  return ok({ first, resources, overrides });
}

function materialTextureSourcesError(
  resources: readonly (MaterialResource | undefined)[],
  canvasIds: ReadonlySet<string>,
  sourceTokens: ReadonlySet<string>,
  originKey: (key: string) => string | undefined,
): RenderPublicationError | undefined {
  for (const resource of resources)
    for (const source of resource?.snapshot.textureSources?.values() ?? []) {
      // Feature textures are renderer-owned names, resolved by the feature
      // host in its current generation. They have no transported target token.
      if (isRenderFeatureTextureSource(source)) continue;
      if (
        isExternalTextureSource(source) ||
        (isCanvasTextureSource(source)
          ? !canvasIds.has(renderTextureSourceKey(source))
          : !sourceTokens.has(
              originKey(renderTextureSourceKey(source)) ?? renderTextureSourceKey(source),
            ))
      )
        return shapeError('missing material texture source');
    }
  return undefined;
}

function validStaticSkinBinding(binding: NonNullable<TemplateSnapshot['skinBinding']>): boolean {
  return (
    binding !== null &&
    typeof binding === 'object' &&
    Number.isSafeInteger(binding.skeleton) &&
    binding.skeleton > 0 &&
    binding.skeleton <= 0xffffffff &&
    (binding.affinePoint === undefined || typeof binding.affinePoint === 'boolean') &&
    Array.isArray(binding.joints) &&
    binding.joints.length !== 0 &&
    !binding.joints.some(
      (joint: unknown) =>
        !Number.isSafeInteger(joint) ||
        typeof joint !== 'number' ||
        joint < 0 ||
        joint > 0xffffffff,
    )
  );
}

/** Skin facts arrive as a static Binding only; the receiver derives GPU skin state. */
function templateSkinError(snapshot: TemplateSnapshot): RenderPublicationError | undefined {
  if ('skin' in snapshot && snapshot.skin !== undefined)
    return shapeError('source GPU skin receipt');
  if (snapshot.skinBinding !== undefined && !validStaticSkinBinding(snapshot.skinBinding))
    return shapeError('static Skin binding');
  if (snapshot.capsuleShadowRequested !== undefined && snapshot.capsuleShadowRequested !== true)
    return shapeError('capsule shadow author request');
  return undefined;
}

type StagedTemplate = Omit<RenderableSnapshot, 'entityKey' | 'transform'>;

/** Resolve and validate each distinct template once per owned chunk. */
function createTemplateDecoder(
  material: (id: number) => MaterialResource | undefined,
  canvasIds: ReadonlySet<string>,
  sourceTokens: ReadonlySet<string>,
  originKey: (key: string) => string | undefined,
  bind?: (input: StagedTemplate) => StagedTemplate,
) {
  const stagedTemplates = new Map<RenderPublicationTemplate, StagedTemplate>();
  return (template: RenderPublicationTemplate): StagedTemplate | RenderPublicationError => {
    const known = stagedTemplates.get(template);
    if (known !== undefined) return known;
    if (!Array.isArray(template.snapshot?.materials) || !Array.isArray(template.dispatch))
      return shapeError('template');
    const sourceError =
      templateGeometryError(template.snapshot) ?? templateBindingError(template.snapshot);
    if (sourceError !== undefined) return sourceError;
    const materials = resolveTemplateMaterials(template.snapshot, material);
    if (!materials.ok) return materials.error;
    const { first, resources, overrides } = materials.value;
    const bindingError =
      materialTextureSourcesError(
        [...resources, ...(overrides ?? [])],
        canvasIds,
        sourceTokens,
        originKey,
      ) ?? templateSkinError(template.snapshot);
    if (bindingError !== undefined) return bindingError;
    const binding = template.snapshot.skinBinding;
    const ownedBinding =
      binding === undefined
        ? undefined
        : Object.freeze({
            skeleton: binding.skeleton,
            ...(binding.affinePoint ? { affinePoint: true } : {}),
            joints: Object.freeze([...binding.joints]),
          });
    const { materialOverrides: _overrides, ...templateContent } = template.snapshot;
    const waterMeshSource =
      template.snapshot.waterMeshSource === undefined
        ? undefined
        : ownWaterMeshSource(template.snapshot.waterMeshSource);
    const staged: StagedTemplate = {
      ...templateContent,
      ...(waterMeshSource === undefined ? {} : { waterMeshSource }),
      ...(ownedBinding === undefined ? {} : { skinBinding: ownedBinding }),
      ...(overrides === undefined
        ? {}
        : { materialOverrides: captureMaterialOverrides(overrides) }),
      material: first,
      materials: Object.freeze(resources),
    };
    const bound = bind?.(staged) ?? staged;
    stagedTemplates.set(template, bound);
    return bound;
  };
}

/** Decode static rows whose payload ownership moved to this realm.
 * The result has no ordinary scene, revision or material holding side effects.
 * Asset version resolution, native prepare and commit belong to the Level owner. */
export function decodeClosedLevelRows(
  chunk: RenderPublicationRows,
): Result<readonly RenderableSnapshot[], RenderPublicationError> {
  if (
    !(chunk.upserts instanceof Uint32Array) ||
    !(chunk.transformEntities instanceof Uint32Array) ||
    !(chunk.transforms instanceof Float32Array) ||
    chunk.upserts.length !== chunk.transformEntities.length * 2 ||
    chunk.transforms.length !== chunk.transformEntities.length * 16 ||
    !finiteFloats(chunk.transforms) ||
    !Array.isArray(chunk.templates) ||
    !Array.isArray(chunk.materials)
  )
    return rejectPublication('shape', 'closed Level row columns');
  const materials = stageSharedMaterials(
    chunk.materials,
    NO_MATERIALS,
    adoptWorkerMaterialSnapshot,
  );
  if (!materials.ok) return materials;
  const stage = createTemplateDecoder(
    (id) => materials.value.get(id),
    NO_KEYS,
    NO_KEYS,
    () => undefined,
  );
  const seen = new Set<number>();
  const rows: RenderableSnapshot[] = [];
  const poses = new ScenePoseWriter(chunk.transformEntities.length);
  for (let index = 0; index < chunk.transformEntities.length; index++) {
    const entityKey = chunk.transformEntities[index] as number;
    const template = chunk.templates[chunk.upserts[2 * index + 1] as number];
    if (
      entityKey === 0 ||
      seen.has(entityKey) ||
      entityKey !== chunk.upserts[2 * index] ||
      template == null
    )
      return rejectPublication('shape', 'closed Level row identity');
    if (template.snapshot == null || !isClosedLevelTemplate(template.snapshot))
      return rejectPublication('unsupported', 'closed Level static mesh source');
    const snapshot = stage(template);
    if (snapshot instanceof RenderPublicationError) return err(snapshot);
    seen.add(entityKey);
    rows.push({
      ...snapshot,
      entityKey,
      transform: poses.capture(chunk.transforms, index * 16),
    });
  }
  return ok(rows);
}

function isClosedLevelTemplate(snapshot: TemplateSnapshot): boolean {
  const { assetHandle, instances } = snapshot;
  if (
    assetHandle === undefined ||
    !Number.isInteger(assetHandle) ||
    assetHandle <= 0 ||
    assetHandle > 0xffffffff
  )
    return false;
  return (
    validStaticLevelGeometry(snapshot) &&
    snapshot.residencyGroup === undefined &&
    snapshot.temporal === undefined &&
    snapshot.probeBlendRecord === undefined &&
    validClosedLevelInstances(instances)
  );
}

/** This transport carries authored static Mesh rows; derived geometry is prepared by Render. */
function validStaticLevelGeometry(snapshot: TemplateSnapshot): boolean {
  return (
    snapshot.skinBinding === undefined &&
    snapshot.morph === undefined &&
    snapshot.terrain === undefined &&
    snapshot.terrainSection === undefined &&
    snapshot.tilemap === undefined &&
    snapshot.glyph === undefined &&
    snapshot.gpuVertexSource === undefined &&
    snapshot.waterMeshSource === undefined &&
    snapshot.waterGpuMesh === undefined &&
    snapshot.waterMeshTiles === undefined &&
    snapshot.waterOwner === undefined &&
    snapshot.nativeDraw === undefined &&
    snapshot.capsuleShadowRequested === undefined &&
    snapshot.spriteRegion === undefined &&
    snapshot.spriteInstances === undefined &&
    snapshot.pointsLines === undefined
  );
}

function validClosedLevelInstances(instances: StagedTemplate['instances']): boolean {
  return (
    instances === undefined ||
    (instances !== null &&
      instances.transforms instanceof Float32Array &&
      Number.isInteger(instances.instanceCount) &&
      instances.instanceCount >= 0 &&
      instances.transforms.length === instances.instanceCount * 16 &&
      instances.collectionId === undefined &&
      instances.generations === undefined &&
      finiteFloats(instances.transforms))
  );
}

type TemplateDispatch = RenderPublicationTemplate['dispatch'];

/**
 * The publication frame's dispatch, projected on read from each row's shared
 * template Passes: a baseline of N rows holds N template references, not
 * one entry object per row and Pass.
 */
class PublicationDispatch extends FrameListBase<DispatchEntry> {
  private readonly keys: number[] = [];
  private readonly templates: TemplateDispatch[] = [];
  private offsets: Uint32Array | undefined;
  length = 0;

  push(entityKey: number, template: TemplateDispatch): void {
    this.keys.push(entityKey);
    this.templates.push(template);
    this.length += template.length;
    this.offsets = undefined;
  }

  private row(index: number): number {
    if (this.offsets === undefined) {
      const offsets = new Uint32Array(this.templates.length + 1);
      for (let row = 0; row < this.templates.length; row++)
        offsets[row + 1] = (offsets[row] as number) + (this.templates[row]?.length ?? 0);
      this.offsets = offsets;
    }
    const offsets = this.offsets;
    let low = 0;
    let high = this.templates.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if ((offsets[middle] as number) <= index) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  at(index: number): DispatchEntry | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    const row = this.row(index);
    const item = this.templates[row]?.[index - (this.offsets?.[row] ?? 0)];
    return item === undefined
      ? undefined
      : dispatchEntry(item, this.keys[row] as number, row, item.layer ?? 0);
  }

  *[Symbol.iterator](): Generator<DispatchEntry> {
    for (let row = 0; row < this.templates.length; row++)
      for (const item of this.templates[row] ?? [])
        yield dispatchEntry(item, this.keys[row] as number, row, item.layer ?? 0);
  }
}

function bindTemplateMaterials(
  row: StagedTemplate,
  canonical: ReadonlyMap<MaterialResource, MaterialResource>,
): StagedTemplate {
  // All entities using this template share its final receiver-local slots.
  const replaced = (resource: MaterialResource | undefined): boolean => {
    const mapped = resource === undefined ? undefined : canonical.get(resource);
    return mapped !== undefined && mapped !== resource;
  };
  if (
    !replaced(row.material) &&
    !row.materials.some(replaced) &&
    !(row.materialOverrides ?? []).some(replaced)
  )
    return row;
  return {
    ...row,
    material: canonical.get(row.material) ?? row.material,
    materials: Object.freeze(row.materials.map((resource) => canonical.get(resource) ?? resource)),
    ...(row.materialOverrides === undefined
      ? {}
      : {
          materialOverrides: captureMaterialOverrides(
            row.materialOverrides.map((resource) =>
              resource === undefined ? undefined : (canonical.get(resource) ?? resource),
            ),
          ),
        }),
  };
}

function validAssetSource(row: AcceptedAssetRow): boolean {
  return (
    row.sourceKey === undefined ||
    (typeof row.sourceKey === 'string' &&
      row.sourceKey.length !== 0 &&
      typeof row.guid === 'string' &&
      row.guid.length !== 0)
  );
}

function validSkinSkeleton(skeleton: Asset | undefined): boolean {
  return (
    skeleton?.kind === 'skeleton' &&
    skeleton.inverseBindMatrices instanceof Float32Array &&
    skeleton.inverseBindMatrices.length === skeleton.jointCount * 16 &&
    finiteFloats(skeleton.inverseBindMatrices)
  );
}

/** Assets live for this source session; the Renderer owns all retained scene/GPU state. */
/** Accepted revisions a released prepared payload stays adoptable (covers in-flight draws). */
const RELEASED_PREPARED_MESH_REVISIONS = 8;

interface PreparedMeshEntry {
  readonly mesh: MeshAsset;
  readonly revision: number;
  readonly leases: Set<{ retire(): void; published(): void }>;
  readonly bytes: number;
  fixedHolds: number;
  cached: boolean;
}

interface FixedAssetVersion {
  readonly value: Asset;
  readonly preparation?: PreparedMeshEntry;
}

interface StagedAssetVersions {
  readonly retired: ReadonlySet<string>;
  readonly admitted: ReadonlyMap<string, FixedAssetVersion>;
}

export class RenderPublicationReceiver {
  private revision = 0;
  /** Completes the frame metadata a successor message omits as unchanged. */
  private acceptedMetadata: RenderPublicationMetadata | undefined;
  private readonly transformRows = new PublicationTransformRows();
  private readonly skinJoints = new SkinJointReferences();
  // Receiver source facts, once per referenced joint. Per-view SkinInputs derive
  // their numeric roots from these facts; no Binding owns another pose copy.
  private readonly jointMatrices = new Map<number, Float32Array>();
  private readonly materials = new Map<
    number,
    { readonly resource: MaterialResource; holds: number }
  >();
  /** Exact versions are immutable. Only their live material users can block retirement. */
  private readonly versionMaterials = new Map<string, Set<number>>();
  private readonly materialIds = new WeakMap<MaterialResource, number>();
  private disposed = false;
  private failed = false;
  private accepting = false;
  // The accepted Mesh and its next unpublished candidate may both hold leases.
  private readonly preparedMeshes = new Map<number, Map<number, PreparedMeshEntry>>();
  private preparedMeshBytes = 0;
  private reservedMeshTransferBytes = 0;
  private peakMeshBudgetBytes = 0;

  private get meshBudgetBytesUsed(): number {
    return this.preparedMeshBytes + this.reservedMeshTransferBytes;
  }

  inspectMeshStorage() {
    return {
      preparedBytes: this.preparedMeshBytes,
      reservedTransferBytes: this.reservedMeshTransferBytes,
      peakBudgetBytes: this.peakMeshBudgetBytes,
      limitBytes: this.maxPreparedMeshBytes,
    };
  }
  /**
   * Payloads of released or superseded preparations stay adoptable for a few
   * revisions, keyed by handle and revision: a release, or a newer revision's
   * mesh-prepare, may be handled before a queued draw that references the
   * older payload.
   */
  private readonly releasedPreparedMeshes = new Map<
    string,
    { readonly entry: PreparedMeshEntry; readonly until: number }
  >();
  private keepReleasedPrepared(handle: number, entry: PreparedMeshEntry): void {
    const key = `${handle}:${entry.revision}`;
    entry.cached = true;
    this.releasedPreparedMeshes.set(key, {
      entry,
      until: this.revision + RELEASED_PREPARED_MESH_REVISIONS,
    });
  }
  private dropReleasedPrepared(key: string, reactivated?: PreparedMeshEntry): void {
    const released = this.releasedPreparedMeshes.get(key);
    if (released === undefined) return;
    const { entry } = released;
    if (entry.fixedHolds > 0 && entry !== reactivated) return;
    this.releasedPreparedMeshes.delete(key);
    entry.cached = false;
    this.releasePreparedMeshBytes(entry);
  }

  private releasePreparedMeshBytes(entry: PreparedMeshEntry): void {
    if (entry.leases.size === 0 && entry.fixedHolds === 0 && !entry.cached)
      this.preparedMeshBytes -= entry.bytes;
  }

  private findPreparedMesh(handle: number, revision: number): PreparedMeshEntry | undefined {
    return (
      this.preparedMeshes.get(handle)?.get(revision) ??
      this.releasedPreparedMeshes.get(versionKey({ handle, revision }))?.entry
    );
  }

  private preparedMeshBudgetError(bytes: number): MeshResidencyError | undefined {
    const used = this.meshBudgetBytesUsed;
    if (used <= this.maxPreparedMeshBytes - bytes) return undefined;
    return new MeshResidencyError(
      'mesh-residency-budget-exceeded',
      'prepared and in-transit publication Mesh bytes fit the Render budget',
      'retire earlier preparations or increase the Renderer mesh budget',
      { used, requested: bytes, limit: this.maxPreparedMeshBytes },
    );
  }

  reserveMeshTransfer(
    bytes: number,
  ): Result<PublishedMeshTransferReservation, RenderPublicationError | MeshResidencyError> {
    if (this.disposed || this.failed)
      return rejectPublication('disposed', 'receiver retired or failed; start a new source epoch');
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      return rejectPublication('shape', 'Mesh transfer size must be a positive safe integer');
    const failure = this.preparedMeshBudgetError(bytes);
    if (failure !== undefined) return err(failure);
    this.reservedMeshTransferBytes += bytes;
    this.peakMeshBudgetBytes = Math.max(this.peakMeshBudgetBytes, this.meshBudgetBytesUsed);
    let held = true;
    return ok({
      bytes,
      release: () => {
        if (!held) return;
        held = false;
        this.reservedMeshTransferBytes -= bytes;
      },
    });
  }

  private capturePreparedMesh(
    input: PublishedMeshPreparation,
    current: MeshAsset | undefined,
    inputOwnership?: 'received',
  ): Result<PreparedMeshEntry, RenderPublicationError | MeshResidencyError> {
    const mesh = current ?? input.mesh;
    try {
      const take =
        current !== undefined ||
        (inputOwnership === 'received' && canOwnReceivedPublishedMesh(mesh));
      const bytes = assetDataBytes(mesh, undefined, take ? 'receive' : 'copy');
      const failure = this.preparedMeshBudgetError(bytes);
      if (failure !== undefined) return err(failure);
      const owned = current ?? (take ? ownPublishedMeshBuffers(mesh) : copyPublishedMesh(mesh));
      this.preparedMeshBytes += bytes;
      this.peakMeshBudgetBytes = Math.max(this.peakMeshBudgetBytes, this.meshBudgetBytesUsed);
      return ok({
        mesh: owned,
        revision: input.revision,
        leases: new Set(),
        bytes,
        fixedHolds: 0,
        cached: false,
      });
    } catch (cause) {
      return rejectPublication('shape', cause instanceof Error ? cause.message : String(cause));
    }
  }
  private readonly canvases = new CanvasFrameReceiver();
  private readonly videoFrames = new Map<string, VideoFrame>();
  /**
   * This source's retained rows: the single source-key to row identity
   * translation, shared by every view of the Renderer.
   */
  private readonly rows: SceneRows;
  private readonly poses = new ScenePoseWriter();
  private readonly stageRows: SceneRowWriteAccess;
  private readonly prepareRows: PublicationRowPreparation | undefined;
  private readonly targets: RenderPublicationTargetReceiver | undefined;
  private readonly assetVersions = new Map<string, FixedAssetVersion>();
  /** CPU payloads held for closed Level work in this publication namespace. */
  private readonly levelAssets = new Map<number, HeldLevelAsset>();
  private readonly levelGuids = new Map<string, HeldLevelAsset>();
  private readonly assets = new Map<number, RenderPublication['assets'][number]>();
  private readonly acceptedPrograms = new Set<string>();
  /** Validated, owned projections shared by every material row with equal content. */
  private readonly projections = new PublicationMaterialProjectionAdmission();
  private readonly resources: RenderResourceScope;
  private drawParameters: Map<number, readonly number[]> | undefined;
  private readonly readDrawParameters = (entity: number) => this.drawParameters?.get(entity);
  private guidHandles = new Map<string, number>();

  constructor(
    private readonly identity: RenderPublicationIdentity,
    targets?: RenderTargetAuthoring,
    prepareRows?: PublicationRowPreparation,
    private readonly maxPreparedMeshBytes = DEFAULT_DYNAMIC_GEOMETRY_MESH_BUDGET_BYTES,
  ) {
    validateDynamicGeometryMeshBudget(maxPreparedMeshBytes);
    this.prepareRows = prepareRows;
    this.targets = targets === undefined ? undefined : new RenderPublicationTargetReceiver(targets);
    const resolveAsset: AssetReader['resolveAsset'] = <T extends Asset>(
      handle: number,
      revision?: number,
    ) => {
      const value =
        revision === undefined
          ? (this.assets.get(handle)?.value ?? this.currentLevelAsset(handle)?.value)
          : (this.assetVersions.get(versionKey({ handle, revision }))?.value ??
            this.levelAssetAtVersion(handle, revision));
      return value === undefined
        ? err(
            new AssetError({
              code: 'asset-not-found',
              expected: 'the accepted publication contains the referenced asset generation',
              hint: 'publish the asset closure before drawing its consumer',
            }),
          )
        : ok(value as T);
    };
    const acceptedRevision = () => (this.disposed || this.failed ? -1 : this.revision);
    const readDrawParameters = () =>
      this.drawParameters === undefined ? undefined : this.readDrawParameters;
    this.resources = {
      get revision() {
        return acceptedRevision();
      },
      get drawParameters() {
        return readDrawParameters();
      },
      identity: `${identity.source}:${identity.epoch}`,
      time: {
        delta: 0,
        elapsed: 0,
        maxDeltaSeconds: 0,
        unscaledDelta: 0,
        unscaledElapsed: 0,
        scale: 1,
      },
      transparentSort: { mode: 0, yzAlpha: 1 },
      resolveAsset,
      resolveMaterialTemplate: (handle, revision) => {
        const row = this.assets.get(handle);
        const projection = row?.materialProjection;
        if (
          row?.revision !== revision ||
          row.value.kind !== 'material' ||
          projection?.sourceTemplate === undefined
        )
          return undefined;
        return { asset: row.value as MaterialAsset, projection };
      },
      assetRevision: (handle) =>
        this.assets.get(handle)?.revision ?? this.currentLevelAsset(handle)?.revision,
      canvasFrame: (id) => this.canvases.get(id),
      videoFrame: (entity, clip) => this.videoFrames.get(`${entity}:${clip}`),
      handleForGuid: (guid) => this.readableGuidHandle(guid),
      sourceForAsset: (handle) => {
        const row = this.assets.get(handle);
        return row?.guid === undefined
          ? undefined
          : {
              guid: row.guid,
              ...(row.sourceKey === undefined ? {} : { sourceKey: row.sourceKey }),
            };
      },
      lookupAsset: <T extends Asset>(guid: string): T | undefined => {
        const handle = this.readableGuidHandle(guid);
        if (handle === undefined) return undefined;
        const asset = resolveAsset<T>(handle);
        return asset.ok ? asset.value : undefined;
      },
    };
    this.rows = new SceneRows(this.resources);
    this.stageRows = {
      prepareRow: (snapshot) => this.rows.prepareRow(snapshot),
      apply: (operations, spans) => this.rows.apply(operations, spans),
      commitTransformSpans: (spans, world) => this.rows.commitTransformSpans(spans, world),
    };
  }

  /** The ordinary publisher independently retains its complete asset dependencies. */
  referencesAcceptedAsset(handle: number): boolean {
    return this.assets.has(handle);
  }

  private readableGuidHandle(guid: string): number | undefined {
    const key = guid.toLowerCase();
    const held = this.levelGuids.get(key);
    return this.guidHandles.get(key) ?? (held?.current === true ? held.handle : undefined);
  }

  private currentLevelAsset(handle: number): HeldLevelAsset | undefined {
    const entry = this.levelAssets.get(handle);
    return entry?.current ? entry : undefined;
  }

  private levelAssetAtVersion(handle: number, revision: number): Asset | undefined {
    const level = this.levelAssets.get(handle);
    return level?.revision === revision ? level.value : undefined;
  }

  /**
   * Retain one received immutable asset in the source's existing render scope.
   * Ordinary packet validation still uses the ordinary accepted dependency
   * closure. This hold can be used by device preparation before participation.
   */
  retainClosedLevelAsset(
    identity: RenderPublicationIdentity,
    row: ClosedLevelAssetPublication,
  ): Result<ClosedLevelAssetHold, RenderPublicationError> {
    if (this.disposed || this.failed)
      return rejectPublication('disposed', 'closed Level asset receiver');
    if (identity.source !== this.identity.source || identity.epoch !== this.identity.epoch)
      return rejectPublication('identity', 'closed Level asset source');
    const hasPayload = row !== null && typeof row === 'object' && 'value' in row;
    if (hasPayload) {
      const invalid = closedLevelAssetError(identity, row);
      if (invalid !== undefined) return rejectPublication('shape', invalid);
    } else if (!validVersion(row)) return rejectPublication('shape', 'closed Level asset version');
    const current = this.assets.get(row.handle);
    const held = this.levelAssets.get(row.handle);
    if (
      (current !== undefined && current.revision !== row.revision) ||
      (held !== undefined && (!held.current || held.revision !== row.revision))
    )
      return rejectPublication('revision', 'closed Level asset differs from the live revision');
    if (hasPayload) return this.holdReceivedLevelAsset(row, current?.value, held);
    return held === undefined
      ? rejectPublication('revision', 'closed Level asset is no longer retained')
      : ok(this.holdLevelAsset(held));
  }

  private holdReceivedLevelAsset(
    row: ClosedLevelAssetPayload,
    current: Asset | undefined,
    held: HeldLevelAsset | undefined,
  ): Result<ClosedLevelAssetHold, RenderPublicationError> {
    const guid = row.guid?.toLowerCase();
    const previous = guid === undefined ? undefined : this.levelGuids.get(guid);
    if (
      (previous?.current === true && previous.handle !== row.handle) ||
      (held !== undefined && held.guid?.toLowerCase() !== guid)
    )
      return rejectPublication('shape', 'closed Level asset conflicts with its source identity');
    const known =
      held?.value ??
      current ??
      this.assetVersions.get(versionKey(row))?.value ??
      this.findPreparedMesh(row.handle, row.revision)?.mesh;
    if (known !== undefined && !sameAssetPayload(known, row.value))
      return rejectPublication('shape', 'closed Level asset conflicts with the retained payload');
    const value =
      known ??
      (row.value.kind === 'mesh'
        ? ownReceivedPublishedMesh(row.value)
        : ownAdmittedAssetValue(row.value));
    return ok(this.holdLevelAsset(held ?? { ...row, value, holds: 0, current: true }));
  }

  private holdLevelAsset(entry: HeldLevelAsset): ClosedLevelAssetHold {
    const { handle, value } = entry;
    const guid = entry.guid?.toLowerCase();
    entry.holds++;
    this.levelAssets.set(handle, entry);
    if (guid !== undefined) this.levelGuids.set(guid, entry);
    let released = false;
    return {
      value,
      isCurrent: () =>
        !released &&
        !this.disposed &&
        !this.failed &&
        entry.current &&
        this.levelAssets.get(handle) === entry,
      release: () => {
        if (released) return;
        released = true;
        entry.holds--;
        if (entry.holds === 0 && this.levelAssets.get(handle) === entry)
          this.levelAssets.delete(handle);
        if (entry.holds === 0 && guid !== undefined && this.levelGuids.get(guid) === entry)
          this.levelGuids.delete(guid);
      },
    };
  }

  private prepareMeshEntry(
    input: PublishedMeshPreparation,
    key: string,
    versions: ReadonlyMap<number, PreparedMeshEntry>,
    inputOwnership?: 'received',
  ): Result<PreparedMeshEntry, RenderPublicationError | MeshResidencyError> {
    const accepted = this.assets.get(input.meshHandle);
    const acceptedRevision = accepted?.revision ?? 0;
    if (
      input.revision < acceptedRevision ||
      (input.revision !== acceptedRevision && [...versions.keys()].some((r) => r > input.revision))
    )
      return rejectPublication('revision', 'stale prepared mesh revision');
    const active = versions.get(input.revision);
    const mesh =
      active?.mesh ??
      (accepted?.revision === input.revision ? accepted.value : undefined) ??
      this.levelAssetAtVersion(input.meshHandle, input.revision);
    if (mesh !== undefined && (mesh.kind !== 'mesh' || !samePublishedMesh(mesh, input.mesh)))
      return rejectPublication('shape', 'prepared mesh conflicts with its resource handle');
    if (active !== undefined) return ok(active);
    const cached = this.releasedPreparedMeshes.get(key)?.entry;
    if (cached !== undefined && samePublishedMesh(cached.mesh, input.mesh)) return ok(cached);
    if (cached !== undefined && cached.fixedHolds > 0)
      return rejectPublication('shape', 'prepared mesh conflicts with a fixed asset version');
    // A cancelled candidate may reuse its uncommitted slot with different data
    // once its physical lease has been released. Keep the old cache until admission succeeds.
    return this.capturePreparedMesh(input, mesh, inputOwnership);
  }

  /** Reserve a Mesh POD without admitting a scene row or an asset dependency. */
  prepareMesh(
    input: PublishedMeshPreparation,
    onRetire: () => void = () => {},
    onPublished: () => void = () => {},
    inputOwnership?: 'received',
    reservation?: PublishedMeshTransferReservation,
  ): Result<
    {
      readonly resources: RenderResourceScope;
      readonly mesh: MeshAsset;
      isCurrent(): boolean;
      release(): void;
    },
    RenderPublicationError | MeshResidencyError
  > {
    if (this.disposed || this.failed)
      return rejectPublication('disposed', 'receiver retired or failed; start a new source epoch');
    if (input.source !== this.identity.source || input.epoch !== this.identity.epoch)
      return rejectPublication('identity', 'prepared mesh source/epoch');
    const invalid = preparedMeshShapeError(input);
    if (invalid !== undefined) return rejectPublication('shape', invalid);
    if (reservation !== undefined) {
      try {
        if (
          inputOwnership !== 'received' ||
          assetDataBytes(input.mesh, undefined, 'receive') !== reservation.bytes
        )
          return rejectPublication('shape', 'received Mesh size does not match its reserved bytes');
      } catch (cause) {
        return rejectPublication('shape', cause instanceof Error ? cause.message : String(cause));
      }
      // No async work can intervene between returning credit and adopting the
      // exact prepared storage (or reusing an earlier entry).
      reservation.release();
    }
    const { meshHandle, revision } = input;
    const versions = this.preparedMeshes.get(meshHandle) ?? new Map<number, PreparedMeshEntry>();
    const key = `${meshHandle}:${revision}`;
    const captured = this.prepareMeshEntry(input, key, versions, inputOwnership);
    if (!captured.ok) return captured;
    const entry = captured.value;
    const lease = { retire: onRetire, published: onPublished };
    entry.leases.add(lease);
    this.dropReleasedPrepared(key, entry);
    versions.set(revision, entry);
    this.preparedMeshes.set(meshHandle, versions);
    this.retireOlderPreparations(meshHandle, revision, this.assets.get(meshHandle)?.revision);
    const owns = () => this.preparedMeshes.get(meshHandle)?.get(revision) === entry;
    let released = false;
    return ok({
      resources: this.resources,
      mesh: entry.mesh,
      isCurrent: () => !released && !this.disposed && !this.failed && owns(),
      release: () => {
        if (released) return;
        released = true;
        entry.leases.delete(lease);
        if (entry.leases.size === 0 && owns()) {
          versions.delete(revision);
          if (versions.size === 0) this.preparedMeshes.delete(meshHandle);
          this.keepReleasedPrepared(meshHandle, entry);
        }
        this.releasePreparedMeshBytes(entry);
      },
    });
  }

  /** Renderer consumers pass their registry; scene-only receivers need no shader installation.
   * The received record and its asset buffers belong to this receiver; callers
   * transfer them or supply independent publication copies, never later mutate them. */
  accept(
    message: RenderPublicationMessage,
    materialAssets?: AssetRegistry,
  ): Result<PreparedRenderPublication, RenderPublicationError> {
    if (this.accepting)
      return err(
        new RenderPublicationError({ reason: 'in-flight', subject: 'publication adoption' }),
      );
    if (this.disposed || this.failed)
      return rejectPublication('disposed', 'receiver retired or failed; start a new source epoch');
    const packet = decodeRenderPublication(message, this.acceptedMetadata);
    if (!packet.ok) return packet;
    this.accepting = true;
    try {
      return this.adopt(packet.value, materialAssets);
    } finally {
      this.accepting = false;
    }
  }

  private adopt(
    input: RenderPublication,
    materialAssets?: AssetRegistry,
  ): Result<PreparedRenderPublication, RenderPublicationError> {
    if (this.disposed || this.failed)
      return rejectPublication('disposed', 'receiver retired or failed; start a new source epoch');
    const admitted = this.admitPacket(input);
    if (!admitted.ok) return admitted;
    const packet = admitted.value;
    const textureSources = admitFrameTextureSources(packet, this.canvases);
    if (!textureSources.ok) return textureSources;
    const versions = this.stageFixedAssetVersions(packet);
    if (!versions.ok) return versions;
    const featureError = featureIdentitiesError(packet.features);
    if (featureError !== undefined) return err(featureError);
    if (!this.transformRows.validate(packet.transformEntities, packet.upserts.length > 0))
      return rejectPublication('shape', 'duplicate transform identity');
    const retiredMaterials: ReadonlySet<number> =
      packet.retiredMaterials.length === 0 ? NO_MATERIALS : new Set(packet.retiredMaterials);
    const stagedMaterialRows = stageSharedMaterials(packet.materials, retiredMaterials);
    if (!stagedMaterialRows.ok) return stagedMaterialRows;
    const stagedMaterials = stagedMaterialRows.value;
    const { canvasIds, sourceTokens } = textureSources.value;
    let residentMaterials: Map<MaterialResource, MaterialResource> | undefined;
    const material = (id: number): MaterialResource | undefined => {
      let staged = stagedMaterials.get(id);
      const resident = this.materials.get(id)?.resource;
      if (staged === undefined) {
        if (resident === undefined) return undefined;
        staged = new MaterialResource(resident.snapshot);
        stagedMaterials.set(id, staged);
      }
      if (resident !== undefined) {
        residentMaterials ??= new Map();
        residentMaterials.set(staged, resident);
      }
      return staged;
    };
    const materialHolds = new Map<number, number>();
    const hold = (id: number, delta: number) =>
      materialHolds.set(id, this.materialHoldCount(materialHolds, id) + delta);
    const releaseMaterial = (resource: MaterialResource) => {
      const id = this.materialIds.get(resource);
      if (id === undefined) throw new Error('missing accepted material identity');
      hold(id, -1);
    };
    const releaseEntityMaterials = (entity: number) => {
      const row = this.rows.lookup(entity);
      if (row === undefined) return;
      const content = slotContent(row);
      for (const resource of content.materials) releaseMaterial(resource);
      if (content.materialOverrides !== undefined)
        for (const resource of content.materialOverrides)
          if (resource !== undefined) releaseMaterial(resource);
    };
    const holdTemplateMaterials = (snapshot: TemplateSnapshot) => {
      for (const id of snapshot.materials) hold(id, 1);
      for (const id of snapshot.materialOverrides ?? []) if (id !== 0) hold(id, 1);
    };
    const operations: RenderSceneOperation[] = [];
    const renderables: RenderableSnapshot[] = [];
    const dispatch = new PublicationDispatch();
    const updated = new Set<number>();
    const removed = new Set<number>();
    // Dependencies read proposed values. Draw rows bind to stable receiver identities
    // before fan-out; those identities adopt their values only after admission.
    const templateInputs: StagedTemplate[] = [];
    const stageTemplate = createTemplateDecoder(
      material,
      canvasIds,
      sourceTokens,
      (key) => this.targets?.originKey(key),
      (input) => {
        templateInputs.push(input);
        return residentMaterials === undefined
          ? input
          : bindTemplateMaterials(input, residentMaterials);
      },
    );
    const stageUpsert = (
      entityKey: number,
      template: RenderPublicationTemplate | undefined,
    ): RenderPublicationError | undefined => {
      const matrixIndex = this.transformRows.find(packet.transformEntities, entityKey);
      if (template === undefined || matrixIndex === undefined || updated.has(entityKey))
        return shapeError('upsert template/transform');
      const staged = stageTemplate(template);
      if (staged instanceof RenderPublicationError) return staged;
      const transform = this.poses.capture(packet.transforms, matrixIndex * 16);
      updated.add(entityKey);
      releaseEntityMaterials(entityKey);
      holdTemplateMaterials(template.snapshot);
      const snapshot: RenderableSnapshot = {
        ...staged,
        entityKey,
        transform,
      };
      dispatch.push(entityKey, template.dispatch);
      renderables.push(snapshot);
      operations.push({ kind: 'update', entityKey, snapshot });
      return undefined;
    };
    const stageSceneEdits = (): RenderPublicationError | undefined => {
      for (let i = 0; i < packet.upserts.length; i += 2) {
        const upsertError = stageUpsert(
          packet.upserts[i] as number,
          packet.templates[packet.upserts[i + 1] as number],
        );
        if (upsertError !== undefined) return upsertError;
      }
      for (const entityKey of packet.removed) {
        if (!this.hasRow(entityKey) || updated.has(entityKey) || removed.has(entityKey))
          return shapeError('duplicate removal');
        removed.add(entityKey);
        releaseEntityMaterials(entityKey);
        operations.push({ kind: 'remove', entityKey });
      }
      return undefined;
    };
    const sceneError = stageSceneEdits();
    if (sceneError !== undefined) return err(sceneError);
    const drawParameters =
      packet.drawParameters === undefined
        ? undefined
        : stageDrawParameters(
            packet.drawParameters,
            this.drawParameters,
            (entity) => !removed.has(entity) && (updated.has(entity) || this.hasRow(entity)),
          );
    if (packet.drawParameters !== undefined && drawParameters === undefined)
      return rejectPublication('shape', 'mesh draw parameter rows');
    const references = this.prepareSkinReferences(removed, renderables);
    const retiredJoints = this.stageRetiredJoints(packet.retiredJoints, references);
    if (!retiredJoints.ok) return retiredJoints;
    // Packet-backed ranges stay local to this synchronous transaction. Only
    // committed Scene pages and detached content leave receiver admission.
    // An unfiltered pose span addresses the wire column directly. Materialize
    // selected ordinals only when a joint-only row or an upsert splits that span.
    let worldRows: number[] | undefined;
    /** Joint matrix rows, plus world-only updates for unchanged accepted renderables. */
    const stageTransformRows = (): Result<number[], RenderPublicationError> => {
      const jointRows: number[] = [];
      for (let index = 0; index < packet.transformEntities.length; index++) {
        const entityKey = packet.transformEntities[index] as number;
        const renderable =
          !removed.has(entityKey) && (updated.has(entityKey) || this.hasRow(entityKey));
        const joint = references?.has(entityKey) ?? this.skinJoints.has(entityKey);
        if (!renderable && !joint) return rejectPublication('shape', 'unknown transform identity');
        if (joint && !retiredJoints.value.has(entityKey)) jointRows.push(index);
        else if (!renderable)
          return rejectPublication('shape', 'retired joint also has a positive row');
        if (renderable && !updated.has(entityKey)) {
          worldRows?.push(index);
        } else if (worldRows === undefined) {
          worldRows = [];
          for (let row = 0; row < index; row++) worldRows.push(row);
        }
      }
      return ok(jointRows);
    };
    const jointRows = stageTransformRows();
    if (!jointRows.ok) return jointRows;
    const holdError = this.materialHoldError(packet, retiredMaterials, materialHolds);
    if (holdError !== undefined) return err(holdError);
    const fixedAsset = (handle: number, revision: number): Asset | undefined => {
      const key = versionKey({ handle, revision });
      return (
        versions.value.admitted.get(key)?.value ??
        (versions.value.retired.has(key) ? undefined : this.assetVersions.get(key)?.value)
      );
    };
    const sourceError = this.materialSourceError(
      stagedMaterials,
      materialHolds,
      retiredMaterials,
      versions.value.retired,
      fixedAsset,
    );
    if (sourceError !== undefined) return err(sourceError);
    // Validate the complete packet before changing the accepted asset namespace.
    const assets = this.stageAssets(
      packet,
      templateInputs,
      materialAssets,
      (handle, revision) => fixedAsset(handle, revision) !== undefined,
    );
    if (!assets.ok) return assets;
    const commitAdmittedPublication = () => {
      const materialUpdates = [...stagedMaterials.values()];
      let prepared = this.admitPublicationPrograms(
        {
          ...(jointRows.value.length === 0 && retiredJoints.value.size === 0
            ? {}
            : { skinJoints: { rows: jointRows.value, retired: retiredJoints.value } }),
          assetChanges: assets.value.changes,
          materialUpdates,
          resources: this.resources,
          packet,
          operations,
          scene: {
            rows: this.rows,
            stageRows: this.stageRows,
            before: this.rows.revision,
            delta: undefined,
          },
          frame: {
            ...packet.metadata,
            renderables,
            dispatch,
            visibilitySnapshot: undefined,
            hiddenEntityReports: NO_ROWS,
          },
        },
        materialAssets,
      );
      if (this.disposed) return rejectPublication('disposed', 'receiver retired during admission');
      // Program/target admission can throw. Keep the accepted resource namespace
      // and revision unchanged until it succeeds so the same packet can retry.
      try {
        this.commitMaterials(stagedMaterials, materialUpdates, materialHolds, retiredMaterials);
        this.commitAssetNamespace(packet, versions.value, assets.value.guidChanges);
        this.commitAssetRows(packet, assets.value.admitted, assets.value.patched, materialAssets);
        for (const change of assets.value.changes)
          this.retireOlderPreparations(change.handle, change.revision);
        this.commitFrameInputs(packet, canvasIds);
        references?.commit();
        this.commitJointMatrices(packet, retiredJoints.value, jointRows.value);
        if (drawParameters !== undefined) {
          this.drawParameters ??= new Map();
          drawParameters.apply(this.drawParameters);
        }
        if (this.drawParameters !== undefined) {
          for (const entity of removed) this.drawParameters.delete(entity);
          if (this.drawParameters.size === 0) this.drawParameters = undefined;
        }
        this.revision = packet.revision;
        this.acceptedMetadata = packet.metadata;
        for (const [key, released] of this.releasedPreparedMeshes)
          if (released.until < this.revision) this.dropReleasedPrepared(key);
        prepared = this.commitTransformRows(prepared, worldRows);
        this.publishPreparedMeshes(packet);
        return ok(prepared);
      } catch (cause) {
        this.failed = true;
        throw new AggregateError(
          [cause],
          'Render publication adoption failed; start a new source epoch',
          { cause },
        );
      }
    };
    return commitAdmittedPublication();
  }

  /**
   * Order, then prepared-asset restoration, then frame-shaped columns of the
   * restored packet.
   */
  private admitPacket(input: RenderPublication): Result<RenderPublication, RenderPublicationError> {
    const orderError = this.packetOrderError(input);
    if (orderError !== undefined) return err(orderError);
    const restored = this.restorePreparedAssets(input);
    if (!restored.ok) return restored;
    const columnsError = packetColumnsError(restored.value);
    if (columnsError !== undefined) return err(columnsError);
    return restored;
  }

  /** Protocol, session identity and revision order. */
  private packetOrderError(packet: RenderPublication): RenderPublicationError | undefined {
    if (!Array.isArray(packet.materials) || !Array.isArray(packet.retiredMaterials))
      return shapeError('material publication protocol');
    if (packet.source !== this.identity.source || packet.epoch !== this.identity.epoch)
      return new RenderPublicationError({ reason: 'identity', subject: 'source/epoch' });
    if (packet.base !== this.revision || packet.baseline !== (this.revision === 0))
      return new RenderPublicationError({ reason: 'base', subject: 'accepted revision' });
    if (!Number.isSafeInteger(packet.revision) || packet.revision !== this.revision + 1)
      return new RenderPublicationError({ reason: 'revision', subject: 'next revision' });
    return undefined;
  }

  /**
   * A prepared mesh payload crossed once with its residency preparation, which
   * the source keeps until this adoption; restore the ordinary asset row.
   */
  private restorePreparedAssets(
    packet: RenderPublication,
  ): Result<RenderPublication, RenderPublicationError> {
    if (packet.preparedAssets === undefined) return ok(packet);
    if (!Array.isArray(packet.preparedAssets) || !Array.isArray(packet.assets))
      return rejectPublication('shape', 'prepared asset rows');
    const adopted: RenderPublication['assets'][number][] = [];
    for (const row of packet.preparedAssets) {
      if (!validVersion(row)) return rejectPublication('shape', 'prepared asset identity');
      const prepared = this.findPreparedMesh(row.handle, row.revision);
      if (prepared === undefined)
        return rejectPublication('revision', 'prepared mesh reference without receiver residency');
      adopted.push({
        handle: row.handle,
        revision: row.revision,
        ...(row.guid === undefined ? {} : { guid: row.guid }),
        ...(row.sourceKey === undefined ? {} : { sourceKey: row.sourceKey }),
        value: prepared.mesh,
      });
    }
    return ok({ ...packet, assets: [...packet.assets, ...adopted] });
  }

  private stageFixedAssetVersions(
    packet: RenderPublication,
  ): Result<StagedAssetVersions, RenderPublicationError> {
    if (
      (packet.assetVersions !== undefined && !Array.isArray(packet.assetVersions)) ||
      (packet.retiredAssetVersions !== undefined && !Array.isArray(packet.retiredAssetVersions))
    )
      return rejectPublication('shape', 'fixed asset version rows');
    if (!packet.assetVersions?.length && !packet.retiredAssetVersions?.length)
      return ok(NO_VERSIONS);
    const retired = new Set<string>();
    for (const row of packet.retiredAssetVersions ?? []) {
      if (
        !validVersion(row) ||
        retired.has(versionKey(row)) ||
        !this.assetVersions.has(versionKey(row))
      )
        return rejectPublication('shape', 'retired fixed asset version');
      retired.add(versionKey(row));
    }
    const admitted = new Map<string, FixedAssetVersion>();
    for (const row of packet.assetVersions ?? []) {
      if (!validVersion(row)) return rejectPublication('shape', 'fixed asset version');
      const key = versionKey(row);
      if (admitted.has(key) || this.assetVersions.has(key) || retired.has(key))
        return rejectPublication('shape', 'fixed asset version');
      const captured = this.captureFixedAssetVersion(row);
      if (!captured.ok) return captured;
      admitted.set(key, captured.value);
    }
    if (this.assetVersions.size + admitted.size - retired.size > 65536)
      return rejectPublication('shape', 'fixed asset version capacity');
    return ok({ retired, admitted });
  }

  private captureFixedAssetVersion(
    row: NonNullable<RenderPublication['assetVersions']>[number],
  ): Result<FixedAssetVersion, RenderPublicationError> {
    const held = this.levelAssetAtVersion(row.handle, row.revision);
    if (row.preparedRevision !== undefined) {
      if (
        row.value !== undefined ||
        !Number.isSafeInteger(row.preparedRevision) ||
        row.preparedRevision < 1 ||
        row.preparedRevision > row.revision
      )
        return rejectPublication('shape', 'fixed prepared mesh revision');
      const preparation = this.findPreparedMesh(row.handle, row.preparedRevision);
      if (preparation === undefined)
        return rejectPublication('revision', 'fixed mesh reference without receiver residency');
      if (held !== undefined && !sameAssetPayload(held, preparation.mesh))
        return rejectPublication(
          'shape',
          'fixed asset version conflicts with closed Level custody',
        );
      return ok({ value: preparation.mesh, preparation });
    }
    const value = row.value;
    if (value === null || typeof value !== 'object' || typeof value.kind !== 'string')
      return rejectPublication('shape', 'fixed asset value');
    if (held !== undefined && !sameAssetPayload(held, value))
      return rejectPublication('shape', 'fixed asset version conflicts with closed Level custody');
    return ok({
      value:
        held ??
        (value.kind === 'mesh'
          ? ownReceivedPublishedMesh(value)
          : ownAdmittedAssetValue(structuredClone(value))),
    });
  }

  private materialHoldCount(holds: ReadonlyMap<number, number>, id: number): number {
    return holds.get(id) ?? this.materials.get(id)?.holds ?? 0;
  }

  /** Only known Binding edits enter joint reference preparation. */
  private prepareSkinReferences(
    removed: ReadonlySet<number>,
    renderables: readonly RenderableSnapshot[],
  ): SkinReferenceCandidate | undefined {
    let referenceEdits: Map<number, readonly number[] | undefined> | undefined;
    for (const entity of removed)
      if (this.skinJoints.hasBinding(entity)) {
        referenceEdits ??= new Map();
        referenceEdits.set(entity, undefined);
      }
    for (const row of renderables)
      if (row.skinBinding !== undefined || this.skinJoints.hasBinding(row.entityKey)) {
        referenceEdits ??= new Map();
        referenceEdits.set(row.entityKey, row.skinBinding?.joints);
      }
    return referenceEdits === undefined ? undefined : this.skinJoints.prepare(referenceEdits);
  }

  private stageRetiredJoints(
    rows: Uint32Array,
    references: SkinReferenceCandidate | undefined,
  ): Result<Set<number>, RenderPublicationError> {
    const retiredJoints = new Set(rows);
    if (retiredJoints.size !== rows.length)
      return rejectPublication('shape', 'duplicate joint retirement');
    for (const joint of retiredJoints)
      if (!this.skinJoints.has(joint) && !(references?.has(joint) ?? false))
        return rejectPublication('shape', 'unknown joint retirement');
    for (const joint of references?.retired ?? []) retiredJoints.add(joint);
    return ok(retiredJoints);
  }

  /** Retired materials are unreferenced, and every published material is held. */
  private materialHoldError(
    packet: RenderPublication,
    retiredMaterials: ReadonlySet<number>,
    holds: ReadonlyMap<number, number>,
  ): RenderPublicationError | undefined {
    if (retiredMaterials.size !== packet.retiredMaterials.length)
      return shapeError('duplicate material retirement');
    for (const id of retiredMaterials)
      if (!this.materials.has(id) || this.materialHoldCount(holds, id) !== 0)
        return shapeError('referenced material retirement');
    for (const row of packet.materials)
      if (this.materialHoldCount(holds, row.id) === 0)
        return shapeError('unreferenced material publication');
    for (const [id, count] of holds) if (count < 0) return shapeError(`material hold ${id}`);
    return undefined;
  }

  /** Every held captured material keeps its complete exact source, including quiet rows. */
  private materialSourceError(
    staged: ReadonlyMap<number, MaterialResource>,
    holds: ReadonlyMap<number, number>,
    retired: ReadonlySet<number>,
    retiredVersions: ReadonlySet<string>,
    resolveVersion: (handle: number, revision: number) => Asset | undefined,
  ): RenderPublicationError | undefined {
    const valid = (id: number, resource: MaterialResource): boolean => {
      if (retired.has(id) || this.materialHoldCount(holds, id) === 0) return true;
      const source = resource.snapshot.sourceAssets;
      if (source === undefined) return true;
      if (
        source.root !== resource.snapshot.materialHandle ||
        resolveVersion(source.root, source.revision)?.kind !== 'material'
      )
        return false;
      const needed = new Set<number>();
      collectMaterialDependencies(resource.snapshot, needed);
      for (const asset of source.assets) {
        if (resolveVersion(asset.handle, asset.revision) === undefined) return false;
        needed.delete(asset.handle);
      }
      return needed.size === 0;
    };
    for (const [id, resource] of staged)
      if (!valid(id, resource)) return shapeError('missing material source version');
    for (const [id, count] of holds) {
      const previous = this.materials.get(id);
      if (count > 0 && previous?.holds === 0 && !staged.has(id) && !valid(id, previous.resource))
        return shapeError('missing material source version');
    }
    for (const key of retiredVersions) {
      const users = this.versionMaterials.get(key);
      if (users === undefined) continue;
      for (const id of users)
        if (!staged.has(id) && !retired.has(id) && this.materialHoldCount(holds, id) > 0)
          return shapeError('missing material source version');
    }
    return undefined;
  }

  private indexMaterialVersion(key: string, id: number, add: boolean): void {
    const users = this.versionMaterials.get(key);
    if (add) {
      if (users === undefined) this.versionMaterials.set(key, new Set([id]));
      else users.add(id);
    } else if (users?.delete(id) && users.size === 0) {
      this.versionMaterials.delete(key);
    }
  }

  private indexMaterialSource(id: number, resource: MaterialResource, add: boolean): void {
    const source = resource.snapshot.sourceAssets;
    if (source === undefined) return;
    this.indexMaterialVersion(
      versionKey({ handle: source.root, revision: source.revision }),
      id,
      add,
    );
    for (const asset of source.assets) this.indexMaterialVersion(versionKey(asset), id, add);
  }

  private assetRowAdmissible(row: AcceptedAssetRow): boolean {
    return (
      row.value !== null &&
      typeof row.value === 'object' &&
      Number.isSafeInteger(row.handle) &&
      row.handle > 0 &&
      row.handle <= 0xffffffff &&
      Number.isSafeInteger(row.revision) &&
      row.revision >= 1 &&
      row.revision > (this.assets.get(row.handle)?.revision ?? 0)
    );
  }

  /** A published revision must match any preparation of that exact version. */
  private preparedMeshRevisionError(row: AcceptedAssetRow): RenderPublicationError | undefined {
    const prepared = this.preparedMeshes.get(row.handle)?.get(row.revision);
    if (
      prepared !== undefined &&
      (row.value.kind !== 'mesh' || !samePublishedMesh(prepared.mesh, row.value))
    )
      return shapeError('accepted mesh differs from prepared residency');
    return undefined;
  }

  private stageAssetRows(
    packet: RenderPublication,
    materialAssets: AssetRegistry | undefined,
  ): Result<
    {
      readonly assetHandles: Set<number>;
      readonly changes: AssetChange[];
      readonly projections: ReadonlyMap<AcceptedAssetRow, MaterialRenderProjection>;
    },
    RenderPublicationError
  > {
    const assetHandles = new Set<number>();
    const changes: AssetChange[] = [];
    if (packet.assets.length === 0)
      return ok({ assetHandles, changes, projections: NO_PROJECTIONS });
    const packetPrograms = new Set(packet.programs.map((program) => program.key));
    const programKnown = (key: string) =>
      packetPrograms.has(key) ||
      this.acceptedPrograms.has(key) ||
      materialAssets?.shaderRegistry.materialArtifactDeclaration(key) !== undefined;
    // A program row is validated and owned once per id; later projections
    // reference the receiver program table entry.
    const projections = new Map<AcceptedAssetRow, MaterialRenderProjection>();
    const admitProjection = this.projections.stage(programKnown);
    for (const row of packet.assets) {
      if (
        !this.assetRowAdmissible(row) ||
        assetHandles.has(row.handle) ||
        packet.retiredAssets.includes(row.handle)
      )
        return rejectPublication('shape', 'asset payload');
      if (!validAssetSource(row)) return rejectPublication('shape', 'asset source');
      assetHandles.add(row.handle);
      const projection = this.receivedMaterialProjection(
        row,
        packet.retiredAssets,
        admitProjection,
      );
      if (!projection.ok) return rejectPublication('shape', projection.error);
      const held = this.levelAssets.get(row.handle);
      if (held?.revision === row.revision && !sameAssetPayload(held.value, row.value))
        return rejectPublication('shape', 'asset row conflicts with closed Level custody');
      if (projection.value !== undefined) {
        materialAssets?.bindReceivedMaterialTemplate(projection.value);
        projections.set(row, projection.value);
      }
      const preparedError = this.preparedMeshRevisionError(row);
      if (preparedError !== undefined) return err(preparedError);
      changes.push({
        handle: row.handle as AssetChange['handle'],
        revision: row.revision,
        removed: false,
        fields: ['*'],
        ranges: [],
      });
    }
    return ok({ assetHandles, changes, projections });
  }

  /**
   * One asset row's admitted projection: carried, adopted from a resident
   * holder, retained by omission, or cleared by null.
   */
  private receivedMaterialProjection(
    row: RenderPublication['assets'][number],
    retired: readonly number[],
    admit: ReturnType<PublicationMaterialProjectionAdmission['stage']>,
  ): Result<MaterialRenderProjection | undefined, string> {
    const source = row.materialProjectionSource;
    if (source === undefined && row.materialProjection === undefined)
      return ok(this.assets.get(row.handle)?.materialProjection ?? undefined);
    if (row.value.kind !== 'material') return err('material projection on another asset kind');
    let input: unknown = row.materialProjection;
    if (source !== undefined) {
      if (input !== undefined || retired.includes(source)) return err('material projection holder');
      input = this.assets.get(source)?.materialProjection ?? undefined;
      if (input === undefined) return err('material projection holder');
    }
    if (input === null) return ok(undefined);
    const projection = admit(input, row.value);
    return projection === undefined ? err('material source projection') : ok(projection);
  }

  /** Capture a patch; a prepared candidate at the same revision must equal its result. */
  private preparePatchedAsset(
    current: AcceptedAssetRow,
    patch: PublishedAssetPatch,
  ): Result<
    { readonly row: AcceptedAssetRow; readonly prepared: PreparedAssetPatch },
    RenderPublicationError
  > {
    try {
      const prepared = prepareAssetPatch(
        current.value,
        patch,
        this.preparedMeshes.has(patch.handle) ||
          this.releasedPreparedMeshes.has(versionKey(current)) ||
          this.levelAssets.has(patch.handle),
      );
      const fixed =
        this.preparedMeshes.get(patch.handle)?.get(patch.revision)?.mesh ??
        this.levelAssetAtVersion(patch.handle, patch.revision);
      if (fixed !== undefined) {
        // The temporary COW buffers make candidate equality a validation step.
        prepared.commit();
        if (!sameAssetPayload(fixed, prepared.value))
          return rejectPublication('shape', 'patched asset differs from prepared residency');
      }
      return ok({
        row: {
          ...current,
          revision: patch.revision,
          value: fixed ?? prepared.value,
        },
        prepared,
      });
    } catch (cause) {
      if (cause instanceof RenderPublicationError) return err(cause);
      return rejectPublication('shape', 'asset patch capture');
    }
  }

  private stageAssetPatches(
    packet: RenderPublication,
    assetHandles: Set<number>,
    changes: AssetChange[],
  ): Result<PatchedAssetRow[], RenderPublicationError> {
    const patched: PatchedAssetRow[] = [];
    for (const patch of packet.assetPatches) {
      const current = this.assets.get(patch.handle);
      if (
        current === undefined ||
        patch.base !== current.revision ||
        !Number.isSafeInteger(patch.revision) ||
        patch.revision <= patch.base ||
        assetHandles.has(patch.handle) ||
        packet.retiredAssets.includes(patch.handle)
      )
        return rejectPublication('shape', 'asset patch base or identity');
      const staged = this.preparePatchedAsset(current, patch);
      if (!staged.ok) return staged;
      patched.push({ row: staged.value.row, commit: staged.value.prepared.commit });
      changes.push(staged.value.prepared.change);
      assetHandles.add(patch.handle);
    }
    return ok(patched);
  }

  /** The handle is published by this packet or stays accepted through it. */
  private assetResolvable(
    handle: number,
    assetHandles: ReadonlySet<number>,
    retiredAssets: readonly number[],
  ): boolean {
    return assetHandles.has(handle) || (this.assets.has(handle) && !retiredAssets.includes(handle));
  }

  private missingAssetDependency(
    packet: RenderPublication,
    assetHandles: ReadonlySet<number>,
    templates: readonly StagedTemplate[],
    exactVersionAvailable: (handle: number, revision: number) => boolean,
  ): boolean {
    const missing = (handle: number) =>
      !this.assetResolvable(handle, assetHandles, packet.retiredAssets);
    // Accepted metadata already resolved; only a retirement can invalidate it.
    if (
      (packet.metadata !== this.acceptedMetadata || packet.retiredAssets.length > 0) &&
      publicationFrameDependencies(packet.metadata).some(missing)
    )
      return true;
    for (const row of templates)
      if (publicationDependencies(row, exactVersionAvailable).some(missing)) return true;
    return false;
  }

  /** Stage only changed GUIDs; asset retirement never scans the namespace. */
  private stageGuidChanges(packet: RenderPublication): ReadonlyMap<string, number | undefined> {
    if (packet.retiredAssets.length === 0 && packet.assets.length === 0) return NO_GUID_CHANGES;
    const guidChanges = new Map<string, number | undefined>();
    for (const handle of packet.retiredAssets) {
      const guid = this.assets.get(handle)?.guid;
      if (guid !== undefined) guidChanges.set(guid.toLowerCase(), undefined);
    }
    for (const row of packet.assets) {
      if (row.guid === undefined) continue;
      guidChanges.set(row.guid.toLowerCase(), row.handle);
    }
    return guidChanges;
  }

  private missingLodDependency(
    packet: RenderPublication,
    assetHandles: ReadonlySet<number>,
    guidChanges: ReadonlyMap<string, number | undefined>,
    templates: readonly StagedTemplate[],
  ): boolean {
    const lodMissing = (mesh: NonNullable<RenderableSnapshot['lods']>[number]['mesh']) => {
      if (typeof mesh === 'number')
        return !this.assetResolvable(mesh, assetHandles, packet.retiredAssets);
      const guid = AssetGuid.format(mesh).toLowerCase();
      return (
        (guidChanges.has(guid) ? guidChanges.get(guid) : this.guidHandles.get(guid)) === undefined
      );
    };
    for (const row of templates) if (row.lods?.some((lod) => lodMissing(lod.mesh))) return true;
    return false;
  }

  /**
   * Worker cloning removes the Source loader's ownership mark. Detach program
   * JSON at admission without freezing borrowed Source assets or frame data.
   * A getter/copy failure must leave the accepted namespace and revision intact.
   */
  private ownAdmittedAssets(
    packet: RenderPublication,
    projections: ReadonlyMap<AcceptedAssetRow, MaterialRenderProjection>,
  ): AcceptedAssetRow[] {
    return packet.assets.map((row) => {
      const held = this.levelAssets.get(row.handle);
      const admitted =
        held?.revision === row.revision ? held.value : ownAdmittedAssetValue(row.value);
      const { materialProjectionSource: _source, ...received } = row;
      const value = this.preparedMeshes.get(row.handle)?.get(row.revision)?.mesh ?? admitted;
      return {
        ...received,
        materialProjection: projections.get(row) ?? null,
        // Non-JSON inputs retain their exact payload types and mutable behavior.
        value: value.kind === 'mesh' ? ownReceivedPublishedMesh(value) : value,
      };
    });
  }

  private skinSkeletonMissing(
    packet: RenderPublication,
    patched: readonly PatchedAssetRow[],
    templates: readonly StagedTemplate[],
  ): boolean {
    for (const row of templates) {
      const binding = row.skinBinding;
      if (binding === undefined) continue;
      const skeleton =
        patched.find((item) => item.row.handle === binding.skeleton)?.row.value ??
        packet.assets.find((item) => item.handle === binding.skeleton)?.value ??
        this.assets.get(binding.skeleton)?.value;
      if (!validSkinSkeleton(skeleton)) return true;
    }
    return false;
  }

  /** Validate the complete asset closure before changing the accepted namespace. */
  private stageAssets(
    packet: RenderPublication,
    templates: readonly StagedTemplate[],
    materialAssets: AssetRegistry | undefined,
    exactVersionAvailable: (handle: number, revision: number) => boolean,
  ): Result<
    {
      readonly changes: AssetChange[];
      readonly patched: PatchedAssetRow[];
      readonly guidChanges: ReadonlyMap<string, number | undefined>;
      readonly admitted: AcceptedAssetRow[];
    },
    RenderPublicationError
  > {
    const rows = this.stageAssetRows(packet, materialAssets);
    if (!rows.ok) return rows;
    const { assetHandles, changes, projections } = rows.value;
    const patched = this.stageAssetPatches(packet, assetHandles, changes);
    if (!patched.ok) return patched;
    if (this.missingAssetDependency(packet, assetHandles, templates, exactVersionAvailable))
      return rejectPublication('shape', 'missing asset dependency');
    const guidChanges = this.stageGuidChanges(packet);
    if (this.missingLodDependency(packet, assetHandles, guidChanges, templates))
      return rejectPublication('shape', 'missing LOD dependency');
    const admitted = this.ownAdmittedAssets(packet, projections);
    if (this.skinSkeletonMissing(packet, patched.value, templates))
      return rejectPublication('shape', 'Skin Skeleton definition');
    return ok({ changes, patched: patched.value, guidChanges, admitted });
  }

  /** Target and program admission may throw before the accepted namespace changes. */
  private admitPublicationPrograms(
    prepared: PreparedRenderPublication,
    materialAssets: AssetRegistry | undefined,
  ): PreparedRenderPublication {
    const cameras = this.targets?.bind(prepared.packet, prepared.materialUpdates);
    let admitted =
      cameras === undefined ? prepared : { ...prepared, frame: { ...prepared.frame, ...cameras } };
    if (materialAssets !== undefined) {
      installPublicationPrograms(materialAssets, prepared.packet.programs);
      admitted = rebindPublicationMaterialSchemas(materialAssets.shaderRegistry, admitted);
    }
    return admitted;
  }

  /** Staged material copies adopt into their accepted resources, which rows then reference. */
  private commitMaterials(
    staged: ReadonlyMap<number, MaterialResource>,
    updates: MaterialResource[],
    holds: ReadonlyMap<number, number>,
    retiredMaterials: ReadonlySet<number>,
  ): void {
    let index = 0;
    for (const [id, resource] of staged) {
      const previous = this.materials.get(id);
      const current = previous?.resource ?? resource;
      if (previous?.resource.snapshot.sourceAssets !== resource.snapshot.sourceAssets) {
        if (previous !== undefined) this.indexMaterialSource(id, previous.resource, false);
        this.indexMaterialSource(id, resource, true);
      }
      if (previous !== undefined) current.adopt(resource.snapshot);
      this.materials.set(id, {
        resource: current,
        holds: holds.get(id) ?? previous?.holds ?? 0,
      });
      this.materialIds.set(current, id);
      updates[index++] = current;
    }
    for (const [id, count] of holds) {
      const current = this.materials.get(id);
      if (current !== undefined) current.holds = count;
    }
    for (const id of retiredMaterials) {
      const entry = this.materials.get(id);
      if (entry !== undefined) this.indexMaterialSource(id, entry.resource, false);
      this.materials.delete(id);
    }
  }

  private commitAssetNamespace(
    packet: RenderPublication,
    versions: StagedAssetVersions,
    guidChanges: ReadonlyMap<string, number | undefined>,
  ): void {
    if (packet.baseline) {
      this.assets.clear();
      this.acceptedPrograms.clear();
      for (const key of this.assetVersions.keys()) this.retireFixedAssetVersion(key);
    }
    for (const key of versions.retired) this.retireFixedAssetVersion(key);
    for (const [key, version] of versions.admitted) {
      if (version.preparation !== undefined) version.preparation.fixedHolds++;
      this.assetVersions.set(key, version);
    }
    for (const [guid, handle] of guidChanges) {
      if (handle === undefined) this.guidHandles.delete(guid);
      else this.guidHandles.set(guid, handle);
    }
    // Retirement ends the accepted row only. A live preparation belongs to
    // its source lease, which this packet does not reach: the source may
    // reference it again when the handle re-enters its closure, and it
    // releases or replaces that preparation itself.
    for (const handle of packet.retiredAssets) {
      this.assets.delete(handle);
      for (const key of [...this.releasedPreparedMeshes.keys()])
        if (key.startsWith(`${handle}:`)) this.dropReleasedPrepared(key);
    }
  }

  private retireFixedAssetVersion(key: string): void {
    const preparation = this.assetVersions.get(key)?.preparation;
    this.assetVersions.delete(key);
    if (preparation === undefined) return;
    preparation.fixedHolds--;
    this.releasePreparedMeshBytes(preparation);
  }

  private commitAcceptedAsset(row: AcceptedAssetRow): void {
    const staged = this.levelAssets.get(row.handle);
    if (staged !== undefined && (staged.revision !== row.revision || staged.value !== row.value))
      staged.current = false;
    this.assets.set(row.handle, row);
  }

  private commitAssetRows(
    packet: RenderPublication,
    admitted: readonly AcceptedAssetRow[],
    patched: readonly PatchedAssetRow[],
    materialAssets: AssetRegistry | undefined,
  ): void {
    for (const row of admitted) {
      this.commitAcceptedAsset(row);
      if (row.materialProjection != null && materialAssets !== undefined)
        materialAssets.materialPayloadProjections.set(row.value, row.materialProjection);
    }
    for (const program of packet.programs) this.acceptedPrograms.add(program.key);
    for (const patch of patched) {
      patch.commit();
      this.commitAcceptedAsset(patch.row);
      if (patch.row.materialProjection != null && materialAssets !== undefined)
        materialAssets.materialPayloadProjections.set(
          patch.row.value,
          patch.row.materialProjection,
        );
    }
  }

  private retireOlderPreparations(handle: number, revision: number, preserve?: number): void {
    const versions = this.preparedMeshes.get(handle);
    if (versions === undefined) return;
    for (const [prior, entry] of versions) {
      if (prior >= revision || prior === preserve) continue;
      versions.delete(prior);
      this.keepReleasedPrepared(handle, entry);
      for (const lease of entry.leases) lease.retire();
    }
    if (versions.size === 0) this.preparedMeshes.delete(handle);
  }

  private commitFrameInputs(packet: RenderPublication, canvasIds: ReadonlySet<string>): void {
    const resources = this.resources as {
      -readonly [K in 'time' | 'transparentSort']: RenderResourceScope[K];
    };
    resources.time = packet.time;
    resources.transparentSort = packet.transparentSort;
    this.releaseVideoFrames();
    for (const row of packet.videoFrames)
      this.videoFrames.set(`${row.entity}:${row.clip}`, row.frame);
    this.canvases.accept(packet.canvasFrames ?? [], canvasIds);
  }

  private commitJointMatrices(
    packet: RenderPublication,
    retiredJoints: ReadonlySet<number>,
    jointRows: readonly number[],
  ): void {
    for (const joint of retiredJoints) this.jointMatrices.delete(joint);
    for (const index of jointRows) {
      const joint = packet.transformEntities[index] as number;
      let matrix = this.jointMatrices.get(joint);
      if (matrix === undefined) {
        matrix = new Float32Array(16);
        this.jointMatrices.set(joint, matrix);
      }
      for (let lane = 0; lane < 16; lane++)
        matrix[lane] = packet.transforms[index * 16 + lane] as number;
    }
  }

  private hasRow(entity: number): boolean {
    return this.rows.lookup(entity) !== undefined;
  }

  private commitTransformRows(
    prepared: PreparedRenderPublication,
    rows: readonly number[] | undefined,
  ): PreparedRenderPublication {
    const packet = prepared.packet;
    return this.commitRows(
      prepared,
      (rows?.length ?? packet.transformEntities.length) === 0
        ? NO_ROWS
        : [
            {
              entities: packet.transformEntities,
              worlds: packet.transforms,
              ...(rows === undefined ? {} : { rows }),
            },
          ],
    );
  }

  /**
   * Admission validated every edit; renderer-level preparation then completes
   * the accepted rows once, then commits them to the shared rows. A failure
   * here fails the receiver, so a partial row write is never observable.
   */
  private commitRows(
    prepared: PreparedRenderPublication,
    transforms: readonly WorldTransformSpan[],
  ): PreparedRenderPublication {
    const before = this.rows.revision;
    for (const change of prepared.assetChanges) {
      const mesh = change.removed
        ? undefined
        : this.resources.resolveAsset<MeshAsset>(change.handle);
      if (change.removed || (mesh?.ok && mesh.value.kind === 'mesh'))
        this.rows.adoptMesh(change.handle, mesh?.ok ? mesh.value : undefined);
    }
    const completed = this.prepareRows?.(prepared) ?? prepared;
    // The receiver built every staged snapshot and owns it immutably: rows
    // adopt them as-is instead of copying matrices, bounds and draw tables.
    const delta =
      completed.operations.length === 0
        ? this.rows.commitDistinctTransformSpans(transforms)
        : this.rows.apply(completed.operations, transforms, true);
    return { ...completed, scene: { rows: this.rows, stageRows: this.stageRows, before, delta } };
  }

  private publishPreparedMeshes(packet: RenderPublication): void {
    if (this.preparedMeshes.size === 0) return;
    const publish = (row: { readonly handle: number; readonly revision: number }) => {
      const candidate = this.preparedMeshes.get(row.handle)?.get(row.revision);
      if (candidate !== undefined) for (const lease of candidate.leases) lease.published();
    };
    packet.assets.forEach(publish);
    packet.assetPatches.forEach(publish);
  }

  /** A new view starts at the accepted scene, including changes made while no view rendered. */
  snapshot(input: PreparedRenderPublication): PreparedRenderPublication {
    if (this.disposed || this.failed)
      throw new RenderPublicationError({
        reason: 'disposed',
        subject: 'receiver retired or failed; start a new source epoch',
      });
    if (
      this.accepting ||
      input.resources !== this.resources ||
      input.packet.source !== this.identity.source ||
      input.packet.epoch !== this.identity.epoch ||
      input.packet.revision !== this.revision ||
      input.resources.revision !== this.revision
    )
      throw new RenderPublicationError({
        reason: 'base',
        subject: 'current accepted source snapshot outside admission',
      });
    // Cold initialization only: a new view derives its private state from the
    // shared rows; only the referenced joint matrices are re-published.
    const jointRows: number[] = [];
    const transformEntities = new Uint32Array(this.jointMatrices.size);
    const transforms = new Float32Array(this.jointMatrices.size * 16);
    for (const [joint, matrix] of this.jointMatrices) {
      const index = jointRows.length;
      jointRows.push(index);
      transformEntities[index] = joint;
      transforms.set(matrix, index * 16);
    }
    return {
      ...input,
      skinJoints: { rows: jointRows, retired: new Set() },
      packet: {
        ...input.packet,
        baseline: true,
        transformEntities,
        transforms,
        retiredJoints: new Uint32Array(0),
        removed: new Uint32Array(0),
      },
      // A baseline seeds the accepted material contexts as well as entity rows;
      // the most recent delta may contain no material changes at all.
      materialUpdates: [...this.materials.values()].map(({ resource }) => resource),
      frame: { ...input.frame, renderables: [], dispatch: [] },
      operations: [],
      scene: { rows: this.rows, stageRows: this.stageRows, before: -1, delta: undefined },
    };
  }

  /** copyExternalImageToTexture consumes native sources synchronously during draw. */
  releaseVideoFrames(): void {
    this.canvases.releaseFrames();
    for (const frame of this.videoFrames.values()) frame.close();
    this.videoFrames.clear();
  }

  dispose(): void {
    this.disposed = true;
    for (const key of this.assetVersions.keys()) this.retireFixedAssetVersion(key);
    for (const versions of this.preparedMeshes.values())
      for (const entry of versions.values()) for (const lease of entry.leases) lease.retire();
    this.preparedMeshes.clear();
    for (const key of this.releasedPreparedMeshes.keys()) this.dropReleasedPrepared(key);
    this.canvases.dispose();
    this.releaseVideoFrames();
    this.assets.clear();
    this.acceptedPrograms.clear();
    this.projections.clear();
    this.levelAssets.clear();
    this.levelGuids.clear();
    this.materials.clear();
    this.versionMaterials.clear();
    this.guidHandles = new Map();
    // A retired source epoch removes only its own rows.
    this.rows.dispose();
    this.poses.clear();
    this.transformRows.dispose();
    this.skinJoints.clear();
    this.jointMatrices.clear();
    this.drawParameters = undefined;
    this.acceptedMetadata = undefined;
  }

  get acceptedRevision(): number {
    return this.disposed || this.failed ? -1 : this.revision;
  }

  /** Borrow only the current accepted source facts for synchronous demand projection. */
  borrowAcceptedDemand():
    | {
        readonly metadata: RenderPublicationMetadata;
        readonly resources: RenderResourceScope;
        readonly revision: number;
        isCurrent(): boolean;
      }
    | undefined {
    const metadata = this.acceptedMetadata;
    if (this.accepting || this.disposed || this.failed || metadata === undefined) return undefined;
    const revision = this.revision;
    return {
      metadata,
      resources: this.resources,
      revision,
      isCurrent: () =>
        !this.accepting &&
        !this.disposed &&
        !this.failed &&
        this.acceptedMetadata === metadata &&
        this.revision === revision,
    };
  }
}

function publicationTimeValid(time: RenderPublication['time']): boolean {
  return (
    Number.isFinite(time?.elapsed) &&
    Number.isFinite(time?.delta) &&
    Number.isFinite(time?.maxDeltaSeconds) &&
    Number.isFinite(time?.unscaledDelta) &&
    Number.isFinite(time?.unscaledElapsed) &&
    Number.isFinite(time?.scale) &&
    time.delta >= 0 &&
    time.elapsed >= 0 &&
    time.maxDeltaSeconds >= 0 &&
    time.unscaledDelta >= 0 &&
    time.unscaledElapsed >= 0 &&
    time.scale >= 0
  );
}

function gpuVertexBindingError(snapshot: TemplateSnapshot): RenderPublicationError | undefined {
  const gpu = snapshot.gpuVertexSource;
  if (
    gpu !== undefined &&
    (gpu === null ||
      typeof gpu !== 'object' ||
      typeof gpu.feature !== 'string' ||
      gpu.feature.length === 0 ||
      typeof gpu.resource !== 'string' ||
      gpu.resource.length === 0 ||
      Object.keys(gpu).some((key) => key !== 'feature' && key !== 'resource'))
  )
    return shapeError('GPU mesh vertex source');
  return undefined;
}
