import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  type AssetChange,
  runtimeAssetRegistry,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type {
  RenderReadLease,
  RenderReadVersion,
  StateProjectionBatch,
} from '@forgeax/engine-ecs/projection';
import { readMutationEpoch } from '@forgeax/engine-ecs/projection';
import { box3 } from '@forgeax/engine-math';
import {
  type MaterialCookRasterContext,
  materialProgramContextKey,
} from '@forgeax/engine-pack/material-cook';
import type { RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { Children, GlobalTransform, MorphWeights } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { type MeshAsset, ok, type Result, type SkeletonAsset } from '@forgeax/engine-types';
import { Instances, Lines, Points, SpriteInstances } from '../components';
import { GlyphSources } from '../glyph-source';
import { BatchTopology, type BatchTopologyInspection } from '../gpu-driven/batch-topology';
import { GpuInputArena } from '../gpu-input-arena';
import { GpuScene } from '../gpu-scene';
import type { GpuSceneSlotBounds } from '../gpu-scene-change-log';
import type { PersistentRenderSceneInspection } from '../inspection-types';
import type { InstanceProjectionStore } from '../instances';
import { MaterialResource, materialResource } from '../material-resource';
import { RenderPublicationError, type RenderPublicationIdentity } from '../publication/contract';
import { publicationFrameDependencies, renderableAssetRoots } from '../publication/dependencies';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { RenderResourceScope } from '../publication/resource-scope';
import { worldRenderResources } from '../publication/resource-scope';
import { worldEntityKey } from '../record/frame-snapshot';
import type {
  DispatchList,
  ExtractedFrame,
  MaterialSnapshotCachesByWorld,
  RenderableSnapshot,
} from '../render-system-extract';
import { materialSnapshotContext, resolveMaterialSnapshot } from '../render-system-extract';
import type { TerrainLayers } from '../terrain/layers';
import { TerrainSourceCache } from '../terrain/source';
import { TilemapSources } from '../tilemap-source';
import type { TransmissionDemand } from '../transmission/projection';
import { SceneAssetClosure } from './asset-closure';
import { CompositionSkinAdoption } from './composition-skin';
import type { FrameList } from './frame-list';
import { FrameSet } from './frame-set';
import { MaterialDispatch, type MaterialFrame } from './material-dispatch';
import { rotateMeshDraws } from './mesh-draw';
import type { MeshMaterialGeometry } from './mesh-materials';
import { ProbeBlendSceneProjection, type ProbeSceneObjectInput } from './probe-blend';
import { boundsFromArray, identityKey } from './render-scene-snapshots';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneOperation,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';
import { EMPTY_SLOT_FRAME, RenderScene, sceneSnapshotDelta } from './render-scene-view';
import {
  acceptRenderSourceEntities,
  captureRenderSourceEntities,
  createGlobalTransformChangeQuery,
  createRenderSourceState,
  type GlobalTransformChangeQuery,
  isRenderableMember,
  type RenderSourceEntity,
  renderSourceHierarchyChanged,
} from './render-source';
import type { SceneSlotFrame } from './scene-slots';
import type { SkinSceneInputs } from './skin-scene-inputs';

type WorldTransformSpan = import('./scene-rows').WorldTransformSpan;

/** The normal extract request used by the persistent scene owner. */
export type PersistentRenderCandidateRequest =
  | 'full'
  | 'none'
  | {
      readonly kind: 'partial';
      /** Entity keys are local to the corresponding World entry. */
      readonly entitiesByWorld: readonly (ReadonlySet<number> | undefined)[];
    };

/** Renderer-level facts every view of one Renderer shares. */
export interface SceneCompositionOptions {
  readonly terrainLayers?: TerrainLayers;
  readonly assets?: AssetRegistry | undefined;
  readonly shaderRegistry?: ShaderRegistry | undefined;
  readonly getDevice?: (() => RhiDevice) | undefined;
  readonly onGpuError?: ((error: RhiError) => void) | undefined;
  /** Renderer-owned asset consumer (GPU residency); view consumers subscribe for their lifetime. */
  readonly onAssetChange?: ((scope: RenderResourceScope, change: AssetChange) => void) | undefined;
  /** Instance projection accepted by the same World source update flow. */
  readonly instanceCollections?: InstanceProjectionStore | undefined;
}

/**
 * The renderer's one retained composition: shared rows with a canonical
 * view, batch topology, material dispatch, Skin inputs, probe objects and
 * the request/availability bookkeeping. Every view reads it; none copies it.
 */
export interface CompositionEntry {
  readonly token: object;
  readonly worlds: readonly RenderResourceScope[];
  /** Canonical view over the shared rows; carries the renderer-level submitted history. */
  readonly projection: RenderScene;
  readonly assetClosures: ReadonlyMap<World, SceneAssetClosure>;
  assetRevision: number;
  readonly topology: BatchTopology;
  hiddenEntityReports: ExtractedFrame['hiddenEntityReports'];
  /** Stable renderer-local World keys; unlike RenderableSnapshot.worldId they survive reorder. */
  readonly worldKeys: readonly number[];
  readonly readVersions: RenderReadVersion[];
  readLeases: readonly RenderReadLease[];
  publicationRevision: number | undefined;
  readonly transformQueries: readonly GlobalTransformChangeQuery[];
  readonly sourceStates: readonly ReturnType<typeof createRenderSourceState>[];
  readonly materialDispatch: MaterialDispatch;
  skin: SkinSceneInputs | undefined;
  /** Renderable identities whose partial producer still needs a successful publish. */
  readonly pendingRenderableEntitiesByWorld: Set<number>[];
  /** Slots retained for recovery but excluded from direct and indirect submission. */
  unavailableSlots: FrameSet;
  readonly probeProjection: ProbeBlendSceneProjection;
  probeObjects:
    | {
        readonly revision: number;
        readonly hasProbes: boolean;
        readonly value: readonly ProbeSceneObjectInput[];
      }
    | undefined;
}

/**
 * One applied step of the shared composition. A view at `seq - 1` whose rows
 * pin `before` observes `delta`; a view at `seq` is current; any other view
 * re-observes the complete rows.
 */
export interface SceneAdvance {
  readonly entry: CompositionEntry;
  readonly seq: number;
  readonly before: number;
  readonly delta: RenderSceneApplyResult | undefined;
  /** The step remapped World indices of the rows at `before` ahead of `delta`. */
  readonly remapped: boolean;
  readonly materialUpdates: readonly MaterialResource[];
}

type PersistentGpuSceneInspection = PersistentRenderSceneInspection['gpu'];

/** The complete retained composition a frame reads, with its source currency checks. */
export interface RetainedComposition {
  readonly identity: object;
  readonly revision: number;
  readonly worlds: readonly RenderResourceScope[];
  readonly slots: FrameList<RenderSceneSlot>;
  readonly materials: MaterialFrame;
  readonly meshes: import('./mesh-frame').MeshFrame;
  isCurrent(): boolean;
  /** The current source still matches the versions consumed by extraction. */
  isSourceCurrent(): boolean;
}

/**
 * World boxes seeded by a rebuild so the change log proves the old box of
 * each slot's first later change instead of reporting it unbounded.
 */
function sceneSnapshotBounds(projection: RenderScene): GpuSceneSlotBounds {
  return (slot) => projection.cullingWorldBoundsAt(slot);
}

function sourceMembershipChanged(world: World, slot: RenderSceneSlot): boolean {
  const entity = slot.entityKey as EntityHandle;
  const snapshot = slot.snapshot;
  const skin = (world.components.resolve(Skin.name) as typeof Skin | undefined) ?? Skin;
  return (
    !world.hasComponent(entity, GlobalTransform) ||
    (snapshot.instances !== undefined) !== world.hasComponent(entity, Instances) ||
    (snapshot.spriteInstances !== undefined) !== world.hasComponent(entity, SpriteInstances) ||
    (snapshot.skinBinding !== undefined) !== world.hasComponent(entity, skin) ||
    (snapshot.morph !== undefined) !== world.hasComponent(entity, MorphWeights) ||
    (snapshot.pointsLines?.component === 'Points') !== world.hasComponent(entity, Points) ||
    (snapshot.pointsLines?.component === 'Lines') !== world.hasComponent(entity, Lines)
  );
}

function bindMaterialDispatch(
  frame: ExtractedFrame,
  projection: RenderScene,
  dispatch = new MaterialDispatch(),
): MaterialDispatch {
  for (const snapshot of frame.renderables) {
    const slot = projection.slot(snapshot.worldId, snapshot.entityKey);
    if (slot !== undefined) dispatch.bind(slot.slot, snapshot);
  }
  return dispatch;
}

function topologyDeltaForAvailable(
  delta: RenderSceneApplyResult,
  unavailableSlots: ReadonlySet<number>,
  newlyUnavailable: FrameList<RenderSceneSlot>,
): RenderSceneApplyResult {
  const updatedSlots = delta.updatedSlots.filter((slot) => !unavailableSlots.has(slot.slot));
  const unavailableUpdates = newlyUnavailable.map((slot) => ({
    ...slot,
    snapshot: { ...slot.snapshot, gpuDrivenDraws: [] },
  }));
  const contentUpdatedSlots = delta.contentUpdatedSlots?.filter(
    (slot) => !unavailableSlots.has(slot.slot),
  );
  const instanceUpdatedSlots = delta.instanceUpdatedSlots?.filter(
    (slot) => !unavailableSlots.has(slot.slot),
  );
  const contentBySlot =
    contentUpdatedSlots === undefined
      ? undefined
      : new Map(contentUpdatedSlots.map((slot) => [slot.slot, slot]));
  for (const slot of unavailableUpdates) contentBySlot?.set(slot.slot, slot);
  return {
    ...delta,
    updatedSlots: [...updatedSlots, ...unavailableUpdates],
    ...(contentBySlot === undefined ? {} : { contentUpdatedSlots: [...contentBySlot.values()] }),
    ...(instanceUpdatedSlots === undefined ? {} : { instanceUpdatedSlots }),
  };
}

/** One frame's observed World change evidence, before any producer runs. */
interface CompositionChanges {
  readonly changedEntitiesByWorld: Set<number>[];
  readonly contentChangedByWorld: Set<number>[];
  readonly nextReadVersions: RenderReadVersion[];
  readonly sourceBatches: StateProjectionBatch[];
  readonly sourceRowsByWorld: (readonly (RenderSourceEntity | undefined)[])[];
  readonly removedSlots: RenderSceneSlot[];
  readonly transformSpans: WorldTransformSpan[];
}

/** Can the retained composition advance incrementally over exactly these Worlds and leases? */
function sameCompositionInputs(
  entry: CompositionEntry,
  worlds: readonly World[],
  leases: readonly RenderReadLease[],
): boolean {
  return (
    entry.worlds.length === worlds.length &&
    !entry.worlds.some((world, index) => world.world !== worlds[index]) &&
    leases.length === worlds.length
  );
}

/** A pure reorder of the same Worlds under the same leases keeps per-entity visibility. */
function preservesVisibilityOnReorder(
  entry: CompositionEntry | undefined,
  worlds: readonly World[],
  leases: readonly RenderReadLease[] | undefined,
): boolean {
  if (entry === undefined) return false;
  const sameWorldSet =
    entry.worlds.length === worlds.length &&
    entry.worlds.every((world) => worlds.some((local) => local === world.world));
  const worldOrderChanged =
    sameWorldSet && entry.worlds.some((world, index) => world.world !== worlds[index]);
  const leaseSetPreserved =
    leases !== undefined &&
    leases.length === worlds.length &&
    entry.readLeases.length === leases.length &&
    entry.readLeases.every((lease) => leases.includes(lease));
  return worldOrderChanged && leaseSetPreserved;
}

/** Did this row gain/lose a structural component or its scene membership facts? */
function sourceRowMembershipChanged(
  entry: CompositionEntry,
  world: World,
  worldId: number,
  batch: StateProjectionBatch,
  index: number,
  entity: number,
): boolean {
  if (batch.hasStructuralChange(index)) return true;
  if (!batch.membershipChanged) return false;
  const existing = entry.projection.slot(worldId, entity);
  return existing === undefined || sourceMembershipChanged(world, existing);
}

/** A hierarchy change re-extracts every renderable descendant of its root. */
function markHierarchyDependents(
  world: World,
  root: EntityHandle,
  visited: Set<number>,
  changed: Set<number>,
  content: Set<number>,
): void {
  const pending: EntityHandle[] = [root];
  while (pending.length > 0) {
    const dependent = pending.pop();
    if (dependent === undefined || visited.has(dependent)) continue;
    visited.add(dependent);
    const children = world.hasComponent(dependent, Children)
      ? world.get(dependent, Children)
      : undefined;
    if (children?.ok)
      for (const child of children.value.entities) pending.push(child as EntityHandle);
    if (!isRenderableMember(world, dependent)) continue;
    changed.add(dependent);
    content.add(dependent);
  }
}

/**
 * Change queries have been observed, but this publication never ran.
 * Retain every consumed transform identity for the producer retry.
 */
function retainObservedTransforms(
  entry: CompositionEntry,
  transformSpans: readonly WorldTransformSpan[],
): void {
  for (const span of transformSpans) {
    const pending = entry.pendingRenderableEntitiesByWorld[span.worldId];
    for (const entity of span.entities) {
      if (entry.projection.has(span.worldId, entity)) pending?.add(entity);
    }
  }
}

/** New or content-changed rows replace their snapshot; others update only their instances. */
function partialUpdateOperation(
  entry: CompositionEntry,
  changes: CompositionChanges,
  snapshot: RenderableSnapshot,
): RenderSceneOperation {
  const existing = entry.projection.slot(snapshot.worldId, snapshot.entityKey);
  const contentChanged =
    existing === undefined ||
    changes.contentChangedByWorld[snapshot.worldId]?.has(snapshot.entityKey);
  return {
    kind: 'update',
    worldId: snapshot.worldId,
    entityKey: snapshot.entityKey,
    ...(contentChanged || snapshot.instances === undefined
      ? { snapshot }
      : { instances: snapshot.instances }),
  };
}

/** Drop reports for re-requested or departed entities, then append the producer's new ones. */
function refreshHiddenEntityReports(
  entry: CompositionEntry,
  worlds: readonly World[],
  changedEntitiesByWorld: readonly Set<number>[],
  partial: ExtractedFrame | undefined,
): void {
  const worldIndices = new Map(worlds.map((world, index) => [world, index]));
  entry.hiddenEntityReports = [
    ...entry.hiddenEntityReports.filter((report) => {
      const worldId = worldIndices.get(report.world);
      return (
        worldId !== undefined &&
        !changedEntitiesByWorld[worldId]?.has(report.entity) &&
        isRenderableMember(report.world, report.entity)
      );
    }),
    ...(partial?.hiddenEntityReports ?? []),
  ];
}

/** Clear published or departed requests; keep unpublished ones pending and out of dispatch. */
function settleRequestedIdentities(
  entry: CompositionEntry,
  worlds: readonly World[],
  changedEntitiesByWorld: readonly Set<number>[],
  publishedEntitiesByWorld: readonly Set<number>[],
): void {
  for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
    const requested = changedEntitiesByWorld[worldId];
    const published = publishedEntitiesByWorld[worldId];
    if (requested === undefined || published === undefined) continue;
    const pending = entry.pendingRenderableEntitiesByWorld[worldId];
    for (const entityKey of requested) {
      const slot = entry.projection.slot(worldId, entityKey);
      if (published.has(entityKey)) {
        pending?.delete(entityKey);
        continue;
      }
      if (slot === undefined) {
        const world = worlds[worldId];
        if (world !== undefined && !isRenderableMember(world, entityKey))
          pending?.delete(entityKey);
        continue;
      }
      // The producer did not publish this requested identity. Keep the
      // old CPU slot for recovery, but stop submitting stale dispatch and
      // retry the same identity even if its World version stays still.
      pending?.add(entityKey);
      entry.materialDispatch.remove(slot.slot);
    }
  }
}

