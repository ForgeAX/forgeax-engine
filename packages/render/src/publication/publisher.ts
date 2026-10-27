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
import { MeshFilter } from '../components/mesh-filter';
import { stereoEyeCameras } from '../components/stereo-camera';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { EnvironmentGate } from '../extract/environment-gate';
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
  type DispatchEntry,
  type EnvironmentFrameGate,
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
  type RenderPublicationMetadata,
  type RenderPublicationTemplate,
} from './contract';
import { publicationFrameDependencies, renderableAssetRoots } from './dependencies';
import { EntityMaterialLists } from './material-lists';
import { PublishedMaterialProjections } from './material-projections';
import { beginSourcePreparation, type SourcePreparationObservation } from './observation';
import { publicationMaterialProgramKeys } from './programs';
import {
  encodeRenderPublication,
  type RenderPublicationMessage,
  renderPublicationRecordBytes,
  renderPublicationRecordColumns,
} from './record';
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
  const materialsByEntity = new EntityMaterialLists();
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
  const publishedMaterialProjections = new PublishedMaterialProjections();
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
  // One record per publication slot: it crosses with its publication and
  // returns with the frame completion, so slots never allocate in steady state.
  let storage: ArrayBuffer | undefined;
  const spareStorage: ArrayBuffer[] = [];
  // Metadata of the last accepted publication; the next message omits unchanged entries.
  let acceptedMetadata: RenderPublicationMetadata | undefined;
  // Camera, light and environment entries re-extract only when their inputs change.
  const environmentGate: EnvironmentFrameGate = new EnvironmentGate();
  const record = (bytes: number): ArrayBuffer => {
    let value = storage ?? new ArrayBuffer(0);
    // A baseline-sized record must not keep crossing the Worker boundary: every
    // transfer re-registers its full capacity as external memory in both
    // realms, and that pressure forces whole-heap GC proportional to N.
    const oversized =
      value.byteLength > STORAGE_SHRINK_FLOOR && value.byteLength > bytes * STORAGE_SHRINK_RATIO;
    if (value.byteLength < bytes || oversized) {
      let capacity = oversized ? 256 : Math.max(256, value.byteLength);
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
    private readonly tokens = new Map<object, { readonly field: string; readonly token: string }>();
    private readonly structuralIds = new Map<string, number>();
    private recentReferences: MaterialReferences | undefined;
    private readonly templateBuckets = new Map<
      string,
      { index: number; dependencies: readonly number[] }[]
    >();
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
    ): Result<RenderPublicationCandidate, RenderPublicationError> {
      const observation = this.observation;
      observation?.phase('extract');
      const extracted = this.withoutPreparingRenderables();
      environmentGate.assetsChanged = this.baseline || this.assetBatch.changes.length > 0;
      const frame = extractFrames([world], { cameraOwner: 0, resourceOwner: 0 }, assets, caches, {
        ...(capabilities === undefined ? {} : renderMaterialContext(capabilities, limits)),
        cull: 'none',
        retainHidden: true,
        renderables: extracted.size ? { kind: 'partial', entitiesByWorld: [extracted] } : 'none',
        environmentGate,
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
      const {
        renderables: _rows,
        dispatch: _dispatch,
        visibilitySnapshots: _visibility,
        featureVisibilitySnapshots: _features,
        hiddenEntityReports: _hidden,
        ...extractedMetadata
      } = frame;
      const metadata = retainStatistics(extractedMetadata, acceptedMetadata);
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
      const columns = this.recordColumns();
      observation?.phase('packet');
      const packet: RenderPublication = {
        ...identity,
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
        targetSources: publicationTargetSources(referencedMaterialRows()),
        features: featureRows,
        assetVersions: this.addedAssetVersions(),
        retiredAssetVersions: this.retiredAssetVersions(),
        programs: [...this.programs.values()],
        ...columns,
        ...(preparedRows.length === 0 ? {} : { preparedAssets: preparedRows }),
        assets: sentAssetRows.map(([handle, value, revision]) =>
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
      this.batch.validate();
      active = true;
      let closed = false;
      return ok({
        packet,
        message,
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
            acceptedMetadata = packet.metadata;
            flights.set(revision, {
              features: featureRows,
              owners: this.featureSources,
              submitted: false,
            });
            storage = spareStorage.pop();
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
          for (const row of featureRows)
            this.featureSources
              .find((feature) => feature.identity === row.identity)
              ?.onSourceFrameDiscarded?.(row.data);
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
      // Group dispatch entries by renderable with two numeric columns; entries
      // are copied without their row identity only when a new template needs them.
      const count = frame.renderables.length;
      const entries: readonly DispatchEntry[] = [...frame.dispatch];
      const starts = new Int32Array(count + 1);
      for (const entry of entries)
        if (entry.renderableIndex >= 0 && entry.renderableIndex < count)
          starts[entry.renderableIndex + 1] = (starts[entry.renderableIndex + 1] as number) + 1;
      for (let index = 0; index < count; index++)
        starts[index + 1] = (starts[index + 1] as number) + (starts[index] as number);
      const order = new Int32Array(starts[count] as number);
      const cursor = starts.slice(0, count);
      for (let index = 0; index < entries.length; index++) {
        const renderable = (entries[index] as DispatchEntry).renderableIndex;
        if (renderable < 0 || renderable >= count) continue;
        order[cursor[renderable] as number] = index;
        cursor[renderable] = (cursor[renderable] as number) + 1;
      }
      const checked = new Set<MaterialResource>();
      for (let i = 0; i < count; i++) {
        const row = frame.renderables.at(i) as RenderableSnapshot;
        const unsupported = unsupportedRenderableSource(row, checked);
        if (unsupported !== undefined) return unsupported;
        this.addRenderableTemplate(
          row,
          { entries, order, start: starts[i] as number, end: starts[i + 1] as number },
          meshCounts,
        );
      }
      return undefined;
    }

    private addRenderableTemplate(
      row: RenderableSnapshot,
      rowDispatch: RowDispatch,
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
      const references = this.materialReferences(material, materials, materialOverrides);
      const { materials: materialReferences, overrides } = references;
      nextMaterialDependencies.set(entityKey, references.dependencies);
      const snapshot = {
        ...content,
        material: references.material,
        materials: materialReferences,
        ...(overrides === undefined ? {} : { materialOverrides: overrides }),
      };
      const shareable = this.shareable(snapshot, meshCounts);
      // Rows of one mesh/material tuple almost always share content: compare
      // against that tuple's templates before deriving a content key.
      const bucketKey = shareable ? `${snapshot.assetHandle}|${references.key}` : undefined;
      const bucket = bucketKey === undefined ? undefined : this.templateBuckets.get(bucketKey);
      let known =
        bucket === undefined ? undefined : this.matchTemplate(snapshot, rowDispatch, bucket);
      let template: RenderPublicationTemplate | undefined;
      let key: string | undefined;
      if (known === undefined) {
        template = { snapshot, dispatch: strippedDispatch(rowDispatch) };
        if (shareable) {
          key = this.templateKey(template);
          known = this.templateIds.get(key);
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
        if (key !== undefined) this.templateIds.set(key, known);
        if (bucketKey !== undefined) this.addTemplateBucket(bucketKey, known);
      }
      if (known === undefined) throw new Error('renderable template was not published');
      this.upserts.push(entityKey, known.index);
      this.matrixRows.set(entityKey, transform.world);
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
      snapshot: RenderPublicationTemplate['snapshot'],
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
      const bucket = this.templateBuckets.get(bucketKey);
      if (bucket === undefined) this.templateBuckets.set(bucketKey, [known]);
      else if (bucket.length < TEMPLATE_BUCKET_LIMIT) bucket.push(known);
    }

    private matchTemplate(
      snapshot: RenderPublicationTemplate['snapshot'],
      dispatch: RowDispatch,
      bucket: readonly { index: number; dependencies: readonly number[] }[],
    ): { index: number; dependencies: readonly number[] } | undefined {
      for (const known of bucket) {
        const candidate = this.templates[known.index] as RenderPublicationTemplate;
        if (
          this.sameContent('snapshot', snapshot, candidate.snapshot, 0) &&
          this.sameDispatch(dispatch, candidate.dispatch)
        )
          return known;
      }
      return undefined;
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
      const cached = this.tokens.get(value);
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
        let id = this.structuralIds.get(token);
        if (id === undefined) {
          id = this.structuralIds.size;
          this.structuralIds.set(token, id);
        }
        token = `@${id}`;
      } else token = `#${this.leafId(field, value)}`;
      this.tokens.set(value, { field, token });
      return token;
    }

    private leafId(field: string, value: object): number {
      return this.valueId({ [field]: value });
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
        receiverSession: `${identity.source}:${identity.epoch}`,
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
        columns.transforms.set(matrix, 16 * index++);
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
        for (const id of materialsByEntity.get(entity)) holdMaterial(id, -1);
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
  /** Every material a row of this packet references, held ones included, so their target sources resolve. */
  const referencedMaterialRows = (): RenderPublication['materials'] =>
    [...materialSources].map(([id, resource]) => ({
      id,
      value: materialRows.get(id) ?? resource.snapshot,
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
      const returned = buffers[0];
      if (buffers.length !== 1 || !(returned instanceof ArrayBuffer))
        return fail('shape', 'returned storage');
      if (active || storage !== undefined) spareStorage.push(returned);
      else storage = returned;
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
