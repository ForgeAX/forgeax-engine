import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  runtimeAssetReference,
  runtimeAssetSource,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import { type EntityHandle, Time, type World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { Children, GlobalTransform, readPresentationWorldMatrix } from '@forgeax/engine-scene';
import { type Asset, err, ok, type Result } from '@forgeax/engine-types';
import { stereoEyeCameras } from '../components/stereo-camera';
import { renderMaterialContext } from '../extract/material-context';
import { fullscreenRenderFeatureDeclaration } from '../features/fullscreen';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';
import type { RenderFeature, RenderFeatureExtractContext } from '../features/types';
import { renderFeatureCameraView } from '../features/view';
import { MaterialResource } from '../material-resource';
import {
  type MaterialSnapshot,
  type MaterialSnapshotCachesByWorld,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
  resolveRuntimeAssetReference,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';
import {
  acceptRenderSourceEntities,
  captureRenderSourceEntities,
  createGlobalTransformChangeQuery,
  createRenderSourceState,
  isRenderableMember,
  renderSourceHierarchyChanged,
} from '../scene/render-source';
import { registerRenderSourceSystems } from '../scene/source-systems';
import { getTransparentSortConfig } from '../systems/transparent-sort-config';
import { renderTargetMaterialSourceIdentity } from '../targets/material-source';
import { type CanvasTextureSource, isCanvasTextureSource } from '../textures/canvas-texture';
import { isExternalTextureSource } from '../textures/external-texture';
import { renderTextureSourceKey } from '../textures/source-token';
import { PublishedAssetClosure } from './asset-closure';
import { type PublishedCanvasFrame, publicationCanvasFrames } from './canvas';
import {
  type RenderPublication,
  RenderPublicationError,
  type RenderPublicationIdentity,
  type RenderPublicationTemplate,
} from './contract';
import { publicationFrameDependencies, renderableAssetRoots } from './dependencies';
import { beginSourcePreparation, type SourcePreparationObservation } from './observation';
import { publicationMaterialProgramKeys } from './programs';
import { worldRenderResources } from './resource-scope';
import { SkinJointReferences } from './skin-joints';
import { publicationTargetSources, type RenderPublicationTargetOwner } from './targets';
import {
  materialCanvasSources,
  materialVideoClips,
  projectTextureConsumers,
} from './texture-consumers';
import { publicationVideoFrames } from './video';

const EMPTY_ASSET_ROWS: readonly (readonly [number, Asset, number])[] = Object.freeze([]);
type PreparedAssetRow = NonNullable<RenderPublication['preparedAssets']>[number];
const EMPTY_IDENTITIES: readonly number[] = Object.freeze([]);
const EMPTY_MATERIAL_ROWS: RenderPublication['materials'] = Object.freeze([]);

function publicationKeyValue(key: string, value: unknown): unknown {
  return value instanceof Map
    ? key === 'textureSources'
      ? [...value].map(([name, source]) => [
          name,
          isCanvasTextureSource(source)
            ? renderTextureSourceKey(source)
            : isExternalTextureSource(source)
              ? renderTextureSourceKey(source)
              : renderTargetMaterialSourceIdentity(source),
        ])
      : [...value]
    : ArrayBuffer.isView(value)
      ? Array.from(value as unknown as ArrayLike<number>)
      : value;
}

/** The source kind a publication packet cannot carry for this renderable, if any. */
function unsupportedRenderableSource(row: RenderableSnapshot): string | undefined {
  if ('skin' in row && row.skin !== undefined) return 'source GPU skin receipt';
  if (
    [...row.materials, ...(row.materialOverrides ?? [])].some((material) =>
      [...(material?.snapshot.textureSources?.values() ?? [])].some(isExternalTextureSource),
    )
  )
    return 'renderer-local external texture source';
  return undefined;
}

function publicationAssetBrand(asset: Asset | undefined) {
  return asset?.kind === 'material'
    ? 'material'
    : asset?.kind === 'mesh'
      ? 'mesh'
      : 'RenderFeatureAsset';
}

export interface RenderPublicationCandidate {
  readonly packet: RenderPublication;
  /** Source-local diagnostic; never serialized with the packet. */
  readonly observation?: SourcePreparationObservation;
  /** Call synchronously after successful postMessage; never wait for remote ACK. */
  accept(): void;
  discard(): void;
}

/** Source indices and asset dependencies only; the receiver owns the RenderScene. */
export function createRenderPublisher(
  world: World,
  assets: AssetRegistry,
  identity: RenderPublicationIdentity,
  capabilities?: RhiCaps,
  features: readonly RenderFeature<unknown>[] = [],
  targetOwner?: RenderPublicationTargetOwner,
  limits?: Readonly<Record<string, number>>,
  maxInFlight: 2 | 3 | 4 = 2,
  /**
   * True when the receiver already holds this exact mesh revision from a ready
   * residency preparation that stays until this publication is adopted.
   */
  preparedMesh?: (handle: number, revision: number) => boolean,
) {
  world.bindAssets(assets).unwrap();
  const assetObserver = assets.observe().unwrap();
  const assetClosure = new PublishedAssetClosure();
  const materialIds = new WeakMap<MaterialResource, number>();
  const materialRecords = new Map<
    number,
    {
      readonly resource: MaterialResource;
      readonly snapshot: MaterialSnapshot;
      readonly holds: number;
    }
  >();
  const materialsByEntity = new Map<number, readonly number[]>();
  const materialRows = new Map<number, MaterialSnapshot>();
  const materialSources = new Map<number, MaterialResource>();
  const nextMaterialDependencies = new Map<number, readonly number[]>();
  const materialHolds = new Map<number, number>();
  let nextMaterialId = 1;
  if (maxInFlight !== 2 && maxInFlight !== 3 && maxInFlight !== 4)
    throw new RenderPublicationError({ reason: 'shape', subject: 'publication capacity' });
  let activeObservation: SourcePreparationObservation | undefined;
  const publishedFullscreenFeatures = new Map<string, object>();
  const releaseTransforms = registerRenderSourceSystems(world);
  const source = createRenderSourceState(world);
  const transforms = createGlobalTransformChangeQuery(world);
  const caches: MaterialSnapshotCachesByWorld = new WeakMap();
  const members = new Set<number>();
  const publishedPrograms = new Set<string>();
  const publishedMaterialProjections = new Map<
    number,
    ReturnType<AssetRegistry['getMaterialProjectionForPayload']>
  >();
  // An accepted projection is an immutable program contract: a reload installs
  // a new object, which is also what the omission check above compares. One
  // frozen detached copy serves every row and packet, so copied materials do
  // not clone shared program rows and ABIs again, and a Worker structured clone
  // carries each shared projection once per packet.
  const detachedMaterialProjections = new WeakMap<object, object>();
  const detachMaterialProjection = <T extends object>(projection: T | undefined): T | null => {
    if (projection === undefined) return null;
    const known = detachedMaterialProjections.get(projection) as T | undefined;
    if (known !== undefined) return known;
    const owned = ownRenderFeatureProgramData(projection);
    if (!isOwnedRenderFeatureProgramData(owned)) return structuredClone(projection);
    detachedMaterialProjections.set(projection, owned);
    return owned;
  };
  let assetVersions = new Map<
    string,
    { readonly handle: number; readonly revision: number; readonly value: Asset }
  >();
  const dependencies = new Map<number, readonly number[]>();
  const pending = new Set<number>();
  let canvasConsumers = new Map<number, readonly CanvasTextureSource[]>();
  let videoConsumers = new Map<number, readonly number[]>();
  // One consuming frame and a bounded number of sealed successors.
  const flights = new Map<
    number,
    {
      features: RenderPublication['features'];
      owners: readonly RenderFeature<unknown>[];
      submitted: boolean;
    }
  >();
  const skinJoints = new SkinJointReferences();
  let frameDependencies = new Set<number>();
  let revision = 0,
    disposed = false,
    failed = false,
    active = false;
  let lastScannedRows = 0,
    allocations = 0;
  let storage = Array.from({ length: 5 }, () => new ArrayBuffer(0));
  const spareStorage: ArrayBuffer[][] = [];
  const buffer = (index: number, bytes: number): ArrayBuffer => {
    let value = storage[index] as ArrayBuffer;
    if (value.byteLength < bytes) {
      let capacity = Math.max(16, value.byteLength);
      while (capacity < bytes) capacity *= 2;
      value = new ArrayBuffer(capacity);
      storage[index] = value;
      allocations++;
    }
    return value;
  };

  const fail = (reason: RenderPublicationError['detail']['reason'], subject: string) =>
    err(new RenderPublicationError({ reason, subject }));
  const acknowledgePrograms = (programs: RenderPublication['programs']): void => {
    if (disposed || failed) return;
    for (const program of programs) publishedPrograms.add(program.key);
  };

  /** Count a newly changed entity once under the observation reason that admitted it. */
  const addChanged = (
    changed: Set<number>,
    entity: number,
    observation: SourcePreparationObservation | undefined,
    reason: 'renderable-component-or-new' | 'hierarchy' | 'catalog-source',
  ): void => {
    const size = observation === undefined ? 0 : changed.size;
    changed.add(entity);
    observation?.count(reason, changed.size !== size);
  };

  const closeFrames = (
    videoFrames: RenderPublication['videoFrames'],
    canvasFrames: readonly PublishedCanvasFrame[],
  ): void => {
    for (const row of videoFrames) row.frame.close();
    for (const row of canvasFrames) row.frame?.close();
  };

  /**
   * One candidate preparation: source changes observed at construction, then
   * the packet and the deferred acceptance that commits its publisher state.
   */
  class PublicationPreparation {
    readonly featureSources = [...features];
    readonly batch = source.projection.read();
    readonly sourceRows = captureRenderSourceEntities(world, source, this.batch);
    readonly changed: Set<number>;
    readonly removed = new Set<number>();
    readonly invalidated = new Set<number>();
    readonly assetBatch: ReturnType<ReturnType<typeof assetObserver.read>['unwrap']>;
    readonly matrixRows = new Map<number, ArrayLike<number>>();
    canvasFrames: readonly PublishedCanvasFrame[] = [];
    videoFrames: RenderPublication['videoFrames'] = [];
    // Dispatch entries share their material's parameter snapshot. Intern
    // both so each pass/entity does not serialize that same payload again.
    // The value table lives only for this preparation.
    private readonly valueIds = new Map<object, number>();
    private readonly values = new Map<string, number>();
    private readonly templates: RenderPublicationTemplate[] = [];
    private readonly templateIds = new Map<
      string,
      { index: number; dependencies: readonly number[] }
    >();
    private readonly upserts: number[] = [];
    private readonly programs = new Map<string, RenderPublication['programs'][number]>();
    private readonly programMaterials = new Set<MaterialSnapshot>();
    private readonly nextDependencies = new Map<number, readonly number[]>();
    private readonly nextAssetVersions = new Map<
      string,
      { readonly handle: number; readonly revision: number; readonly value: Asset }
    >();
    private closure: ReturnType<PublishedAssetClosure['begin']> | undefined;
    private references: ReturnType<SkinJointReferences['prepare']> | undefined;
    private jointChanges: Set<number> | undefined;
    private retiredJoints: Set<number> | undefined;

    constructor(
      readonly baseline: boolean,
      readonly observation: SourcePreparationObservation | undefined,
    ) {
      const batch = this.batch;
      lastScannedRows = batch.scannedRows;
      observation?.fact('scannedRows', batch.scannedRows);
      observation?.fact('batchIndices', batch.indices.length);
      observation?.fact('changedComponentKinds', batch.changedComponents.length);
      observation?.fact('membershipChanged', batch.membershipChanged);
      observation?.fact('pending', pending.size);
      this.changed = new Set(pending);
      this.assetBatch = assetObserver.read().unwrap();
      observation?.fact('assetChanges', this.assetBatch.changes.length);
      for (const change of this.assetBatch.changes)
        if (!change.removed) this.invalidated.add(change.handle as unknown as number);
      this.collectSourceChanges();
      if (baseline) this.addBaselineMembers();
      this.collectTransformRows();
      observation?.fact('changed', this.changed.size);
      observation?.fact('removed', this.removed.size);
      observation?.fact('invalidated', this.invalidated.size);
      observation?.fact('matrixRows', this.matrixRows.size);
      for (const entity of this.changed) pending.add(entity);
    }

    private collectSourceChanges(): void {
      let sourceCursor = 0;
      for (const index of this.batch.indices) {
        const currentSource = this.sourceRows[sourceCursor++];
        const previous = source.entities.get(index)?.entity,
          current = currentSource?.entity;
        if (previous !== undefined) this.retirePreviousSource(previous, current);
        if (current === undefined) continue;
        if (isRenderableMember(world, current) && this.renderableChanged(index, current))
          addChanged(this.changed, current, this.observation, 'renderable-component-or-new');
        if (
          currentSource !== undefined &&
          renderSourceHierarchyChanged(source, index, currentSource)
        )
          this.addHierarchyChanges(current);
      }
    }

    /** A replaced or no-longer-renderable source row leaves membership and joint tracking. */
    private retirePreviousSource(previous: number, current: number | undefined): void {
      if (members.has(previous) && (current !== previous || !isRenderableMember(world, previous)))
        this.removed.add(previous);
      if (
        skinJoints.has(previous) &&
        (current !== previous || !world.hasComponent(previous as EntityHandle, GlobalTransform))
      )
        skinJoints.mark(previous);
    }

    private renderableChanged(index: number, current: EntityHandle): boolean {
      const observation = this.observation;
      return (
        this.baseline ||
        this.batch.hasStructuralChange(index) ||
        !members.has(current) ||
        source.renderableComponents.some((component) => {
          const dirty = source.projection.changed(current, component);
          if (dirty && observation !== undefined && component.name === 'MeshFilter')
            observation.count('mesh-filter-write');
          return dirty;
        })
      );
    }

    private addHierarchyChanges(root: number): void {
      const queue = [root],
        visited = new Set<number>();
      while (queue.length) {
        const entity = queue.pop() as EntityHandle;
        if (visited.has(entity)) continue;
        visited.add(entity);
        if (isRenderableMember(world, entity))
          addChanged(this.changed, entity, this.observation, 'hierarchy');
        if (world.hasComponent(entity, Children))
          queue.push(
            ...Array.from(
              world.get(entity, Children).unwrap().entities,
              (child) => child as EntityHandle,
            ),
          );
      }
    }

    private addBaselineMembers(): void {
      for (const entity of members) this.changed.add(entity);
      for (const { entity } of source.entities.values())
        if (isRenderableMember(world, entity))
          addChanged(this.changed, entity, this.observation, 'catalog-source');
    }

    private collectTransformRows(): void {
      for (const span of transforms.spans().unwrap()) {
        for (let row = 0; row < span.entities.length; row++) {
          const entity = span.entities[row] as EntityHandle;
          skinJoints.mark(entity);
          if (members.has(entity) && !this.removed.has(entity)) {
            const matrix = readPresentationWorldMatrix(world, entity);
            if (matrix !== undefined) this.matrixRows.set(entity, matrix);
            pending.add(entity);
          }
        }
      }
    }

    private readonly keyValue = (key: string, value: unknown): unknown =>
      key === 'paramSnapshot' && value !== null && typeof value === 'object'
        ? this.valueId(value, true)
        : publicationKeyValue(key, value);

    private valueId(object: object, parameters = false): number {
      const cached = this.valueIds.get(object);
      if (cached !== undefined) return cached;
      const value = JSON.stringify(object, parameters ? publicationKeyValue : this.keyValue);
      let id = this.values.get(value);
      if (id === undefined) {
        id = this.values.size;
        this.values.set(value, id);
      }
      this.valueIds.set(object, id);
      return id;
    }

    private publicationClosure(): ReturnType<PublishedAssetClosure['begin']> {
      this.closure ??= assetClosure.begin(assets);
      return this.closure;
    }

    private publishMaterial(resource: MaterialResource): number {
      let id = materialIds.get(resource);
      if (id === undefined) {
        if (nextMaterialId > 0xffffffff)
          throw new Error('material publication identity capacity exhausted');
        id = nextMaterialId++;
        materialIds.set(resource, id);
      }
      materialSources.set(id, resource);
      if (materialRecords.get(id)?.snapshot !== resource.snapshot)
        materialRows.set(id, resource.snapshot);
      return id;
    }

    private publishProgram(key: string): void {
      if (publishedPrograms.has(key) || this.programs.has(key)) return;
      const shader = assets.shaderRegistry.findMaterialArtifact(key);
      if (!shader.ok) throw shader.error;
      const artifact = assets.getMaterialArtifact(key);
      this.programs.set(key, {
        key,
        shader: {
          source: shader.value.source,
          ...(shader.value.program.entryPoints === undefined
            ? {}
            : { entryPoints: shader.value.program.entryPoints }),
          paramSchema: shader.value.paramSchema,
          ...(shader.value.receipt === undefined ? {} : { receipt: shader.value.receipt }),
        },
        ...(artifact === undefined ? {} : { artifact }),
      });
    }

    private publishPrograms(materials: readonly MaterialSnapshot[]): void {
      for (const material of materials) {
        if (this.programMaterials.has(material)) continue;
        this.programMaterials.add(material);
        for (const key of publicationMaterialProgramKeys(material)) this.publishProgram(key);
      }
    }

    prepare(
      sampleTimeSeconds: number,
      temporalReset: boolean,
    ): Result<RenderPublicationCandidate, RenderPublicationError> {
      const observation = this.observation;
      observation?.phase('extract');
      const frame = extractFrames([world], { cameraOwner: 0, resourceOwner: 0 }, assets, caches, {
        ...(capabilities === undefined ? {} : renderMaterialContext(capabilities, limits)),
        cull: 'none',
        retainHidden: true,
        renderables: this.changed.size
          ? { kind: 'partial', entitiesByWorld: [this.changed] }
          : 'none',
      });
      observation?.phase('templates');
      observation?.fact('renderables', frame.renderables.length);
      this.republishInvalidatedMaterials();
      const unsupported = this.addRenderableTemplates(frame);
      if (unsupported !== undefined) return fail('unsupported', unsupported);
      observation?.phase('feature');
      const featureRows = this.extractFeatureRows(frame);
      observation?.phase('packet');
      const nextFrameDependencies = this.collectFrameDependencies(frame, featureRows);
      const emitted = new Set(frame.renderables.map((row) => row.entityKey));
      for (const entity of this.changed)
        if (members.has(entity) && !emitted.has(entity)) this.removed.add(entity);
      for (const entity of this.removed) this.matrixRows.delete(entity);
      this.prepareJointUpdates(frame);
      const nextVideoConsumers = projectTextureConsumers(
        videoConsumers,
        this.removed,
        frame.renderables,
        materialVideoClips,
      );
      this.videoFrames = publicationVideoFrames(world, nextVideoConsumers);
      const nextCanvasConsumers = projectTextureConsumers(
        canvasConsumers,
        this.removed,
        frame.renderables,
        materialCanvasSources,
      );
      this.canvasFrames = publicationCanvasFrames(nextCanvasConsumers);
      const transformEntities = this.transformEntityColumn();
      const matrices = this.transformMatrixColumn();
      const {
        renderables: _rows,
        dispatch: _dispatch,
        visibilitySnapshots: _visibility,
        featureVisibilitySnapshots: _features,
        hiddenEntityReports: _hidden,
        ...metadata
      } = frame;
      const removedConsumers = new Set([...this.removed, ...this.nextDependencies.keys()]);
      this.updateAssetClosure(removedConsumers, nextFrameDependencies);
      const assetRows = this.closure?.rows() ?? EMPTY_ASSET_ROWS;
      const retired = this.closure?.retired() ?? EMPTY_IDENTITIES;
      const materialProjections = this.collectMaterialProjections(assetRows);
      this.holdMaterials();
      const retiredMaterials = retiredMaterialIds();
      const publishedMaterials = publishedMaterialRows();
      const preparedRows: PreparedAssetRow[] = [];
      const sentAssetRows = this.unpreparedAssetRows(assetRows, preparedRows);
      observation?.fact('preparedAssets', preparedRows.length);
      const upsertColumn = new Uint32Array(
        buffer(0, this.upserts.length * 4),
        0,
        this.upserts.length,
      );
      upsertColumn.set(this.upserts);
      const removedColumn = new Uint32Array(buffer(1, this.removed.size * 4), 0, this.removed.size);
      removedColumn.set([...this.removed]);
      observation?.phase('packet');
      const packet: RenderPublication = {
        ...identity,
        protocol: 3,
        materials: publishedMaterials,
        retiredMaterials,
        revision: revision + 1,
        base: revision,
        baseline: this.baseline,
        time: { ...world.getResource(Time) },
        sampleTimeSeconds,
        temporalReset,
        transparentSort: getTransparentSortConfig(world),
        metadata,
        templates: this.templates,
        videoFrames: this.videoFrames,
        ...(this.canvasFrames.length > 0 ? { canvasFrames: this.canvasFrames } : {}),
        targets: targetSnapshot(),
        targetSources: publicationTargetSources(publishedMaterials),
        features: featureRows,
        assetVersions: this.addedAssetVersions(),
        retiredAssetVersions: this.retiredAssetVersions(),
        programs: [...this.programs.values()],
        upserts: upsertColumn,
        removed: removedColumn,
        transformEntities,
        transforms: matrices,
        retiredJoints: this.retiredJointColumn(),
        ...(preparedRows.length === 0 ? {} : { preparedAssets: preparedRows }),
        assets: sentAssetRows.map(([handle, value, revision]) =>
          this.packetAsset(handle, value, revision, materialProjections),
        ),
        retiredAssets: retired as number[],
        assetPatches: this.assetPatches(),
      };
      observation?.fact('assets', packet.assets.length);
      observation?.fact('templates', this.templates.length);
      observation?.fact('upsertRows', this.upserts.length / 2);
      observation?.phase('candidate');
      this.batch.validate();
      active = true;
      let closed = false;
      return ok({
        packet,
        ...(observation === undefined ? {} : { observation }),
        accept: () => {
          if (closed || disposed || failed)
            throw new RenderPublicationError({ reason: 'revision', subject: 'closed candidate' });
          try {
            observation?.phase('accept');
            this.batch.accept();
            this.assetBatch.accept();
            assetVersions = this.nextAssetVersions;
            commitMaterialProjections(retired, materialProjections);
            this.closure?.commit();
            commitMaterialRecords(publishedMaterials);
            commitEntityMaterials(this.removed);
            for (const row of featureRows) {
              if (row.fullscreen !== undefined)
                publishedFullscreenFeatures.set(row.identity, row.fullscreen);
            }
            for (const key of this.programs.keys()) publishedPrograms.add(key);
            closed = true;
            active = false;
            revision++;
            flights.set(revision, {
              features: featureRows,
              owners: this.featureSources,
              submitted: false,
            });
            storage = spareStorage.pop() ?? Array.from({ length: 5 }, () => new ArrayBuffer(0));
            closeFrames(this.videoFrames, this.canvasFrames);
            videoConsumers = nextVideoConsumers;
            canvasConsumers = nextCanvasConsumers;
            frameDependencies = nextFrameDependencies;
            this.commitMembership(removedConsumers);
            observation?.finish('accepted');
            activeObservation = undefined;
          } catch (cause) {
            failed = true;
            closed = true;
            active = false;
            throw this.acceptanceFailure(cause);
          }
        },
        discard: () => {
          if (closed) return;
          closed = true;
          active = false;
          closeFrames(this.videoFrames, this.canvasFrames);
          observation?.finish('discarded');
          activeObservation = undefined;
        },
      });
    }

    private republishInvalidatedMaterials(): void {
      for (const handle of this.invalidated) {
        for (const { cache, geometry, vertexColor } of caches
          .get(worldRenderResources(world))
          ?.values() ?? []) {
          if (!cache.has(handle)) continue;
          const context =
            capabilities === undefined
              ? undefined
              : renderMaterialContext(capabilities, limits).materialContext;
          const snapshot = resolveMaterialSnapshot(
            handle,
            worldRenderResources(world),
            assets,
            undefined,
            cache,
            context === undefined ? undefined : { ...context, geometry },
            undefined,
            vertexColor,
          );
          const resource = MaterialResource.from(snapshot);
          const id = materialIds.get(resource);
          if (id !== undefined && materialRecords.has(id)) {
            this.publishMaterial(resource);
            this.publishPrograms([snapshot]);
          }
        }
      }
    }

    /** Publish every extracted renderable; returns the unsupported source kind, if any. */
    private addRenderableTemplates(frame: ReturnType<typeof extractFrames>): string | undefined {
      const meshCounts = new Map<number, number>();
      for (const row of frame.renderables)
        if (row.assetHandle !== undefined)
          meshCounts.set(row.assetHandle, (meshCounts.get(row.assetHandle) ?? 0) + 1);
      const byRenderable = new Map<number, RenderPublicationTemplate['dispatch'][number][]>();
      for (const { entityIndex: _entity, renderableIndex, ...dispatch } of frame.dispatch) {
        const rows = byRenderable.get(renderableIndex) ?? [];
        rows.push(dispatch);
        byRenderable.set(renderableIndex, rows);
      }
      for (let i = 0; i < frame.renderables.length; i++) {
        const row = frame.renderables.at(i) as RenderableSnapshot;
        const unsupported = unsupportedRenderableSource(row);
        if (unsupported !== undefined) return unsupported;
        this.addRenderableTemplate(row, byRenderable.get(i) ?? [], meshCounts);
      }
      return undefined;
    }

    private addRenderableTemplate(
      row: RenderableSnapshot,
      dispatch: RenderPublicationTemplate['dispatch'],
      meshCounts: ReadonlyMap<number, number>,
    ): void {
      const {
        worldId: _world,
        entityKey,
        transform,
        material,
        materials,
        materialOverrides,
        ...content
      } = row;
      const materialReferences = materials.map((resource) => this.publishMaterial(resource));
      const overrides = materialOverrides?.map((resource) =>
        resource === undefined ? 0 : this.publishMaterial(resource),
      );
      nextMaterialDependencies.set(entityKey, [
        ...materialReferences,
        ...(overrides ?? []).filter((id) => id !== 0),
      ]);
      const snapshot = {
        ...content,
        material: this.publishMaterial(material),
        materials: materialReferences,
        ...(overrides === undefined ? {} : { materialOverrides: overrides }),
      };
      const template = { snapshot, dispatch };
      const key = this.templateKey(template, meshCounts);
      let known = key === undefined ? undefined : this.templateIds.get(key);
      if (known === undefined) {
        const index = this.templates.length;
        this.templates.push(template);
        this.publishPrograms(
          [
            ...row.materials,
            ...(materialOverrides ?? []).filter((resource) => resource !== undefined),
          ].map((resource) => resource.snapshot),
        );
        known = { index, dependencies: renderableAssetRoots(row) };
        if (key !== undefined) this.templateIds.set(key, known);
      }
      this.upserts.push(entityKey, known.index);
      this.matrixRows.set(entityKey, transform.world);
      this.nextDependencies.set(entityKey, known.dependencies);
    }

    /** Shared-template identity, or undefined for payloads only one entity can own. */
    private templateKey(
      template: RenderPublicationTemplate,
      meshCounts: ReadonlyMap<number, number>,
    ): string | undefined {
      const snapshot = template.snapshot;
      // These payloads already contain the source entity identity. They
      // cannot share a template, regardless of equal pose/instance bytes.
      const entityOwned =
        snapshot.instances !== undefined ||
        snapshot.spriteInstances !== undefined ||
        snapshot.skinBinding !== undefined ||
        snapshot.pointsLines !== undefined;
      if (
        entityOwned ||
        (snapshot.assetHandle !== undefined && meshCounts.get(snapshot.assetHandle) === 1)
      )
        return undefined;
      return JSON.stringify(
        {
          snapshot: {
            ...snapshot,
            material: snapshot.material,
            materials: snapshot.materials,
          },
          dispatch: template.dispatch,
        },
        this.keyValue,
      );
    }

    private extractFeatureRows(
      frame: ReturnType<typeof extractFrames>,
    ): RenderPublication['features'] {
      return this.featureSources.map((feature) => {
        const data = feature.extract(this.featureExtractContext(frame)).unwrap();
        const fullscreen = fullscreenRenderFeatureDeclaration(feature);
        return {
          identity: feature.identity,
          data,
          ...(fullscreen === undefined ||
          publishedFullscreenFeatures.get(feature.identity) === fullscreen
            ? {}
            : { fullscreen }),
        };
      });
    }

    private featureExtractContext(
      frame: ReturnType<typeof extractFrames>,
    ): RenderFeatureExtractContext {
      return {
        worlds: [world],
        owner: 0,
        frameNumber: revision + 1,
        ...(capabilities === undefined
          ? {}
          : {
              caps: capabilities,
              ...(limits === undefined ? {} : { limits }),
              ...renderMaterialContext(capabilities, limits),
            }),
        views: frame.cameras
          .filter((camera) => camera.view?.enabled !== false)
          .flatMap(stereoEyeCameras)
          .map((camera) => ({
            ...renderFeatureCameraView(camera),
            ...(frame.cloudLayer === undefined ? {} : { frame: { cloudLayer: frame.cloudLayer } }),
          })),
        visibilitySnapshots: frame.featureVisibilitySnapshots,
        referenceAssetVersion: (sourceWorldIndex, version) => {
          if (sourceWorldIndex !== 0) throw new TypeError('fixed asset source World mismatch');
          const key = `${version.handle}:${version.revision}`;
          const prior = this.nextAssetVersions.get(key) ?? assetVersions.get(key);
          this.nextAssetVersions.set(key, prior ?? version);
        },
        referenceAsset: (sourceWorldIndex, identity, captured) =>
          sourceWorldIndex === 0 ? currentFeatureAsset(identity, captured) : undefined,
      };
    }

    private collectFrameDependencies(
      frame: ReturnType<typeof extractFrames>,
      featureRows: RenderPublication['features'],
    ): Set<number> {
      const nextFrameDependencies = new Set(publicationFrameDependencies(frame));
      for (const feature of this.featureSources) {
        const row = featureRows.find((row) => row.identity === feature.identity);
        if (row === undefined) continue;
        for (const identity of feature.assetDependencies?.(row.data) ?? []) {
          const handle =
            typeof identity === 'string' ? runtimeAssetReference(assets, identity) : identity;
          if (handle === undefined || !assets.validate(handle).ok)
            throw new Error(`Missing feature asset ${identity}`);
          // The accepted runtime record holds its complete dependency closure.
          // Publication residency acquires it once; source Catalog rows are not
          // another dependency or current-content authority.
          nextFrameDependencies.add(handle);
        }
      }
      return nextFrameDependencies;
    }

    // Reference changes are static Binding edits, never a joint-to-consumer fanout.
    private prepareJointUpdates(frame: ReturnType<typeof extractFrames>): void {
      let referenceEdits: Map<number, readonly number[] | undefined> | undefined;
      for (const entity of this.removed)
        if (skinJoints.hasBinding(entity)) {
          referenceEdits ??= new Map();
          referenceEdits.set(entity, undefined);
        }
      for (const row of frame.renderables)
        if (row.skinBinding !== undefined || skinJoints.hasBinding(row.entityKey)) {
          referenceEdits ??= new Map();
          referenceEdits.set(row.entityKey, row.skinBinding?.joints);
        }
      const references =
        referenceEdits === undefined ? undefined : skinJoints.prepare(referenceEdits);
      this.references = references;
      const jointChanges =
        skinJoints.changes.size > 0 || (references?.first.size ?? 0) > 0
          ? new Set(skinJoints.changes)
          : undefined;
      for (const joint of references?.first ?? EMPTY_IDENTITIES) jointChanges?.add(joint);
      this.jointChanges = jointChanges;
      this.retiredJoints =
        (references?.retired.size ?? 0) > 0 ? new Set(references?.retired) : undefined;
      for (const joint of jointChanges ?? EMPTY_IDENTITIES) this.updateJointMatrix(joint);
      this.observation?.fact('jointUpdates', jointChanges?.size ?? 0);
      this.observation?.fact('retiredJoints', this.retiredJoints?.size ?? 0);
    }

    private updateJointMatrix(joint: number): void {
      if (!(this.references?.has(joint) ?? skinJoints.has(joint))) return;
      const matrix =
        this.matrixRows.get(joint) ?? readPresentationWorldMatrix(world, joint as EntityHandle);
      if (matrix === undefined) {
        this.retiredJoints ??= new Set();
        this.retiredJoints.add(joint);
      } else this.matrixRows.set(joint, matrix);
    }

    private transformEntityColumn(): Uint32Array {
      const column = new Uint32Array(buffer(2, this.matrixRows.size * 4), 0, this.matrixRows.size);
      let index = 0;
      for (const entity of this.matrixRows.keys()) column[index++] = entity;
      return column;
    }

    private transformMatrixColumn(): Float32Array {
      const column = new Float32Array(
        buffer(3, this.matrixRows.size * 64),
        0,
        this.matrixRows.size * 16,
      );
      let index = 0;
      for (const matrix of this.matrixRows.values()) column.set(matrix, 16 * index++);
      return column;
    }

    private retiredJointColumn(): Uint32Array {
      const count = this.retiredJoints?.size ?? 0;
      const column = new Uint32Array(buffer(4, count * 4), 0, count);
      let index = 0;
      for (const joint of this.retiredJoints ?? EMPTY_IDENTITIES) column[index++] = joint;
      return column;
    }

    // New holds precede old releases so a rebinding keeps shared closure members resident.
    private updateAssetClosure(
      removedConsumers: ReadonlySet<number>,
      nextFrameDependencies: ReadonlySet<number>,
    ): void {
      for (const handles of this.nextDependencies.values())
        for (const handle of handles) this.publicationClosure().acquire(handle);
      for (const entity of removedConsumers)
        for (const handle of dependencies.get(entity) ?? [])
          this.publicationClosure().release(handle);
      for (const handle of nextFrameDependencies)
        if (!frameDependencies.has(handle)) this.publicationClosure().acquire(handle);
      for (const handle of frameDependencies)
        if (!nextFrameDependencies.has(handle)) this.publicationClosure().release(handle);
      for (const change of this.assetBatch.changes)
        if (!change.removed) this.publicationClosure().update(change.handle, change);
    }

    // New dependency materials need their immutable program closure even
    // when a Mesh or Terrain edit produces no entity upsert.
    private collectMaterialProjections(
      assetRows: readonly (readonly [number, Asset, number])[],
    ): Map<number, ReturnType<AssetRegistry['getMaterialProjectionForPayload']>> {
      const materialProjections = new Map<
        number,
        ReturnType<AssetRegistry['getMaterialProjectionForPayload']>
      >();
      for (const [handle, value] of assetRows) {
        if (value.kind !== 'material') continue;
        const material = runtimeAssets(world.assets).resolveAsset(handle).unwrap();
        const projection =
          material.kind === 'material'
            ? assets.getMaterialProjectionForPayload(material)
            : undefined;
        materialProjections.set(handle, projection);
        if (projection !== undefined) {
          for (const pass of projection.passes)
            for (const program of pass.programs) this.publishProgram(program.specializationKey);
        } else {
          this.publishPrograms([
            resolveMaterialSnapshot(
              handle,
              worldRenderResources(world),
              assets,
              undefined,
              undefined,
              capabilities === undefined
                ? undefined
                : renderMaterialContext(capabilities, limits).materialContext,
            ),
          ]);
        }
      }
      return materialProjections;
    }

    private holdMaterials(): void {
      for (const ids of nextMaterialDependencies.values())
        for (const id of ids) holdMaterial(id, 1);
      for (const entity of new Set([...this.removed, ...nextMaterialDependencies.keys()]))
        for (const id of materialsByEntity.get(entity) ?? []) holdMaterial(id, -1);
    }

    private addedAssetVersions(): NonNullable<RenderPublication['assetVersions']> {
      return [...this.nextAssetVersions].flatMap(([key, version]) =>
        assetVersions.has(key) ? [] : [{ ...version, value: structuredClone(version.value) }],
      );
    }

    private retiredAssetVersions(): NonNullable<RenderPublication['retiredAssetVersions']> {
      return [...assetVersions].flatMap(([key, { handle, revision }]) =>
        this.nextAssetVersions.has(key) ? [] : [{ handle, revision }],
      );
    }

    /**
     * A mesh revision the receiver already holds from a ready preparation
     * crosses once: send its identity, not a second cloned payload.
     */
    private unpreparedAssetRows(
      assetRows: Iterable<readonly [number, Asset, number]>,
      preparedRows: PreparedAssetRow[],
    ): (readonly [number, Asset, number])[] {
      if (preparedMesh === undefined) return [...assetRows];
      return [...assetRows].filter(([handle, value, revision]) => {
        if (value.kind !== 'mesh' || !preparedMesh(handle as number, revision)) return true;
        const guid = runtimeAssetSource(assets, handle);
        const sourceKey = guid === undefined ? undefined : assets.sourceKeyOf(guid);
        preparedRows.push({
          handle: handle as number,
          revision,
          ...(guid === undefined ? {} : { guid }),
          ...(sourceKey === undefined ? {} : { sourceKey }),
        });
        return false;
      });
    }

    private assetPatches(): NonNullable<RenderPublication['assetPatches']> {
      return this.closure?.patches() ?? [];
    }

    private packetAsset(
      handle: number,
      value: Asset,
      assetRevision: number,
      materialProjections: ReadonlyMap<
        number,
        ReturnType<AssetRegistry['getMaterialProjectionForPayload']>
      >,
    ): RenderPublication['assets'][number] {
      // Runtime content is a projection, so GUID identity stays with the
      // underlying catalogued payload rather than the projected object.
      const guid = runtimeAssetSource(assets, handle);
      const sourceKey = guid === undefined ? undefined : assets.sourceKeyOf(guid);
      const isMesh = value.kind === 'mesh';
      if (isMesh) this.observation?.phase('clone');
      const packetValue = structuredClone(value);
      if (isMesh) {
        this.observation?.phase('packet');
        this.observation?.mesh(handle, guid === undefined, packetValue);
      }
      return {
        handle: handle as number,
        revision: assetRevision,
        // Assets stay with their source owner. An admitted mesh owns a
        // detached packet copy so its large buffers can move to Render
        // without another receiver-side structured-clone allocation.
        value: packetValue,
        ...(value.kind !== 'material' ||
        (publishedMaterialProjections.has(handle) &&
          publishedMaterialProjections.get(handle) === materialProjections.get(handle))
          ? {}
          : {
              materialProjection: detachMaterialProjection(materialProjections.get(handle)),
            }),
        ...(guid === undefined ? {} : { guid }),
        ...(sourceKey === undefined ? {} : { sourceKey }),
      };
    }

    private commitMembership(removedConsumers: ReadonlySet<number>): void {
      for (const entity of removedConsumers) dependencies.delete(entity);
      this.references?.commit();
      if (this.jointChanges !== undefined) skinJoints.acknowledged(this.jointChanges);
      for (const entity of this.removed) members.delete(entity);
      for (const [entity, handles] of this.nextDependencies) {
        members.add(entity);
        dependencies.set(entity, handles);
      }
      for (const entity of this.matrixRows.keys()) pending.delete(entity);
      for (const entity of this.removed) pending.delete(entity);
      acceptRenderSourceEntities(source, this.batch.indices, this.sourceRows);
    }

    private acceptanceFailure(cause: unknown): AggregateError {
      const errors = [cause];
      for (const row of this.videoFrames) {
        try {
          row.frame.close();
        } catch (cleanup) {
          errors.push(cleanup);
        }
      }
      for (const row of this.canvasFrames) {
        try {
          row.frame?.close();
        } catch (cleanup) {
          errors.push(cleanup);
        }
      }
      this.observation?.finish('prepare-error');
      activeObservation = undefined;
      return new AggregateError(
        errors,
        'Render publication acceptance failed; start a new source epoch',
        { cause },
      );
    }
  }

  const holdMaterial = (id: number, delta: number) =>
    materialHolds.set(id, (materialHolds.get(id) ?? materialRecords.get(id)?.holds ?? 0) + delta);
  const retiredMaterialIds = (): readonly number[] =>
    materialHolds.size === 0
      ? EMPTY_IDENTITIES
      : [...materialHolds].flatMap(([id, count]) => (count === 0 ? [id] : []));
  const publishedMaterialRows = (): RenderPublication['materials'] =>
    materialRows.size === 0
      ? EMPTY_MATERIAL_ROWS
      : [...materialRows]
          .filter(([id]) => (materialHolds.get(id) ?? materialRecords.get(id)?.holds ?? 0) > 0)
          .map(([id, value]) => ({ id, value }));
  const targetSnapshot = (): RenderPublication['targets'] => targetOwner?.snapshot() ?? [];
  const currentFeatureAsset = (identity: string | number, captured: Asset): number | undefined => {
    const handle =
      typeof identity === 'string'
        ? resolveRuntimeAssetReference(
            worldRenderResources(world),
            identity,
            publicationAssetBrand(captured),
          )
        : identity;
    if (handle === undefined) return undefined;
    const current = runtimeAssets(world.assets).resolveAsset(handle);
    return current.ok && current.value === captured ? handle : undefined;
  };
  const commitMaterialProjections = (
    retired: readonly number[],
    materialProjections: ReadonlyMap<
      number,
      ReturnType<AssetRegistry['getMaterialProjectionForPayload']>
    >,
  ): void => {
    for (const handle of retired) publishedMaterialProjections.delete(handle);
    for (const [handle, projection] of materialProjections)
      publishedMaterialProjections.set(handle, projection);
  };
  const commitMaterialRecords = (publishedMaterials: RenderPublication['materials']): void => {
    for (const [id, holds] of materialHolds) {
      const resource = materialSources.get(id) ?? materialRecords.get(id)?.resource;
      if (holds === 0) materialRecords.delete(id);
      else if (resource !== undefined)
        materialRecords.set(id, { resource, holds, snapshot: resource.snapshot });
    }
    for (const { id, value } of publishedMaterials) {
      const previous = materialRecords.get(id);
      if (previous !== undefined) materialRecords.set(id, { ...previous, snapshot: value });
    }
  };
  const commitEntityMaterials = (removed: ReadonlySet<number>): void => {
    for (const entity of removed) materialsByEntity.delete(entity);
    for (const [entity, ids] of nextMaterialDependencies) materialsByEntity.set(entity, ids);
  };

  return {
    identity,
    /** A successful candidate preparation ACK proves these programs reached this receiver. */
    acknowledgePrograms,
    unpublishedPrograms: (programs: RenderPublication['programs']) =>
      programs.filter((program) => !publishedPrograms.has(program.key)),
    inspect: () => ({
      revision,
      failed,
      members: members.size,
      assetCount: assetClosure.size,
      scannedRows: lastScannedRows,
      inFlight: flights.size > 0,
      inFlightCount: flights.size,
      allocations,
    }),
    prepare(
      sampleTimeSeconds: number,
      temporalReset = false,
      execution?: { readonly frameId: number },
    ): Result<RenderPublicationCandidate, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      if (active || flights.size >= maxInFlight)
        return fail('in-flight', 'publication slots are occupied');
      materialRows.clear();
      materialSources.clear();
      nextMaterialDependencies.clear();
      materialHolds.clear();
      const baseline = revision === 0;
      const observation = beginSourcePreparation(
        world,
        identity.source,
        identity.epoch,
        revision + 1,
        execution?.frameId,
        baseline,
      );
      activeObservation = observation;
      const preparation = new PublicationPreparation(baseline, observation);
      try {
        return preparation.prepare(sampleTimeSeconds, temporalReset);
      } catch (cause) {
        observation?.finish('prepare-error');
        activeObservation = undefined;
        closeFrames(preparation.videoFrames, preparation.canvasFrames);
        return fail('unsupported', cause instanceof Error ? cause.message : String(cause));
      }
    },
    acknowledgeFeatures(
      acceptedRevision: number,
      receipts: readonly { readonly identity: string; readonly feedback: unknown }[],
    ): Result<void, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      const flight = flights.get(acceptedRevision);
      if (flight === undefined || flight.submitted)
        return fail('revision', 'feature acknowledgment');
      const identities = new Set<string>();
      for (const receipt of receipts) {
        if (identities.has(receipt.identity))
          return fail('revision', 'duplicate feature acknowledgment');
        const row = flight.features.find((row) => row.identity === receipt.identity);
        const feature = flight.owners.find((feature) => feature.identity === receipt.identity);
        if (row === undefined || feature === undefined)
          return fail('shape', 'unknown feature acknowledgment');
        identities.add(receipt.identity);
      }
      flight.submitted = true;
      for (const receipt of receipts) {
        const row = flight.features.find((row) => row.identity === receipt.identity);
        const feature = flight.owners.find((feature) => feature.identity === receipt.identity);
        feature?.onSourceFrameSubmitted?.(row?.data, receipt.feedback);
      }
      return ok(undefined);
    },
    recycle(
      acceptedRevision: number,
      buffers: readonly ArrayBuffer[],
    ): Result<void, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      if (flights.keys().next().value !== acceptedRevision)
        return fail('revision', 'returned storage revision');
      if (buffers.length !== 5 || buffers.some((value) => !(value instanceof ArrayBuffer)))
        return fail('shape', 'returned storage');
      if (active || storage.some((buffer) => buffer.byteLength > 0))
        spareStorage.push([...buffers]);
      else storage = [...buffers];
      flights.delete(acceptedRevision);
      return ok(undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeObservation?.finish('retired');
      activeObservation = undefined;
      releaseTransforms();
      members.clear();
      dependencies.clear();
      assetObserver.dispose();
      assetClosure.clear();
      assetVersions.clear();
      publishedMaterialProjections.clear();
      materialRecords.clear();
      materialsByEntity.clear();
      pending.clear();
      videoConsumers.clear();
      canvasConsumers.clear();
      flights.clear();
      spareStorage.length = 0;
      frameDependencies.clear();
      skinJoints.clear();
    },
  };
}
