import type { AssetRegistry, MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import type { AssetChange, AssetReader } from '@forgeax/engine-assets-runtime/internal';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  type Asset,
  AssetError,
  err,
  type MeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { LIGHTING_CHANNELS_DEFAULT, validateChannelMask } from '../components/lighting-channels';
import { validatePointLightDecay } from '../components/point-light';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';
import { MaterialResource } from '../material-resource';
import type {
  DispatchEntry,
  DispatchList,
  ExtractedFrame,
  RenderableSnapshot,
} from '../render-system-extract';
import { captureMaterialOverrides } from '../scene/mesh-materials';
import type { RenderSceneOperation } from '../scene/render-scene-types';
import { isCanvasTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import { isRenderTextureSourceToken, renderTextureSourceKey } from '../textures/source-token';
import { validTilemapSource } from '../tilemap-geometry';
import {
  type PreparedAssetPatch,
  type PublishedAssetPatch,
  prepareAssetPatch,
} from './asset-patch';
import { CanvasFrameReceiver } from './canvas';
import {
  type PublishedMeshPreparation,
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
  type RenderPublicationMetadata,
  type RenderPublicationTemplate,
} from './contract';
import { publicationDependencies, publicationFrameDependencies } from './dependencies';
import { retainPublicationDispatchGroups } from './dispatch-groups';
import { copyPublishedMesh, ownReceivedPublishedMesh, samePublishedMesh } from './mesh';
import {
  installPublicationPrograms,
  PublicationMaterialProjectionAdmission,
  rebindPublicationMaterialSchemas,
} from './programs';
import type { RenderResourceScope } from './resource-scope';
import { SkinJointReferences } from './skin-joints';
import { RenderPublicationTargetReceiver, type RenderTargetAuthoring } from './targets';

export interface PreparedRenderPublication {
  /** Fixed row indices into this packet, not a callback into later receiver state. */
  readonly skinJoints?: { readonly rows: readonly number[]; readonly retired: ReadonlySet<number> };
  readonly assetChanges: readonly AssetChange[];
  readonly materialUpdates: readonly MaterialResource[];
  readonly resources: RenderResourceScope;
  readonly packet: RenderPublication;
  readonly operations: readonly RenderSceneOperation[];
  readonly frame: ExtractedFrame;
  readonly onFeatureSourceSubmitted?: (identity: string, feedback: unknown) => void;
}

function finiteFloats(values: Float32Array): boolean {
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) return false;
  }
  return true;
}

type AcceptedAssetRow = RenderPublication['assets'][number];
type TemplateSnapshot = RenderPublicationTemplate['snapshot'];
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

/** Frame-shaped numeric columns, lists and metadata. */
function packetColumnsError(packet: RenderPublication): RenderPublicationError | undefined {
  if (!numericColumnsValid(packet)) return shapeError('numeric columns');
  if (!publicationListsValid(packet) || !frameMetadataValid(packet))
    return shapeError('frame metadata');
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
    Number.isFinite(packet.time?.elapsed) &&
    Number.isFinite(packet.time?.delta)
  );
}

function lightingChannelsError(lights: FrameLights): RenderPublicationError | undefined {
  for (const light of [lights.directional, ...lights.point, ...lights.spot, ...lights.rect]) {
    if (
      light !== undefined &&
      (light === null ||
        typeof light !== 'object' ||
        validateChannelMask(
          light.lightingChannels === undefined ? LIGHTING_CHANNELS_DEFAULT : light.lightingChannels,
        ) !== null)
    )
      return shapeError('light lightingChannels');
  }
  return undefined;
}

function shadowCasterChannelsError(lights: FrameLights): RenderPublicationError | undefined {
  for (const shadow of [lights.directionalCsmConfig, ...lights.pointShadow, ...lights.spot]) {
    if (
      shadow !== undefined &&
      (shadow === null ||
        typeof shadow !== 'object' ||
        validateChannelMask(
          shadow.shadowCasterChannels === undefined ? 0xffffffff : shadow.shadowCasterChannels,
          'shadowCasterChannels',
        ) !== null)
    )
      return shapeError('light shadowCasterChannels');
  }
  return undefined;
}