/** Mark unpublished retained slots unavailable; return those that just became so. */
function updateUnavailableSlots(
  entry: CompositionEntry,
  changedEntitiesByWorld: readonly Set<number>[],
  publishedEntitiesByWorld: readonly Set<number>[],
  delta: RenderSceneApplyResult,
): RenderSceneSlot[] {
  const newlyUnavailable: RenderSceneSlot[] = [];
  for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
    const requested = changedEntitiesByWorld[worldId];
    const published = publishedEntitiesByWorld[worldId];
    if (requested === undefined || published === undefined) continue;
    for (const entityKey of requested) {
      const slot = entry.projection.slot(worldId, entityKey);
      if (slot === undefined || published.has(entityKey)) {
        if (slot !== undefined) entry.unavailableSlots = entry.unavailableSlots.without(slot.slot);
        continue;
      }
      if (!entry.unavailableSlots.has(slot.slot)) newlyUnavailable.push(slot);
      entry.unavailableSlots = entry.unavailableSlots.with(slot.slot);
    }
  }
  for (const removed of delta.removedSlots)
    entry.unavailableSlots = entry.unavailableSlots.without(removed.slot);
  for (const recreated of delta.recreatedSlots)
    entry.unavailableSlots = entry.unavailableSlots.without(recreated.slot);
  return newlyUnavailable;
}

/** Each removed or (re)published slot replaces its retained asset roots. */
function replaceSlotAssetClosures(
  entry: CompositionEntry,
  worlds: readonly World[],
  delta: RenderSceneApplyResult,
): void {
  for (const removed of delta.removedSlots) {
    const world = worlds[removed.worldId];
    if (world !== undefined) entry.assetClosures.get(world)?.replace(removed.entityKey, []);
  }
  for (const slot of [
    ...delta.createdSlots,
    ...delta.contentUpdatedSlots,
    ...delta.recreatedSlots,
  ]) {
    const world = worlds[slot.worldId];
    if (world !== undefined)
      entry.assetClosures.get(world)?.replace(slot.entityKey, renderableAssetRoots(slot.snapshot));
  }
}

/** Accept every validated source batch and adopt its captured membership rows. */
function acceptObservedSources(entry: CompositionEntry, changes: CompositionChanges): void {
  for (let worldId = 0; worldId < changes.sourceBatches.length; worldId++) {
    const batch = changes.sourceBatches[worldId];
    const source = entry.sourceStates[worldId];
    if (batch === undefined || source === undefined) continue;
    const sourceRows = changes.sourceRowsByWorld[worldId];
    if (sourceRows === undefined) throw new Error('Missing captured source observations');
    batch.accept();
    if (!batch.membershipChanged) continue;
    acceptRenderSourceEntities(source, batch.indices, sourceRows);
  }
}

const EMPTY_MATERIAL_UPDATES: readonly MaterialResource[] = Object.freeze([]);

/**
 * The renderer's shared scene preparation. It consumes each publication or
 * World change set once, owns the composition, its Skin inputs and the one
 * GPU Scene, and records each applied step as a {@link SceneAdvance}. Views
 * (one {@link PersistentRenderScene} each) hold only camera-dependent state
 * and catch up from the latest advance.
 */
export class SceneComposition {
  private readonly skinAdoption = new CompositionSkinAdoption({
    inputArena: () => this.inputArena(),
    abandon: () => {
      this.composition?.projection.dispose();
      this.composition = undefined;
      this.invalidate();
    },
  });

  private readonly visibilityWorldKeys = new Map<string, number>();
  private nextVisibilityWorldKey = 0;
  private materialSnapshotCaches: MaterialSnapshotCachesByWorld = new WeakMap();
  private materialContextKey: string | undefined;
  private readonly assetConsumers = new Set<
    (scope: RenderResourceScope, change: AssetChange) => void
  >();
  private readonly assetObservers = new Map<
    World,
    ReturnType<AssetRegistry['observe']> extends Result<infer T, unknown> ? T : never
  >();
  private materialContext: MaterialCookRasterContext | undefined;
  private terrainAssets: AssetRegistry | undefined;

  /** The renderer asset service for source projections: the latest observed registry, else the construction option. */
  get sourceAssets(): AssetRegistry | undefined {
    return this.terrainAssets ?? this.options.assets;
  }

