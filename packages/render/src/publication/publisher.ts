import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  runtimeAssetReference,
  runtimeAssetSource,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import { type EntityHandle, Time, type World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { readPresentationWorldMatrix } from '@forgeax/engine-scene';
import { type Asset, err, ok, type Result } from '@forgeax/engine-types';
import { planarCaptureDemanded } from '../capture/planar-material';
import { MeshFilter } from '../components/mesh-filter';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { EnvironmentFrameGate } from '../extract/environment-frame-gate';
import { renderMaterialContext } from '../extract/material-context';
import { withBuiltinRenderFeatures } from '../features/builtins';
import { isRenderFeatureTextureSource } from '../features/feature-texture-source';
import { fullscreenRenderFeatureDeclaration } from '../features/fullscreen';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';
import {
  captureRenderFeatureSource,
  renderFeatureSourceContext,
  renderFeatureSourceFailure,
} from '../features/source';
import type {
  RenderFeature,
  RenderFeatureCompletion,
  RenderFeatureExtractContext,
  RenderFeatureSubmission,
} from '../features/types';
import { MaterialResource, materialResource } from '../material-resource';
import { materialSourceReferences } from '../material-source';
import type { FeatureTextureReadbackResult } from '../render-contract';
import {
  createWorldInternalView,
  type DispatchEntry,
  type MaterialSnapshot,
  type MaterialSnapshotContexts,
  type RenderableSnapshot,
  resolveMaterialSnapshot,
  resolveRuntimeAssetReference,
  Severity,
  type WaterMeshSourceState,
  type WaterMeshViewFacts,
} from '../render-system-extract';
import { extractSource } from '../render-system-extract-tail';
import { CapturedSceneTransform } from '../scene/captured-transform';
import {
  createGlobalTransformChangeQuery,
  createRenderSourceState,
  isRenderableMember,
  type RenderSourceChanges,
  readRenderSourceChanges,
} from '../scene/render-source';
import { registerRenderSourceSystems } from '../scene/source-systems';
import { captureSurfaceDynamicInput, surfaceDynamicInputOf } from '../surface/frame-source';
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
  type RenderPublicationMetadata,
  type RenderPublicationTemplate,
} from './contract';
import {
  PublishedAssetConsumers,
  publicationFrameDependencies,
  renderableAssetRoots,
} from './dependencies';
import { DrawParameterPublisher, drawParameterComponent } from './draw-parameters';
import { MAX_RENDER_FRAMES_IN_FLIGHT } from './frame-limits';
import { EntityMaterialLists } from './material-lists';
import { PublishedMaterialProjections, ReceivingMaterialProjections } from './material-projections';
import { beginSourcePreparation, type SourcePreparationObservation } from './observation';
import { capturePublicationProgram, publicationMaterialProgramKeys } from './programs';
import {
  encodeRenderPublication,
  type RenderPublicationMessage,
  renderPublicationRecordBytes,
  renderPublicationRecordColumns,
} from './record';
import { renderableTemplateSnapshot } from './renderable-template';
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
/** Distinct shareable contents compared per mesh/material tuple before keying. */
const TEMPLATE_BUCKET_LIMIT = 4;
/** Array elements never name a special publication field. */
const ARRAY_FIELD = '0';
const EMPTY_MATERIAL_RESOURCES: readonly (MaterialResource | undefined)[] = Object.freeze([]);
/** Column capacity above this floor shrinks once demand falls below 1/ratio of it. */
const STORAGE_SHRINK_FLOOR = 64 * 1024;
const STORAGE_SHRINK_RATIO = 8;

export interface SourceFeatureAcknowledgment {
  readonly identity: string;
  readonly feedback: unknown;
  readonly submission?: RenderFeatureSubmission | undefined;
}
type SourceFeatureFlight = {
  readonly features: RenderPublication['features'];
  readonly owners: readonly RenderFeature<unknown>[];
} & (
  | { readonly phase: 'accepted' }
  | { readonly phase: 'submitted'; readonly receipts: readonly SourceFeatureAcknowledgment[] }
  | { readonly phase: 'completed' }
);

