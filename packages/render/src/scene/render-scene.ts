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
import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { Children, GlobalTransform, MorphWeights } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { err, type MeshAsset, ok, type Result, type SkeletonAsset } from '@forgeax/engine-types';
import { Instances, Lines, Points, SpriteInstances } from '../components';
import { GlyphSources, projectGlyphView } from '../glyph-source';
import {
  BatchTopology,
  type BatchTopologyInspection,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import {
  type GpuDrivenMaterialProgramIndex,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import { GpuInputArena } from '../gpu-input-arena';
import { GpuScene } from '../gpu-scene';
import type { GpuSceneSlotBounds } from '../gpu-scene-change-log';
import type {
  FrameCacheCounters,
  GpuDrivenStructureMetrics,
  PersistentRenderSceneInspection,
} from '../inspection-types';
import type { InstanceProjectionStore } from '../instances';
import { MaterialResource, materialResource } from '../material-resource';
import type { PointsLinesInspection } from '../points-lines/inspection';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import { RenderPublicationError, type RenderPublicationIdentity } from '../publication/contract';
import { publicationFrameDependencies, renderableAssetRoots } from '../publication/dependencies';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { RenderResourceScope } from '../publication/resource-scope';
import { worldRenderResources } from '../publication/resource-scope';
import { worldEntityKey } from '../record/frame-snapshot';
import {
  type ReflectionProbeFact,
  ReflectionProbeProjection,
  type ReflectionProbeSelectionResult,
} from '../reflection/projection';
import type {
  DispatchList,
  ExtractedFrame,
  GpuOwnedFrame,
  MaterialSnapshotCachesByWorld,
  RenderableSnapshot,
} from '../render-system-extract';
import { materialSnapshotContext, resolveMaterialSnapshot } from '../render-system-extract';
import type { SubsurfaceDemand } from '../subsurface/selection';
import { standardSceneTemporalDemand } from '../temporal/standard-scene-data';
import type { TerrainLayers } from '../terrain/layers';
import { TerrainSourceCache } from '../terrain/source';
import { projectTerrainView, terrainSectionKey } from '../terrain/view.js';
import { projectTilemapView, TilemapSources } from '../tilemap-source';
import type { TransmissionDemand } from '../transmission/projection';
import { SceneAssetClosure } from './asset-closure';
import { CompositionSkinAdoption } from './composition-skin';
import type { DrawEvidence } from './draw-evidence';
import { type FrameList, FrameProjection } from './frame-list';
import { FrameSet } from './frame-set';
import { MaterialDispatch, type MaterialFrame } from './material-dispatch';
import type { MeshFrame } from './mesh-frame';
import type { MeshMaterialGeometry } from './mesh-materials';
import {
  cullPersistentFrame,
  cullResidualFrame,
  type PersistentCullMemo,
  type ResidualCullMemo,
} from './persistent-cull';
import { attachProbeRecord, attachProbeRecords, type ProbeAttachMemo } from './probe-attach';
import {
  type ProbeBlendBufferProjection,
  ProbeBlendSceneProjection,
  type ProbeSceneObjectInput,
} from './probe-blend';
import {
  boundsFromArray,
  type FrameCacheTally,
  identityKey,
  worldBounds,
  writeBounds,
} from './render-scene-snapshots';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneOperation,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';
import {
  EMPTY_SLOT_FRAME,
  RenderScene,
  type RenderSceneSubmissionCapture,
  sceneRow,
  sceneSnapshotDelta,
} from './render-scene-view';
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
import { ResidualRoster } from './residual-roster';
import type { SceneSlotFrame } from './scene-slots';
import { SlotIdentityKeys } from './scene-slots';

export { RenderScene, type RenderSceneSubmissionCapture } from './render-scene-view';

import type { SkinSceneFrame, SkinSceneInputs } from './skin-scene-inputs';

export type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneIdentity,
  RenderSceneInspection,
  RenderSceneOperation,
  RenderSceneRecord,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';

/**
 * World boxes seeded by a rebuild so the change log proves the old box of
 * each slot's first later change instead of reporting it unbounded.
 */
function sceneSnapshotBounds(projection: RenderScene): GpuSceneSlotBounds {
  return (slot) => projection.cullingWorldBoundsAt(slot);
}

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

/**
 * Complete ShadowCaster producer projection retained beside the camera-cull
 * submission frame. The persistent scene owns this sequence; record consumes
 * it for the CPU residual lane without rebuilding a second scene projection.
 */
/** Receiver-local authority; never transported as an ECS lease or packet field. */
export interface ShadowPublicationSource {
  readonly resources: RenderResourceScope;
  readonly revision: number;
  readonly isCurrent: () => boolean;
}

export interface PersistentShadowCasterProjection {
  readonly meshDraws: Pick<RenderScene, 'meshDrawSlot' | 'beginMeshDrawFrame'>;
  /**
   * Caster content evidence: unchanged owner and revisions prove every
   * published renderable and its dispatch are unchanged, whatever else the
   * ECS mutated (a camera Transform, gameplay state).
   */
  readonly content: {
    readonly materials: import('./material-dispatch').MaterialFrame;
    readonly meshes: MeshFrame;
    readonly subsurface: {
      readonly source: SubsurfaceDemand;
      readonly authorVisible: SubsurfaceDemand;
      readonly admitted: SubsurfaceDemand;
    };
    readonly owner: object;
    readonly sceneRevision: number;
    readonly dispatchRevision: number;
    readonly publicationSource?: ShadowPublicationSource;
    /** Actual view-derived draws; root scene revisions do not encode their geometry. */
    readonly viewDraws?: FrameList<RenderableSnapshot>;
  };
  /**
   * Writes borrowed task scratch; false leaves out unchanged and means
   * uncullable. A draw selected from a Scene row passes that row, which
   * replaces the identity lookup.
   */
  readonly worldBoundsOf: (
    source: RenderableSnapshot,
    out: box3.Box3,
    slot?: RenderSceneSlot,
  ) => boolean;
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly dispatch: DispatchList;
  readonly materialPrograms?: GpuDrivenMaterialProgramIndex;
}

export interface PersistentRenderSceneOptions {
  readonly terrainLayers?: TerrainLayers;
  readonly assets?: AssetRegistry | undefined;
  readonly shaderRegistry?: ShaderRegistry | undefined;
  /** Profile consumers that need the same submitted history as camera effects. */
  readonly getTemporalConsumerDemand?: (() => boolean) | undefined;
  readonly getDevice?: (() => RhiDevice) | undefined;
  readonly onGpuError?: ((error: RhiError) => void) | undefined;
  readonly onAssetChange?: ((scope: RenderResourceScope, change: AssetChange) => void) | undefined;
  /** Instance projection accepted by the same World source update flow. */
  readonly instanceCollections?: InstanceProjectionStore | undefined;
}

export interface PersistentGpuDrivenState {
  /** Fixed numeric roots borrowed through this physical recording. */
  readonly skin?: SkinSceneFrame | undefined;
  readonly meshes?: MeshFrame;
  readonly completeGeometry?: boolean;
  /** Geometry rows without native batch membership, maintained by Scene changes. */
  readonly unbatchedSlots?: ReadonlySet<number>;
  /** Explicit source requests, maintained independently of draw visibility. */
  readonly pipelinePreparationSlots?: ReadonlySet<number>;
  /** Present only for the complete retained composition, never a filtered view. */
  readonly retained?: {
    readonly identity: object;
    readonly revision: number;
    readonly worlds: readonly RenderResourceScope[];
    readonly slots: FrameList<RenderSceneSlot>;
    readonly materials: MaterialFrame;
    readonly meshes: MeshFrame;
    isCurrent(): boolean;
    /** The current source still matches the versions consumed by extraction. */
    isSourceCurrent(): boolean;
  };
  readonly scene: GpuScene;
  readonly plan: SubmissionPlan;
  /** Native source plans expand only when a recording actually requests tasks. */
  readonly queryPlan?: () => SubmissionPlan;
  readonly slots: FrameList<RenderSceneSlot>;
  /**
   * Fixed-frame record by stable slot address, resolving one indexed page path.
   * Old frame callbacks keep their original records through later updates.
   */
  readonly slotAt: (slot: number) => RenderSceneSlot | undefined;
  /** Indexed temporal/probe projection for an actual draw, without materializing the scene. */
  readonly drawSnapshotAt?: (slot: number) => RenderableSnapshot | undefined;
  /** Roots `drawSnapshotAt` reads; retained consumers link two states through their diff. */
  readonly draws?: DrawEvidence;
  /** Native Scene's existing entity index; borrowed states can omit this projection. */
  readonly slotForEntity?: (worldId: number, entityKey: number) => RenderSceneSlot | undefined;
  /** Stable renderer-local World keys aligned with RenderSceneSlot.worldId. */
  readonly worldKeys?: readonly number[];
  /** Public World identities aligned with RenderSceneSlot.worldId. */
  readonly worldIdentities?: readonly string[];
  readonly structureMetrics?: GpuDrivenStructureMetrics;
  /** Stable retained ProbeBlend upload projection from the Scene owner. */
  readonly probeBlend?: ProbeBlendBufferProjection;
}

/**
 * The one renderer-owned submission projection for a display view.
 *
 * Record and prepare consume the same renderables, dispatch and stable active
 * identity, so CPU direct and GPU indirect lanes never rebuild a second
 * visibility map with different identity semantics.
 */
export interface PersistentVisibilityProjection {
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly dispatch: DispatchList;
  readonly activeEntityKeys: ReadonlySet<number>;
  /** Monotonic owner revision for exactly this active-key projection. */
  readonly activeEntityRevision: number;
}

type PersistentGpuSceneInspection = PersistentRenderSceneInspection['gpu'];

interface PersistentCompositionEntry {
  readonly token: object;
  readonly worlds: readonly RenderResourceScope[];
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
  /** Residual rows of this view's submitted GPU selection, kept from topology and selection diffs. */
  readonly residual: ResidualRoster;
  readonly probeProjection: ProbeBlendSceneProjection;
  probeObjects:
    | {
        readonly revision: number;
        readonly hasProbes: boolean;
        readonly value: readonly ProbeSceneObjectInput[];
      }
    | undefined;
  temporalDemanded: boolean;
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

/** Draw keys the GPU-driven raster owned last primary frame, in its world-key space. */
export interface GpuRasterOwnership {
  readonly selection: GpuDrawSelection;
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
  entry: PersistentCompositionEntry,
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
  entry: PersistentCompositionEntry | undefined,
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
  entry: PersistentCompositionEntry,
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
  entry: PersistentCompositionEntry,
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
  entry: PersistentCompositionEntry,
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
  entry: PersistentCompositionEntry,
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
  entry: PersistentCompositionEntry,
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
  entry: PersistentCompositionEntry,
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
  entry: PersistentCompositionEntry,
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
function acceptObservedSources(
  entry: PersistentCompositionEntry,
  changes: CompositionChanges,
): void {
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

function sameWorldSequence(
  left: readonly RenderResourceScope[],
  right: readonly RenderResourceScope[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const EMPTY_MATERIAL_UPDATES: readonly MaterialResource[] = Object.freeze([]);

/** Persistent scene projection used by the renderer's multi-World composition path. */
export class PersistentRenderScene {
  private readonly skinAdoption = new CompositionSkinAdoption({
    inputArena: () => this.inputArena(),
    abandon: () => {
      this.composition?.projection.dispose();
      this.composition = undefined;
      this.invalidate();
    },
  });

  /** Current fixed pair for actual draw consumers; never copied into wire DTOs. */
  skinRecordingFrame(): SkinSceneFrame | undefined {
    return this.composition?.skin?.recordingFrame();
  }

  /** Called at physical queue acceptance, before any post-submit observers. */
  trackSkinSubmittedWork(completed: Promise<void>): Promise<void> | undefined {
    const skin = this.composition?.skin,
      frame = skin?.recordingFrame();
    return frame === undefined ? undefined : skin?.trackSubmittedWork(frame, completed);
  }

  discardSkinFrame(): void {
    this.composition?.skin?.discardFrame();
  }

  /** Physical work pins both roots even if the Scene picture was not accepted. */
  submitSkinFrame(completed: Promise<void>, accepted: boolean): Promise<void> | undefined {
    const skin = this.composition?.skin,
      frame = skin?.recordingFrame();
    return frame === undefined ? undefined : skin?.submitFrame(frame, completed, accepted);
  }

  /** World identity is the author/runtime identity; array position is only a frame routing detail. */
  private projectSceneSources(frame: ExtractedFrame, entry: PersistentCompositionEntry) {
    entry.materialDispatch.prepare(entry.projection.meshFrame());
    const terrainView = projectTerrainView(
      frame,
      this.terrainAccepted,
      entry.materialDispatch.materials(),
      entry.worlds,
      this.terrainSources,
      (world, handle) =>
        this.prepareMeshMaterial(
          world,
          handle,
          'terrain',
          false,
          this.terrainAssets ?? this.options.assets,
        ),
      this.options.terrainLayers,
      entry.projection.hasSource('terrain'),
    );
    const glyphView = projectGlyphView(
      terrainView.frame,
      terrainView.materials,
      entry.worlds,
      this.glyphSources,
      this.terrainAssets ?? this.options.assets,
      entry.projection.hasSource('glyph'),
    );
    return projectTilemapView(
      glyphView.frame,
      glyphView.materials,
      entry.worlds,
      this.tilemapSources,
      this.terrainAssets ?? this.options.assets,
      entry.projection.hasSource('tilemap'),
    );
  }

  private readonly visibilityWorldKeys = new Map<string, number>();
  private nextVisibilityWorldKey = 0;
  private materialSnapshotCaches: MaterialSnapshotCachesByWorld = new WeakMap();
  private materialContextKey: string | undefined;
  private readonly assetObservers = new Map<
    World,
    ReturnType<AssetRegistry['observe']> extends Result<infer T, unknown> ? T : never
  >();
  private materialContext: MaterialCookRasterContext | undefined;
  private terrainAssets: AssetRegistry | undefined;
  private readonly terrainSources = new TerrainSourceCache();
  private readonly glyphSources = new GlyphSources();
  private readonly tilemapSources = new TilemapSources();

  private prepareMeshMaterial(
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
  ): readonly MaterialResource[] {
    let updates: MaterialResource[] | undefined;
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
      const closure = this.composition?.assetClosures.get(world);
      if (closure !== undefined) {
        const previous = closure.revision;
        closure.adopt(batch.changes);
        if (closure.revision !== previous && this.composition !== undefined)
          this.composition.assetRevision++;
      }
      const contexts = this.materialSnapshotCaches.get(worldRenderResources(world));
      for (const change of batch.changes) {
        this.options.onAssetChange?.(worldRenderResources(world), change);
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
            this.composition as PersistentCompositionEntry,
            worldId,
            change.handle,
            definition?.ok && definition.value.kind === 'skeleton' ? definition.value : undefined,
          );
        }
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
    return updates ?? EMPTY_MATERIAL_UPDATES;
  }
  private fullRebuilds = 0;
  private worldEntitiesScanned = 0;
  private sceneTableUploadBytes = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private transformUpdates = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;
  private composition: PersistentCompositionEntry | undefined;
  private gpuScene: GpuScene | undefined;
  private readonly retiredGpuScenes = new Set<GpuScene>();
  private shadowProjection: PersistentShadowCasterProjection | undefined;
  private readonly materialProgramProjection = new GpuDrivenMaterialProgramProjection();
  private gpuOwner: object | undefined;
  private gpuRasterOwned: GpuRasterOwnership | undefined;
  private gpuDevice: RhiDevice | undefined;
  private gpuStatus: 'inactive' | 'unsupported' | 'resident' | 'rebuild-pending' | 'error' =
    'inactive';
  private terrainCandidate: FrameList<RenderableSnapshot> = [];
  private terrainAccepted = new Map<string, RenderableSnapshot>();
  private temporalCapture:
    | { readonly projection: RenderScene; readonly capture: RenderSceneSubmissionCapture }
    | undefined;
  private readonly probeAttachMemo: ProbeAttachMemo = {
    bySnapshot: new WeakMap(),
    previous: undefined,
  };
  private readonly cullMemo: { value: PersistentCullMemo | undefined } = { value: undefined };
  private readonly residualCullMemo: { value: ResidualCullMemo | undefined } = {
    value: undefined,
  };
  /** Lifetime visibility-projection cache counters (camera-independent key). */
  visibilityProjectionCacheInspection(): FrameCacheCounters {
    return { hits: this.visibilityProjectionHits, misses: this.visibilityProjectionMisses };
  }

  /** Lifetime per-renderable temporal snapshot memo counters. */
  temporalSnapshotCacheInspection(): FrameCacheCounters {
    return { ...this.temporalCounters };
  }

  private readonly temporalCounters: FrameCacheTally = { hits: 0, misses: 0 };
  private visibilityProjectionHits = 0;
  private visibilityProjectionMisses = 0;
  private visibilityProjectionCache:
    | {
        readonly scene: RenderScene | undefined;
        readonly sceneRevision: number;
        readonly worlds: readonly RenderResourceScope[];
        readonly renderables: FrameList<RenderableSnapshot>;
        readonly dispatch: DispatchList;
        readonly projection: PersistentVisibilityProjection;
      }
    | undefined;
  private visibilityProjectionRevision = 0;
  /** The active set the revision stands for: an owned key copy, or a fixed slot roster. */
  private lastActiveEntityKeys: ReadonlySet<number> | undefined;
  private pointsLinesInspections: readonly PointsLinesInspection[] = [];
  private readonly reflectionProbes = new ReflectionProbeProjection();

  private numericArena: GpuInputArena | undefined;
  constructor(private readonly options: PersistentRenderSceneOptions = {}) {}

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
      this.gpuRasterOwned = undefined;
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
    return (
      entry === undefined ||
      entry.worlds.length !== 1 ||
      entry.worlds[0] !== resources ||
      (scene !== undefined &&
        (entry.projection.sceneRows !== scene.rows ||
          scene.before !== entry.projection.observedRows))
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

  private worldKeyAt(worlds: readonly RenderResourceScope[], worldId: number): number {
    return this.visibilityWorldKey(worlds[worldId], worldId);
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

  shadowCasterProjection(): PersistentShadowCasterProjection | undefined {
    return this.shadowProjection;
  }

  private stableEntityKey(
    worlds: readonly RenderResourceScope[],
    renderable: Pick<RenderableSnapshot, 'worldId' | 'entityKey'>,
  ): number {
    return worldEntityKey(this.worldKeyAt(worlds, renderable.worldId), renderable.entityKey);
  }

  /**
   * Project extracted renderables into the final primary-raster submission.
   *
   * Occlusion belongs to the GPU two-phase HZB, so this projection passes every
   * renderable through and owns only the stable active-entity identity that
   * production-raster admission caches key on.
   */
  projectVisibility(
    worlds: readonly RenderResourceScope[],
    renderables: FrameList<RenderableSnapshot>,
    dispatch: DispatchList,
    roster?: SceneSlotFrame,
  ): PersistentVisibilityProjection {
    const cached = this.visibilityProjectionCache;
    const scene = this.composition?.projection;
    const sceneRevision = scene?.revisionValue() ?? 0;
    if (
      cached !== undefined &&
      cached.scene === scene &&
      cached.sceneRevision === sceneRevision &&
      sameWorldSequence(cached.worlds, worlds) &&
      cached.renderables === renderables &&
      cached.dispatch === dispatch
    ) {
      this.visibilityProjectionHits += 1;
      return cached.projection;
    }
    this.visibilityProjectionMisses += 1;
    let activeEntityKeys: ReadonlySet<number>;
    let activeEntityRevision: number;
    if (roster === undefined) {
      const keys = new Set<number>();
      for (const renderable of renderables) keys.add(this.stableEntityKey(worlds, renderable));
      activeEntityKeys = keys;
      activeEntityRevision = this.activeEntityRevision(keys);
    } else {
      const keys = new SlotIdentityKeys(roster, this.visibilityWorldKeysFor(worlds));
      activeEntityKeys = keys;
      activeEntityRevision = this.rosterEntityRevision(keys);
    }
    const projection = { renderables, dispatch, activeEntityKeys, activeEntityRevision };
    this.visibilityProjectionCache = {
      scene,
      sceneRevision,
      worlds: [...worlds],
      renderables,
      dispatch,
      projection,
    };
    return projection;
  }

  /**
   * Advance the projection revision only when the active stable-entity set
   * changes. Camera fingerprints and scene-plan identity cover view/topology
   * changes; keeping this token set-stable preserves the GPU filtered-plan
   * cache on ordinary no-change frames.
   */
  private activeEntityRevision(activeEntityKeys: ReadonlySet<number>): number {
    const previous = this.lastActiveEntityKeys;
    if (
      previous === undefined ||
      previous.size !== activeEntityKeys.size ||
      [...previous].some((key) => !activeEntityKeys.has(key))
    ) {
      this.lastActiveEntityKeys = new Set(activeEntityKeys);
      this.visibilityProjectionRevision += 1;
    }
    return this.visibilityProjectionRevision;
  }

  /** The same set-stable revision for a slot roster, read from its row-change log. */
  private rosterEntityRevision(keys: SlotIdentityKeys): number {
    const previous = this.lastActiveEntityKeys;
    let changed = !(previous instanceof SlotIdentityKeys);
    if (
      previous instanceof SlotIdentityKeys &&
      !keys.changesSince(previous, () => {
        changed = true;
      })
    )
      changed = true;
    this.lastActiveEntityKeys = keys;
    if (changed) this.visibilityProjectionRevision += 1;
    return this.visibilityProjectionRevision;
  }

  private invalidateActiveEntityRevision(): void {
    this.lastActiveEntityKeys = undefined;
    this.visibilityProjectionRevision += 1;
  }

  /** Project probe facts and per-row selection; only changed rows are re-selected. */
  projectReflectionProbes(probes: readonly ReflectionProbeFact[]): void {
    const entry = this.composition;
    if (entry === undefined) return;
    const projection = entry.projection;
    this.reflectionProbes.update(
      probes,
      {
        identity: entry.token,
        revision: projection.contentRevision + entry.assetRevision,
        slots: projection.slotsSnapshot(),
        materials: entry.materialDispatch.materials(),
        meshes: projection.meshFrame(),
      },
      (slot) => {
        const resolved = projection.cullingWorldBoundsAt(slot);
        if (resolved === undefined || resolved === null) return undefined;
        return [
          (resolved.min[0] + resolved.max[0]) / 2,
          (resolved.min[1] + resolved.max[1]) / 2,
          (resolved.min[2] + resolved.max[2]) / 2,
        ];
      },
    );
  }

  reflectionProbeSelection(worldId: number, entityKey: number): ReflectionProbeSelectionResult {
    return this.reflectionProbes.selection(worldId, entityKey);
  }

  reflectionProbeProjection(): ReturnType<ReflectionProbeProjection['snapshot']> {
    return this.reflectionProbes.snapshot();
  }

  consumePublication(input: PreparedRenderPublication): ExtractedFrame {
    const { resources, packet, frame } = input;
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
    let entry = this.composition;
    const fresh = entry === undefined || packet.baseline;
    if (entry === undefined || packet.baseline) {
      this.invalidate();
      // Every view reads the receiver's shared rows; it owns only derived state.
      const projection = new RenderScene(input.scene.rows);
      entry = {
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
        residual: new ResidualRoster(),
        probeProjection: new ProbeBlendSceneProjection(),
        probeObjects: undefined,
        temporalDemanded: false,
      };
      this.composition = entry;
      this.fullRebuilds++;
      this.lastResyncReason = 'attach';
    }
    const materialDispatch = entry.materialDispatch;
    entry.projection.setSources([resources]);
    this.worldEntitiesScanned = 0;
    this.sceneTableUploadBytes = 0;
    this.terrainSources.adopt(resources, input.assetChanges);
    this.glyphSources.adopt(resources, input.assetChanges);
    this.tilemapSources.adopt(resources, input.assetChanges);
    this.options.terrainLayers?.adopt(resources, input.assetChanges);
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
    for (const change of input.assetChanges) {
      this.options.onAssetChange?.(resources, change);
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
    let delta: RenderSceneApplyResult;
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
      this.invalidateActiveEntityRevision();
    }
    entry.topology.apply(delta);
    for (const material of input.materialUpdates) entry.materialDispatch.adopt(material);
    entry.materialDispatch.prepare(entry.projection.meshFrame());
    if (input.operations.length || delta.created > 0) this.deltaFrames++;
    else this.noChangeFrames++;
    this.transformUpdates += delta.updated;
    if (
      packet.assets.length > 0 ||
      packet.assetPatches.length > 0 ||
      packet.materials.length > 0 ||
      packet.retiredAssets.length > 0
    )
      entry.assetRevision++;
    entry.publicationRevision = packet.revision;
    return this.deriveFramePlan(entry, frame, delta, input.materialUpdates);
  }

  extractComposition(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    assets: AssetRegistry,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases?: readonly RenderReadLease[],
  ): ExtractedFrame {
    this.retireFailedInputArena();
    this.worldEntitiesScanned = 0;
    this.sceneTableUploadBytes = 0;
    this.terrainAssets = assets;
    const materialUpdates = this.adoptAssetChanges(worlds, assets);
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
    const resourceWorld = worlds[owner.resourceOwner];
    if (resourceWorld !== undefined)
      entry.assetClosures
        .get(resourceWorld)
        ?.replace(-1, publicationFrameDependencies(resourceFrame));
    this.skinAdoption.initializeJoints(entry);
    const result = this.deriveFramePlan(entry, resourceFrame, changedDelta, materialUpdates);
    acceptObservedSources(entry, changes);
    entry.readLeases = [...leases];
    for (let worldId = 0; worldId < changes.nextReadVersions.length; worldId += 1) {
      const version = changes.nextReadVersions[worldId];
      if (version !== undefined) entry.readVersions[worldId] = version;
    }
    return result;
  }

  /** Read each World's change evidence into one frame's requested identities and spans. */
  private observeCompositionChanges(
    entry: PersistentCompositionEntry,
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
    entry: PersistentCompositionEntry,
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
      this.invalidateActiveEntityRevision();
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
    entry: PersistentCompositionEntry,
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
    entry: PersistentCompositionEntry,
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
    entry: PersistentCompositionEntry,
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

  invalidate(): void {
    const skin = this.composition?.skin;
    if (this.composition !== undefined) this.composition.skin = undefined;
    // Owned rows leave with their composition.
    this.composition?.projection.dispose();
    this.composition = undefined;
    this.probeAttachMemo.previous = undefined;
    this.cullMemo.value = undefined;
    this.residualCullMemo.value = undefined;
    this.shadowProjection = undefined;
    this.materialProgramProjection.clear();
    this.temporalCapture = undefined;
    this.terrainCandidate = [];
    this.terrainAccepted.clear();
    this.terrainSources.clear();
    this.glyphSources.clear();
    this.tilemapSources.clear();
    this.invalidateActiveEntityRevision();
    this.visibilityProjectionCache = undefined;
    this.lastResyncReason = 'explicit-invalidate';
    skin?.dispose();
  }

  /**
   * Record the draws the GPU-driven raster owned in the last primary frame.
   * Resident renderables whose every draw it owned bypass the CPU frustum cull:
   * the GPU view pass culls them against the same bounds, and a camera move
   * then leaves the admission set, filtered plan and material table unchanged.
   * A renderable with any CPU-drawn residual (blend, transmission, fallback)
   * keeps the CPU cull, since that draw has no GPU cull behind it.
   */
  setGpuDrivenRasterLane(owned: GpuRasterOwnership | undefined): void {
    this.gpuRasterOwned = owned;
  }

  private gpuCullBypass(owner: object): ((snapshot: RenderableSnapshot) => boolean) | undefined {
    const owned = this.gpuRasterOwned;
    if (owned === undefined || this.gpuStatus !== 'resident' || this.gpuOwner !== owner) {
      return undefined;
    }
    return (snapshot) => owned.selection.ownsAll(snapshot);
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
      this.shadowProjection = undefined;
      this.materialProgramProjection.clear();
    }
    if (detachedComposition !== undefined) this.temporalCapture = undefined;
    if (detachedComposition !== undefined) {
      this.invalidateActiveEntityRevision();
    }
    if (detachedComposition !== undefined) {
      this.visibilityProjectionCache = undefined;
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
    let failure: unknown;
    const entry = this.composition;
    if (entry !== undefined) {
      try {
        entry.skin?.resetHistory();
      } catch (cause) {
        try {
          this.skinAdoption.fail(entry, cause);
        } catch (retired) {
          failure = retired;
        }
      }
    }
    const scene = this.gpuScene,
      device = this.gpuDevice;
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = this.options.getDevice === undefined ? 'inactive' : 'rebuild-pending';
    // Device-derived projections restart cold; the next frame rebuilds them
    // from the retained rows through the ordinary path.
    this.shadowProjection = undefined;
    this.materialProgramProjection.clear();
    this.temporalCapture = undefined;
    this.visibilityProjectionCache = undefined;
    try {
      this.retireGpuScene(scene, device);
    } catch (cause) {
      if (failure !== undefined)
        throw new AggregateError([failure, cause], 'Skin history and GPU Scene retirement failed', {
          cause: failure,
        });
      throw cause;
    }
    if (failure !== undefined) throw failure;
  }

  setPointsLinesInspections(inspections: readonly PointsLinesInspection[]): void {
    this.pointsLinesInspections = inspections.map((inspection) => ({
      ...inspection,
      cache: { ...inspection.cache },
      ...(inspection.refusal === undefined ? {} : { refusal: { ...inspection.refusal } }),
    }));
  }

  dispose(): void {
    const skin = this.composition?.skin;
    if (this.composition !== undefined) this.composition.skin = undefined;
    this.composition?.projection.dispose();
    this.composition = undefined;
    for (const observer of this.assetObservers.values()) observer.dispose();
    this.assetObservers.clear();
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = 'inactive';
    this.probeAttachMemo.previous = undefined;
    this.cullMemo.value = undefined;
    this.residualCullMemo.value = undefined;
    this.shadowProjection = undefined;
    this.materialProgramProjection.clear();
    this.temporalCapture = undefined;
    this.terrainCandidate = [];
    this.terrainAccepted.clear();
    this.terrainSources.clear();
    this.glyphSources.clear();
    this.tilemapSources.clear();
    this.invalidateActiveEntityRevision();
    this.visibilityProjectionCache = undefined;
    this.pointsLinesInspections = [];
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
    entry: PersistentCompositionEntry,
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

  inspect(): PersistentRenderSceneInspection {
    const entry = this.composition;
    const pointsLines = this.pointsLinesInspections;
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
      pointsLines,
    };
  }

  /** Current CPU composition is the scene authority even before GPU tables exist. */
  compositionRetainedScene(): PersistentGpuDrivenState['retained'] {
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

  compositionGpuDrivenState(): PersistentGpuDrivenState | undefined {
    const entry = this.composition;
    if (entry === undefined || this.gpuOwner !== entry.token || this.gpuScene === undefined) {
      return undefined;
    }
    const slots = entry.projection.slotsSnapshot();
    const meshes = entry.projection.meshFrame();
    const retained = this.compositionRetainedScene();
    const unavailable = entry.unavailableSlots;
    const sourcePlan = entry.topology.sourcePlan();
    const draws: DrawEvidence = {
      slots,
      meshes,
      unavailable,
      probe: entry.probeProjection.recordBufferProjection(),
      temporal: entry.projection.temporalDrawInputs(),
    };
    return {
      draws,
      ...(retained === undefined ? {} : { retained }),
      skin: entry.skin?.recordingFrame(),
      scene: this.gpuScene,
      meshes: entry.projection.meshFrame(),
      plan: sourcePlan,
      queryPlan: () => entry.topology.query(sourcePlan, meshes),
      completeGeometry: entry.topology.completeGeometry,
      unbatchedSlots: entry.topology.unbatchedSlots,
      pipelinePreparationSlots: entry.projection.pipelinePreparationSlots,
      slots,
      slotAt: slots.slotAt,
      drawSnapshotAt: this.slotDraws(entry),
      slotForEntity: slots.lookup,
      worldKeys: entry.worldKeys,
      worldIdentities: entry.worlds.map((world) => world.identity),
      structureMetrics: {
        worldEntitiesScanned: this.worldEntitiesScanned,
        sceneTableUploadBytes: this.sceneTableUploadBytes,
      },
      probeBlend: entry.probeProjection.recordBufferProjection(),
    };
  }

  /**
   * Draw snapshots by stable slot address: the current row with its Mesh,
   * temporal and probe facts, undefined for absent or unavailable rows.
   * Readers address rows by slot (entity) and never by frame rank.
   */
  private slotDraws(
    entry: PersistentCompositionEntry,
  ): (slot: number) => RenderableSnapshot | undefined {
    const unavailable = entry.unavailableSlots;
    const drawAt = entry.projection.drawFrame(
      entry.materialDispatch.materials(),
      this.temporalCounters,
      entry.projection.meshFrame(),
    );
    const probeAt = entry.probeProjection.captureRecordLookup();
    const probeMemo = this.probeAttachMemo.bySnapshot;
    return (slot) => {
      if (unavailable.has(slot)) return undefined;
      const source = drawAt(slot);
      return source === undefined ? undefined : attachProbeRecord(source, probeAt(slot), probeMemo);
    };
  }

  /**
   * Receipt of a submitted frame. Previous poses were already written when
   * rows changed; the receipt only starts the next frame's stamp and history.
   */
  commitTemporalFrame(terrainReady = true): Result<void, RhiError> {
    const gpuCommit = this.gpuScene?.commitFrame();
    if (gpuCommit !== undefined && !gpuCommit.ok) {
      this.temporalCapture = undefined;
      return gpuCommit;
    }
    const temporalCapture = this.temporalCapture;
    if (temporalCapture !== undefined) {
      try {
        temporalCapture.projection.commitSubmission(temporalCapture.capture);
      } catch (cause) {
        void cause;
        this.temporalCapture = undefined;
        return err(
          new RhiError({
            code: 'internal-error',
            expected: 'render scene remains unchanged while a submitted temporal frame commits',
            hint: 'retry the temporal frame after the renderer-owned scene snapshot is stable',
          }),
        );
      }
      this.temporalCapture = undefined;
    }
    if (terrainReady)
      this.terrainAccepted = new Map(
        this.terrainCandidate.flatMap((source) =>
          source.terrainSection === undefined
            ? []
            : [[terrainSectionKey(source, source.terrainSection.index), source] as const],
        ),
      );
    this.terrainCandidate = [];
    return ok(undefined);
  }

  /** Drop a staged temporal capture when the owning frame did not submit. */
  discardTemporalFrame(): void {
    this.terrainCandidate = [];
    this.temporalCapture = undefined;
  }

  /** Capture current CPU scene facts; commitTemporalFrame publishes them only after submit. */
  prepareTemporalFrame(
    visible: Iterable<Pick<RenderableSnapshot, 'worldId' | 'entityKey'>>,
    roster?: SceneSlotFrame,
  ): void {
    const projection = this.composition?.projection;
    this.temporalCapture =
      projection === undefined || this.composition?.temporalDemanded !== true
        ? undefined
        : { projection, capture: projection.captureSubmission(visible, roster) };
  }

  pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
    return this.composition?.projection.pointsLinesSnapshots() ?? [];
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

  private reconcileComposition(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases?: readonly RenderReadLease[],
    preserveVisibilityOnReorder = false,
  ): ExtractedFrame {
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
    this.temporalCapture = undefined;
    this.worldEntitiesScanned = candidateFrame.renderables.length;
    const worldKeys = this.visibilityWorldKeysFor(resourceScopes);
    if (!preserveVisibilityOnReorder) {
      this.invalidateActiveEntityRevision();
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
        this.invalidateActiveEntityRevision();
      }
    }
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
    projection.setSources(resourceScopes);
    const materialDispatch = new MaterialDispatch((worldId, handle, geometry, vertexColor) =>
      this.prepareMeshMaterial(
        resourceScopes[worldId],
        handle,
        geometry,
        vertexColor,
        this.terrainAssets ?? this.options.assets,
      ),
    );
    if (previousEntry !== undefined) {
      projection.remapWorlds(previousEntry.worlds.map((world) => resourceScopes.indexOf(world)));
    }
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
    const topology = previousEntry?.topology ?? new BatchTopology();
    topology.apply(delta);
    const assetClosures = new Map<World, SceneAssetClosure>();
    for (const world of worlds)
      if (world.assets !== undefined) assetClosures.set(world, new SceneAssetClosure(world.assets));
    for (const row of renderables) {
      const world = worlds[row.worldId];
      if (world !== undefined)
        assetClosures.get(world)?.replace(row.entityKey, renderableAssetRoots(row));
    }
    const resourceWorld = worlds[owner.resourceOwner];
    if (resourceWorld !== undefined)
      assetClosures.get(resourceWorld)?.replace(-1, publicationFrameDependencies(candidateFrame));
    const token = previousEntry?.token ?? {};
    const entry: PersistentCompositionEntry = {
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
      residual: new ResidualRoster(),
      probeProjection: new ProbeBlendSceneProjection(),
      probeObjects: undefined,
      temporalDemanded: standardSceneTemporalDemand(
        candidateFrame.cameras[0],
        this.options.getTemporalConsumerDemand?.(),
      ),
    };
    this.composition = entry;
    if (stableCandidateFrame.renderables.some((snapshot) => snapshot.skinBinding !== undefined))
      this.skinAdoption.apply(entry, sceneSnapshotDelta(projection.slotsSnapshot()));
    this.skinAdoption.initializeJoints(entry);
    projection.setTemporalTracking(entry.temporalDemanded);
    // The projection must be installed before deriving probe primitives.  On
    // the first composition rebuild `projectReflectionProbes` otherwise sees
    // no composition and silently drops every per-renderable selection,
    // leaving the producer on its neutral/no-demand path until an unrelated
    // later rebuild.
    this.projectReflectionProbes(candidateFrame.reflectionProbes ?? []);
    this.projectProbes(entry, candidateFrame);
    materialDispatch.prepare(projection.meshFrame());
    const dispatch = this.queryMaterialPasses(entry);
    this.syncGpuOwner(token, projection, materialDispatch.materials(), delta);
    if (previousEntry === undefined) this.fullRebuilds += 1;
    this.lastResyncReason = 'attach';
    const materialized = projection.materialize();
    const candidates = entry.temporalDemanded
      ? projection.materializeTemporal(this.temporalCounters, materialDispatch.materials())
      : materialized;
    const frameWithProbes = attachProbeRecords(
      {
        ...stableCandidateFrame,
        renderables: candidates,
        dispatch,
      },
      candidates,
      projection.slotsSnapshot(),
      entry.probeProjection,
      this.probeAttachMemo,
    );
    const { frame: ownedFrame, materials: materialFrame } = this.projectSceneSources(
      frameWithProbes,
      entry,
    );
    const meshFrame = projection.meshFrame();
    const hasGeneratedDraws =
      entry.projection.hasSource('terrain') ||
      entry.projection.hasSource('glyph') ||
      entry.projection.hasSource('tilemap');
    const skinFrame = this.skinAdoption.prepareFrame(entry);
    const { frame: result, subsurface } = this.cullFrame(
      entry,
      ownedFrame,
      materialFrame,
      meshFrame,
      skinFrame,
      hasGeneratedDraws,
    );
    const materialProgramProjection = this.materialProgramProjection;
    const shadowSlots = entry.projection.slotsSnapshot();
    this.shadowProjection = {
      meshDraws: projection,
      content: {
        materials: materialFrame,
        meshes: meshFrame,
        subsurface,
        owner: entry,
        sceneRevision: projection.revisionValue(),
        dispatchRevision: entry.materialDispatch.revisionValue(),
        viewDraws: !hasGeneratedDraws
          ? []
          : ownedFrame.renderables.filter(
              (source) => source.terrainSection !== undefined || source.generatedMesh !== undefined,
            ),
      },
      renderables: ownedFrame.renderables,
      dispatch: ownedFrame.dispatch,
      get materialPrograms() {
        return materialProgramProjection.project(ownedFrame.dispatch, materialFrame);
      },
      worldBoundsOf: (source, out, row) => {
        const slot = sceneRow(row, source) ?? shadowSlots.lookup(source.worldId, source.entityKey);
        return source.terrainSection !== undefined || source.generatedMesh !== undefined
          ? writeBounds(worldBounds(source), out)
          : slot !== undefined &&
              projection.writeCullingWorldBoundsAt(slot, out, meshFrame, materialFrame, skinFrame);
      },
    };

    for (const source of sourceStates) source.batch.accept();
    this.terrainCandidate = !hasGeneratedDraws
      ? []
      : result.renderables.filter(
          (source) => source.terrainSection !== undefined || source.generatedMesh !== undefined,
        );
    return result;
  }

  /**
   * GPU-lane frames test only residual rows and stay uncompacted; the classic
   * lane, and frames with view-generated rows, compact the culled frame.
   */
  private cullFrame(
    entry: PersistentCompositionEntry,
    ownedFrame: ExtractedFrame,
    materialFrame: MaterialFrame,
    meshFrame: MeshFrame,
    skinFrame: SkinSceneFrame | undefined,
    hasGeneratedDraws: boolean,
  ): ReturnType<typeof cullPersistentFrame> {
    // Frame rank is roster rank, so a ranked candidate verifies its row
    // instead of searching the identity tree.
    const roster = entry.projection.slotsSnapshot();
    const boundsOf = (
      snapshot: RenderableSnapshot,
      index: number,
      out: box3.Box3,
      row?: RenderSceneSlot,
    ): boolean => {
      const slot =
        sceneRow(row ?? (index >= 0 ? roster.at(index) : undefined), snapshot) ??
        entry.projection.slotOf(snapshot);
      if (snapshot.terrainSection !== undefined || snapshot.generatedMesh !== undefined)
        return writeBounds(worldBounds(snapshot), out);
      return slot === undefined
        ? writeBounds(entry.projection.cullingWorldBounds(snapshot), out)
        : entry.projection.writeCullingWorldBoundsAt(
            slot,
            out,
            meshFrame,
            materialFrame,
            skinFrame,
          );
    };
    const owned = this.gpuCullBypass(entry.token);
    const selection = this.gpuRasterOwned?.selection;
    if (owned !== undefined && selection !== undefined && !hasGeneratedDraws) {
      this.cullMemo.value = undefined;
      return cullResidualFrame(
        ownedFrame,
        materialFrame,
        boundsOf,
        this.gpuOwnedFrame(entry),
        selection,
        this.residualCullMemo,
      );
    }
    this.residualCullMemo.value = undefined;
    return cullPersistentFrame(
      ownedFrame,
      materialFrame,
      boundsOf,
      this.cullMemo,
      owned,
      meshFrame,
      hasGeneratedDraws || entry.unavailableSlots.size > 0
        ? ownedFrame.renderables
        : entry.materialDispatch,
      entry.materialDispatch.revisionValue(),
    );
  }

  /**
   * Residual rows are unbatched geometry and members of uncovered bindings,
   * retained by the view's roster from topology and selection diffs. Slot
   * roster and plan are fixed for this frame; rows resolve by slot address.
   */
  private gpuOwnedFrame(entry: PersistentCompositionEntry): GpuOwnedFrame {
    const slots = entry.projection.slotsSnapshot();
    const plan = entry.topology.sourcePlan();
    const unbatched = entry.topology.unbatchedSlots;
    const dispatch = entry.materialDispatch;
    const rowAt = this.slotDraws(entry);
    // One fixed residual list per selection; frame rows resolve only when read.
    let memo:
      | {
          selection: GpuDrawSelection;
          set: FrameSet;
          records: readonly RenderSceneSlot[];
          rows?: readonly RenderableSnapshot[];
        }
      | undefined;
    const residualOf = (selection: GpuDrawSelection) => {
      if (memo?.selection === selection) return memo;
      const records: RenderSceneSlot[] = [];
      const set = entry.residual.sync(plan, unbatched, selection);
      const unavailable = entry.unavailableSlots;
      for (const slot of set) {
        // An unpublished retained slot keeps its row for recovery but has no
        // dispatch binding or accepted material version; it draws nothing.
        if (unavailable.has(slot)) continue;
        const record = slots.slotAt(slot);
        if (record !== undefined) records.push(record);
      }
      memo = { selection, set, records };
      return memo;
    };
    return {
      residual(selection) {
        const residual = residualOf(selection);
        residual.rows ??= residual.records.flatMap((record) => rowAt(record.slot) ?? []);
        return residual.rows;
      },
      residualSet: (selection) => residualOf(selection).set,
      residualSlots: (selection) => residualOf(selection).records,
      displays(row) {
        const slot = slots.identitySlot(row.worldId, row.entityKey);
        return slot !== undefined && dispatch.displays(slot);
      },
      row(worldId, entity) {
        const slot = slots.identitySlot(worldId, entity);
        return slot === undefined ? undefined : rowAt(slot);
      },
      slots,
    };
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
  private queryMaterialPasses(entry: PersistentCompositionEntry): DispatchList {
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

  /**
   * Derive an ephemeral frame plan from persistent scene facts. The scene
   * retains identity/topology/read versions; no prior frame object is an authority.
   */
  private deriveFramePlan(
    entry: PersistentCompositionEntry,
    resourceFrame: ExtractedFrame,
    delta?: RenderSceneApplyResult,
    materialUpdates?: readonly MaterialResource[],
  ): ExtractedFrame {
    const dispatch = this.queryMaterialPasses(entry);
    this.syncGpuOwner(
      entry.token,
      entry.projection,
      entry.materialDispatch.materials(),
      delta,
      materialUpdates,
    );
    const candidateFrame: ExtractedFrame = {
      ...resourceFrame,
      hiddenEntityReports: entry.hiddenEntityReports,
      visibilityStats:
        entry.sourceStates.length === 0
          ? resourceFrame.visibilityStats
          : { explicitlyHidden: entry.hiddenEntityReports.length },
      dispatch,
    };
    entry.temporalDemanded = standardSceneTemporalDemand(
      candidateFrame.cameras[0],
      this.options.getTemporalConsumerDemand?.(),
    );
    entry.projection.setTemporalTracking(entry.temporalDemanded);
    this.projectProbes(entry, candidateFrame);
    this.projectReflectionProbes(candidateFrame.reflectionProbes ?? []);
    const materialized = entry.projection.materialize();
    const candidates = entry.temporalDemanded
      ? entry.projection.materializeTemporal(
          this.temporalCounters,
          entry.materialDispatch.materials(),
          entry.unavailableSlots.size === 0 ? undefined : entry.unavailableSlots,
        )
      : materialized;
    const acceptedSlots = entry.projection.slotsSnapshot();
    const unavailable = entry.unavailableSlots;
    const drawableCandidates =
      unavailable.size === 0 || entry.temporalDemanded
        ? candidates
        : new FrameProjection(candidates, (snapshot) => {
            const slot = acceptedSlots.lookup(snapshot.worldId, snapshot.entityKey);
            return slot !== undefined && unavailable.has(slot.slot)
              ? { ...snapshot, authorVisible: false }
              : snapshot;
          });
    const frameWithProbes = attachProbeRecords(
      { ...candidateFrame, renderables: drawableCandidates },
      drawableCandidates,
      entry.projection.slotsSnapshot(),
      entry.probeProjection,
      this.probeAttachMemo,
    );
    const { frame: ownedFrame, materials: materialFrame } = this.projectSceneSources(
      frameWithProbes,
      entry,
    );
    const resource = entry.worlds[0];
    const publicationRevision = entry.publicationRevision;
    const sceneRevision = entry.projection.revisionValue();
    const dispatchRevision = entry.materialDispatch.revisionValue();
    const publicationSource: ShadowPublicationSource | undefined =
      resourceFrame.lights.directionalCsmConfig?.staggerCascades !== true ||
      publicationRevision === undefined ||
      resource === undefined ||
      resource.world !== undefined
        ? undefined
        : {
            resources: resource,
            revision: publicationRevision,
            isCurrent: () =>
              this.composition === entry &&
              entry.worlds.length === 1 &&
              entry.worlds[0] === resource &&
              entry.publicationRevision === publicationRevision &&
              resource.revision === publicationRevision &&
              entry.projection.revisionValue() === sceneRevision &&
              entry.materialDispatch.revisionValue() === dispatchRevision,
          };
    const meshFrame = entry.projection.meshFrame();
    const hasGeneratedDraws =
      entry.projection.hasSource('terrain') ||
      entry.projection.hasSource('glyph') ||
      entry.projection.hasSource('tilemap');
    const skinFrame = this.skinAdoption.prepareFrame(entry);
    const { frame: result, subsurface } = this.cullFrame(
      entry,
      ownedFrame,
      materialFrame,
      meshFrame,
      skinFrame,
      hasGeneratedDraws,
    );
    const materialProgramProjection = this.materialProgramProjection;
    const shadowSlots = entry.projection.slotsSnapshot();
    this.shadowProjection = {
      meshDraws: entry.projection,
      content: {
        materials: materialFrame,
        meshes: meshFrame,
        subsurface,
        owner: entry,
        sceneRevision: entry.projection.revisionValue(),
        dispatchRevision: entry.materialDispatch.revisionValue(),
        ...(publicationSource === undefined ? {} : { publicationSource }),
        viewDraws: !hasGeneratedDraws
          ? []
          : ownedFrame.renderables.filter(
              (source) => source.terrainSection !== undefined || source.generatedMesh !== undefined,
            ),
      },
      renderables: ownedFrame.renderables,
      dispatch: ownedFrame.dispatch,
      get materialPrograms() {
        return materialProgramProjection.project(ownedFrame.dispatch, materialFrame);
      },
      worldBoundsOf: (source, out, row) => {
        const slot = sceneRow(row, source) ?? shadowSlots.lookup(source.worldId, source.entityKey);
        return source.terrainSection !== undefined || source.generatedMesh !== undefined
          ? writeBounds(worldBounds(source), out)
          : slot !== undefined &&
              entry.projection.writeCullingWorldBoundsAt(
                slot,
                out,
                meshFrame,
                materialFrame,
                skinFrame,
              );
      },
    };

    this.terrainCandidate = !hasGeneratedDraws
      ? []
      : result.renderables.filter(
          (source) => source.terrainSection !== undefined || source.generatedMesh !== undefined,
        );
    return result;
  }

  private projectProbes(entry: PersistentCompositionEntry, frame: ExtractedFrame): void {
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
    // A rebuilt GPU table has no submitted history on this device. Seed its
    // temporal flags from the same cold snapshot as a newly extracted scene.
    const temporal =
      projection.temporalDrawInputs() === undefined
        ? undefined
        : (slot: RenderSceneSlot) => projection.temporalSnapshotBySlot(slot.slot, true);
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