  readonly terrainSources = new TerrainSourceCache();
  readonly glyphSources = new GlyphSources();
  readonly tilemapSources = new TilemapSources();
  private composition: CompositionEntry | undefined;
  private latest: SceneAdvance | undefined;
  private advances = 0;
  private passes: { readonly entry: CompositionEntry; readonly list: DispatchList } | undefined;
  /** Publication revision and World read epoch the latest advance consumed. */
  private consumedRevision: number | undefined;
  private extractedFrame: number | undefined;
  /** Resource-frame roots each World closure fences in the current renderer frame. */
  private readonly resourceFrameRoots = new Map<World, readonly number[]>();
  private committedFrame: number | undefined;
  private historyFrame: number | undefined;
  private fullRebuilds = 0;
  private worldEntitiesScanned = 0;
  private sceneTableUploadBytes = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private transformUpdates = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;
  private gpuScene: GpuScene | undefined;
  private readonly retiredGpuScenes = new Set<GpuScene>();
  private gpuOwner: object | undefined;
  private gpuDevice: RhiDevice | undefined;
  private gpuStatus: 'inactive' | 'unsupported' | 'resident' | 'rebuild-pending' | 'error' =
    'inactive';
  private numericArena: GpuInputArena | undefined;
  /** Advances when every view's active-entity revision must restart. */
  activeEntityEpoch = 0;

  constructor(private readonly options: SceneCompositionOptions = {}) {
    if (options.onAssetChange !== undefined) this.assetConsumers.add(options.onAssetChange);
  }

  /** Live private consumers observe shared adoption even while their view does not draw. */
  subscribeAssetChanges(
    listener: (scope: RenderResourceScope, change: AssetChange) => void,
  ): () => void {
    this.assetConsumers.add(listener);
    return () => {
      this.assetConsumers.delete(listener);
    };
  }