function publicationKeyValue(key: string, value: unknown): unknown {
  return value instanceof Map
    ? key === 'textureSources'
      ? [...value].map(([name, source]) => [
          name,
          isRenderFeatureTextureSource(source) || isCanvasTextureSource(source)
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

/** One renderable's dispatch entries: `order[start..end)` indexes `entries`. */
interface RowDispatch {
  readonly entries: readonly DispatchEntry[];
  readonly order: Int32Array;
  readonly start: number;
  readonly end: number;
}

function strippedDispatch(dispatch: RowDispatch): RenderPublicationTemplate['dispatch'] {
  const rows: RenderPublicationTemplate['dispatch'][number][] = [];
  for (let index = dispatch.start; index < dispatch.end; index++) {
    const {
      entityIndex: _entity,
      renderableIndex: _renderable,
      ...entry
    } = dispatch.entries[dispatch.order[index] as number] as DispatchEntry;
    rows.push(entry);
  }
  return rows;
}

interface MaterialReferences {
  readonly source: MaterialResource;
  readonly sources: readonly MaterialResource[];
  readonly overrideSources: readonly (MaterialResource | undefined)[] | undefined;
  readonly material: number;
  readonly materials: readonly number[];
  readonly overrides: readonly number[] | undefined;
  readonly dependencies: readonly number[];
  /** Bucket key part naming the material tuple. */
  readonly key: string;
}

/** Cold per-preparation facts, admitted only when a row needs template construction. */
function createTemplateWorkspace() {
  return {
    valueIds: new Map<object, number>(),
    tokens: new Map<object, { readonly field: string; readonly token: string }>(),
    structuralIds: new Map<string, number>(),
    templateBuckets: new Map<string, { index: number; dependencies: readonly number[] }[]>(),
    values: new Map<string, number>(),
    templateIds: new Map<string, { index: number; dependencies: readonly number[] }>(),
  };
}

function sameList(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function hasExternalTextureSource(material: MaterialResource | undefined): boolean {
  const sources = material?.snapshot.textureSources;
  if (sources === undefined) return false;
  for (const source of sources.values()) if (isExternalTextureSource(source)) return true;
  return false;
}

/** The source kind a publication packet cannot carry for this renderable, if any. */
function unsupportedRenderableSource(
  row: RenderableSnapshot,
  checked: Set<MaterialResource>,
): string | undefined {
  if ('skin' in row && row.skin !== undefined) return 'source GPU skin receipt';
  for (const list of [row.materials, row.materialOverrides ?? EMPTY_MATERIAL_RESOURCES])
    for (const material of list) {
      if (material === undefined || checked.has(material)) continue;
      if (hasExternalTextureSource(material)) return 'renderer-local external texture source';
      checked.add(material);
    }
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
  /** Source-side contents; diagnostics and tests read it, it never crosses a realm. */
  readonly packet: RenderPublication;
  /** The only form a Worker transfers and a Renderer draws. */
  readonly message: RenderPublicationMessage;
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
  /**
   * True while a dynamic geometry preparation still uploads this mesh handle.
   * A new, self-hidden renderable that draws such a mesh waits for it, so its
   * payload crosses once through the preparation instead of a second clone.
   */
  preparingMesh?: (handle: number) => boolean,
  /** These newly materialized renderables are owned by the closed Level lane. */
  ownsClosedLevelRow?: (entity: number) => boolean,
) {
  world.bindAssets(assets).unwrap();
  const assetObserver = assets.observe().unwrap();
  const sourceRecords = runtimeAssets(world.assets);
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
  const materialsByEntity = new EntityMaterialLists();
  const materialRows = new Map<number, MaterialSnapshot>();
  const materialSources = new Map<number, MaterialResource>();
  const nextMaterialDependencies = new Map<number, readonly number[]>();
  const materialHolds = new Map<number, number>();
  let nextMaterialId = 1;
  if (maxInFlight !== 2 && maxInFlight !== 3 && maxInFlight !== MAX_RENDER_FRAMES_IN_FLIGHT)
    throw new RenderPublicationError({ reason: 'shape', subject: 'publication capacity' });
  let activeObservation: SourcePreparationObservation | undefined;
  const publishedFullscreenFeatures = new Map<string, object>();
  const releaseTransforms = registerRenderSourceSystems(world);
  const source = createRenderSourceState(world);
  const transforms = createGlobalTransformChangeQuery(world);
  const caches: MaterialSnapshotContexts = new Map();
  const changedMaterialSources = new Set<number>();
  // A capture demand flip re-routes cached planar receivers.
  let planarDemand: boolean | undefined;
  const members = new Set<number>();
  let drawParameterSource: DrawParameterPublisher | undefined;
  const acceptedWaterMeshOwners = new Set<number>();
  let acceptedWaterMeshSourceState: WaterMeshSourceState | undefined;
  const publishedPrograms = new Set<string>();
  const publishedMaterialProjections = new PublishedMaterialProjections();
  const receivingMaterialProjections = new ReceivingMaterialProjections();
  // An accepted projection is an immutable program contract: a reload installs
  // a new object, which is also what the residency identity compares. One
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
  const dependencies = new PublishedAssetConsumers();
  const pending = new Set<number>();
  let canvasConsumers = new Map<number, readonly CanvasTextureSource[]>();
  let videoConsumers = new Map<number, readonly number[]>();
  // One consuming frame and a bounded number of sealed successors.
  const flights = new Map<number, SourceFeatureFlight>();
  const skinJoints = new SkinJointReferences();
  let frameDependencies = new Set<number>();
  let revision = 0,
    disposed = false,
    failed = false;
  const builtinFeatureSources = withBuiltinRenderFeatures(features, capabilities).map(
    (feature) => feature.source ?? feature,
  );
  let preparationPhase: 'idle' | 'preparing' | 'candidate' | 'settling' = 'idle';
  const phaseIs = (phase: typeof preparationPhase): boolean => preparationPhase === phase;
  let lastScannedRows = 0,
    allocations = 0;
  // One record per publication slot: it crosses with its publication and
  // returns with the frame completion, so slots never allocate in steady state.
  let storage: ArrayBuffer | undefined;
  const spareStorage: ArrayBuffer[] = [];
  let discardStorageThrough = 0;
  // Metadata of the last accepted publication; the next message omits unchanged entries.
  let acceptedMetadata: RenderPublicationMetadata | undefined;
  // Camera, light and environment entries re-extract only when their inputs change.
  const environmentGate = new EnvironmentFrameGate();
  const record = (bytes: number): ArrayBuffer => {
    let value = storage;
    // A baseline-sized record must not keep crossing the Worker boundary: every
    // transfer re-registers its full capacity as external memory in both
    // realms, and that pressure forces whole-heap GC proportional to N.
    const oversized =
      value !== undefined &&
      value.byteLength > STORAGE_SHRINK_FLOOR &&
      value.byteLength > bytes * STORAGE_SHRINK_RATIO;
    if (value === undefined || value.byteLength < bytes || oversized) {
      let capacity = oversized ? 256 : Math.max(256, value?.byteLength ?? 0);
      while (capacity < bytes) capacity *= 2;
      value = new ArrayBuffer(capacity);
      allocations++;
    }
    storage = value;
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
    readonly featureSources = withBuiltinRenderFeatures(features, capabilities).map((feature) => {
      if (features.some((requested) => requested.identity === feature.identity))
        return feature.source ?? feature;
      return (
        builtinFeatureSources.find((builtin) => builtin.identity === feature.identity) ?? feature
      );
    });
    readonly sourceChanges: RenderSourceChanges;
    get batch() {
      return this.sourceChanges.batch;
    }
    readonly changed: Set<number>;
    readonly removed = new Set<number>();
    readonly invalidated = new Set<number>();
    readonly assetBatch: ReturnType<ReturnType<typeof assetObserver.read>['unwrap']>;
    readonly observedAssetRevision: number;
    readonly matrixRows = new Map<number, ArrayLike<number> | CapturedSceneTransform>();
    canvasFrames: readonly PublishedCanvasFrame[] = [];
    videoFrames: RenderPublication['videoFrames'] = [];
    // Dispatch entries share their material's parameter snapshot. Intern
    // both so each pass/entity does not serialize that same payload again.
    // The value table lives only for this preparation.
    private templateWork: ReturnType<typeof createTemplateWorkspace> | undefined;
    private recentReferences: MaterialReferences | undefined;
    private readonly templates: RenderPublicationTemplate[] = [];
    private readonly upserts: number[] = [];
    private nextWaterMeshOwners: Set<number> | undefined;
    private nextWaterMeshSourceState: WaterMeshSourceState | undefined;
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
      this.changed = new Set(pending);
      this.sourceChanges = readRenderSourceChanges(world, source, members, baseline, {
        changed: this.changed,
        content: false,
        removed: this.removed,
        ...(observation === undefined
          ? {}
          : {
              onChanged: (reason, inserted) => observation.count(reason, inserted),
            }),
      });
      const batch = this.batch;
      lastScannedRows = batch.scannedRows;
      observation?.fact('scannedRows', batch.scannedRows);
      observation?.fact('batchIndices', batch.indices.length);
      observation?.fact('changedComponentKinds', batch.changedComponents.length);
      observation?.fact('membershipChanged', batch.membershipChanged);
      observation?.fact('pending', pending.size);
      this.assetBatch = assetObserver.read().unwrap();
      this.observedAssetRevision = sourceRecords.currentRevision;
      observation?.fact('assetChanges', this.assetBatch.changes.length);
      for (const change of this.assetBatch.changes)
        if (!change.removed) this.invalidated.add(change.handle as unknown as number);
      this.collectSourceChanges();
      if (baseline) this.addBaselineMembers();
      this.excludeClosedLevelRows();
      this.collectTransformRows();
      observation?.fact('changed', this.changed.size);
      observation?.fact('removed', this.removed.size);
      observation?.fact('invalidated', this.invalidated.size);
      observation?.fact('matrixRows', this.matrixRows.size);
      for (const entity of this.changed) pending.add(entity);
    }

    private excludeClosedLevelRows(): void {
      if (ownsClosedLevelRow === undefined) return;
      for (const entity of this.changed) {
        if (!ownsClosedLevelRow(entity)) continue;
        if (members.has(entity))
          throw new Error('A closed Level cannot claim an already published renderable');
        this.changed.delete(entity);
        pending.delete(entity);
      }
    }

    private templateWorkspace(): ReturnType<typeof createTemplateWorkspace> {
      this.templateWork ??= createTemplateWorkspace();
      return this.templateWork;
    }

    private collectSourceChanges(): void {
      const changes = this.sourceChanges.changes;
      for (const entity of changes.retiredTransforms)
        if (skinJoints.has(entity)) skinJoints.mark(entity);
      if (this.observation !== undefined)
        for (let index = 0; index < changes.meshFilterWrites; index++)
          this.observation.count('mesh-filter-write');
    }

    private addBaselineMembers(): void {
      for (const entity of members) this.changed.add(entity);
      for (const { entity } of source.entities.values())
        if (isRenderableMember(world, entity))
          addChanged(this.changed, entity, this.observation, 'catalog-source');
    }

    private collectTransformRows(): void {
      transforms.forEach((row) => {
        const entity = row.entity;
        skinJoints.mark(entity);
        if (members.has(entity) && !this.removed.has(entity)) {
          const matrix = readPresentationWorldMatrix(world, entity);
          if (matrix !== undefined) this.matrixRows.set(entity, matrix);
          pending.add(entity);
        }
      });
    }

    private readonly keyValue = (key: string, value: unknown): unknown =>
      key === 'paramSnapshot' && value !== null && typeof value === 'object'
        ? this.valueId(value, true)
        : publicationKeyValue(key, value);

    private valueId(object: object, parameters = false): number {
      const cached = this.templateWorkspace().valueIds.get(object);
      if (cached !== undefined) return cached;
      const value = JSON.stringify(object, parameters ? publicationKeyValue : this.keyValue);
      let id = this.templateWorkspace().values.get(value);
      if (id === undefined) {
        id = this.templateWorkspace().values.size;
        this.templateWorkspace().values.set(value, id);
      }
      this.templateWorkspace().valueIds.set(object, id);
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
      const row = capturePublicationProgram(assets, key);
      this.programs.set(key, row);
      for (const reference of row.shader.variantReferences ?? [])
        this.publishProgram(reference.identifier);
    }

    /**
     * Changed entities minus new, self-hidden renderables whose mesh is still
     * being prepared. Those stay pending and publish once the receiver holds the
     * prepared payload (or the preparation ends), never as a hidden clone first.
     */
    private withoutPreparingRenderables(): Set<number> {
      if (preparingMesh === undefined || this.changed.size === 0) return this.changed;
      let kept: Set<number> | undefined;
      for (const entity of this.changed) {
        if (!this.waitsForPreparation(entity)) continue;
        kept ??= new Set(this.changed);
        kept.delete(entity);
      }
      if (kept !== undefined)
        this.observation?.fact('preparingRenderables', this.changed.size - kept.size);
      return kept ?? this.changed;
    }

    private waitsForPreparation(entity: number): boolean {
      if (members.has(entity) || preparingMesh === undefined) return false;
      const handle = entity as EntityHandle;
      if (!world.hasComponent(handle, MeshFilter) || !world.hasComponent(handle, Visibility))
        return false;
      if (world.get(handle, Visibility).unwrap().state !== VisibilityStateValue.hidden)
        return false;
      const mesh = world.get(handle, MeshFilter).unwrap().assetHandle as number | undefined;
      return mesh !== undefined && preparingMesh(mesh);
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
      waterMeshViewFacts?: WaterMeshViewFacts,
    ): Result<RenderPublicationCandidate, RenderPublicationError> {
      const observation = this.observation;
      observation?.phase('extract');
      const extracted = new Set(this.withoutPreparingRenderables());
      for (const entity of this.removed)
        if (acceptedWaterMeshOwners.has(entity)) extracted.add(entity);
      changedMaterialSources.clear();
      const resources = worldRenderResources(world);
      for (const { cache } of caches.values())
        cache.collectSourceChanges(
          resources,
          this.assetBatch.changes,
          changedMaterialSources,
          'source',
        );
      for (const handle of changedMaterialSources) dependencies.collect(handle, extracted);
      changedMaterialSources.clear();
      if (acceptedWaterMeshOwners.size !== 0)
        for (const handle of this.invalidated)
          dependencies.collect(handle, extracted, acceptedWaterMeshOwners);
      environmentGate.assetsChanged = this.baseline || this.assetBatch.changes.length > 0;
      const frame = extractSource(world, assets, caches, {
        ...(capabilities === undefined ? {} : renderMaterialContext(capabilities, limits)),
        cull: 'none',
        retainHidden: true,
        renderables: extracted.size ? { kind: 'partial', entities: extracted } : 'none',
        ...(acceptedWaterMeshSourceState === undefined
          ? {}
          : { waterMeshSourceState: acceptedWaterMeshSourceState }),
        ...(waterMeshViewFacts === undefined ? {} : { waterMeshViewFacts }),
        environmentGate,
      });
      const waterRefresh = frame.waterMeshOwnerRefreshes?.find((refresh) => refresh.worldId === 0);
      const captureWaterOwnerRefresh = () => {
        if (waterRefresh !== undefined) {
          const currentWaterOwners = new Set(waterRefresh.ownerEntityKeys);
          const ordinaryRenderableEntities = new Set(
            frame.renderables
              .filter((renderable) => renderable.waterMeshSource === undefined)
              .map((renderable) => renderable.entityKey),
          );
          for (const entity of acceptedWaterMeshOwners) {
            if (!currentWaterOwners.has(entity) && !ordinaryRenderableEntities.has(entity))
              this.removed.add(entity);
            else this.removed.delete(entity);
          }
          for (const entity of currentWaterOwners) this.removed.delete(entity);
          this.nextWaterMeshOwners = currentWaterOwners;
          this.nextWaterMeshSourceState = {
            system: waterRefresh.system,
            inputKey: waterRefresh.inputKey,
            ownerEntityKeys: [...currentWaterOwners],
            ownerSources: waterRefresh.ownerSources,
          };
        } else {
          // The unchanged input key includes current WaterBody membership and liveness.
          for (const entity of acceptedWaterMeshOwners) this.removed.delete(entity);
        }
      };
      captureWaterOwnerRefresh();
      observation?.phase('templates');
      observation?.fact('renderables', frame.renderables.length);
      this.invalidatePlanarRouting();
      this.republishInvalidatedMaterials();
      const unsupported = this.addRenderableTemplates(frame);
      if (unsupported !== undefined) return fail('unsupported', unsupported);
      observation?.phase('feature');
      const featureRows = this.extractFeatureRows(frame);
      observation?.phase('packet');
      const nextFrameDependencies = this.collectFrameDependencies(frame, featureRows);
      const emitted = new Set(frame.renderables.map((row) => row.entityKey));
      // An unchanged accepted water owner is intentionally omitted from this delta.
      for (const entity of this.changed)
        if (
          members.has(entity) &&
          !emitted.has(entity) &&
          !(waterRefresh === undefined && acceptedWaterMeshOwners.has(entity))
        )
          this.removed.add(entity);
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
      const {
        renderables: _rows,
        waterMeshOwnerRefreshes: _waterMeshOwnerRefreshes,
        dispatch: _dispatch,
        visibilitySnapshot: _visibility,
        hiddenEntityReports: _hidden,
        ...extractedMetadata
      } = frame;
      const metadata = retainStatistics(extractedMetadata, acceptedMetadata);
      const removedConsumers = new Set([...this.removed, ...this.nextDependencies.keys()]);
      this.updateAssetClosure(removedConsumers, nextFrameDependencies);
      const preparedRows: PreparedAssetRow[] = [];
      const assetRows =
        this.closure?.rows((handle, revision) =>
          this.referencePreparedMesh(handle, revision, preparedRows),
        ) ?? EMPTY_ASSET_ROWS;
      const retired = this.closure?.retired() ?? EMPTY_IDENTITIES;
      const materialProjections = this.collectMaterialProjections(assetRows);
      this.holdMaterials();
      const referencedMaterials = referencedMaterialRows();
      this.referenceMaterialSources(referencedMaterials);
      const retiredMaterials = retiredMaterialIds();
      const publishedMaterials = publishedMaterialRows();
      observation?.fact('preparedAssets', preparedRows.length);
      const columns = this.recordColumns();
      const drawParameters = this.prepareDrawParameters(removedConsumers);
      observation?.phase('packet');
      const surfaceInput = surfaceDynamicInputOf(world);
      const surfaceDynamicInputs =
        surfaceInput === undefined
          ? []
          : [captureSurfaceDynamicInput(surfaceInput, world.identity).unwrap()];
      const packet: RenderPublication = {
        ...identity,
        materials: publishedMaterials.map(({ id, value }) => ({
          id,
          value:
            value.sourceAssets === undefined
              ? value
              : { ...value, sourceAssets: materialSourceReferences(value.sourceAssets) },
        })),
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
        targetSources: publicationTargetSources(referencedMaterials),
        features: featureRows,
        ...(surfaceDynamicInputs.length ? { surfaceDynamicInputs } : {}),
        drawParameters: drawParameters?.packet,
        assetVersions: this.addedAssetVersions(),
        retiredAssetVersions: this.retiredAssetVersions(),
        programs: [...this.programs.values()],
        ...columns,
        ...(preparedRows.length === 0 ? {} : { preparedAssets: preparedRows }),
        assets: assetRows.map(([handle, value, revision]) =>
          this.packetAsset(handle, value, revision, materialProjections, retired),
        ),
        retiredAssets: retired as number[],
        assetPatches: this.assetPatches(),
      };
      observation?.fact('assets', packet.assets.length);
      observation?.fact('templates', this.templates.length);
      observation?.fact('upsertRows', this.upserts.length / 2);
      const message = encodeRenderPublication(packet, acceptedMetadata);
      observation?.phase('candidate');
      this.sourceChanges.validate();
      drawParameters?.validate();
      preparationPhase = 'candidate';
      let closed = false;
      return ok({
        packet,
        message,
        ...(observation === undefined ? {} : { observation }),
        accept: () => {
          if (closed || disposed || failed)
            throw new RenderPublicationError({ reason: 'revision', subject: 'closed candidate' });
          preparationPhase = 'settling';
          try {
            observation?.phase('accept');
            drawParameters?.validate();
            this.sourceChanges.accept();
            drawParameters?.accept();
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
            revision++;
            acceptedMetadata = packet.metadata;
            flights.set(revision, {
              features: featureRows,
              owners: this.featureSources,
              phase: 'accepted',
            });
            storage = spareStorage.pop();
            closeFrames(this.videoFrames, this.canvasFrames);
            videoConsumers = nextVideoConsumers;
            canvasConsumers = nextCanvasConsumers;
            frameDependencies = nextFrameDependencies;
            this.commitMembership();
            if (this.nextWaterMeshOwners !== undefined) {
              acceptedWaterMeshOwners.clear();
              for (const entity of this.nextWaterMeshOwners) acceptedWaterMeshOwners.add(entity);
              acceptedWaterMeshSourceState = this.nextWaterMeshSourceState;
            }
            observation?.finish('accepted');
            activeObservation = undefined;
          } catch (cause) {
            failed = true;
            closed = true;
            throw this.acceptanceFailure(cause);
          } finally {
            preparationPhase = 'idle';
          }
        },
        discard: () => {
          if (closed) return;
          closed = true;
          preparationPhase = 'settling';
          this.sourceChanges.discard();
          try {
            for (const row of featureRows) {
              if (row.failure !== undefined) continue;
              this.featureSources
                .find((feature) => feature.identity === row.identity)
                ?.onSourceFrameDiscarded?.(row.data);
            }
            closeFrames(this.videoFrames, this.canvasFrames);
            observation?.finish('discarded');
          } finally {
            activeObservation = undefined;
            preparationPhase = 'idle';
          }
        },
      });
    }

    private prepareDrawParameters(membershipChanges: ReadonlySet<number>) {
      if (drawParameterSource === undefined) {
        const component = drawParameterComponent(world);
        if (component === undefined) return undefined;
        drawParameterSource = new DrawParameterPublisher(world, component);
      }
      const candidate = drawParameterSource.prepare(
        (entity) =>
          !this.removed.has(entity) && (this.nextDependencies.has(entity) || members.has(entity)),
        membershipChanges,
      );
      this.observation?.fact('drawParameterRows', candidate?.packet?.entities.length ?? 0);
      this.observation?.fact('retiredDrawParameters', candidate?.packet?.removed.length ?? 0);
      return candidate;
    }

    /**
     * Adding or removing a PlanarReflection capture changes no entity or
     * asset, yet planar receivers drop or regain their Deferred pass with it.
     * Republish every cached receiver routed for the other demand.
     */
    private invalidatePlanarRouting(): void {
      const demanded = planarCaptureDemanded(world);
      if (planarDemand === demanded) return;
      planarDemand = demanded;
      for (const { cache } of caches.values())
        cache.collectPlanarChanges(demanded, this.invalidated);
    }

    private republishInvalidatedMaterials(): void {
      // Source extraction can admit new closures or edit assets after the opening observation.
      // Keep the original acceptance cursor so a late publication also reaches the following frame.
      const changes =
        this.observedAssetRevision === sourceRecords.currentRevision
          ? this.assetBatch.changes
          : assetObserver.read().unwrap().changes;
      const resources = worldRenderResources(world);
      for (const { cache } of caches.values())
        cache.collectSourceChanges(resources, changes, this.invalidated, 'all');
      for (const handle of this.invalidated) {
        for (const { cache, geometry, vertexColor } of caches.values()) {
          if (!cache.has(handle)) continue;
          const previous = cache.get(handle);
          const retained = previous === undefined ? undefined : materialResource(previous.snapshot);
          const retainedId = retained === undefined ? undefined : materialIds.get(retained);
          const context =
            capabilities === undefined
              ? undefined
              : renderMaterialContext(capabilities, limits).materialContext;
          try {
            const snapshot = resolveMaterialSnapshot(
              handle,
              resources,
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
          } catch (cause) {
            if (
              previous === undefined ||
              retainedId === undefined ||
              !materialRecords.has(retainedId)
            )
              throw cause;
            retained?.adopt(previous.snapshot);
            cache.set(handle, { ...previous, retry: { cause } });
            createWorldInternalView(world)._routeError(cause, {
              severity: Severity.Error,
              systemName: 'RenderPublisher.material-admission',
            });
          }
        }
      }
    }

    /** Grouping is synchronous: no temporary column escapes template admission. */
    private addRenderableTemplates(frame: ReturnType<typeof extractSource>): string | undefined {
      const count = frame.renderables.length;
      if (count === 0) return undefined;
      const entries: readonly DispatchEntry[] = Array.isArray(frame.dispatch)
        ? frame.dispatch
        : [...frame.dispatch];
      const words = count * 2 + 1 + entries.length;
      // A tiny factory is cheaper than a scope/Result/view. Large grouping
      // uses the World's bounded arena through the end of this exact reader.
      if (words < 256) return this.groupRenderableTemplates(frame, entries, new Int32Array(words));
      return world
        .withFrameArena(() => {
          const allocated = world.frameArena.alloc(Int32Array, words);
          if (!allocated.ok) return allocated;
          return ok(this.groupRenderableTemplates(frame, entries, allocated.value));
        })
        .unwrap();
    }

    private groupRenderableTemplates(
      frame: ReturnType<typeof extractSource>,
      entries: readonly DispatchEntry[],
      storage: Int32Array,
    ): string | undefined {
      const meshCounts = new Map<number, number>();
      for (const row of frame.renderables)
        if (row.assetHandle !== undefined)
          meshCounts.set(row.assetHandle, (meshCounts.get(row.assetHandle) ?? 0) + 1);
      const count = frame.renderables.length;
      const cursorBase = count + 1;
      const orderBase = count * 2 + 1;
      storage.fill(0, 0, cursorBase);
      for (const entry of entries)
        if (entry.renderableIndex >= 0 && entry.renderableIndex < count)
          storage[entry.renderableIndex + 1] = (storage[entry.renderableIndex + 1] as number) + 1;
      for (let i = 0; i < count; i++) {
        storage[i + 1] = (storage[i + 1] as number) + (storage[i] as number);
        storage[cursorBase + i] = storage[i] as number;
      }
      for (let i = 0; i < entries.length; i++) {
        const renderable = (entries[i] as DispatchEntry).renderableIndex;
        if (renderable < 0 || renderable >= count) continue;
        const cursor = cursorBase + renderable;
        storage[orderBase + (storage[cursor] as number)] = i;
        storage[cursor] = (storage[cursor] as number) + 1;
      }
      const checked = new Set<MaterialResource>();
      const rowDispatch = { entries, order: storage, start: 0, end: 0 };
      for (let i = 0; i < count; i++) {
        const row = frame.renderables.at(i) as RenderableSnapshot;
        const unsupported = unsupportedRenderableSource(row, checked);
        if (unsupported !== undefined) return unsupported;
        rowDispatch.start = orderBase + (storage[i] as number);
        rowDispatch.end = orderBase + (storage[i + 1] as number);
        this.addRenderableTemplate(row, rowDispatch, meshCounts);
      }
      return undefined;
    }

    private addRenderableTemplate(
      row: RenderableSnapshot,
      rowDispatch: RowDispatch,
      meshCounts: ReadonlyMap<number, number>,
    ): void {
      const { entityKey, transform, material, materials, materialOverrides } = row;
      const references = this.materialReferences(material, materials, materialOverrides);
      nextMaterialDependencies.set(entityKey, references.dependencies);
      const shareable = this.shareable(row, meshCounts);
      // extractSource owns these plain source-row envelopes. Compare the exact
      // publication fields before constructing another envelope on a hit.
      const bucketKey = shareable ? `${row.assetHandle}|${references.key}` : undefined;
      const bucket =
        bucketKey === undefined
          ? undefined
          : this.templateWorkspace().templateBuckets.get(bucketKey);
      let snapshot: RenderPublicationTemplate['snapshot'] | undefined;
      let known =
        bucket === undefined
          ? undefined
          : this.matchRowTemplate(row, references, rowDispatch, bucket);
      let template: RenderPublicationTemplate | undefined;
      let key: string | undefined;
      if (known === undefined) {
        snapshot = renderableTemplateSnapshot(row, references);
        template = { snapshot, dispatch: strippedDispatch(rowDispatch) };
        if (shareable) {
          key = this.templateKey(template);
          known = this.templateWorkspace().templateIds.get(key);
        }
      }
      if (known !== undefined && bucketKey !== undefined && bucket?.includes(known) !== true)
        this.addTemplateBucket(bucketKey, known);
      if (known === undefined && template !== undefined) {
        const index = this.templates.length;
        this.templates.push(template);
        this.publishPrograms(
          [
            ...row.materials,
            ...(materialOverrides ?? []).filter((resource) => resource !== undefined),
          ].map((resource) => resource.snapshot),
        );
        known = { index, dependencies: renderableAssetRoots(row) };
        if (key !== undefined) this.templateWorkspace().templateIds.set(key, known);
        if (bucketKey !== undefined) this.addTemplateBucket(bucketKey, known);
      }
      if (known === undefined) throw new Error('renderable template was not published');
      this.upserts.push(entityKey, known.index);
      this.matrixRows.set(entityKey, CapturedSceneTransform.storage(transform));
      this.nextDependencies.set(entityKey, known.dependencies);
    }

    /**
     * Published material ids of one row. Consecutive rows of one template carry
     * equal material lists; they share the previous row's id lists and
     * dependency list instead of rebuilding them.
     */
    private materialReferences(
      material: MaterialResource,
      materials: readonly MaterialResource[],
      overrides: readonly (MaterialResource | undefined)[] | undefined,
    ): MaterialReferences {
      const recent = this.recentReferences;
      if (
        recent !== undefined &&
        recent.source === material &&
        sameList(recent.sources, materials) &&
        sameList(recent.overrideSources, overrides)
      )
        return recent;
      const ids = materials.map((resource) => this.publishMaterial(resource));
      const overrideIds = overrides?.map((resource) =>
        resource === undefined ? 0 : this.publishMaterial(resource),
      );
      const id = this.publishMaterial(material);
      this.recentReferences = {
        source: material,
        sources: [...materials],
        overrideSources: overrides === undefined ? undefined : [...overrides],
        material: id,
        materials: ids,
        overrides: overrideIds,
        dependencies: [...ids, ...(overrideIds ?? []).filter((value) => value !== 0)],
        key: `${id}|${ids.join(',')}|${overrideIds?.join(',') ?? ''}`,
      };
      return this.recentReferences;
    }

    /** False for payloads only one entity can own. */
    private shareable(
      snapshot: Pick<
        RenderableSnapshot,
        'instances' | 'spriteInstances' | 'skinBinding' | 'pointsLines' | 'assetHandle'
      >,
      meshCounts: ReadonlyMap<number, number>,
    ): boolean {
      // These payloads already contain the source entity identity. They
      // cannot share a template, regardless of equal pose/instance bytes.
      const entityOwned =
        snapshot.instances !== undefined ||
        snapshot.spriteInstances !== undefined ||
        snapshot.skinBinding !== undefined ||
        snapshot.pointsLines !== undefined;
      return !(
        entityOwned ||
        (snapshot.assetHandle !== undefined && meshCounts.get(snapshot.assetHandle) === 1)
      );
    }

    /** Shared-template content identity. */
    private templateKey(template: RenderPublicationTemplate): string {
      return `${this.keyToken('snapshot', template.snapshot, 0)}|${this.keyToken('dispatch', template.dispatch, 0)}`;
    }

    private addTemplateBucket(
      bucketKey: string,
      known: { index: number; dependencies: readonly number[] },
    ): void {
      const bucket = this.templateWorkspace().templateBuckets.get(bucketKey);
      if (bucket === undefined) this.templateWorkspace().templateBuckets.set(bucketKey, [known]);
      else if (bucket.length < TEMPLATE_BUCKET_LIMIT) bucket.push(known);
    }

    private matchRowTemplate(
      row: RenderableSnapshot,
      materials: MaterialReferences,
      dispatch: RowDispatch,
      bucket: readonly { index: number; dependencies: readonly number[] }[],
    ): { index: number; dependencies: readonly number[] } | undefined {
      // A custom JSON root must still take the ordinary captured-template path.
      if (typeof (row as unknown as { toJSON?: unknown }).toJSON === 'function') return undefined;
      for (const known of bucket) {
        const candidate = this.templates[known.index] as RenderPublicationTemplate;
        if (
          this.sameRowContent(row, materials, candidate.snapshot) &&
          this.sameDispatch(dispatch, candidate.dispatch)
        )
          return known;
      }
      return undefined;
    }

    private sameRowContent(
      row: RenderableSnapshot,
      materials: MaterialReferences,
      candidate: RenderPublicationTemplate['snapshot'],
    ): boolean {
      if (
        !this.sameContent('material', materials.material, candidate.material, 1) ||
        !this.sameContent('materials', materials.materials, candidate.materials, 1) ||
        !this.sameContent('materialOverrides', materials.overrides, candidate.materialOverrides, 1)
      )
        return false;
      const fields = row as unknown as Record<string, unknown>;
      const captured = candidate as unknown as Record<string, unknown>;
      let count = materials.overrides === undefined ? 2 : 3;
      for (const key in fields) {
        if (
          !Object.hasOwn(fields, key) ||
          key === 'entityKey' ||
          key === 'transform' ||
          key === 'material' ||
          key === 'materials' ||
          key === 'materialOverrides'
        )
          continue;
        const value = fields[key];
        if (value === undefined || typeof value === 'function') continue;
        count++;
        if (!this.sameContent(key, value, captured[key], 1)) return false;
      }
      for (const key in captured) {
        const value = captured[key];
        if (value !== undefined && typeof value !== 'function') count--;
      }
      return count === 0;
    }

    /** {@link sameContent} of a row's dispatch entries without their row identity fields. */
    private sameDispatch(
      dispatch: RowDispatch,
      candidate: RenderPublicationTemplate['dispatch'],
    ): boolean {
      if (dispatch.end - dispatch.start !== candidate.length) return false;
      for (let index = dispatch.start; index < dispatch.end; index++) {
        const entry = dispatch.entries[dispatch.order[index] as number] as unknown as Record<
          string,
          unknown
        >;
        const other = candidate[index - dispatch.start] as unknown as Record<string, unknown>;
        let count = 0;
        for (const key in entry) {
          if (key === 'entityIndex' || key === 'renderableIndex') continue;
          const value = entry[key];
          if (value === undefined || typeof value === 'function') continue;
          count++;
          if (!this.sameContent(key, value, other[key], 2)) return false;
        }
        for (const key in other) {
          const value = other[key];
          if (value !== undefined && typeof value !== 'function') count--;
        }
        if (count !== 0) return false;
      }
      return true;
    }

    /**
     * Allocation-free content equality with {@link keyToken}'s meaning, except
     * that plain-object member order is ignored. Identical references
     * short-circuit; leaves fall back to their cached content tokens.
     */
    private sameContent(field: string, a: unknown, b: unknown, depth: number): boolean {
      if (a === b) return true;
      if (typeof a !== typeof b) return false;
      if (typeof a === 'number') return Object.is(a, b);
      if (typeof a !== 'object' || a === null || b === null) return false;
      const left = this.structural(field, a, depth);
      if (left !== this.structural(field, b as object, depth)) return false;
      if (left === 'leaf') return this.keyToken(field, a, depth) === this.keyToken(field, b, depth);
      if (left === 'array') {
        const x = a as readonly unknown[];
        const y = b as readonly unknown[];
        if (x.length !== y.length) return false;
        for (let index = 0; index < x.length; index++)
          if (!this.sameContent(ARRAY_FIELD, x[index], y[index], depth + 1)) return false;
        return true;
      }
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      let count = 0;
      for (const key in x) {
        const entry = x[key];
        if (entry === undefined || typeof entry === 'function') continue;
        count++;
        if (!this.sameContent(key, entry, y[key], depth + 1)) return false;
      }
      for (const key in y) {
        const entry = y[key];
        if (entry !== undefined && typeof entry !== 'function') count--;
      }
      return count === 0;
    }

    private structural(field: string, value: object, depth: number): 'array' | 'object' | 'leaf' {
      if (
        depth >= 8 ||
        field === 'paramSnapshot' ||
        typeof (value as { toJSON?: unknown }).toJSON === 'function'
      )
        return 'leaf';
      if (Array.isArray(value)) return 'array';
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null ? 'object' : 'leaf';
    }

    /**
     * Content token of one template field: plain containers are walked
     * structurally and every other object (Map, typed array, class value or
     * deep leaf) becomes the content id of its publication JSON, cached by
     * identity for this preparation. Equal tokens imply equal publication
     * JSON, so bulk admission shares the existing template identity without
     * stringifying every row's shared leaves again.
     */
    private keyToken(field: string, value: unknown, depth: number): string {
      switch (typeof value) {
        case 'undefined':
          return 'u';
        case 'number':
          return Object.is(value, -0) ? 'n-0' : `n${value}`;
        case 'boolean':
          return value ? 't' : 'f';
        case 'string':
          return `s${value.length}:${value}`;
        case 'object':
          break;
        default:
          return `x${this.leafId(field, value as object)}`;
      }
      if (value === null) return 'z';
      const cached = this.templateWorkspace().tokens.get(value);
      if (cached !== undefined && cached.field === field) return cached.token;
      let token: string;
      const prototype = Object.getPrototypeOf(value);
      if (
        depth < 8 &&
        field !== 'paramSnapshot' &&
        typeof (value as { toJSON?: unknown }).toJSON !== 'function' &&
        (Array.isArray(value) || prototype === Object.prototype || prototype === null)
      ) {
        if (Array.isArray(value)) {
          token = `[${value.length}`;
          for (let index = 0; index < value.length; index++)
            token += `,${this.keyToken(String(index), value[index], depth + 1)}`;
          token += ']';
        } else {
          token = '{';
          for (const key of Object.keys(value)) {
            const entry = (value as Record<string, unknown>)[key];
            // JSON omits undefined and function members of objects.
            if (entry === undefined || typeof entry === 'function') continue;
            token += `${key.length}:${key}=${this.keyToken(key, entry, depth + 1)};`;
          }
          token += '}';
        }
        // Intern the content so enclosing tokens stay short.
        let id = this.templateWorkspace().structuralIds.get(token);
        if (id === undefined) {
          id = this.templateWorkspace().structuralIds.size;
          this.templateWorkspace().structuralIds.set(token, id);
        }
        token = `@${id}`;
      } else token = `#${this.leafId(field, value)}`;
      this.templateWorkspace().tokens.set(value, { field, token });
      return token;
    }

    private leafId(field: string, value: object): number {
      return this.valueId({ [field]: value });
    }

    private extractFeatureRows(
      frame: ReturnType<typeof extractSource>,
    ): RenderPublication['features'] {
      return this.featureSources.flatMap((feature, order) => {
        const captured = captureRenderFeatureSource(
          feature,
          this.featureExtractContext(frame),
          order,
        );
        const data = captured.result.ok ? captured.result.value : undefined;
        if (
          captured.result.ok &&
          captured.hiddenEntities.length === 0 &&
          Object.hasOwn(feature, 'inactiveSourceData') &&
          data === feature.inactiveSourceData
        )
          return [];
        const fullscreen = fullscreenRenderFeatureDeclaration(feature);
        return [
          {
            identity: feature.identity,
            data,
            ...(captured.result.ok
              ? {}
              : { failure: renderFeatureSourceFailure(captured.result.error) }),
            ...(captured.hiddenEntities.length === 0
              ? {}
              : { hiddenEntities: captured.hiddenEntities }),
            ...(fullscreen === undefined ||
            publishedFullscreenFeatures.get(feature.identity) === fullscreen
              ? {}
              : { fullscreen }),
          },
        ];
      });
    }

    private featureExtractContext(
      frame: ReturnType<typeof extractSource>,
    ): RenderFeatureExtractContext {
      return renderFeatureSourceContext(world, frame, revision + 1, {
        receiverSession: `${identity.source}:${identity.epoch}`,
        ...(capabilities === undefined
          ? {}
          : {
              caps: capabilities,
              ...(limits === undefined ? {} : { limits }),
              ...renderMaterialContext(capabilities, limits),
            }),
        referenceAssetVersion: (version) => {
          this.referenceAssetVersion(version.handle, version).unwrap();
        },
        referenceAsset: (identity, captured) => currentFeatureAsset(identity, captured),
      });
    }

    private referenceAssetVersion(
      handle: number,
      captured?: Readonly<{ revision: number; value: Asset }>,
    ): Result<
      Readonly<{ handle: number; revision: number; value: Asset; contentRevision?: number }>,
      import('@forgeax/engine-types').AssetError
    > {
      const records = runtimeAssets(assets);
      const revision = captured === undefined ? records.version(handle) : ok(captured.revision);
      if (!revision.ok) return revision;
      const key = `${handle}:${revision.value}`;
      const prior = this.nextAssetVersions.get(key) ?? assetVersions.get(key);
      const value =
        prior === undefined
          ? captured === undefined
            ? records.borrow<Asset>(handle)
            : ok(captured.value)
          : ok(prior.value);
      if (!value.ok) return value;
      const version = prior ?? { handle, revision: revision.value, value: value.value };
      if (version.value.kind === 'material') {
        const projection = assets.getMaterialProjectionForPayload(version.value);
        for (const pass of projection?.passes ?? [])
          for (const program of pass.programs) this.publishProgram(program.specializationKey);
      }
      this.nextAssetVersions.set(key, version);
      return ok({
        ...version,
        ...(captured === undefined ? { contentRevision: revision.value } : {}),
      });
    }

    private referenceMaterialSources(materials: RenderPublication['materials']): void {
      this.publishPrograms(materials.map(({ value }) => value));
      for (const { value } of materials)
        for (const asset of value.sourceAssets?.assets ?? []) {
          if (asset.value === undefined)
            throw new Error('Accepted material source payload is unavailable');
          this.referenceAssetVersion(asset.handle, {
            revision: asset.revision,
            value: asset.value,
          }).unwrap();
        }
    }

    private collectFrameDependencies(
      frame: ReturnType<typeof extractSource>,
      featureRows: RenderPublication['features'],
    ): Set<number> {
      const nextFrameDependencies = new Set(publicationFrameDependencies(frame));
      for (const feature of this.featureSources) {
        const row = featureRows.find((row) => row.identity === feature.identity);
        if (row === undefined || row.failure !== undefined) continue;
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
    private prepareJointUpdates(frame: ReturnType<typeof extractSource>): void {
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

    /** The five change columns, written once at their offsets in this slot's record. */
    private recordColumns(): ReturnType<typeof renderPublicationRecordColumns> {
      const counts = {
        upserts: this.upserts.length,
        removed: this.removed.size,
        transforms: this.matrixRows.size,
        retiredJoints: this.retiredJoints?.size ?? 0,
      };
      const columns = renderPublicationRecordColumns(
        record(renderPublicationRecordBytes(counts)),
        counts,
      );
      columns.upserts.set(this.upserts);
      let index = 0;
      for (const entity of this.removed) columns.removed[index++] = entity;
      index = 0;
      this.matrixRows.forEach((matrix, entity) => {
        columns.transformEntities[index] = entity;
        CapturedSceneTransform.writeStorage(columns.transforms, 16 * index++, matrix);
      });
      index = 0;
      for (const joint of this.retiredJoints ?? EMPTY_IDENTITIES)
        columns.retiredJoints[index++] = joint;
      return columns;
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
        const projection = receivingMaterialProjections.project(
          material.kind === 'material'
            ? assets.getMaterialProjectionForPayload(material)
            : undefined,
          capabilities === undefined
            ? undefined
            : renderMaterialContext(capabilities, limits).materialContext,
        );
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
        for (const id of materialsByEntity.get(entity)) holdMaterial(id, -1);
    }

    private addedAssetVersions(): NonNullable<RenderPublication['assetVersions']> {
      const rows: Array<NonNullable<RenderPublication['assetVersions']>[number]> = [];
      const records = runtimeAssets(assets);
      for (const [key, { handle, revision, value }] of this.nextAssetVersions) {
        if (assetVersions.has(key)) continue;
        const preparedRevision =
          value.kind === 'mesh' && preparedMesh !== undefined
            ? records.fixedContentRevision(handle, revision, value)
            : undefined;
        rows.push(
          preparedRevision !== undefined && preparedMesh?.(handle, preparedRevision)
            ? { handle, revision, preparedRevision }
            : { handle, revision, value: structuredClone(value) },
        );
      }
      return rows;
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
    private referencePreparedMesh(
      handle: number,
      revision: number,
      preparedRows: PreparedAssetRow[],
    ): boolean {
      if (!preparedMesh?.(handle, revision)) return false;
      const kind = runtimeAssets(assets).kind(handle);
      if (!kind.ok || kind.value !== 'mesh') return false;
      const guid = runtimeAssetSource(assets, handle);
      const sourceKey = guid === undefined ? undefined : assets.sourceKeyOf(guid);
      preparedRows.push({
        handle,
        revision,
        ...(guid === undefined ? {} : { guid }),
        ...(sourceKey === undefined ? {} : { sourceKey }),
      });
      return true;
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
      retired: readonly number[],
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
        ...(value.kind === 'material'
          ? publishedMaterialProjections.row(
              handle,
              materialProjections.get(handle),
              retired,
              detachMaterialProjection,
            )
          : {}),
        ...(guid === undefined ? {} : { guid }),
        ...(sourceKey === undefined ? {} : { sourceKey }),
      };
    }

    private commitMembership(): void {
      for (const entity of this.removed)
        if (!this.nextDependencies.has(entity)) dependencies.delete(entity);
      this.references?.commit();
      if (this.jointChanges !== undefined) skinJoints.acknowledged(this.jointChanges);
      for (const entity of this.removed) members.delete(entity);
      for (const [entity, handles] of this.nextDependencies) {
        members.add(entity);
        dependencies.set(entity, handles);
      }
      for (const entity of this.matrixRows.keys()) pending.delete(entity);
      for (const entity of this.removed) pending.delete(entity);
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
  /** Final material roster, including unchanged consumers and retained last-good owners. */
  const referencedMaterialRows = (): RenderPublication['materials'] =>
    [...new Set([...materialRecords.keys(), ...materialSources.keys()])]
      .filter((id) => (materialHolds.get(id) ?? materialRecords.get(id)?.holds ?? 0) > 0)
      .map((id) => ({
        id,
        value:
          materialRows.get(id) ??
          materialRecords.get(id)?.snapshot ??
          (materialSources.get(id) as MaterialResource).snapshot,
      }));
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
    publishedMaterialProjections.accept(retired, materialProjections);
    for (const handle of retired) for (const { cache } of caches.values()) cache.delete(handle);
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
      execution?: {
        readonly frameId: number;
        readonly waterMeshViewFacts?: WaterMeshViewFacts;
      },
    ): Result<RenderPublicationCandidate, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      if (!phaseIs('idle') || flights.size >= maxInFlight)
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
      preparationPhase = 'preparing';
      let preparation: PublicationPreparation | undefined;
      try {
        preparation = new PublicationPreparation(baseline, observation);
        return preparation.prepare(sampleTimeSeconds, temporalReset, execution?.waterMeshViewFacts);
      } catch (cause) {
        observation?.finish('prepare-error');
        activeObservation = undefined;
        if (preparation !== undefined)
          closeFrames(preparation.videoFrames, preparation.canvasFrames);
        return fail('unsupported', cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (phaseIs('preparing')) {
          preparationPhase = 'idle';
        }
      }
    },
    acknowledgeFeatures(
      acceptedRevision: number,
      receipts: readonly SourceFeatureAcknowledgment[],
    ): Result<void, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      const flight = flights.get(acceptedRevision);
      if (flight === undefined || flight.phase !== 'accepted')
        return fail('revision', 'feature acknowledgment');
      const identities = new Set<string>();
      for (const receipt of receipts) {
        if (identities.has(receipt.identity))
          return fail('revision', 'duplicate feature acknowledgment');
        const row = flight.features.find((row) => row.identity === receipt.identity);
        const feature = flight.owners.find((feature) => feature.identity === receipt.identity);
        if (row === undefined || row.failure !== undefined || feature === undefined)
          return fail('shape', 'unknown feature acknowledgment');
        identities.add(receipt.identity);
      }
      flights.set(acceptedRevision, {
        ...flight,
        phase: 'submitted',
        receipts: receipts.map((receipt) => ({ ...receipt })),
      });
      for (const receipt of receipts) {
        const row = flight.features.find((row) => row.identity === receipt.identity);
        const feature = flight.owners.find((feature) => feature.identity === receipt.identity);
        feature?.onSourceFrameSubmitted?.(row?.data, receipt.feedback, receipt.submission);
      }
      return ok(undefined);
    },
    completeFeatures(
      acceptedRevision: number,
      completion: RenderFeatureCompletion,
      readbacks: FeatureTextureReadbackResult = { ok: true, value: [] },
    ): Result<void, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      const flight = flights.get(acceptedRevision);
      if (flights.keys().next().value !== acceptedRevision || flight?.phase !== 'submitted')
        return fail('revision', 'submitted feature completion in publication order');
      if (
        ![
          completion.frameId,
          completion.deviceGeneration,
          ...(completion.graphGeneration === undefined ? [] : [completion.graphGeneration]),
        ].every((value) => Number.isSafeInteger(value) && value >= 0)
      )
        return fail('shape', 'actual completed Renderer receipt facts');
      if (readbacks.ok) {
        const validateCompletedFeatureReadbacks = (
          checkedReadbacks: Extract<FeatureTextureReadbackResult, { ok: true }>,
        ) => {
          const owners = new Set(flight.owners.map((feature) => feature.identity));
          const seen = new Set<string>();
          for (const observation of checkedReadbacks.value) {
            const key = `${observation.featureIdentity}\u0000${observation.viewIdentity ?? 'frame'}\u0000${observation.name}`;
            if (
              !owners.has(observation.featureIdentity) ||
              observation.name.length === 0 ||
              observation.targetName.length === 0 ||
              seen.has(key) ||
              observation.metadata.frameId !== completion.frameId ||
              observation.metadata.deviceGeneration !== completion.deviceGeneration ||
              (completion.graphGeneration !== undefined &&
                observation.metadata.graphGeneration !== completion.graphGeneration)
            )
              return fail('shape', 'receipt-bound feature-texture observations');
            seen.add(key);
          }
          return undefined;
        };
        const readbackFailure = validateCompletedFeatureReadbacks(readbacks);
        if (readbackFailure !== undefined) return readbackFailure;
      } else if (
        typeof readbacks.error.code !== 'string' ||
        typeof readbacks.error.expected !== 'string' ||
        typeof readbacks.error.hint !== 'string'
      )
        return fail('shape', 'structured feature-texture readback error');
      flights.set(acceptedRevision, {
        features: flight.features,
        owners: flight.owners,
        phase: 'completed',
      });
      for (const receipt of flight.receipts) {
        const row = flight.features.find((row) => row.identity === receipt.identity);
        const feature = flight.owners.find((feature) => feature.identity === receipt.identity);
        feature?.onSourceFrameCompleted?.(
          row?.data,
          completion,
          receipt.feedback,
          receipt.submission,
          readbacks.ok
            ? {
                ok: true,
                value: readbacks.value.filter(
                  (observation) => observation.featureIdentity === receipt.identity,
                ),
              }
            : readbacks,
        );
      }
      return ok(undefined);
    },
    trimStorage(): void {
      spareStorage.length = 0;
      // The candidate owns its record independently, including while waiting for credit.
      storage = undefined;
      discardStorageThrough = revision + (phaseIs('idle') ? 0 : 1);
    },
    recycle(
      acceptedRevision: number,
      buffers: readonly ArrayBuffer[],
    ): Result<void, RenderPublicationError> {
      if (disposed || failed)
        return fail('disposed', 'publisher retired or failed; start a new source epoch');
      if (flights.keys().next().value !== acceptedRevision)
        return fail('revision', 'returned storage revision');
      const returned = buffers[0];
      if (buffers.length !== 1 || !(returned instanceof ArrayBuffer))
        return fail('shape', 'returned storage');
      if (acceptedRevision > discardStorageThrough) {
        if (!phaseIs('idle') || storage !== undefined) spareStorage.push(returned);
        else storage = returned;
      }
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
      caches.clear();
      materialsByEntity.clear();
      pending.clear();
      videoConsumers.clear();
      canvasConsumers.clear();
      flights.clear();
      spareStorage.length = 0;
      storage = undefined;
      acceptedMetadata = undefined;
      frameDependencies.clear();
      skinJoints.clear();
    },
  };
}

type FrameStatistics = Pick<
  RenderPublicationMetadata,
  'frustumStats' | 'visibilityStats' | 'materialTextureSources'
>;

/**
 * Keep the accepted statistics objects whose counts did not change, so the
 * identity-compared metadata delta omits them. Every other entry is retained
 * by the environment gate.
 */
function retainStatistics(
  metadata: RenderPublicationMetadata,
  accepted: FrameStatistics | undefined,
): RenderPublicationMetadata {
  if (accepted === undefined) return metadata;
  const frustum =
    accepted.frustumStats.culled === metadata.frustumStats.culled &&
    accepted.frustumStats.total === metadata.frustumStats.total
      ? accepted.frustumStats
      : metadata.frustumStats;
  const visibility =
    accepted.visibilityStats.explicitlyHidden === metadata.visibilityStats.explicitlyHidden
      ? accepted.visibilityStats
      : metadata.visibilityStats;
  const textures = sameTextureSources(
    accepted.materialTextureSources,
    metadata.materialTextureSources,
  )
    ? accepted.materialTextureSources
    : metadata.materialTextureSources;
  return {
    ...metadata,
    frustumStats: frustum,
    visibilityStats: visibility,
    ...(textures === undefined ? {} : { materialTextureSources: textures }),
  };
}

function sameTextureSources(
  left: FrameStatistics['materialTextureSources'],
  right: FrameStatistics['materialTextureSources'],
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.sourceFieldsVisited !== right.sourceFieldsVisited) return false;
  const routes = Object.keys(right.producerRoutes);
  if (routes.length !== Object.keys(left.producerRoutes).length) return false;
  for (const route of routes)
    if (left.producerRoutes[route] !== right.producerRoutes[route]) return false;
  return true;
}