function pointLightDecayError(lights: FrameLights): RenderPublicationError | undefined {
  for (const light of lights.point) {
    if (
      light === undefined ||
      validatePointLightDecay(light.decay === undefined ? 2 : light.decay) !== null
    )
      return shapeError('point light decay');
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

function admitCanvasFrameIds(
  rows: RenderPublication['canvasFrames'],
): Result<Set<string>, RenderPublicationError> {
  if (rows !== undefined && !Array.isArray(rows))
    return rejectPublication('shape', 'canvas frames');
  const canvasIds = new Set<string>();
  for (const row of rows ?? []) {
    if (
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      typeof row.flipY !== 'boolean' ||
      canvasIds.has(row.id) ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      typeof row.disposed !== 'boolean' ||
      (row.disposed && row.frame !== undefined) ||
      (row.frame !== undefined && unusableVideoFrame(row.frame))
    )
      return rejectPublication('shape', 'canvas frame');
    canvasIds.add(row.id);
  }
  return ok(canvasIds);
}

function videoFramesError(
  rows: RenderPublication['videoFrames'],
): RenderPublicationError | undefined {
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
): Result<Set<object>, RenderPublicationError> {
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

/** Every camera target is published, and each planar reflection target has one writer. */
function cameraTargetsError(
  metadata: RenderPublicationMetadata,
  targetTokens: ReadonlySet<object>,
): RenderPublicationError | undefined {
  const cameraWriters = [
    ...metadata.cameras,
    ...metadata.auxiliaryCameras,
    ...metadata.cubeCameras,
  ];
  for (const camera of cameraWriters)
    if (camera.target !== undefined && !targetTokens.has(camera.target))
      return shapeError('missing target descriptor');
  const planarTargets = new Set(
    metadata.auxiliaryCameras
      .filter((camera) => camera.planarReflection !== undefined)
      .map((camera) => camera.target),
  );
  for (const target of planarTargets) {
    if (
      target === undefined ||
      cameraWriters.filter((camera) => camera.target === target).length !== 1
    )
      return shapeError('duplicate planar target writer');
  }
  return undefined;
}

function admitTargetSourceKeys(
  rows: RenderPublication['targetSources'],
  targetTokens: ReadonlySet<object>,
): Result<Set<string>, RenderPublicationError> {
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
): Result<
  { readonly canvasIds: Set<string>; readonly sourceTokens: Set<string> },
  RenderPublicationError
> {
  const lights = packet.metadata.lights;
  const lightError =
    lightingChannelsError(lights) ??
    shadowCasterChannelsError(lights) ??
    pointLightDecayError(lights);
  if (lightError !== undefined) return err(lightError);
  const canvasIds = admitCanvasFrameIds(packet.canvasFrames);
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
    Number.isSafeInteger(row.handle) &&
    row.handle > 0 &&
    row.handle <= 0xffffffff &&
    Number.isSafeInteger(row.revision) &&
    row.revision > 0
  );
}

function validFixedAssetVersion(
  row: NonNullable<RenderPublication['assetVersions']>[number],
): boolean {
  return (
    validVersion(row) &&
    row.value !== null &&
    typeof row.value === 'object' &&
    typeof row.value.kind === 'string'
  );
}

function featureIdentitiesError(
  rows: RenderPublication['features'],
): RenderPublicationError | undefined {
  const featureIdentities = new Set<string>();
  for (const row of rows) {
    if (typeof row.identity !== 'string' || featureIdentities.has(row.identity))
      return shapeError('feature identity');
    featureIdentities.add(row.identity);
  }
  return undefined;
}

function indexTransformRows(entities: Uint32Array): Map<number, number> | undefined {
  const matrices = new Map<number, number>();
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i] as number;
    if (matrices.has(entity)) return undefined;
    matrices.set(entity, i);
  }
  return matrices;
}

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
    Number.isSafeInteger(row.id) &&
    row.id > 0 &&
    row.id <= 0xffffffff &&
    row.value !== null &&
    typeof row.value === 'object' &&
    Array.isArray(row.value.passes) &&
    ArrayBuffer.isView(row.value.baseColor) &&
    Number.isFinite(row.value.roughness) &&
    Number.isFinite(row.value.metallic) &&
    validMaterialContext(row.value.materialContext)
  );
}

function stageSharedMaterials(
  packet: RenderPublication,
): Result<Map<number, MaterialResource>, RenderPublicationError> {
  const stagedMaterials = new Map<number, MaterialResource>();
  for (const row of packet.materials) {
    if (
      !validSharedMaterialRow(row) ||
      stagedMaterials.has(row.id) ||
      packet.retiredMaterials.includes(row.id)
    )
      return rejectPublication('shape', 'shared material');
    stagedMaterials.set(row.id, new MaterialResource(row.value));
  }
  return ok(stagedMaterials);
}

function validGlyphSource(glyph: NonNullable<TemplateSnapshot['glyph']>): boolean {
  return (
    glyph !== null &&
    typeof glyph === 'object' &&
    Number.isInteger(glyph.font) &&
    glyph.font > 0 &&
    glyph.font <= 0xffff_ffff &&
    typeof glyph.text === 'string' &&
    Number.isFinite(glyph.size) &&
    glyph.size > 0 &&
    Array.isArray(glyph.color) &&
    glyph.color.length === 4 &&
    glyph.color.every(Number.isFinite)
  );
}

/** Tilemap, GlyphText and sprite-region sources a template may draw. */
function templateGeometryError(snapshot: TemplateSnapshot): RenderPublicationError | undefined {
  const tilemap = snapshot.tilemap;
  if (tilemap !== undefined && (snapshot.assetHandle !== undefined || !validTilemapSource(tilemap)))
    return shapeError('Tilemap source');
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
): RenderPublicationError | undefined {
  for (const resource of resources)
    for (const source of resource?.snapshot.textureSources?.values() ?? [])
      if (
        isExternalTextureSource(source) ||
        (isCanvasTextureSource(source)
          ? !canvasIds.has(renderTextureSourceKey(source))
          : !sourceTokens.has(renderTextureSourceKey(source)))
      )
        return shapeError('missing material texture source');
  return undefined;
}