  private notifyAssetChange(scope: RenderResourceScope, change: AssetChange): void {
    const failures: unknown[] = [];
    for (const consumer of this.assetConsumers) {
      try {
        consumer(scope, change);
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(failures, 'Render asset consumers failed', { cause: failures[0] });
    if (failures.length === 1) throw failures[0];
  }

  get terrainLayers(): TerrainLayers | undefined {
    return this.options.terrainLayers;
  }

  get instanceCollections(): InstanceProjectionStore | undefined {
    return this.options.instanceCollections;
  }

  get entry(): CompositionEntry | undefined {
    return this.composition;
  }

  /** The latest applied step of the current composition. */
  get advance(): SceneAdvance | undefined {
    return this.latest?.entry === this.composition ? this.latest : undefined;
  }

  get gpuSceneResident(): GpuScene | undefined {
    const entry = this.composition;
    return entry !== undefined && this.gpuOwner === entry.token && this.gpuStatus === 'resident'
      ? this.gpuScene
      : undefined;
  }

  get structureMetrics() {
    return {
      worldEntitiesScanned: this.worldEntitiesScanned,
      sceneTableUploadBytes: this.sceneTableUploadBytes,
    };
  }

  private record(
    entry: CompositionEntry,
    before: number,
    delta: RenderSceneApplyResult | undefined,
    materialUpdates: readonly MaterialResource[],
    remapped = false,
  ): SceneAdvance {
    this.advances += 1;
    this.latest = Object.freeze({
      entry,
      seq: this.advances,
      before,
      delta,
      remapped,
      materialUpdates,
    });
    return this.latest;
  }

  prepareMeshMaterial(
    world: RenderResourceScope | undefined,
    handle: number,
    geometry: MeshMaterialGeometry,
    vertexColor: boolean,
    assets = this.options.assets,
  ): MaterialResource {
    if (world?.world?.assets !== undefined) assets = runtimeAssetRegistry(world.world.assets);
    if (world === undefined || assets === undefined)
      throw new Error(
        'Mesh material preparation requires an accepted resource scope and asset service',
      );
    let contexts = this.materialSnapshotCaches.get(world);
    if (contexts === undefined) {
      contexts = new Map();
      this.materialSnapshotCaches.set(world, contexts);
    }
    const revision = world.assetRevision(handle);
    const publication = world.revision;
    const context = this.materialContextKey;
    const snapshot = resolveMaterialSnapshot(
      handle,
      world,
      assets,
      undefined,
      materialSnapshotContext(contexts, geometry, vertexColor),
      this.materialContext === undefined ? undefined : { ...this.materialContext, geometry },
      undefined,
      vertexColor,
      geometry,
    );
    if (
      world.assetRevision(handle) !== revision ||
      world.revision !== publication ||
      this.materialContextKey !== context
    )
      throw new Error('Material source changed during Pass preparation');
    return MaterialResource.from(snapshot);
  }
  private adoptAssetChanges(
    worlds: readonly World[],
    assets: AssetRegistry,
  ): { readonly materialUpdates: readonly MaterialResource[]; readonly changed: boolean } {
    let updates: MaterialResource[] | undefined;
    let changed = false;
    for (let worldId = 0; worldId < worlds.length; worldId++) {
      const world = worlds[worldId];
      if (world?.assets === undefined) continue;
      let observer = this.assetObservers.get(world);
      if (observer === undefined) {
        observer = runtimeAssets(world.assets).observe().unwrap();
        this.assetObservers.set(world, observer);
      }
      const batch = observer.read().unwrap();
      this.terrainSources.adopt(worldRenderResources(world), batch.changes);
      this.glyphSources.adopt(worldRenderResources(world), batch.changes);
      this.tilemapSources.adopt(worldRenderResources(world), batch.changes);
      this.options.terrainLayers?.adopt(worldRenderResources(world), batch.changes);
      changed ||= batch.changes.length > 0;
      const closure = this.composition?.assetClosures.get(world);
      if (closure !== undefined) {
        const previous = closure.revision;
        closure.adopt(batch.changes);
        if (closure.revision !== previous && this.composition !== undefined)
          this.composition.assetRevision++;
      }
      const contexts = this.materialSnapshotCaches.get(worldRenderResources(world));
      for (const change of batch.changes) {
        this.adoptLocalAsset(world, worldId, change);
        if (contexts === undefined) continue;
        for (const { cache, geometry, vertexColor } of contexts.values()) {
          if (!cache.has(change.handle)) continue;
          if (change.removed) {
            cache.delete(change.handle);
            continue;
          }
          const snapshot = resolveMaterialSnapshot(
            change.handle,
            worldRenderResources(world),
            assets,
            undefined,
            cache,
            this.materialContext === undefined ? undefined : { ...this.materialContext, geometry },
            undefined,
            vertexColor,
          );
          const resource = materialResource(snapshot);
          if (resource !== undefined) {
            updates ??= [];
            updates.push(resource);
          }
        }
      }
      batch.accept();
    }
    return { materialUpdates: updates ?? EMPTY_MATERIAL_UPDATES, changed };
  }
  private adoptLocalAsset(world: World, worldId: number, change: AssetChange): void {
    if (world.assets === undefined) return;
    this.notifyAssetChange(worldRenderResources(world), change);
    const mesh = change.removed
      ? undefined
      : runtimeAssets(world.assets).borrow<MeshAsset>(change.handle);
    if (
      (change.removed || (mesh?.ok && mesh.value.kind === 'mesh')) &&
      this.composition?.projection.adoptMesh(
        worldId,
        change.handle,
        mesh?.ok ? mesh.value : undefined,
      ) === true &&
      isMeshContentPatch(change)
    )
      this.composition?.topology.recordContentPatch();
    const skeleton = this.composition?.skin;
    if (skeleton !== undefined) {
      const definition = change.removed
        ? undefined
        : runtimeAssets(world.assets).borrow<SkeletonAsset>(change.handle);
      this.skinAdoption.skeleton(
        this.composition as CompositionEntry,
        worldId,
        change.handle,
        definition?.ok && definition.value.kind === 'skeleton' ? definition.value : undefined,
      );
    }
  }
  private inputArena(): GpuInputArena {
    this.numericArena ??= new GpuInputArena();
    this.numericArena.assertLive();
    return this.numericArena;
  }
  /** Check before capturing/adopting a composition, never midway through an edit. */
  private retireFailedInputArena(): void {
    const arena = this.numericArena;
    if (arena === undefined) return;
    try {
      arena.assertLive();
      return;
    } catch (cause) {
      const scene = this.gpuScene,
        device = this.gpuDevice;
      this.numericArena = undefined;
      this.gpuScene = undefined;
      this.gpuDevice = undefined;
      this.gpuOwner = undefined;
      this.gpuStatus = this.options.getDevice === undefined ? 'inactive' : 'rebuild-pending';
      const failures: unknown[] = [];
      // Abandon the failed address space before Skin/GPU owners release ranges.
      // Their physical buffers retain their existing submission completion owner.
      try {
        arena.dispose();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      try {
        this.invalidate();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      try {
        this.retireGpuScene(scene, device);
      } catch (cleanup) {
        failures.push(cleanup);
      }
      if (failures.length > 0)
        throw new AggregateError([cause, ...failures], 'Failed numeric arena retirement', {
          cause,
        });
    }
  }
  /** Cold initialization is derived from the retained source, not a second watermark. */
  publicationBaselineRequired(
    resources: RenderResourceScope,
    scene?: PreparedRenderPublication['scene'],
  ): boolean {
    this.retireFailedInputArena();
    const entry = this.composition;
    if (entry === undefined || entry.worlds.length !== 1 || entry.worlds[0] !== resources)
      return true;
    // Another view of this frame already applied this publication.
    if (this.latest?.entry === entry && this.consumedRevision === resources.revision) return false;
    return (
      scene !== undefined &&
      (entry.projection.sceneRows !== scene.rows || scene.before !== entry.projection.observedRows)
    );
  }

  /** RenderScene owns the per-World material fact cache used during extraction. */
  materialSnapshotCacheStore(context?: MaterialCookRasterContext): MaterialSnapshotCachesByWorld {
    this.materialContext = context;
    if (context !== undefined) {
      const key = materialProgramContextKey(context);
      if (key !== this.materialContextKey) {
        if (this.materialContextKey !== undefined) {
          this.materialSnapshotCaches = new WeakMap();
          this.invalidate();
        }
        this.materialContextKey = key;
      }
    }
    return this.materialSnapshotCaches;
  }

  private visibilityWorldKey(world: RenderResourceScope | undefined, fallback: number): number {
    if (world === undefined) return fallback;
    const existing = this.visibilityWorldKeys.get(world.identity);
    if (existing !== undefined) return existing;
    const key = this.nextVisibilityWorldKey;
    this.nextVisibilityWorldKey += 1;
    this.visibilityWorldKeys.set(world.identity, key);
    return key;
  }

  /** Stable World routing keys for the current worlds[] frame projection. */
  visibilityWorldKeysFor(worlds: readonly RenderResourceScope[]): readonly number[] {
    return worlds.map((world, worldId) => this.visibilityWorldKey(world, worldId));
  }

  /** Current retained slots, available to CPU query transport as well as GPU. */
  compositionSlots(): SceneSlotFrame {
    return this.composition?.projection.slotsSnapshot() ?? EMPTY_SLOT_FRAME;
  }

  compositionSlot(worldId: number, entityKey: number): RenderSceneSlot | undefined {
    return this.composition?.projection.slot(worldId, entityKey);
  }
  /**
   * Apply one prepared publication to the shared composition. Every view of
   * a frame passes the same publication revision; only the first applies it.
   */
  consume(input: PreparedRenderPublication): SceneAdvance {
    const { resources, packet } = input;
    const current = this.composition;
    if (
      current !== undefined &&
      this.latest?.entry === current &&
      this.consumedRevision === packet.revision &&
      current.worlds.length === 1 &&
      current.worlds[0] === resources
    )
      return this.latest;
    this.validatePublication(input);
    const fresh = current === undefined || packet.baseline;
    const entry = fresh ? this.initializePublication(input) : current;
    if (entry === undefined) throw new Error('publication admission requires a composition');
    entry.projection.setSources([resources]);
    this.worldEntitiesScanned = 0;
    this.sceneTableUploadBytes = 0;
    this.terrainSources.adopt(resources, input.assetChanges);
    this.glyphSources.adopt(resources, input.assetChanges);
    this.tilemapSources.adopt(resources, input.assetChanges);
    this.options.terrainLayers?.adopt(resources, input.assetChanges);
    this.seedPublishedMaterials(input);
    const before = fresh ? -1 : entry.projection.observedRows;
    for (const change of input.assetChanges) this.adoptPublishedAsset(entry, resources, change);
    const delta = this.applyPublicationRows(entry, input, fresh);
    this.advancePublicationRevision(entry, packet);
    this.queryMaterialPasses(entry);
    this.syncGpuOwner(
      entry.token,
      entry.projection,
      entry.materialDispatch.materials(),
      delta,
      input.materialUpdates,
    );
    this.consumedRevision = packet.revision;
    return this.record(entry, before, delta, input.materialUpdates);
  }

  private validatePublication(input: PreparedRenderPublication): void {
    const { resources, packet } = input;
    if (resources.revision !== packet.revision)
      throw new RenderPublicationError({
        reason: 'revision',
        subject: 'stale prepared scene input',
      });
    if (this.publicationBaselineRequired(resources, input.scene) && !packet.baseline)
      throw new RenderPublicationError({
        reason: 'base',
        subject: 'complete source baseline for cold scene admission',
      });
  }

  private initializePublication(input: PreparedRenderPublication): CompositionEntry {
    const { resources, packet } = input;
    this.invalidate();
    // Every view reads the receiver's shared rows; it owns only derived state.
    const projection = new RenderScene(input.scene.rows);
    const entry: CompositionEntry = {
      token: {},
      worlds: [resources],
      projection,
      assetClosures: new Map(),
      assetRevision: 0,
      topology: new BatchTopology(),
      hiddenEntityReports: [],
      worldKeys: this.visibilityWorldKeysFor([resources]),
      readVersions: [],
      readLeases: [],
      publicationRevision: packet.revision,
      transformQueries: [],
      sourceStates: [],
      materialDispatch: new MaterialDispatch((worldId, handle, geometry, vertexColor) =>
        this.prepareMeshMaterial(
          worldId === 0 ? resources : undefined,
          handle,
          geometry,
          vertexColor,
        ),
      ),
      skin: undefined,
      pendingRenderableEntitiesByWorld: [],
      unavailableSlots: new FrameSet(),
      probeProjection: new ProbeBlendSceneProjection(),
      probeObjects: undefined,
    };
    this.composition = entry;
    this.fullRebuilds++;
    this.lastResyncReason = 'attach';
    return entry;
  }

  private seedPublishedMaterials(input: PreparedRenderPublication): void {
    const { resources } = input;
    // A publication already owns these exact prepared resources. Seed the same
    // context cache used by local preparation, so actual Mesh selection reuses
    // its identity instead of creating a second projection and GPU upload.
    let contexts = this.materialSnapshotCaches.get(resources);
    for (const material of input.materialUpdates) {
      const snapshot = material.snapshot;
      const context = snapshot.materialContext;
      const handle = snapshot.materialHandle;
      if (context === undefined || handle === undefined) continue;
      contexts ??= new Map();
      materialSnapshotContext(contexts, context.geometry, context.vertexColor).set(handle, {
        snapshot,
        assetRevision: resources.assetRevision(handle) ?? 0,
      });
    }
    if (contexts !== undefined) this.materialSnapshotCaches.set(resources, contexts);
  }

  private adoptPublishedAsset(
    entry: CompositionEntry,
    resources: RenderResourceScope,
    change: AssetChange,
  ): void {
    this.notifyAssetChange(resources, change);
    const mesh = change.removed ? undefined : resources.resolveAsset<MeshAsset>(change.handle);
    if (
      (change.removed || (mesh?.ok && mesh.value.kind === 'mesh')) &&
      entry.projection.adoptMesh(0, change.handle, mesh?.ok ? mesh.value : undefined) &&
      isMeshContentPatch(change)
    )
      entry.topology.recordContentPatch();
    const definition = change.removed
      ? undefined
      : resources.resolveAsset<SkeletonAsset>(change.handle);
    this.skinAdoption.skeleton(
      entry,
      0,
      change.handle,
      definition?.ok && definition.value.kind === 'skeleton' ? definition.value : undefined,
    );
    this.adoptPublishedMaterial(entry, resources, change);
  }

  private adoptPublishedMaterial(
    entry: CompositionEntry,
    resources: RenderResourceScope,
    change: AssetChange,
  ): void {
    const materialDispatch = entry.materialDispatch;
    for (const { cache, geometry, vertexColor } of this.materialSnapshotCaches
      .get(resources)
      ?.values() ?? []) {
      const cached = cache.get(change.handle);
      if (cached === undefined) continue;
      if (change.removed) {
        cache.delete(change.handle);
        continue;
      }
      if (cached.assetRevision === change.revision) continue;
      const assets = this.options.assets;
      if (assets === undefined)
        throw new Error('Published material adoption requires the renderer asset service');
      const snapshot = resolveMaterialSnapshot(
        change.handle,
        resources,
        assets,
        undefined,
        cache,
        this.materialContext === undefined ? undefined : { ...this.materialContext, geometry },
        undefined,
        vertexColor,
      );
      materialDispatch.adopt(MaterialResource.from(snapshot));
    }
  }

  private applyPublicationRows(
    entry: CompositionEntry,
    input: PreparedRenderPublication,
    fresh: boolean,
  ): RenderSceneApplyResult {
    const { packet } = input;
    let delta: RenderSceneApplyResult;
    // The publication wrote these rows: one read generation for every view.
    rotateMeshDraws();
    // A new view starts at the complete current rows; later deltas apply only
    // on top of the rows revision the view observed.
    if (fresh) delta = entry.projection.observeBaseline();
    else if (
      input.scene.delta === undefined ||
      input.scene.before !== entry.projection.observedRows
    )
      throw new RenderPublicationError({
        reason: 'base',
        subject: 'complete source baseline for an unobserved row delta',
      });
    else {
      delta = input.scene.delta;
      entry.projection.observe(delta, input.operations.length);
    }
    this.skinAdoption.apply(entry, delta);
    this.skinAdoption.published(
      entry,
      packet.baseline,
      input.skinJoints?.retired ?? [],
      input.skinJoints?.rows ?? [],
      packet.transformEntities,
      packet.transforms,
    );
    for (const removed of delta.removedSlots) {
      entry.materialDispatch.remove(removed.slot);
    }
    for (const recreated of delta.recreatedSlots) entry.materialDispatch.remove(recreated.slot);
    // Every published row (complete snapshot) replaces its slot's dispatch binding.
    for (const slots of [delta.createdSlots, delta.recreatedSlots, delta.contentUpdatedSlots])
      for (const slot of slots) entry.materialDispatch.bind(slot.slot, slot.snapshot);
    if (
      delta.created + delta.recreated + delta.contentUpdatedSlots.length > 0 ||
      packet.removed.length
    ) {
      this.activeEntityEpoch += 1;
    }
    entry.topology.apply(delta);
    for (const material of input.materialUpdates) entry.materialDispatch.adopt(material);
    entry.materialDispatch.prepare(entry.projection.meshFrame());
    if (input.operations.length || delta.created > 0) this.deltaFrames++;
    else this.noChangeFrames++;
    this.transformUpdates += delta.updated;
    return delta;
  }

  private advancePublicationRevision(
    entry: CompositionEntry,
    packet: PreparedRenderPublication['packet'],
  ): void {
    if (
      packet.assets.length > 0 ||
      packet.assetPatches.length > 0 ||
      packet.materials.length > 0 ||
      packet.retiredAssets.length > 0
    )
      entry.assetRevision++;
    entry.publicationRevision = packet.revision;
  }
  /**
   * Observe the source Worlds into the shared composition. Within one
   * renderer frame (`frameKey`) only the first view observes; later views
   * build only their own resource frame.
   */
  extract(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    assets: AssetRegistry,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases?: readonly RenderReadLease[],
    frameKey?: number,
  ): { readonly advance: SceneAdvance; readonly resourceFrame: ExtractedFrame } {
    const current = this.composition;
    if (
      frameKey !== undefined &&
      frameKey === this.extractedFrame &&
      current !== undefined &&
      this.latest?.entry === current &&
      leases !== undefined &&
      sameCompositionInputs(current, worlds, leases)
    ) {
      const resourceFrame = buildCandidateFrame('none');
      this.fenceResourceFrame(current.assetClosures, worlds[owner.resourceOwner], resourceFrame);
      return { advance: this.latest, resourceFrame };
    }
    this.extractedFrame = undefined;
    const observed = this.observeSources(worlds, owner, assets, buildCandidateFrame, leases);
    this.extractedFrame = frameKey;
    return observed;
  }

  private observeSources(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    assets: AssetRegistry,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases: readonly RenderReadLease[] | undefined,
  ): { readonly advance: SceneAdvance; readonly resourceFrame: ExtractedFrame } {
    this.retireFailedInputArena();
    this.worldEntitiesScanned = 0;
    this.sceneTableUploadBytes = 0;
    this.terrainAssets = assets;
    const { materialUpdates, changed: assetsChanged } = this.adoptAssetChanges(worlds, assets);
    for (const material of materialUpdates) this.composition?.materialDispatch.adopt(material);
    const entry = this.composition;
    if (
      entry === undefined ||
      leases === undefined ||
      !sameCompositionInputs(entry, worlds, leases)
    ) {
      return this.reconcileComposition(
        worlds,
        owner,
        buildCandidateFrame,
        leases,
        preservesVisibilityOnReorder(entry, worlds, leases),
      );
    }
    const before = entry.projection.observedRows;
    const changes = this.observeCompositionChanges(entry, worlds, leases);

    // Query iteration is an observation step, not publication. Persist every
    // requested identity before invoking any producer so a thrown or omitted
    // partial extraction is retried even after ECS change evidence is drained.
    for (let worldId = 0; worldId < changes.changedEntitiesByWorld.length; worldId += 1) {
      const pending = entry.pendingRenderableEntitiesByWorld[worldId];
      if (pending === undefined) continue;
      for (const entityKey of changes.changedEntitiesByWorld[worldId] ?? []) pending.add(entityKey);
    }

    const resourceFrame = buildCandidateFrame('none');
    for (const batch of changes.sourceBatches) batch.validate();
    const changedDelta = this.applyCompositionChanges(entry, worlds, changes, buildCandidateFrame);
    if (changedDelta === undefined) {
      this.noChangeFrames += 1;
      entry.materialDispatch.prepare(entry.projection.meshFrame());
    } else {
      replaceSlotAssetClosures(entry, worlds, changedDelta);
    }
    this.resourceFrameRoots.clear();
    this.fenceResourceFrame(entry.assetClosures, worlds[owner.resourceOwner], resourceFrame);
    this.skinAdoption.initializeJoints(entry);
    // The Pass query resolves material rows the GPU Scene sync uploads.
    this.queryMaterialPasses(entry);
    this.syncGpuOwner(
      entry.token,
      entry.projection,
      entry.materialDispatch.materials(),
      changedDelta,
      materialUpdates,
    );
    acceptObservedSources(entry, changes);
    entry.readLeases = [...leases];
    for (let worldId = 0; worldId < changes.nextReadVersions.length; worldId += 1) {
      const version = changes.nextReadVersions[worldId];
      if (version !== undefined) entry.readVersions[worldId] = version;
    }
    const advance =
      changedDelta === undefined &&
      materialUpdates.length === 0 &&
      !assetsChanged &&
      this.latest?.entry === entry
        ? this.latest
        : this.record(entry, before, changedDelta, materialUpdates);
    return { advance, resourceFrame };
  }

  /** Read each World's change evidence into one frame's requested identities and spans. */
  private observeCompositionChanges(
    entry: CompositionEntry,
    worlds: readonly World[],
    leases: readonly RenderReadLease[],
  ): CompositionChanges {
    const changes: CompositionChanges = {
      changedEntitiesByWorld: worlds.map(
        (_, worldId) => new Set(entry.pendingRenderableEntitiesByWorld[worldId] ?? []),
      ),
      contentChangedByWorld: worlds.map(
        (_, worldId) => new Set(entry.pendingRenderableEntitiesByWorld[worldId] ?? []),
      ),
      nextReadVersions: entry.readVersions.slice(),
      sourceBatches: [],
      sourceRowsByWorld: [],
      removedSlots: [],
      transformSpans: [],
    };
    for (let worldId = 0; worldId < worlds.length; worldId++) {
      const world = worlds[worldId];
      const lease = leases[worldId];
      if (world !== undefined && lease !== undefined)
        this.observeWorldChanges(entry, world, worldId, lease, changes);
    }
    return changes;
  }

  private observeWorldChanges(
    entry: CompositionEntry,
    world: World,
    worldId: number,
    lease: RenderReadLease,
    changes: CompositionChanges,
  ): void {
    const source = entry.sourceStates[worldId];
    const version = entry.readVersions[worldId];
    if (source === undefined || version === undefined) return;
    const read = lease.readChanges(version);
    changes.nextReadVersions[worldId] = read.version;
    const changed = changes.changedEntitiesByWorld[worldId];
    const content = changes.contentChangedByWorld[worldId];
    if (changed === undefined || content === undefined) return;
    if (version.structureEpoch !== read.version.structureEpoch) {
      this.activeEntityEpoch += 1;
    }
    const batch = source.projection.read();
    changes.sourceBatches[worldId] = batch;
    const sourceRows = captureRenderSourceEntities(world, source, batch);
    changes.sourceRowsByWorld[worldId] = sourceRows;
    this.worldEntitiesScanned += batch.scannedRows;
    this.reconcileSourceIdentities(entry, world, worldId, source, batch, sourceRows, changes);
    for (const entity of content) changed.add(entity);
    const query = entry.transformQueries[worldId];
    if (query === undefined) return;
    for (const span of query.spans().unwrap()) {
      const matrices = span.get(GlobalTransform).world;
      if (!(matrices instanceof Float32Array))
        throw new Error('GlobalTransform projection must expose a numeric column.');
      changes.transformSpans.push({ worldId, entities: span.entities, worlds: matrices });
      if (entry.skin !== undefined)
        for (const entity of span.entities) this.skinAdoption.joint(entry, worldId, entity);
    }
  }

  /** Classify each observed source row as removed, membership/content changed, or a hierarchy root. */
  private reconcileSourceIdentities(
    entry: CompositionEntry,
    world: World,
    worldId: number,
    source: ReturnType<typeof createRenderSourceState>,
    batch: StateProjectionBatch,
    sourceRows: readonly (RenderSourceEntity | undefined)[],
    changes: CompositionChanges,
  ): void {
    const changed = changes.changedEntitiesByWorld[worldId];
    const content = changes.contentChangedByWorld[worldId];
    if (changed === undefined || content === undefined) return;
    const dependencyVisited = new Set<number>();
    const contentComponents = source.renderableComponents.filter(
      (component) => component !== Instances && batch.changedComponents.includes(component),
    );
    const instancesChanged = batch.changedComponents.includes(Instances);
    const reconcileIdentities =
      batch.membershipChanged || contentComponents.length > 0 || instancesChanged;
    let sourceCursor = 0;
    for (const index of reconcileIdentities ? batch.indices : []) {
      const currentSource = sourceRows[sourceCursor++];
      const current = currentSource?.entity;
      this.retireReplacedIdentity(
        entry,
        world,
        worldId,
        batch,
        source.entities.get(index)?.entity,
        current,
        changes,
      );
      if (current === undefined) continue;
      let contentChanged = sourceRowMembershipChanged(entry, world, worldId, batch, index, current);
      for (const component of contentComponents) {
        if (source.projection.changed(current, component)) contentChanged = true;
      }
      if (
        (contentChanged || (instancesChanged && source.projection.changed(current, Instances))) &&
        isRenderableMember(world, current)
      ) {
        changed.add(current);
        if (contentChanged) content.add(current);
      }
      if (
        currentSource !== undefined &&
        renderSourceHierarchyChanged(source, index, currentSource) &&
        !dependencyVisited.has(current)
      )
        markHierarchyDependents(world, current, dependencyVisited, changed, content);
    }
  }

  /** Release the identity a source row previously held when it was replaced or left the scene. */
  private retireReplacedIdentity(
    entry: CompositionEntry,
    world: World,
    worldId: number,
    batch: StateProjectionBatch,
    previous: number | undefined,
    current: number | undefined,
    changes: CompositionChanges,
  ): void {
    if (previous === undefined) return;
    if (previous !== current || !world.hasComponent(previous as EntityHandle, GlobalTransform))
      this.skinAdoption.joint(entry, worldId, previous);
    const slot = entry.projection.slot(worldId, previous);
    if (
      batch.membershipChanged &&
      slot !== undefined &&
      (current !== previous || !isRenderableMember(world, previous))
    ) {
      changes.removedSlots.push(slot);
      changes.changedEntitiesByWorld[worldId]?.add(previous);
    }
  }

  /** Publish requested identities through the partial producer and apply the resulting delta. */
  private applyCompositionChanges(
    entry: CompositionEntry,
    worlds: readonly World[],
    changes: CompositionChanges,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
  ): RenderSceneApplyResult | undefined {
    const { changedEntitiesByWorld, removedSlots, transformSpans } = changes;
    const hasChangedEntities = changedEntitiesByWorld.some((entities) => entities.size > 0);
    if (!hasChangedEntities && removedSlots.length === 0 && transformSpans.length === 0)
      return undefined;
    const operations: RenderSceneOperation[] = [];
    for (const slot of removedSlots) {
      operations.push({ kind: 'remove', worldId: slot.worldId, entityKey: slot.entityKey });
    }
    let partial: ExtractedFrame | undefined;
    try {
      partial = hasChangedEntities
        ? buildCandidateFrame({ kind: 'partial', entitiesByWorld: changedEntitiesByWorld })
        : undefined;
    } catch (cause) {
      retainObservedTransforms(entry, transformSpans);
      throw cause;
    }
    const publishedEntitiesByWorld = worlds.map(() => new Set<number>());
    for (const snapshot of partial?.renderables ?? []) {
      operations.push(partialUpdateOperation(entry, changes, snapshot));
      publishedEntitiesByWorld[snapshot.worldId]?.add(snapshot.entityKey);
    }
    for (const batch of changes.sourceBatches) batch.validate();
    const changedDelta = entry.projection.apply(operations, transformSpans);
    this.skinAdoption.apply(entry, changedDelta);
    this.settleInstanceCollections(worlds, changedDelta, partial);
    for (const removed of changedDelta.removedSlots) entry.materialDispatch.remove(removed.slot);
    for (const recreated of changedDelta.recreatedSlots)
      entry.materialDispatch.remove(recreated.slot);
    if (partial !== undefined || removedSlots.length > 0)
      refreshHiddenEntityReports(entry, worlds, changedEntitiesByWorld, partial);
    if (partial !== undefined) {
      // Every published renderable replaces its slot list, including an
      // empty list after failed producer validation.
      bindMaterialDispatch(partial, entry.projection, entry.materialDispatch);
    }
    settleRequestedIdentities(entry, worlds, changedEntitiesByWorld, publishedEntitiesByWorld);
    const newlyUnavailable = updateUnavailableSlots(
      entry,
      changedEntitiesByWorld,
      publishedEntitiesByWorld,
      changedDelta,
    );
    entry.topology.apply(
      topologyDeltaForAvailable(changedDelta, entry.unavailableSlots, newlyUnavailable),
    );
    entry.materialDispatch.prepare(entry.projection.meshFrame());
    this.deltaFrames +=
      changedDelta.created + changedDelta.updated + changedDelta.removed + changedDelta.recreated >
      0
        ? 1
        : 0;
    this.transformUpdates += changedDelta.updated;
    return changedDelta;
  }

  /** Removed slots and published rows release or accept their Instances collections. */
  private settleInstanceCollections(
    worlds: readonly World[],
    delta: RenderSceneApplyResult,
    partial: ExtractedFrame | undefined,
  ): void {
    const collections = this.options.instanceCollections;
    for (const slot of delta.removedSlots) {
      const world = worlds[slot.worldId];
      if (world !== undefined) collections?.release(world, slot.entityKey);
    }
    for (const snapshot of partial?.renderables ?? []) {
      const world = worlds[snapshot.worldId];
      if (world === undefined) continue;
      if (snapshot.instances === undefined) collections?.release(world, snapshot.entityKey);
      else collections?.accept(world, snapshot.entityKey, snapshot.instances);
    }
  }
  private reconcileComposition(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases?: readonly RenderReadLease[],
    preserveVisibilityOnReorder = false,
  ): { readonly advance: SceneAdvance; readonly resourceFrame: ExtractedFrame } {
    const previousEntry = this.composition;
    const resourceScopes = worlds.map(worldRenderResources);
    const sourceStates = worlds.map((world) => createRenderSourceState(world));
    const candidateFrame = buildCandidateFrame({
      kind: 'partial',
      entitiesByWorld: sourceStates.map(
        (source) => new Set([...source.entities.values()].map((row) => row.entity)),
      ),
    });
    for (const source of sourceStates) source.batch.validate();
    this.worldEntitiesScanned = candidateFrame.renderables.length;
    const worldKeys = this.visibilityWorldKeysFor(resourceScopes);
    this.reconcileActiveEntities(
      previousEntry,
      candidateFrame,
      worldKeys,
      preserveVisibilityOnReorder,
    );
    const stableCandidateFrame = candidateFrame;
    const renderables = candidateFrame.renderables;
    const previousSkin = previousEntry?.skin;
    if (previousEntry !== undefined && previousSkin !== undefined) {
      previousEntry.skin = undefined;
      this.composition = undefined;
      try {
        previousSkin.dispose();
      } catch (cause) {
        this.skinAdoption.fail(previousEntry, cause);
      }
    }
    const projection = previousEntry?.projection ?? new RenderScene(resourceScopes);
    const before = previousEntry === undefined ? -1 : projection.observedRows;
    projection.setSources(resourceScopes);
    const materialDispatch = new MaterialDispatch((worldId, handle, geometry, vertexColor) =>
      this.prepareMeshMaterial(
        resourceScopes[worldId],
        handle,
        geometry,
        vertexColor,
        this.sourceAssets,
      ),
    );
    if (previousEntry !== undefined) {
      projection.remapWorlds(previousEntry.worlds.map((world) => resourceScopes.indexOf(world)));
    }
    const delta = this.reconcileRows(projection, renderables, worlds);
    const topology = previousEntry?.topology ?? new BatchTopology();
    topology.apply(delta);
    const assetClosures = this.reconcileAssetClosures(worlds, owner.resourceOwner, candidateFrame);
    const token = previousEntry?.token ?? {};
    const entry: CompositionEntry = {
      token,
      worlds: resourceScopes,
      projection,
      assetClosures,
      assetRevision: previousEntry?.assetRevision ?? 0,
      topology,
      hiddenEntityReports: stableCandidateFrame.hiddenEntityReports,
      worldKeys,
      readLeases: leases === undefined ? [] : [...leases],
      publicationRevision: undefined,
      readVersions:
        leases === undefined || leases.length !== worlds.length
          ? []
          : leases.map((lease) => lease.captureVersion()),
      transformQueries:
        leases === undefined || leases.length !== worlds.length
          ? []
          : worlds.map(createGlobalTransformChangeQuery),
      sourceStates,
      materialDispatch: bindMaterialDispatch(stableCandidateFrame, projection, materialDispatch),
      skin: undefined,
      pendingRenderableEntitiesByWorld: worlds.map(() => new Set<number>()),
      unavailableSlots: new FrameSet(),
      probeProjection: new ProbeBlendSceneProjection(),
      probeObjects: undefined,
    };
    this.composition = entry;
    if (stableCandidateFrame.renderables.some((snapshot) => snapshot.skinBinding !== undefined))
      this.skinAdoption.apply(entry, sceneSnapshotDelta(projection.slotsSnapshot()));
    this.skinAdoption.initializeJoints(entry);
    materialDispatch.prepare(projection.meshFrame());
    this.queryMaterialPasses(entry);
    this.syncGpuOwner(token, projection, materialDispatch.materials(), delta);
    if (previousEntry === undefined) this.fullRebuilds += 1;
    this.lastResyncReason = 'attach';
    for (const source of sourceStates) source.batch.accept();
    return {
      advance: this.record(entry, before, delta, EMPTY_MATERIAL_UPDATES, before >= 0),
      resourceFrame: candidateFrame,
    };
  }

  private reconcileActiveEntities(
    previousEntry: CompositionEntry | undefined,
    candidateFrame: ExtractedFrame,
    worldKeys: readonly number[],
    preserveVisibilityOnReorder: boolean,
  ): void {
    if (!preserveVisibilityOnReorder) {
      this.activeEntityEpoch += 1;
    } else if (previousEntry !== undefined) {
      const previousKeys = new Set(
        previousEntry.projection
          .slotsSnapshot()
          .map((slot) =>
            worldEntityKey(previousEntry.worldKeys[slot.worldId] ?? slot.worldId, slot.entityKey),
          ),
      );
      const currentKeys = new Set(
        candidateFrame.renderables.map((renderable) =>
          worldEntityKey(worldKeys[renderable.worldId] ?? renderable.worldId, renderable.entityKey),
        ),
      );
      if (
        previousKeys.size !== currentKeys.size ||
        [...previousKeys].some((key) => !currentKeys.has(key))
      ) {
        this.activeEntityEpoch += 1;
      }
    }
  }

  private reconcileRows(
    projection: RenderScene,
    renderables: ExtractedFrame['renderables'],
    worlds: readonly World[],
  ): RenderSceneApplyResult {
    const desired = new Set(
      renderables.map((snapshot) => identityKey(snapshot.worldId, snapshot.entityKey)),
    );
    const operations: RenderSceneOperation[] = [];
    for (const slot of projection.slotsSnapshot()) {
      if (!desired.has(identityKey(slot.worldId, slot.entityKey))) {
        operations.push({ kind: 'remove', worldId: slot.worldId, entityKey: slot.entityKey });
      }
    }
    for (const snapshot of renderables) {
      operations.push({
        kind: 'update',
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        snapshot,
      });
    }
    const delta = projection.apply(operations);
    for (const snapshot of renderables) {
      const world = worlds[snapshot.worldId];
      if (world !== undefined && snapshot.instances !== undefined)
        this.options.instanceCollections?.accept(world, snapshot.entityKey, snapshot.instances);
    }
    if (this.options.instanceCollections !== undefined) {
      const collections = new Set<import('../instances').InstanceCollectionId>();
      for (const slot of projection.slotsSnapshot()) {
        const id = slot.snapshot.instances?.collectionId;
        if (id !== undefined) collections.add(id);
      }
      this.options.instanceCollections.retain(collections);
    }
    return delta;
  }

  private reconcileAssetClosures(
    worlds: readonly World[],
    resourceOwner: number,
    candidateFrame: ExtractedFrame,
  ): Map<World, SceneAssetClosure> {
    const renderables = candidateFrame.renderables;
    const assetClosures = new Map<World, SceneAssetClosure>();
    for (const world of worlds)
      if (world.assets !== undefined) assetClosures.set(world, new SceneAssetClosure(world.assets));
    for (const row of renderables) {
      const world = worlds[row.worldId];
      if (world !== undefined)
        assetClosures.get(world)?.replace(row.entityKey, renderableAssetRoots(row));
    }
    this.resourceFrameRoots.clear();
    this.fenceResourceFrame(assetClosures, worlds[resourceOwner], candidateFrame);
    return assetClosures;
  }

  /**
   * A World closure fences the resource frame of every view that read it in
   * one renderer frame: the observing view starts the set and later views of
   * the same frame add their own dependencies.
   */
  private fenceResourceFrame(
    closures: ReadonlyMap<World, SceneAssetClosure>,
    world: World | undefined,
    frame: ExtractedFrame,
  ): void {
    const closure = world === undefined ? undefined : closures.get(world);
    if (world === undefined || closure === undefined) return;
    const handles = publicationFrameDependencies(frame);
    const previous = this.resourceFrameRoots.get(world);
    const roots = previous === undefined ? handles : [...new Set([...previous, ...handles])];
    this.resourceFrameRoots.set(world, roots);
    closure.replace(-1, roots);
  }

  /** Drop the composition; every view re-derives its state from the next advance. */
  invalidate(): void {
    const skin = this.composition?.skin;
    if (this.composition !== undefined) this.composition.skin = undefined;
    // Owned rows leave with their composition.
    this.composition?.projection.dispose();
    this.composition = undefined;
    this.latest = undefined;
    this.passes = undefined;
    this.consumedRevision = undefined;
    this.extractedFrame = undefined;
    this.terrainSources.clear();
    this.glyphSources.clear();
    this.tilemapSources.clear();
    this.activeEntityEpoch += 1;
    this.lastResyncReason = 'explicit-invalidate';
    skin?.dispose();
  }

  /** Whether the GPU Scene is resident for `owner`; GPU-owned rows then skip the CPU cull. */
  gpuResidentFor(owner: object): boolean {
    return this.gpuStatus === 'resident' && this.gpuOwner === owner;
  }

  detach(world: World): void {
    this.assetObservers.get(world)?.dispose();
    this.assetObservers.delete(world);
    this.materialSnapshotCaches.delete(worldRenderResources(world));
    this.terrainSources.detach(worldRenderResources(world));
    this.glyphSources.detach(worldRenderResources(world));
    this.tilemapSources.detach(worldRenderResources(world));
    this.options.terrainLayers?.detach(worldRenderResources(world));
    const detachedComposition = this.composition?.worlds.includes(worldRenderResources(world))
      ? this.composition
      : undefined;
    const skin = detachedComposition?.skin;
    if (detachedComposition !== undefined) {
      detachedComposition.skin = undefined;
      detachedComposition.projection.dispose();
      this.composition = undefined;
      this.latest = undefined;
      this.passes = undefined;
      this.activeEntityEpoch += 1;
    }
    if (this.gpuOwner === world || this.gpuOwner === detachedComposition?.token) {
      // The GPU Scene is renderer-owned. A frame graph recorded for the current
      // device may retain its table bindings after a World detaches, while the
      // next attached composition can rebuild the same tables in place. Keep
      // that single scene resident until device replacement or renderer
      // disposal; retiring it here lets a reused graph submit destroyed buffers.
      this.gpuOwner = undefined;
      this.gpuStatus = this.gpuScene === undefined ? 'inactive' : 'resident';
    }
    skin?.dispose();
  }

  /** Drop only device-owned tables; the CPU projection remains the recovery authority. */
  resetGpuForRecover(): void {
    const scene = this.gpuScene,
      device = this.gpuDevice;
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = this.options.getDevice === undefined ? 'inactive' : 'rebuild-pending';
    this.committedFrame = undefined;
    this.retireGpuScene(scene, device);
  }

  /** Record that a Skin adoption failure retires the composition. */
  failSkin(cause: unknown): never {
    const entry = this.composition;
    if (entry === undefined) throw cause;
    return this.skinAdoption.fail(entry, cause);
  }

  dispose(): void {
    this.assetConsumers.clear();
    const skin = this.composition?.skin;
    if (this.composition !== undefined) this.composition.skin = undefined;
    this.composition?.projection.dispose();
    this.composition = undefined;
    this.latest = undefined;
    this.passes = undefined;
    for (const observer of this.assetObservers.values()) observer.dispose();
    this.assetObservers.clear();
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = 'inactive';
    this.terrainSources.clear();
    this.glyphSources.clear();
    this.tilemapSources.clear();
    this.activeEntityEpoch += 1;
    const arena = this.numericArena;
    this.numericArena = undefined;
    let failure: unknown;
    try {
      skin?.dispose();
    } catch (cause) {
      failure = cause;
    }
    try {
      arena?.dispose();
    } catch (cause) {
      if (failure !== undefined)
        throw new AggregateError([failure, cause], 'Skin and numeric arena retirement failed', {
          cause: failure,
        });
      throw cause;
    }
    if (failure !== undefined) throw failure;
  }

  private retireGpuScene(scene: GpuScene | undefined, device = this.gpuDevice): void {
    if (scene === undefined) return;
    if (device === undefined) {
      scene.dispose();
      return;
    }
    this.retiredGpuScenes.add(scene);
    const release = (): void => {
      if (!this.retiredGpuScenes.delete(scene)) return;
      scene.dispose();
    };
    // Retirement can happen while the current frame is still being encoded
    // (for example when a new composition token is published).  Calling
    // onSubmittedWorkDone() synchronously at that point observes only work
    // already queued and may resolve before the frame that still references
    // this scene is submitted.  Defer fence acquisition to the next
    // microtask, after the synchronous record/submit transaction has had a
    // chance to enqueue its command buffer.
    void Promise.resolve()
      .then(() => {
        try {
          return device.queue.onSubmittedWorkDone();
        } catch {
          return undefined;
        }
      })
      .then(release, release);
  }

  /** Read existing culling bounds; never expose cached mutable arrays. */
  bounds(world: World | RenderPublicationIdentity, entity: number): RenderSceneBounds | undefined {
    const entry = this.composition;
    const identity = 'source' in world ? `${world.source}:${world.epoch}` : world.identity;
    const worldId = entry?.worlds.findIndex((source) => source.identity === identity) ?? -1;
    if (entry === undefined || worldId < 0) return undefined;
    const slot = entry.projection.slot(worldId, entity);
    if (slot === undefined) return undefined;
    const bounds =
      slot.snapshot.skinBinding === undefined
        ? entry.projection.cullingWorldBoundsAt(slot)
        : this.skinQueryBounds(entry, slot);
    if (bounds === undefined) return undefined;
    for (const axis of [0, 1, 2] as const) {
      if (
        !Number.isFinite(bounds.min[axis]) ||
        !Number.isFinite(bounds.max[axis]) ||
        bounds.min[axis] > bounds.max[axis]
      )
        return undefined;
    }
    return { min: [...bounds.min], max: [...bounds.max] };
  }

  /** Out-of-frame queries read the latest adopted pose through the same proof
   * and envelope rules as culling; recording state and history never change. */
  private skinQueryBounds(
    entry: CompositionEntry,
    slot: RenderSceneSlot,
  ): RenderSceneBounds | undefined {
    const current = entry.skin?.capture();
    if (current === undefined) return undefined;
    try {
      const out = box3.create();
      const frame = { slots: entry.projection.slotsSnapshot(), current, previous: undefined };
      return entry.projection.writeCullingWorldBoundsAt(slot, out, undefined, undefined, frame)
        ? boundsFromArray(out)
        : undefined;
    } finally {
      current.release();
    }
  }

  reflectionCaptureRevision(): string {
    return `${this.fullRebuilds}:${this.composition?.projection.contentRevision ?? 0}`;
  }

  topologyRevision(): number {
    return this.composition?.topology.revisionValue() ?? 0;
  }
  materialFrame(): MaterialFrame | undefined {
    return this.composition?.materialDispatch.materials();
  }

  inspect(): Omit<PersistentRenderSceneInspection, 'pointsLines'> {
    const entry = this.composition;
    return {
      worldEntitiesScanned: this.worldEntitiesScanned,
      fullRebuilds: this.fullRebuilds,
      noChangeFrames: this.noChangeFrames,
      deltaFrames: this.deltaFrames,
      transformUpdates: this.transformUpdates,
      lastResyncReason: this.lastResyncReason,
      projectionRecords: entry?.projection.recordCount ?? 0,
      ...(entry === undefined
        ? {}
        : { instanceBoundsCache: entry.projection.instanceBoundsStatistics() }),
      ...(entry === undefined ? {} : { probeBlend: entry.probeProjection.inspect() }),
      topology:
        entry?.topology.inspect() ??
        ({
          revision: 0,
          batchCount: 0,
          candidateCount: 0,
          rebuilds: 0,
          patches: 0,
          ineligible: 0,
        } satisfies BatchTopologyInspection),
      gpu: this.inspectGpu(),
    };
  }

  /** Current CPU composition is the scene authority even before GPU tables exist. */
  compositionRetainedScene(): RetainedComposition | undefined {
    const entry = this.composition;
    if (entry === undefined) return undefined;
    const revision = entry.projection.contentRevision + entry.assetRevision;
    const closures = [...entry.assetClosures].map(([world, closure]) => ({
      world,
      closure,
      revision: closure.revision,
    }));
    const current = () => {
      if (
        this.composition !== entry ||
        entry.projection.contentRevision + entry.assetRevision !== revision
      )
        return false;
      for (const { world, closure, revision } of closures) {
        if (closure.revision !== revision) return false;
        const changes = this.assetObservers.get(world)?.read();
        if (changes === undefined || !changes.ok || closure.pending(changes.value.changes))
          return false;
      }
      return true;
    };
    const slots = entry.projection.slotsSnapshot();
    const sourceVersions = entry.readVersions.map((version) => ({ ...version }));
    const sourceLeases = [...entry.readLeases];
    const publicationRevision = entry.publicationRevision;
    return {
      identity: entry.token,
      revision,
      worlds: entry.worlds,
      slots,
      materials: entry.materialDispatch.materials(),
      meshes: entry.projection.meshFrame(),
      isCurrent: current,
      isSourceCurrent: () => {
        if (!current()) return false;
        try {
          return entry.worlds.every((world, index) => {
            if (world.world === undefined) return world.revision === publicationRevision;
            const lease = sourceLeases[index],
              version = sourceVersions[index];
            if (
              lease === undefined ||
              version === undefined ||
              lease.worldIdentity !== world.identity
            )
              return false;
            const current = lease.captureVersion();
            return (
              current.mutationEpoch === version.mutationEpoch &&
              current.structureEpoch === version.structureEpoch
            );
          });
        } catch {
          return false;
        }
      },
    };
  }

  /**
   * Publish one renderer submission: the GPU Scene frame stamp and the
   * canonical submitted history advance once, however many views submitted.
   */
  commitFrame(frameKey: number | undefined, temporal: boolean): Result<void, RhiError> {
    if (frameKey === undefined || frameKey !== this.committedFrame) {
      this.committedFrame = frameKey;
      const committed = this.gpuScene?.commitFrame();
      if (committed !== undefined && !committed.ok) return committed;
    }
    const projection = this.composition?.projection;
    if (
      temporal &&
      projection !== undefined &&
      (frameKey === undefined || frameKey !== this.historyFrame)
    ) {
      this.historyFrame = frameKey;
      projection.commitSubmission(projection.captureSubmission([], projection.slotsSnapshot()));
    }
    return ok(undefined);
  }

  private inspectGpu(): PersistentGpuSceneInspection {
    if (this.gpuStatus === 'resident' && this.gpuScene !== undefined) {
      return { status: 'resident', ...this.gpuScene.inspect() };
    }
    if (this.gpuStatus === 'unsupported') {
      return { status: 'unsupported', reason: 'storage-buffer-unavailable' };
    }
    if (this.gpuStatus === 'rebuild-pending') return { status: 'rebuild-pending' };
    if (this.gpuStatus === 'error') return { status: 'error' };
    return { status: 'inactive' };
  }

  /** Internal topology fact; the renderer does not expose demand as public API. */
  transmissionTopologyDemand(): TransmissionDemand {
    return (
      this.composition?.materialDispatch.materials().transmissionDemand ?? {
        activeCount: 0,
        needsRoughMips: false,
      }
    );
  }

  /** Validate the whole source domain before publishing an actual Pass query. */
  /**
   * The Pass query of the latest step. Each query is one dispatch-entry
   * generation, so every view of a frame reads this one list instead of
   * re-querying.
   */
  materialPasses(entry: CompositionEntry): DispatchList {
    const passes = this.passes;
    if (passes === undefined || passes.entry !== entry)
      throw new Error('Material Passes are read from the composition step that queried them');
    return passes.list;
  }

  private queryMaterialPasses(entry: CompositionEntry): void {
    this.passes = undefined;
    this.passes = { entry, list: this.queryMaterialPassList(entry) };
  }

  private queryMaterialPassList(entry: CompositionEntry): DispatchList {
    const sources = entry.worlds;
    const context = this.materialContextKey;
    const revision = entry.projection.revisionValue();
    const versions = sources.map((scope) => {
      const records =
        scope.world?.assets === undefined ? undefined : runtimeAssets(scope.world.assets);
      return {
        scope,
        publication: scope.revision,
        epoch: scope.world === undefined ? undefined : readMutationEpoch(scope.world),
        records,
        assets: records?.currentRevision,
      };
    });
    let entered = false;
    const validate = () => {
      if (
        this.composition !== entry ||
        entry.worlds !== sources ||
        this.materialContextKey !== context ||
        entry.projection.revisionValue() !== revision
      )
        throw new Error('Scene source changed during Pass query');
      for (const { scope, publication, epoch, records, assets } of versions) {
        if (records?.currentRevision !== assets)
          throw new Error('Scene assets changed during Pass query');
        if (
          scope.revision !== publication ||
          (scope.world === undefined && scope.revision !== entry.publicationRevision) ||
          (scope.world !== undefined && readMutationEpoch(scope.world) !== epoch)
        )
          throw new Error('Scene source changed during Pass query');
        const world = scope.world;
        if (world === undefined || entered) continue;
        const observer = this.assetObservers.get(world);
        if (observer === undefined) continue;
        const pending = observer.read().unwrap();
        if (entry.assetClosures.get(world)?.pending(pending.changes))
          throw new Error('Scene assets changed during Pass query');
      }
      entered = true;
    };
    return entry.materialDispatch.query(
      entry.projection.slotsSnapshot(),
      entry.projection.meshFrame(),
      validate,
    );
  }

  projectProbes(entry: CompositionEntry, frame: ExtractedFrame): void {
    const sky =
      frame.skylight === undefined
        ? {
            available: false,
            irradiance: [0, 0, 0] as const,
            fallbackReason: 'no-skylight',
          }
        : {
            available: true,
            identity: `skylight:${frame.skylight.entityHandle}`,
            sourceKey:
              frame.skylight.equirectHandle > 0
                ? `equirect:${frame.skylight.equirectHandle}`
                : `skylight:${frame.skylight.entityHandle}`,
            irradiance: [
              frame.skylight.color[0] * frame.skylight.intensity,
              frame.skylight.color[1] * frame.skylight.intensity,
              frame.skylight.color[2] * frame.skylight.intensity,
            ] as [number, number, number],
          };
    const probes = frame.lightProbes ?? [];
    const hasProbes = probes.length > 0;
    const revision = entry.projection.revisionValue();
    if (entry.probeObjects?.revision !== revision || entry.probeObjects.hasProbes !== hasProbes) {
      const value: ProbeSceneObjectInput[] = [];
      // Without local probes every surface reads Sky directly. Cooked programs
      // with an always-present probe binding use its shared zero lane; material
      // edits therefore require neither object membership nor per-object rows.
      for (const slot of hasProbes ? entry.projection.slotsSnapshot() : []) {
        value.push(
          Object.freeze({
            objectKey: slot.slot,
            generation: slot.generation,
            position: [
              slot.snapshot.transform.world[12] ?? 0,
              slot.snapshot.transform.world[13] ?? 0,
              slot.snapshot.transform.world[14] ?? 0,
            ] as const,
          }),
        );
      }
      entry.probeObjects = { revision, hasProbes, value: Object.freeze(value) };
    }
    entry.probeProjection.apply({
      objects: entry.probeObjects.value,
      probes,
      sky,
      worldRevision: revision,
    });
  }

  private syncGpuOwner(
    owner: object,
    projection: RenderScene,
    materials: MaterialFrame,
    delta?: RenderSceneApplyResult,
    materialUpdates?: readonly MaterialResource[],
  ): void {
    const acquired = this.acquireGpuScene(owner, projection, materials);
    if (acquired === undefined) {
      this.sceneTableUploadBytes = 0;
      return;
    }
    if (acquired.rebuilt) {
      this.sceneTableUploadBytes = acquired.uploadBytes;
      return;
    }
    const result = acquired.scene.sync(
      {
        ...(delta ?? {
          created: 0,
          updated: 0,
          removed: 0,
          recreated: 0,
          ignoredLateUpdates: 0,
          createdSlots: [],
          updatedSlots: [],
          contentUpdatedSlots: [],
          instanceUpdatedSlots: [],
          removedSlots: [],
          recreatedSlots: [],
          previous: new Map(),
          resynced: 0,
        }),
        ...(materialUpdates === undefined ? {} : { materialUpdates }),
        meshes: projection.meshFrame(),
        materials,
      },
      (slot) => projection.temporalSnapshotBySlot(slot.slot),
      (slot) => projection.cullingWorldBoundsAt(slot),
      (slot) => projection.instanceRowBoxesAt(slot),
    );
    if (!result.ok) {
      this.sceneTableUploadBytes = 0;
      this.failGpu(result.error);
      return;
    }
    this.sceneTableUploadBytes = result.value.bytes;
  }

  private acquireGpuScene(
    owner: object,
    projection: RenderScene,
    materials: MaterialFrame,
  ):
    | { readonly scene: GpuScene; readonly rebuilt: boolean; readonly uploadBytes: number }
    | undefined {
    const getDevice = this.options.getDevice;
    if (getDevice === undefined) return undefined;
    const device = getDevice();
    if (this.gpuDevice !== undefined && this.gpuDevice !== device) {
      this.retireGpuScene(this.gpuScene, this.gpuDevice);
      this.gpuScene = undefined;
      this.gpuOwner = undefined;
      this.gpuStatus = 'rebuild-pending';
    }
    if (this.gpuStatus === 'error' && this.gpuDevice === device) return undefined;
    if (this.gpuStatus === 'unsupported' && this.gpuDevice === device) return undefined;
    if (this.gpuScene !== undefined && this.gpuOwner === owner) {
      return { scene: this.gpuScene, rebuilt: false, uploadBytes: 0 };
    }
    // A new device has no accepted temporal history. Cold flags come from
    // the same current rows as initial extraction, independently of each view.
    const temporal = (slot: RenderSceneSlot) => projection.temporalSnapshotBySlot(slot.slot, true);
    if (this.gpuScene !== undefined && this.gpuDevice === device) {
      // Composition rebuilds replace the CPU projection token, but the GPU
      // table resource can be rebuilt in place. Keeping one scene identity
      // avoids destroying buffers that cached frame graphs still reference
      // and lets queue ordering preserve writes across the next submission.
      const slots = projection.slotsSnapshot();
      const rebuilt = this.gpuScene.sync(
        { ...sceneSnapshotDelta(slots), meshes: projection.meshFrame(), materials },
        temporal,
        sceneSnapshotBounds(projection),
      );
      if (!rebuilt.ok) {
        this.failGpu(rebuilt.error);
        return undefined;
      }
      this.gpuOwner = owner;
      this.gpuStatus = 'resident';
      return { scene: this.gpuScene, rebuilt: true, uploadBytes: rebuilt.value.bytes };
    }
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = device;
    const created = GpuScene.create(
      device,
      Math.max(256, projection.slotCapacity),
      this.options.shaderRegistry,
      this.inputArena(),
    );
    if (!created.ok) {
      this.failGpu(created.error);
      return undefined;
    }
    if (created.value.status === 'unavailable') {
      this.gpuStatus = 'unsupported';
      return undefined;
    }
    const scene = created.value.scene;
    const slots = projection.slotsSnapshot();
    const rebuilt = scene.sync(
      { ...sceneSnapshotDelta(slots), meshes: projection.meshFrame(), materials },
      temporal,
      sceneSnapshotBounds(projection),
    );
    if (!rebuilt.ok) {
      scene.dispose();
      this.failGpu(rebuilt.error);
      return undefined;
    }
    scene.inputs.activate();
    this.gpuScene = scene;
    this.gpuOwner = owner;
    this.gpuStatus = 'resident';
    return { scene, rebuilt: true, uploadBytes: rebuilt.value.bytes };
  }

  private failGpu(error: RhiError): void {
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuStatus = 'error';
    this.options.onGpuError?.(error);
  }
}

/** Range-only evidence cannot change submeshes, so batch keys and membership stay intact. */
function isMeshContentPatch(change: AssetChange): boolean {
  return (
    !change.removed &&
    change.ranges.length > 0 &&
    change.fields.every(
      (field) =>
        field === 'aabb' ||
        field === 'collision' ||
        field === 'distanceField' ||
        field === 'cardLayout',
    )
  );
}
