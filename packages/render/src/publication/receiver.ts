import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
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
import { WORLD_CAPSULE_STRIDE } from '../capsule-shadow/world-capsules';
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
import { prepareAssetPatch } from './asset-patch';
import { CanvasFrameReceiver } from './canvas';
import {
  type PublishedMeshPreparation,
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
} from './contract';
import { publicationDependencies, publicationFrameDependencies } from './dependencies';
import { retainPublicationDispatchGroups } from './dispatch-groups';
import { copyPublishedMesh, ownReceivedPublishedMesh, samePublishedMesh } from './mesh';
import {
  installPublicationPrograms,
  rebindPublicationMaterialSchemas,
  validPublicationMaterialProjection,
} from './programs';
import type { RenderResourceScope } from './resource-scope';
import { RenderPublicationTargetReceiver, type RenderTargetAuthoring } from './targets';

export interface PreparedRenderPublication {
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

function validPoseMatrices(matrices: readonly Float32Array[]): boolean {
  for (let index = 0; index < matrices.length; index++) {
    const matrix = matrices[index];
    if (!(matrix instanceof Float32Array) || matrix.length !== 16 || !finiteFloats(matrix))
      return false;
  }
  return true;
}

/** Assets live for this source session; the Renderer owns all retained scene/GPU state. */
export class RenderPublicationReceiver {
  private revision = 0;
  private readonly materials = new Map<
    number,
    { readonly resource: MaterialResource; readonly holds: number }
  >();
  private readonly materialIds = new WeakMap<MaterialResource, number>();
  private disposed = false;
  private accepting = false;
  private readonly preparedMeshes = new Map<
    number,
    {
      readonly mesh: MeshAsset;
      readonly revision: number;
      readonly leases: Set<{ retire(): void; published(): void }>;
    }
  >();
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
    const acceptedRevision = () => this.revision;
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
    const reject = (reason: RenderPublicationError['detail']['reason'], subject: string) =>
      err(new RenderPublicationError({ reason, subject }));
    if (this.disposed) return reject('disposed', 'receiver');
    if (input.source !== this.identity.source || input.epoch !== this.identity.epoch)
      return reject('identity', 'prepared mesh source/epoch');
    if (
      !Number.isSafeInteger(input.meshHandle) ||
      input.mesh?.kind !== 'mesh' ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1
    )
      return reject('shape', 'prepared mesh handle/payload');
    const prior = this.preparedMeshes.get(input.meshHandle);
    const accepted = this.assets.get(input.meshHandle);
    if (input.revision < Math.max(prior?.revision ?? 0, accepted?.revision ?? 0))
      return reject('revision', 'stale prepared mesh revision');
    const mesh =
      prior?.revision === input.revision
        ? prior.mesh
        : accepted?.revision === input.revision
          ? accepted.value
          : undefined;
    if (mesh !== undefined && (mesh.kind !== 'mesh' || !samePublishedMesh(mesh, input.mesh)))
      return reject('shape', 'prepared mesh conflicts with its resource handle');
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
    if (prior !== undefined && prior !== entry) for (const lease of prior.leases) lease.retire();
    let released = false;
    return ok({
      resources: this.resources,
      mesh: entry.mesh,
      isCurrent: () =>
        !released && !this.disposed && this.preparedMeshes.get(input.meshHandle) === entry,
      release: () => {
        if (released) return;
        released = true;
        entry.leases.delete(lease);
        if (entry.leases.size === 0 && this.preparedMeshes.get(input.meshHandle) === entry)
          this.preparedMeshes.delete(input.meshHandle);
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
    packet: RenderPublication,
    materialAssets?: AssetRegistry,
  ): Result<PreparedRenderPublication, RenderPublicationError> {
    const reject = (reason: RenderPublicationError['detail']['reason'], subject: string) =>
      err(new RenderPublicationError({ reason, subject }));
    if (this.disposed) return reject('disposed', 'receiver');
    if (
      packet.protocol !== 2 ||
      !Array.isArray(packet.materials) ||
      !Array.isArray(packet.retiredMaterials)
    )
      return reject('shape', 'material publication protocol');
    if (packet.source !== this.identity.source || packet.epoch !== this.identity.epoch)
      return reject('identity', 'source/epoch');
    if (packet.base !== this.revision || packet.baseline !== (this.revision === 0))
      return reject('base', 'accepted revision');
    if (!Number.isSafeInteger(packet.revision) || packet.revision !== this.revision + 1)
      return reject('revision', 'next revision');
    if (
      !(packet.upserts instanceof Uint32Array) ||
      packet.upserts.length % 2 !== 0 ||
      !(packet.removed instanceof Uint32Array) ||
      !(packet.transformEntities instanceof Uint32Array) ||
      !(packet.transforms instanceof Float32Array) ||
      packet.transforms.length !== packet.transformEntities.length * 16 ||
      !finiteFloats(packet.transforms) ||
      !Number.isFinite(packet.sampleTimeSeconds)
    )
      return reject('shape', 'numeric columns');
    if (
      !Array.isArray(packet.videoFrames) ||
      !Array.isArray(packet.targets) ||
      !Array.isArray(packet.targetSources) ||
      !Array.isArray(packet.features) ||
      !Array.isArray(packet.templates) ||
      !Array.isArray(packet.programs) ||
      !Array.isArray(packet.assets) ||
      !Array.isArray(packet.retiredAssets) ||
      !Array.isArray(packet.assetPatches) ||
      packet.metadata === null ||
      typeof packet.metadata !== 'object' ||
      !Array.isArray(packet.metadata.cameras) ||
      packet.metadata.lights === null ||
      typeof packet.metadata.lights !== 'object' ||
      !Array.isArray(packet.metadata.lights.point) ||
      !Array.isArray(packet.metadata.lights.pointShadow) ||
      !Array.isArray(packet.metadata.lights.spot) ||
      !Array.isArray(packet.metadata.lights.rect) ||
      !Number.isFinite(packet.time?.elapsed) ||
      !Number.isFinite(packet.time?.delta)
    )
      return reject('shape', 'frame metadata');
    for (const light of [
      packet.metadata.lights.directional,
      ...packet.metadata.lights.point,
      ...packet.metadata.lights.spot,
      ...packet.metadata.lights.rect,
    ]) {
      if (
        light !== undefined &&
        (light === null ||
          typeof light !== 'object' ||
          validateChannelMask(
            light.lightingChannels === undefined
              ? LIGHTING_CHANNELS_DEFAULT
              : light.lightingChannels,
          ) !== null)
      )
        return reject('shape', 'light lightingChannels');
    }
    for (const shadow of [
      packet.metadata.lights.directionalCsmConfig,
      ...packet.metadata.lights.pointShadow,
      ...packet.metadata.lights.spot,
    ]) {
      if (
        shadow !== undefined &&
        (shadow === null ||
          typeof shadow !== 'object' ||
          validateChannelMask(
            shadow.shadowCasterChannels === undefined ? 0xffffffff : shadow.shadowCasterChannels,
            'shadowCasterChannels',
          ) !== null)
      )
        return reject('shape', 'light shadowCasterChannels');
    }
    for (const light of packet.metadata.lights.point) {
      if (
        light === undefined ||
        validatePointLightDecay(light.decay === undefined ? 2 : light.decay) !== null
      )
        return reject('shape', 'point light decay');
    }
    if (packet.canvasFrames !== undefined && !Array.isArray(packet.canvasFrames))
      return reject('shape', 'canvas frames');
    const canvasIds = new Set<string>();
    for (const row of packet.canvasFrames ?? []) {
      if (
        typeof row.id !== 'string' ||
        row.id.length === 0 ||
        typeof row.flipY !== 'boolean' ||
        canvasIds.has(row.id) ||
        !Number.isSafeInteger(row.version) ||
        row.version < 1 ||
        typeof row.disposed !== 'boolean' ||
        (row.disposed && row.frame !== undefined) ||
        (row.frame !== undefined &&
          (typeof VideoFrame === 'undefined' ||
            !(row.frame instanceof VideoFrame) ||
            row.frame.displayWidth <= 0 ||
            row.frame.displayHeight <= 0))
      )
        return reject('shape', 'canvas frame');
      canvasIds.add(row.id);
    }
    const videoKeys = new Set<string>();
    for (const row of packet.videoFrames) {
      const key = `${row.entity}:${row.clip}`;
      if (
        !Number.isSafeInteger(row.entity) ||
        !Number.isSafeInteger(row.clip) ||
        typeof VideoFrame === 'undefined' ||
        !(row.frame instanceof VideoFrame) ||
        row.frame.displayWidth <= 0 ||
        row.frame.displayHeight <= 0 ||
        videoKeys.has(key)
      )
        return reject('shape', 'video frame');
      videoKeys.add(key);
    }
    const targetIds = new Set<number>();
    const targetTokens = new Set<object>();
    for (const row of packet.targets) {
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
        return reject('shape', 'target identity/descriptor');
      targetIds.add(row.id);
      targetTokens.add(row.token);
    }
    for (const camera of [
      ...packet.metadata.cameras,
      ...packet.metadata.auxiliaryCameras,
      ...packet.metadata.cubeCameras,
    ])
      if (camera.target !== undefined && !targetTokens.has(camera.target))
        return reject('shape', 'missing target descriptor');
    const cameraWriters = [
      ...packet.metadata.cameras,
      ...packet.metadata.auxiliaryCameras,
      ...packet.metadata.cubeCameras,
    ];
    const planarTargets = new Set(
      packet.metadata.auxiliaryCameras
        .filter((camera) => camera.planarReflection !== undefined)
        .map((camera) => camera.target),
    );
    for (const target of planarTargets) {
      if (
        target === undefined ||
        cameraWriters.filter((camera) => camera.target === target).length !== 1
      )
        return reject('shape', 'duplicate planar target writer');
    }
    const sourceTokens = new Set<string>();
    for (const row of packet.targetSources) {
      if (
        !targetTokens.has(row.target) ||
        !isRenderTextureSourceToken(row.token) ||
        row.token.source !== 'target' ||
        sourceTokens.has(renderTextureSourceKey(row.token))
      )
        return reject('shape', 'target source');
      sourceTokens.add(renderTextureSourceKey(row.token));
    }
    if (
      (packet.assetVersions !== undefined && !Array.isArray(packet.assetVersions)) ||
      (packet.retiredAssetVersions !== undefined && !Array.isArray(packet.retiredAssetVersions))
    )
      return reject('shape', 'fixed asset version rows');
    const versionKey = (row: { handle: number; revision: number }) =>
      `${row.handle}:${row.revision}`;
    const validVersion = (row: { handle: number; revision: number }) =>
      row !== null &&
      Number.isSafeInteger(row.handle) &&
      row.handle > 0 &&
      row.handle <= 0xffffffff &&
      Number.isSafeInteger(row.revision) &&
      row.revision > 0;
    const retiredVersions = new Set<string>();
    for (const row of packet.retiredAssetVersions ?? []) {
      if (
        !validVersion(row) ||
        retiredVersions.has(versionKey(row)) ||
        !this.assetVersions.has(versionKey(row))
      )
        return reject('shape', 'retired fixed asset version');
      retiredVersions.add(versionKey(row));
    }
    const admittedVersions = new Map<string, Asset>();
    for (const row of packet.assetVersions ?? []) {
      if (
        !validVersion(row) ||
        admittedVersions.has(versionKey(row)) ||
        this.assetVersions.has(versionKey(row)) ||
        retiredVersions.has(versionKey(row)) ||
        row.value === null ||
        typeof row.value !== 'object' ||
        typeof row.value.kind !== 'string'
      )
        return reject('shape', 'fixed asset version');
      admittedVersions.set(
        versionKey(row),
        ownRenderFeatureProgramData(structuredClone(row.value)),
      );
    }
    if (this.assetVersions.size + admittedVersions.size - retiredVersions.size > 65536)
      return reject('shape', 'fixed asset version capacity');
    const featureIdentities = new Set<string>();
    for (const row of packet.features) {
      if (typeof row.identity !== 'string' || featureIdentities.has(row.identity))
        return reject('shape', 'feature identity');
      featureIdentities.add(row.identity);
    }
    const matrices = new Map<number, Float32Array>();
    for (let i = 0; i < packet.transformEntities.length; i++) {
      const entity = packet.transformEntities[i] as number;
      if (matrices.has(entity)) return reject('shape', 'duplicate transform identity');
      matrices.set(entity, packet.transforms.slice(i * 16, i * 16 + 16));
    }
    const stagedMaterials = new Map<number, MaterialResource>();
    for (const row of packet.materials) {
      if (
        !Number.isSafeInteger(row.id) ||
        row.id <= 0 ||
        row.id > 0xffffffff ||
        stagedMaterials.has(row.id) ||
        packet.retiredMaterials.includes(row.id) ||
        row.value === null ||
        typeof row.value !== 'object' ||
        !Array.isArray(row.value.passes) ||
        !ArrayBuffer.isView(row.value.baseColor) ||
        !Number.isFinite(row.value.roughness) ||
        !Number.isFinite(row.value.metallic) ||
        (row.value.materialContext !== undefined &&
          (row.value.materialContext === null ||
            typeof row.value.materialContext !== 'object' ||
            !['mesh', 'skinned', 'sprite', 'sprite-instances', 'terrain'].includes(
              row.value.materialContext.geometry,
            ) ||
            typeof row.value.materialContext.vertexColor !== 'boolean'))
      )
        return reject('shape', 'shared material');
      stagedMaterials.set(row.id, new MaterialResource(row.value));
    }
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
      materialHolds.set(id, (materialHolds.get(id) ?? this.materials.get(id)?.holds ?? 0) + delta);
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
    const operations: RenderSceneOperation[] = [];
    const renderables: RenderableSnapshot[] = [];
    const dispatch: DispatchEntry[] = [];
    const updated = new Set<number>();
    for (let i = 0; i < packet.upserts.length; i += 2) {
      const entityKey = packet.upserts[i] as number;
      const template = packet.templates[packet.upserts[i + 1] as number];
      const world = matrices.get(entityKey);
      if (template === undefined || world === undefined || updated.has(entityKey))
        return reject('shape', 'upsert template/transform');
      if (!Array.isArray(template.snapshot?.materials) || !Array.isArray(template.dispatch))
        return reject('shape', 'template');
      const tilemap = template.snapshot.tilemap;
      if (
        tilemap !== undefined &&
        (template.snapshot.assetHandle !== undefined || !validTilemapSource(tilemap))
      )
        return reject('shape', 'Tilemap source');
      const glyph = template.snapshot.glyph;
      if (
        template.snapshot.generatedMesh !== undefined ||
        (glyph !== undefined &&
          (template.snapshot.assetHandle !== undefined ||
            glyph === null ||
            typeof glyph !== 'object' ||
            !Number.isInteger(glyph.font) ||
            glyph.font <= 0 ||
            glyph.font > 0xffff_ffff ||
            typeof glyph.text !== 'string' ||
            !Number.isFinite(glyph.size) ||
            glyph.size <= 0 ||
            !Array.isArray(glyph.color) ||
            glyph.color.length !== 4 ||
            !glyph.color.every(Number.isFinite)))
      )
        return reject('shape', 'GlyphText source');
      const spriteRegion = template.snapshot.spriteRegion;
      if (
        spriteRegion !== undefined &&
        (!Array.isArray(spriteRegion) ||
          spriteRegion.length !== 4 ||
          spriteRegion.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
      )
        return reject('shape', 'sprite region');
      if (
        (template.snapshot.layer !== undefined &&
          (!Number.isInteger(template.snapshot.layer) ||
            template.snapshot.layer < -0x80000000 ||
            template.snapshot.layer > 0x7fffffff)) ||
        (template.snapshot.shadowCaster !== undefined && template.snapshot.shadowCaster !== false)
      )
        return reject('shape', 'material binding');
      if (
        template.snapshot.pipelinePreparation !== undefined &&
        !Array.isArray(template.snapshot.pipelinePreparation)
      )
        return reject('shape', 'pipeline preparation passes');
      if (
        validateChannelMask(
          template.snapshot.lightingChannels === undefined
            ? LIGHTING_CHANNELS_DEFAULT
            : template.snapshot.lightingChannels,
        ) !== null
      )
        return reject('shape', 'receiver lightingChannels');
      if (
        validateChannelMask(
          template.snapshot.shadowChannels === undefined
            ? 0xffffffff
            : template.snapshot.shadowChannels,
          'shadowChannels',
        ) !== null
      )
        return reject('shape', 'receiver shadowChannels');
      const resources: (MaterialResource | undefined)[] = template.snapshot.materials.map(material);
      if (
        template.snapshot.materialOverrides !== undefined &&
        !Array.isArray(template.snapshot.materialOverrides)
      )
        return reject('shape', 'material overrides');
      const overrides = template.snapshot.materialOverrides?.map((id: number) =>
        id === 0 ? undefined : material(id),
      );
      if (
        overrides?.some(
          (resource: MaterialResource | undefined, index: number) =>
            resource === undefined && template.snapshot.materialOverrides?.[index] !== 0,
        )
      )
        return reject('shape', 'missing material override');
      const firstMaterial = material(template.snapshot.material);
      if (
        firstMaterial === undefined ||
        !template.snapshot.materials.includes(template.snapshot.material) ||
        resources.some((resource) => resource === undefined)
      )
        return reject('shape', 'missing material reference');
      for (const resource of [...resources, ...(overrides ?? [])])
        for (const source of resource?.snapshot.textureSources?.values() ?? [])
          if (
            isExternalTextureSource(source) ||
            (isCanvasTextureSource(source)
              ? !canvasIds.has(renderTextureSourceKey(source))
              : !sourceTokens.has(renderTextureSourceKey(source)))
          )
            return reject('shape', 'missing material texture source');
      if (template.snapshot.skin !== undefined) return reject('shape', 'source GPU skin receipt');
      const pose = template.snapshot.skinPose;
      if (
        pose !== undefined &&
        (!Number.isInteger(pose.jointCount) ||
          pose.jointCount <= 0 ||
          pose.inverseBindMatrices.length !== pose.jointCount ||
          pose.jointWorlds.length !== pose.jointCount ||
          !validPoseMatrices(pose.inverseBindMatrices) ||
          !validPoseMatrices(pose.jointWorlds))
      )
        return reject('shape', 'skin pose');
      const capsuleShadow = template.snapshot.capsuleShadow;
      if (
        capsuleShadow?.status === 'ready' &&
        (!(capsuleShadow.capsules instanceof Float32Array) ||
          capsuleShadow.capsules.length % WORLD_CAPSULE_STRIDE !== 0 ||
          !finiteFloats(capsuleShadow.capsules))
      )
        return reject('shape', 'capsule shadow');
      updated.add(entityKey);
      releaseEntityMaterials(entityKey);
      for (const id of template.snapshot.materials) hold(id, 1);
      for (const id of template.snapshot.materialOverrides ?? []) if (id !== 0) hold(id, 1);
      const { materialOverrides: _overrides, ...templateContent } = template.snapshot;
      const snapshot: RenderableSnapshot = {
        ...templateContent,
        ...(overrides === undefined
          ? {}
          : { materialOverrides: captureMaterialOverrides(overrides) }),
        material: firstMaterial,
        materials: resources as MaterialResource[],
        worldId: 0,
        entityKey,
        transform: { world },
      };
      for (const item of template.dispatch)
        dispatch.push({ ...item, entityIndex: entityKey, renderableIndex: renderables.length });
      renderables.push(snapshot);
      operations.push({ kind: 'update', worldId: 0, entityKey, snapshot });
    }
    const removed = new Set<number>();
    for (const entityKey of packet.removed) {
      if (!this.entities.has(entityKey) || updated.has(entityKey) || removed.has(entityKey))
        return reject('shape', 'duplicate removal');
      removed.add(entityKey);
      releaseEntityMaterials(entityKey);
      operations.push({ kind: 'remove', worldId: 0, entityKey });
    }
    for (const [entityKey, world] of matrices) {
      if (removed.has(entityKey)) return reject('shape', 'removed transform');
      if (!updated.has(entityKey) && !this.entities.has(entityKey))
        return reject('shape', 'unknown transform identity');
      if (!updated.has(entityKey))
        operations.push({ kind: 'update', worldId: 0, entityKey, world });
    }
    const retiredMaterials = new Set(packet.retiredMaterials);
    if (retiredMaterials.size !== packet.retiredMaterials.length)
      return reject('shape', 'duplicate material retirement');
    for (const id of retiredMaterials)
      if (
        !this.materials.has(id) ||
        (materialHolds.get(id) ?? this.materials.get(id)?.holds ?? 0) !== 0
      )
        return reject('shape', 'referenced material retirement');
    for (const row of packet.materials)
      if ((materialHolds.get(row.id) ?? this.materials.get(row.id)?.holds ?? 0) === 0)
        return reject('shape', 'unreferenced material publication');
    for (const [id, holds] of materialHolds)
      if (holds < 0) return reject('shape', `material hold ${id}`);
    // Validate the complete packet before changing the accepted asset namespace.
    const assetHandles = new Set<number>();
    const assetChanges: AssetChange[] = [];
    const patchedAssets: { row: RenderPublication['assets'][number]; commit(): void }[] = [];
    const packetPrograms = new Set(packet.programs.map((program) => program.key));
    const stalePreparations = new Set<number>();
    for (const row of packet.assets) {
      if (
        row.value === null ||
        typeof row.value !== 'object' ||
        !Number.isSafeInteger(row.handle) ||
        row.handle <= 0 ||
        row.handle > 0xffffffff ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1 ||
        row.revision <= (this.assets.get(row.handle)?.revision ?? 0) ||
        assetHandles.has(row.handle) ||
        packet.retiredAssets.includes(row.handle)
      )
        return reject('shape', 'asset payload');
      if (
        row.sourceKey !== undefined &&
        (typeof row.sourceKey !== 'string' ||
          row.sourceKey.length === 0 ||
          typeof row.guid !== 'string' ||
          row.guid.length === 0)
      )
        return reject('shape', 'asset source');
      assetHandles.add(row.handle);
      if (row.materialProjection !== undefined && row.value.kind !== 'material')
        return reject('shape', 'material projection on another asset kind');
      if (
        row.materialProjection !== undefined &&
        row.materialProjection !== null &&
        (row.value.kind !== 'material' ||
          !validPublicationMaterialProjection(
            row.materialProjection,
            row.value,
            (key) =>
              packetPrograms.has(key) ||
              this.acceptedPrograms.has(key) ||
              materialAssets?.shaderRegistry.findMaterialArtifact(key).ok === true,
          ))
      )
        return reject('shape', 'material source projection');
      const prepared = this.preparedMeshes.get(row.handle);
      if (prepared !== undefined) {
        if (prepared.revision < row.revision) stalePreparations.add(row.handle);
        if (
          prepared.revision === row.revision &&
          (row.value.kind !== 'mesh' || !samePublishedMesh(prepared.mesh, row.value))
        )
          return reject('shape', 'accepted mesh differs from prepared residency');
      }
      assetChanges.push({
        handle: row.handle as AssetChange['handle'],
        revision: row.revision,
        removed: false,
        fields: ['*'],
        ranges: [],
      });
    }
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
        return reject('shape', 'asset patch base or identity');
      try {
        const prepared = prepareAssetPatch(
          current.value,
          patch,
          this.preparedMeshes.has(patch.handle),
        );
        const candidate = this.preparedMeshes.get(patch.handle);
        if (candidate !== undefined && candidate.revision === patch.revision) {
          // The temporary COW buffers make candidate equality a validation step.
          prepared.commit();
          if (prepared.value.kind !== 'mesh' || !samePublishedMesh(candidate.mesh, prepared.value))
            return reject('shape', 'patched mesh differs from prepared residency');
        }
        patchedAssets.push({
          row: {
            ...current,
            revision: patch.revision,
            value:
              candidate !== undefined && candidate.revision === patch.revision
                ? candidate.mesh
                : prepared.value,
          },
          commit: prepared.commit,
        });
        assetChanges.push(prepared.change);
      } catch (cause) {
        if (cause instanceof RenderPublicationError) return err(cause);
        return reject('shape', 'asset patch capture');
      }
      assetHandles.add(patch.handle);
      if (
        (this.preparedMeshes.get(patch.handle)?.revision ?? Number.POSITIVE_INFINITY) <
        patch.revision
      )
        stalePreparations.add(patch.handle);
    }
    for (const handles of [
      publicationFrameDependencies(packet.metadata),
      ...renderables.map(publicationDependencies),
    ]) {
      if (
        handles.some(
          (handle) =>
            !assetHandles.has(handle) &&
            (!this.assets.has(handle as number) || packet.retiredAssets.includes(handle as number)),
        )
      )
        return reject('shape', 'missing asset dependency');
    }
    // Stage only changed GUIDs; asset retirement never scans the namespace.
    const guidChanges = new Map<string, number | undefined>();
    const retiredAssets = packet.retiredAssets;
    for (const handle of retiredAssets) {
      const guid = this.assets.get(handle)?.guid;
      if (guid !== undefined) guidChanges.set(guid.toLowerCase(), undefined);
    }
    for (const row of packet.assets) {
      if (row.guid === undefined) continue;
      guidChanges.set(row.guid.toLowerCase(), row.handle);
    }
    for (const row of renderables)
      if (
        row.lods?.some((lod) => {
          if (typeof lod.mesh === 'number')
            return (
              !assetHandles.has(lod.mesh) &&
              (!this.assets.has(lod.mesh) || packet.retiredAssets.includes(lod.mesh))
            );
          const guid = AssetGuid.format(lod.mesh).toLowerCase();
          return (
            (guidChanges.has(guid) ? guidChanges.get(guid) : this.guidHandles.get(guid)) ===
            undefined
          );
        })
      )
        return reject('shape', 'missing LOD dependency');
    // Worker cloning removes the Source loader's ownership mark. Detach program
    // JSON at admission without freezing borrowed Source assets or frame data.
    // A getter/copy failure must leave the accepted namespace and revision intact.
    const admittedAssets = packet.assets.map((row) => {
      const program =
        row.value.kind === 'particle-effect' || row.value.kind === 'material'
          ? ownRenderFeatureProgramData(row.value)
          : row.value;
      const projection =
        row.materialProjection === undefined
          ? this.assets.get(row.handle)?.materialProjection
          : row.materialProjection === null
            ? undefined
            : ownRenderFeatureProgramData(row.materialProjection);
      return {
        ...row,
        materialProjection: projection ?? null,
        // Non-JSON inputs retain their exact payload types and mutable behavior.
        value:
          (this.preparedMeshes.get(row.handle)?.revision === row.revision
            ? this.preparedMeshes.get(row.handle)?.mesh
            : undefined) ?? (isOwnedRenderFeatureProgramData(program) ? program : row.value),
      };
    });
    let prepared: PreparedRenderPublication = {
      assetChanges,
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
    };
    prepared = this.targets?.apply(prepared) ?? prepared;
    if (materialAssets !== undefined) {
      installPublicationPrograms(materialAssets, packet.programs);
      prepared = rebindPublicationMaterialSchemas(materialAssets.shaderRegistry, prepared);
    }
    if (this.disposed) return reject('disposed', 'receiver retired during admission');
    // Program/target admission can throw. Keep the accepted resource namespace
    // and revision unchanged until it succeeds so the same packet can retry.
    const stagedMaterialIds = [...stagedMaterials.keys()];
    const canonical = new Map<MaterialResource, MaterialResource>();
    const materialUpdates = prepared.materialUpdates.map((resource, index) => {
      const id = stagedMaterialIds[index] as number;
      const previous = this.materials.get(id);
      const current = previous?.resource ?? resource;
      if (previous !== undefined) current.adopt(resource.snapshot);
      this.materials.set(id, {
        resource: current,
        holds: materialHolds.get(id) ?? previous?.holds ?? 0,
      });
      this.materialIds.set(current, id);
      canonical.set(resource, current);
      return current;
    });
    for (const [id, holds] of materialHolds) {
      const current = this.materials.get(id);
      if (current !== undefined) this.materials.set(id, { ...current, holds });
    }
    for (const id of retiredMaterials) this.materials.delete(id);
    const acceptedRows = new Map<RenderableSnapshot, RenderableSnapshot>();
    for (const row of prepared.frame.renderables)
      acceptedRows.set(row, {
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
      });
    prepared = {
      ...prepared,
      materialUpdates,
      frame: { ...prepared.frame, renderables: [...acceptedRows.values()] },
      operations: prepared.operations.map((operation) =>
        operation.kind === 'update' && operation.snapshot !== undefined
          ? { ...operation, snapshot: acceptedRows.get(operation.snapshot) ?? operation.snapshot }
          : operation,
      ),
    };
    if (packet.baseline) {
      this.assets.clear();
      this.acceptedPrograms.clear();
      this.assetVersions.clear();
    }
    for (const key of retiredVersions) this.assetVersions.delete(key);
    for (const [key, value] of admittedVersions) this.assetVersions.set(key, value);
    for (const [guid, handle] of guidChanges) {
      if (handle === undefined) this.guidHandles.delete(guid);
      else this.guidHandles.set(guid, handle);
    }
    for (const handle of packet.retiredAssets) {
      this.assets.delete(handle);
      for (const lease of this.preparedMeshes.get(handle)?.leases ?? []) lease.retire();
      this.preparedMeshes.delete(handle);
    }
    for (const row of admittedAssets) {
      this.assets.set(row.handle, row);
      if (row.materialProjection !== null && materialAssets !== undefined)
        materialAssets.materialPayloadProjections.set(row.value, row.materialProjection);
    }
    for (const program of packet.programs) this.acceptedPrograms.add(program.key);
    for (const patch of patchedAssets) {
      patch.commit();
      this.assets.set(patch.row.handle, patch.row);
      if (patch.row.materialProjection != null && materialAssets !== undefined)
        materialAssets.materialPayloadProjections.set(
          patch.row.value,
          patch.row.materialProjection,
        );
    }
    for (const handle of stalePreparations) {
      const entry = this.preparedMeshes.get(handle);
      this.preparedMeshes.delete(handle);
      for (const lease of entry?.leases ?? []) lease.retire();
    }
    Object.assign(this.resources, { time: packet.time, transparentSort: packet.transparentSort });
    this.releaseVideoFrames();
    this.videoFrames = new Map(
      packet.videoFrames.map((row) => [`${row.entity}:${row.clip}`, row.frame]),
    );
    this.canvases.accept(packet.canvasFrames ?? []);
    this.revision = packet.revision;
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
    for (const [entity, world] of matrices) {
      const row = this.entities.get(entity);
      if (!updated.has(entity) && row !== undefined)
        this.entities.set(entity, {
          ...row,
          snapshot: {
            ...row.snapshot,
            transform: { ...row.snapshot.transform, world },
          },
        });
    }
    for (const row of [...packet.assets, ...packet.assetPatches]) {
      const candidate = this.preparedMeshes.get(row.handle);
      if (candidate !== undefined && candidate.revision === row.revision)
        for (const lease of candidate.leases) lease.published();
    }
    return ok(prepared);
  }

  /** A new view starts at the accepted scene, including changes made while no view rendered. */
  snapshot(input: PreparedRenderPublication): PreparedRenderPublication {
    const renderables: RenderableSnapshot[] = [];
    const dispatch: DispatchEntry[] = [];
    const dispatchGroups: DispatchEntry[][] = [];
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
      packet: { ...input.packet, baseline: true },
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
    this.canvases.dispose();
    this.releaseVideoFrames();
    this.assets.clear();
    this.acceptedPrograms.clear();
    this.assetVersions.clear();
    this.materials.clear();
    this.guidHandles = new Map();
    this.entities.clear();
  }

  get acceptedRevision(): number {
    return this.revision;
  }
}