function validStaticSkinBinding(binding: NonNullable<TemplateSnapshot['skinBinding']>): boolean {
  return (
    binding !== null &&
    typeof binding === 'object' &&
    Number.isSafeInteger(binding.skeleton) &&
    binding.skeleton > 0 &&
    binding.skeleton <= 0xffffffff &&
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

function canonicalRenderable(
  row: RenderableSnapshot,
  canonical: ReadonlyMap<MaterialResource, MaterialResource>,
): RenderableSnapshot {
  return {
    ...row,
    material: canonical.get(row.material) ?? row.material,
    materials: row.materials.map((resource) => canonical.get(resource) ?? resource),
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

export class RenderPublicationReceiver {
  private revision = 0;
  private readonly skinJoints = new SkinJointReferences();
  // Receiver source facts, once per referenced joint. Per-view SkinInputs derive
  // their numeric roots from these facts; no Binding owns another pose copy.
  private readonly jointMatrices = new Map<number, Float32Array>();
  private readonly materials = new Map<
    number,
    { readonly resource: MaterialResource; readonly holds: number }
  >();
  private readonly materialIds = new WeakMap<MaterialResource, number>();
  private disposed = false;
  private failed = false;
  private accepting = false;
  private readonly preparedMeshes = new Map<
    number,
    {
      readonly mesh: MeshAsset;
      readonly revision: number;
      readonly leases: Set<{ retire(): void; published(): void }>;
    }
  >();
  /**
   * Payloads of released or superseded preparations stay adoptable for a few
   * revisions, keyed by handle and revision: a release, or a newer revision's
   * mesh-prepare, may be handled before a queued draw that references the
   * older payload.
   */
  private readonly releasedPreparedMeshes = new Map<
    string,
    { readonly mesh: MeshAsset; readonly revision: number; readonly until: number }
  >();
  private keepReleasedPrepared(
    handle: number,
    entry: { readonly mesh: MeshAsset; readonly revision: number },
  ): void {
    this.releasedPreparedMeshes.set(`${handle}:${entry.revision}`, {
      mesh: entry.mesh,
      revision: entry.revision,
      until: this.revision + RELEASED_PREPARED_MESH_REVISIONS,
    });
  }
  private readonly canvases = new CanvasFrameReceiver();
  private videoFrames = new Map<string, VideoFrame>();
  private readonly entities = new Map<
    number,
    {
      readonly snapshot: RenderableSnapshot;
      readonly dispatch: DispatchList;
    }
  >();
  private readonly targets: RenderPublicationTargetReceiver | undefined;
  private readonly assetVersions = new Map<string, Asset>();
  private readonly assets = new Map<number, RenderPublication['assets'][number]>();
  private readonly acceptedPrograms = new Set<string>();
  /** Validated, owned projections shared by every material row with equal content. */
  private readonly projections = new PublicationMaterialProjectionAdmission();
  private readonly resources: RenderResourceScope;
  private guidHandles = new Map<string, number>();

  constructor(
    private readonly identity: RenderPublicationIdentity,
    targets?: RenderTargetAuthoring,
  ) {
    this.targets = targets === undefined ? undefined : new RenderPublicationTargetReceiver(targets);
    const resolveAsset: AssetReader['resolveAsset'] = <T extends Asset>(
      handle: number,
      revision?: number,
    ) => {
      const value =
        revision === undefined
          ? this.assets.get(handle)?.value
          : this.assetVersions.get(`${handle}:${revision}`);
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
    this.resources = {
      get revision() {
        return acceptedRevision();
      },
      identity: `${identity.source}:${identity.epoch}`,
      time: { delta: 0, elapsed: 0, maxDeltaSeconds: 0 },
      transparentSort: { mode: 0, yzAlpha: 1 },
      resolveAsset,
      assetRevision: (handle) => this.assets.get(handle)?.revision,
      canvasFrame: (id) => this.canvases.get(id),
      videoFrame: (entity, clip) => this.videoFrames.get(`${entity}:${clip}`),
      handleForGuid: (guid) => this.guidHandles.get(guid.toLowerCase()),
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
        const handle = this.guidHandles.get(guid.toLowerCase());
        return handle === undefined ? undefined : (this.assets.get(handle)?.value as T | undefined);
      },
    };
  }

  /** Reserve a Mesh POD without admitting a scene row or an asset dependency. */
  prepareMesh(
    input: PublishedMeshPreparation,
    onRetire: () => void = () => {},
    onPublished: () => void = () => {},
    inputOwnership?: 'received',
  ): Result<
    {
      readonly resources: RenderResourceScope;
      readonly mesh: MeshAsset;
      isCurrent(): boolean;
      release(): void;
    },
    RenderPublicationError
  > {
    if (this.disposed || this.failed)
      return rejectPublication('disposed', 'receiver retired or failed; start a new source epoch');
    if (input.source !== this.identity.source || input.epoch !== this.identity.epoch)
      return rejectPublication('identity', 'prepared mesh source/epoch');
    if (
      !Number.isSafeInteger(input.meshHandle) ||
      input.mesh?.kind !== 'mesh' ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1
    )
      return rejectPublication('shape', 'prepared mesh handle/payload');
    const prior = this.preparedMeshes.get(input.meshHandle);
    const accepted = this.assets.get(input.meshHandle);
    if (input.revision < Math.max(prior?.revision ?? 0, accepted?.revision ?? 0))
      return rejectPublication('revision', 'stale prepared mesh revision');
    const mesh =
      prior?.revision === input.revision
        ? prior.mesh
        : accepted?.revision === input.revision
          ? accepted.value
          : undefined;
    if (mesh !== undefined && (mesh.kind !== 'mesh' || !samePublishedMesh(mesh, input.mesh)))
      return rejectPublication('shape', 'prepared mesh conflicts with its resource handle');
    const entry = (prior?.revision === input.revision ? prior : undefined) ?? {
      revision: input.revision,
      mesh:
        (mesh as MeshAsset | undefined) ??
        (inputOwnership === 'received'
          ? ownReceivedPublishedMesh(input.mesh)
          : copyPublishedMesh(input.mesh)),
      leases: new Set<{ retire(): void; published(): void }>(),
    };
    const lease = { retire: onRetire, published: onPublished };
    entry.leases.add(lease);
    this.preparedMeshes.set(input.meshHandle, entry);
    if (prior !== undefined && prior !== entry) {
      this.keepReleasedPrepared(input.meshHandle, prior);
      for (const lease of prior.leases) lease.retire();
    }
    let released = false;
    return ok({
      resources: this.resources,
      mesh: entry.mesh,
      isCurrent: () =>
        !released &&
        !this.disposed &&
        !this.failed &&
        this.preparedMeshes.get(input.meshHandle) === entry,
      release: () => {
        if (released) return;
        released = true;
        entry.leases.delete(lease);
        if (entry.leases.size === 0 && this.preparedMeshes.get(input.meshHandle) === entry) {
          this.preparedMeshes.delete(input.meshHandle);
          this.keepReleasedPrepared(input.meshHandle, entry);
        }
      },
    });
  }

  /** Renderer consumers pass their registry; scene-only receivers need no shader installation. */
  accept(
    packet: RenderPublication,
    materialAssets?: AssetRegistry,
  ): Result<PreparedRenderPublication, RenderPublicationError> {
    if (this.accepting)
      return err(
        new RenderPublicationError({ reason: 'in-flight', subject: 'publication adoption' }),
      );
    this.accepting = true;
    try {
      return this.adopt(packet, materialAssets);
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
    const textureSources = admitFrameTextureSources(packet);
    if (!textureSources.ok) return textureSources;
    const versions = this.stageFixedAssetVersions(packet);
    if (!versions.ok) return versions;
    const featureError = featureIdentitiesError(packet.features);
    if (featureError !== undefined) return err(featureError);
    const matrices = indexTransformRows(packet.transformEntities);
    if (matrices === undefined) return rejectPublication('shape', 'duplicate transform identity');
    const stagedMaterialRows = stageSharedMaterials(packet);
    if (!stagedMaterialRows.ok) return stagedMaterialRows;
    const stagedMaterials = stagedMaterialRows.value;
    const { canvasIds, sourceTokens } = textureSources.value;
    const material = (id: number): MaterialResource | undefined => {
      let resource = stagedMaterials.get(id);
      if (resource !== undefined) return resource;
      const previous = this.materials.get(id);
      if (previous === undefined) return undefined;
      resource = new MaterialResource(previous.resource.snapshot);
      stagedMaterials.set(id, resource);
      return resource;
    };
    const materialHolds = new Map<number, number>();
    const hold = (id: number, delta: number) =>
      materialHolds.set(id, this.materialHoldCount(materialHolds, id) + delta);
    const releaseEntityMaterials = (entity: number) => {
      const snapshot = this.entities.get(entity)?.snapshot;
      for (const resource of [
        ...(snapshot?.materials ?? []),
        ...(snapshot?.materialOverrides ?? []),
      ]) {
        if (resource === undefined) continue;
        const id = this.materialIds.get(resource);
        if (id === undefined) throw new Error('missing accepted material identity');
        hold(id, -1);
      }
    };
    const holdTemplateMaterials = (snapshot: TemplateSnapshot) => {
      for (const id of snapshot.materials) hold(id, 1);
      for (const id of snapshot.materialOverrides ?? []) if (id !== 0) hold(id, 1);
    };
    const operations: RenderSceneOperation[] = [];
    const renderables: RenderableSnapshot[] = [];
    const dispatch: DispatchEntry[] = [];
    const updated = new Set<number>();
    const removed = new Set<number>();
    const stageUpsert = (
      entityKey: number,
      template: RenderPublicationTemplate | undefined,
    ): RenderPublicationError | undefined => {
      const matrixIndex = matrices.get(entityKey);
      const world =
        matrixIndex === undefined
          ? undefined
          : packet.transforms.slice(matrixIndex * 16, matrixIndex * 16 + 16);
      if (template === undefined || world === undefined || updated.has(entityKey))
        return shapeError('upsert template/transform');
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
        ) ?? templateSkinError(template.snapshot);
      if (bindingError !== undefined) return bindingError;
      const binding = template.snapshot.skinBinding;
      const ownedBinding =
        binding === undefined
          ? undefined
          : Object.freeze({
              skeleton: binding.skeleton,
              joints: Object.freeze([...binding.joints]),
            });
      updated.add(entityKey);
      releaseEntityMaterials(entityKey);
      holdTemplateMaterials(template.snapshot);
      const { materialOverrides: _overrides, ...templateContent } = template.snapshot;
      const snapshot: RenderableSnapshot = {
        ...templateContent,
        ...(ownedBinding === undefined ? {} : { skinBinding: ownedBinding }),
        ...(overrides === undefined
          ? {}
          : { materialOverrides: captureMaterialOverrides(overrides) }),
        material: first,
        materials: resources,
        worldId: 0,
        entityKey,
        transform: { world },
      };
      for (const item of template.dispatch)
        dispatch.push({ ...item, entityIndex: entityKey, renderableIndex: renderables.length });
      renderables.push(snapshot);
      operations.push({ kind: 'update', worldId: 0, entityKey, snapshot });
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
        if (!this.entities.has(entityKey) || updated.has(entityKey) || removed.has(entityKey))
          return shapeError('duplicate removal');
        removed.add(entityKey);
        releaseEntityMaterials(entityKey);
        operations.push({ kind: 'remove', worldId: 0, entityKey });
      }
      return undefined;
    };
    const sceneError = stageSceneEdits();
    if (sceneError !== undefined) return err(sceneError);
    const references = this.prepareSkinReferences(removed, renderables);
    const retiredJoints = this.stageRetiredJoints(packet.retiredJoints, references);
    if (!retiredJoints.ok) return retiredJoints;
    /** Joint matrix rows, plus world-only updates for unchanged accepted renderables. */
    const stageTransformRows = (): Result<number[], RenderPublicationError> => {
      const jointRows: number[] = [];
      for (const [entityKey, index] of matrices) {
        const renderable =
          !removed.has(entityKey) && (updated.has(entityKey) || this.entities.has(entityKey));
        const joint = references?.has(entityKey) ?? this.skinJoints.has(entityKey);
        if (!renderable && !joint) return rejectPublication('shape', 'unknown transform identity');
        if (joint && !retiredJoints.value.has(entityKey)) jointRows.push(index);
        else if (!renderable)
          return rejectPublication('shape', 'retired joint also has a positive row');
        if (renderable && !updated.has(entityKey)) {
          const world = packet.transforms.slice(index * 16, index * 16 + 16);
          operations.push({ kind: 'update', worldId: 0, entityKey, world });
        }
      }
      return ok(jointRows);
    };
    const jointRows = stageTransformRows();
    if (!jointRows.ok) return jointRows;
    const retiredMaterials = new Set(packet.retiredMaterials);
    const holdError = this.materialHoldError(packet, retiredMaterials, materialHolds);
    if (holdError !== undefined) return err(holdError);
    // Validate the complete packet before changing the accepted asset namespace.
    const assets = this.stageAssets(packet, renderables, materialAssets);
    if (!assets.ok) return assets;
    let prepared = this.admitPublicationPrograms(
      {
        ...(jointRows.value.length === 0 && retiredJoints.value.size === 0
          ? {}
          : { skinJoints: { rows: jointRows.value, retired: retiredJoints.value } }),
        assetChanges: assets.value.changes,
        materialUpdates: [...stagedMaterials.values()],
        resources: this.resources,
        packet,
        operations,
        frame: {
          ...packet.metadata,
          renderables,
          dispatch,
          visibilitySnapshots: [],
          featureVisibilitySnapshots: [],
          hiddenEntityReports: [],
        },
      },
      materialAssets,
    );
    if (this.disposed) return rejectPublication('disposed', 'receiver retired during admission');
    // Program/target admission can throw. Keep the accepted resource namespace
    // and revision unchanged until it succeeds so the same packet can retry.
    try {
      prepared = this.commitMaterials(
        prepared,
        [...stagedMaterials.keys()],
        materialHolds,
        retiredMaterials,
      );
      this.commitAssetNamespace(packet, versions.value, assets.value.guidChanges);
      this.commitAssetRows(packet, assets.value.admitted, assets.value.patched, materialAssets);
      this.retirePreparedMeshes(assets.value.stalePreparations);
      this.commitFrameInputs(packet);
      references?.commit();
      this.commitJointMatrices(packet, retiredJoints.value, jointRows.value);
      this.revision = packet.revision;
      for (const [key, released] of this.releasedPreparedMeshes)
        if (released.until < this.revision) this.releasedPreparedMeshes.delete(key);
      this.commitEntities(prepared, removed, updated, operations);
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
    if (
      packet.protocol !== 3 ||
      !Array.isArray(packet.materials) ||
      !Array.isArray(packet.retiredMaterials)
    )
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
      const live = this.preparedMeshes.get(row?.handle);
      const prepared =
        live?.revision === row?.revision
          ? live
          : this.releasedPreparedMeshes.get(`${row?.handle}:${row?.revision}`);
      if (prepared === undefined || prepared.revision !== row.revision)
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
  ): Result<
    { readonly retired: Set<string>; readonly admitted: Map<string, Asset> },
    RenderPublicationError
  > {
    if (
      (packet.assetVersions !== undefined && !Array.isArray(packet.assetVersions)) ||
      (packet.retiredAssetVersions !== undefined && !Array.isArray(packet.retiredAssetVersions))
    )
      return rejectPublication('shape', 'fixed asset version rows');
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
    const admitted = new Map<string, Asset>();
    for (const row of packet.assetVersions ?? []) {
      if (
        !validFixedAssetVersion(row) ||
        admitted.has(versionKey(row)) ||
        this.assetVersions.has(versionKey(row)) ||
        retired.has(versionKey(row))
      )
        return rejectPublication('shape', 'fixed asset version');
      admitted.set(versionKey(row), ownRenderFeatureProgramData(structuredClone(row.value)));
    }
    if (this.assetVersions.size + admitted.size - retired.size > 65536)
      return rejectPublication('shape', 'fixed asset version capacity');
    return ok({ retired, admitted });
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

  /** A newer row makes its prepared mesh stale; an equal revision must match it exactly. */
  private preparedMeshRevisionError(
    row: AcceptedAssetRow,
    stalePreparations: Set<number>,
  ): RenderPublicationError | undefined {
    const prepared = this.preparedMeshes.get(row.handle);
    if (prepared === undefined) return undefined;
    if (prepared.revision < row.revision) stalePreparations.add(row.handle);
    if (
      prepared.revision === row.revision &&
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
      readonly stalePreparations: Set<number>;
      readonly projections: Map<AcceptedAssetRow, MaterialRenderProjection>;
    },
    RenderPublicationError
  > {
    const assetHandles = new Set<number>();
    const changes: AssetChange[] = [];
    const stalePreparations = new Set<number>();
    const packetPrograms = new Set(packet.programs.map((program) => program.key));
    const programKnown = (key: string) =>
      packetPrograms.has(key) ||
      this.acceptedPrograms.has(key) ||
      materialAssets?.shaderRegistry.materialArtifact(key) !== undefined;
    // Structured clone keeps one shared projection object per packet; content
    // repeated across packets reuses its validated owned copy by digest+equality.
    const projectionAliases = new Map<object, MaterialRenderProjection>();
    const projections = new Map<AcceptedAssetRow, MaterialRenderProjection>();
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
        programKnown,
        projectionAliases,
      );
      if (!projection.ok) return rejectPublication('shape', projection.error);
      if (projection.value !== undefined) projections.set(row, projection.value);
      const preparedError = this.preparedMeshRevisionError(row, stalePreparations);
      if (preparedError !== undefined) return err(preparedError);
      changes.push({
        handle: row.handle as AssetChange['handle'],
        revision: row.revision,
        removed: false,
        fields: ['*'],
        ranges: [],
      });
    }
    return ok({ assetHandles, changes, stalePreparations, projections });
  }

  /**
   * One asset row's admitted projection: carried, adopted from a resident
   * holder, retained by omission, or cleared by null.
   */
  private receivedMaterialProjection(
    row: RenderPublication['assets'][number],
    retired: readonly number[],
    available: (key: string) => boolean,
    aliases: Map<object, MaterialRenderProjection>,
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
    const projection = this.projections.admit(input, row.value, available, aliases);
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
        this.preparedMeshes.has(patch.handle),
      );
      const candidate = this.preparedMeshes.get(patch.handle);
      const candidateMatches = candidate !== undefined && candidate.revision === patch.revision;
      if (candidateMatches) {
        // The temporary COW buffers make candidate equality a validation step.
        prepared.commit();
        if (prepared.value.kind !== 'mesh' || !samePublishedMesh(candidate.mesh, prepared.value))
          return rejectPublication('shape', 'patched mesh differs from prepared residency');
      }
      return ok({
        row: {
          ...current,
          revision: patch.revision,
          value: candidateMatches ? candidate.mesh : prepared.value,
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
    stalePreparations: Set<number>,
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
      if (
        (this.preparedMeshes.get(patch.handle)?.revision ?? Number.POSITIVE_INFINITY) <
        patch.revision
      )
        stalePreparations.add(patch.handle);
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
    renderables: readonly RenderableSnapshot[],
  ): boolean {
    for (const handles of [
      publicationFrameDependencies(packet.metadata),
      ...renderables.map(publicationDependencies),
    ]) {
      if (
        handles.some(
          (handle) => !this.assetResolvable(handle as number, assetHandles, packet.retiredAssets),
        )
      )
        return true;
    }
    return false;
  }

  /** Stage only changed GUIDs; asset retirement never scans the namespace. */
  private stageGuidChanges(packet: RenderPublication): Map<string, number | undefined> {
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
    renderables: readonly RenderableSnapshot[],
  ): boolean {
    const lodMissing = (mesh: NonNullable<RenderableSnapshot['lods']>[number]['mesh']) => {
      if (typeof mesh === 'number')
        return !this.assetResolvable(mesh, assetHandles, packet.retiredAssets);
      const guid = AssetGuid.format(mesh).toLowerCase();
      return (
        (guidChanges.has(guid) ? guidChanges.get(guid) : this.guidHandles.get(guid)) === undefined
      );
    };
    for (const row of renderables) if (row.lods?.some((lod) => lodMissing(lod.mesh))) return true;
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
      const program =
        row.value.kind === 'particle-effect' || row.value.kind === 'material'
          ? ownRenderFeatureProgramData(row.value)
          : row.value;
      const { materialProjectionSource: _source, ...received } = row;
      return {
        ...received,
        materialProjection: projections.get(row) ?? null,
        // Non-JSON inputs retain their exact payload types and mutable behavior.
        value:
          (this.preparedMeshes.get(row.handle)?.revision === row.revision
            ? this.preparedMeshes.get(row.handle)?.mesh
            : undefined) ?? (isOwnedRenderFeatureProgramData(program) ? program : row.value),
      };
    });
  }

  private skinSkeletonMissing(
    packet: RenderPublication,
    patched: readonly PatchedAssetRow[],
    renderables: readonly RenderableSnapshot[],
  ): boolean {
    for (const row of renderables) {
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
    renderables: readonly RenderableSnapshot[],
    materialAssets: AssetRegistry | undefined,
  ): Result<
    {
      readonly changes: AssetChange[];
      readonly patched: PatchedAssetRow[];
      readonly stalePreparations: Set<number>;
      readonly guidChanges: Map<string, number | undefined>;
      readonly admitted: AcceptedAssetRow[];
    },
    RenderPublicationError
  > {
    const rows = this.stageAssetRows(packet, materialAssets);
    if (!rows.ok) return rows;
    const { assetHandles, changes, stalePreparations, projections } = rows.value;
    const patched = this.stageAssetPatches(packet, assetHandles, changes, stalePreparations);
    if (!patched.ok) return patched;
    if (this.missingAssetDependency(packet, assetHandles, renderables))
      return rejectPublication('shape', 'missing asset dependency');
    const guidChanges = this.stageGuidChanges(packet);
    if (this.missingLodDependency(packet, assetHandles, guidChanges, renderables))
      return rejectPublication('shape', 'missing LOD dependency');
    const admitted = this.ownAdmittedAssets(packet, projections);
    if (this.skinSkeletonMissing(packet, patched.value, renderables))
      return rejectPublication('shape', 'Skin Skeleton definition');
    return ok({ changes, patched: patched.value, stalePreparations, guidChanges, admitted });
  }

  /** Target and program admission may throw before the accepted namespace changes. */
  private admitPublicationPrograms(
    prepared: PreparedRenderPublication,
    materialAssets: AssetRegistry | undefined,
  ): PreparedRenderPublication {
    let admitted = this.targets?.apply(prepared) ?? prepared;
    if (materialAssets !== undefined) {
      installPublicationPrograms(materialAssets, prepared.packet.programs);
      admitted = rebindPublicationMaterialSchemas(materialAssets.shaderRegistry, admitted);
    }
    return admitted;
  }

  /** Staged material copies adopt into their accepted resources, which rows then reference. */
  private commitMaterials(
    prepared: PreparedRenderPublication,
    stagedMaterialIds: readonly number[],
    holds: ReadonlyMap<number, number>,
    retiredMaterials: ReadonlySet<number>,
  ): PreparedRenderPublication {
    const canonical = new Map<MaterialResource, MaterialResource>();
    const materialUpdates = prepared.materialUpdates.map((resource, index) => {
      const id = stagedMaterialIds[index] as number;
      const previous = this.materials.get(id);
      const current = previous?.resource ?? resource;
      if (previous !== undefined) current.adopt(resource.snapshot);
      this.materials.set(id, {
        resource: current,
        holds: holds.get(id) ?? previous?.holds ?? 0,
      });
      this.materialIds.set(current, id);
      canonical.set(resource, current);
      return current;
    });
    for (const [id, count] of holds) {
      const current = this.materials.get(id);
      if (current !== undefined) this.materials.set(id, { ...current, holds: count });
    }
    for (const id of retiredMaterials) this.materials.delete(id);
    const acceptedRows = new Map<RenderableSnapshot, RenderableSnapshot>();
    for (const row of prepared.frame.renderables)
      acceptedRows.set(row, canonicalRenderable(row, canonical));
    return {
      ...prepared,
      materialUpdates,
      frame: { ...prepared.frame, renderables: [...acceptedRows.values()] },
      operations: prepared.operations.map((operation) =>
        operation.kind === 'update' && operation.snapshot !== undefined
          ? { ...operation, snapshot: acceptedRows.get(operation.snapshot) ?? operation.snapshot }
          : operation,
      ),
    };
  }

  private commitAssetNamespace(
    packet: RenderPublication,
    versions: {
      readonly retired: ReadonlySet<string>;
      readonly admitted: ReadonlyMap<string, Asset>;
    },
    guidChanges: ReadonlyMap<string, number | undefined>,
  ): void {
    if (packet.baseline) {
      this.assets.clear();
      this.acceptedPrograms.clear();
      this.assetVersions.clear();
    }
    for (const key of versions.retired) this.assetVersions.delete(key);
    for (const [key, value] of versions.admitted) this.assetVersions.set(key, value);
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
        if (key.startsWith(`${handle}:`)) this.releasedPreparedMeshes.delete(key);
    }
  }

  private commitAssetRows(
    packet: RenderPublication,
    admitted: readonly AcceptedAssetRow[],
    patched: readonly PatchedAssetRow[],
    materialAssets: AssetRegistry | undefined,
  ): void {
    for (const row of admitted) {
      this.assets.set(row.handle, row);
      if (row.materialProjection != null && materialAssets !== undefined)
        materialAssets.materialPayloadProjections.set(row.value, row.materialProjection);
    }
    for (const program of packet.programs) this.acceptedPrograms.add(program.key);
    for (const patch of patched) {
      patch.commit();
      this.assets.set(patch.row.handle, patch.row);
      if (patch.row.materialProjection != null && materialAssets !== undefined)
        materialAssets.materialPayloadProjections.set(
          patch.row.value,
          patch.row.materialProjection,
        );
    }
  }

  private retirePreparedMeshes(handles: ReadonlySet<number>): void {
    for (const handle of handles) {
      const entry = this.preparedMeshes.get(handle);
      if (entry !== undefined) this.keepReleasedPrepared(handle, entry);
      this.preparedMeshes.delete(handle);
      for (const lease of entry?.leases ?? []) lease.retire();
    }
  }

  private commitFrameInputs(packet: RenderPublication): void {
    Object.assign(this.resources, { time: packet.time, transparentSort: packet.transparentSort });
    this.releaseVideoFrames();
    this.videoFrames = new Map(
      packet.videoFrames.map((row) => [`${row.entity}:${row.clip}`, row.frame]),
    );
    this.canvases.accept(packet.canvasFrames ?? []);
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

  private commitEntities(
    prepared: PreparedRenderPublication,
    removed: ReadonlySet<number>,
    updated: ReadonlySet<number>,
    operations: readonly RenderSceneOperation[],
  ): void {
    for (const entity of removed) this.entities.delete(entity);
    const dispatchByEntity = new Map<number, DispatchEntry[]>();
    for (const item of prepared.frame.dispatch) {
      const entity = prepared.frame.renderables.at(item.renderableIndex)?.entityKey;
      if (entity === undefined) continue;
      const entries = dispatchByEntity.get(entity) ?? [];
      entries.push(item);
      dispatchByEntity.set(entity, entries);
    }
    const dispatchGroups: DispatchList[] = [];
    for (const snapshot of prepared.frame.renderables) {
      const dispatch = dispatchByEntity.get(snapshot.entityKey) ?? [];
      this.entities.set(snapshot.entityKey, {
        snapshot,
        dispatch,
      });
      dispatchGroups.push(dispatch);
    }
    retainPublicationDispatchGroups(prepared.frame.dispatch, dispatchGroups);
    for (const operation of operations) {
      if (operation.kind !== 'update' || operation.world === undefined) continue;
      const row = this.entities.get(operation.entityKey);
      if (row !== undefined && !updated.has(operation.entityKey))
        this.entities.set(operation.entityKey, {
          ...row,
          snapshot: {
            ...row.snapshot,
            transform: { ...row.snapshot.transform, world: operation.world },
          },
        });
    }
  }

  private publishPreparedMeshes(packet: RenderPublication): void {
    for (const row of [...packet.assets, ...packet.assetPatches]) {
      const candidate = this.preparedMeshes.get(row.handle);
      if (candidate !== undefined && candidate.revision === row.revision)
        for (const lease of candidate.leases) lease.published();
    }
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
    const renderables: RenderableSnapshot[] = [];
    const dispatch: DispatchEntry[] = [];
    const dispatchGroups: DispatchEntry[][] = [];
    // Cold initialization/recovery only. Normal accept updates known rows above
    // and never walks this population to discover changes.
    const matrixRows = new Map<number, number>();
    for (const entity of this.entities.keys()) matrixRows.set(entity, matrixRows.size);
    const jointRows: number[] = [];
    for (const joint of this.jointMatrices.keys()) {
      let index = matrixRows.get(joint);
      if (index === undefined) {
        index = matrixRows.size;
        matrixRows.set(joint, index);
      }
      jointRows.push(index);
    }
    const transformEntities = new Uint32Array(matrixRows.size);
    const transforms = new Float32Array(matrixRows.size * 16);
    for (const [entity, index] of matrixRows) {
      transformEntities[index] = entity;
      const matrix =
        this.jointMatrices.get(entity) ?? this.entities.get(entity)?.snapshot.transform.world;
      if (matrix === undefined)
        throw new RenderPublicationError({
          reason: 'shape',
          subject: 'owned current transform row',
        });
      for (let lane = 0; lane < 16; lane++) transforms[index * 16 + lane] = matrix[lane] as number;
    }
    for (const row of this.entities.values()) {
      const group: DispatchEntry[] = [];
      for (const item of row.dispatch) {
        const entry = { ...item, renderableIndex: renderables.length };
        dispatch.push(entry);
        group.push(entry);
      }
      dispatchGroups.push(group);
      renderables.push(row.snapshot);
    }
    retainPublicationDispatchGroups(dispatch, dispatchGroups);
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
      frame: { ...input.frame, renderables, dispatch },
      operations: renderables.map((snapshot) => ({
        kind: 'update',
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        snapshot,
      })),
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
    for (const entry of this.preparedMeshes.values())
      for (const lease of entry.leases) lease.retire();
    this.preparedMeshes.clear();
    this.releasedPreparedMeshes.clear();
    this.canvases.dispose();
    this.releaseVideoFrames();
    this.assets.clear();
    this.acceptedPrograms.clear();
    this.projections.clear();
    this.assetVersions.clear();
    this.materials.clear();
    this.guidHandles = new Map();
    this.entities.clear();
    this.skinJoints.clear();
    this.jointMatrices.clear();
  }

  get acceptedRevision(): number {
    return this.disposed || this.failed ? -1 : this.revision;
  }
}
