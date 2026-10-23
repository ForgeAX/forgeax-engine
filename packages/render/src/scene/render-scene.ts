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
import { box3, frustum, mat4 } from '@forgeax/engine-math';
import {
  type MaterialCookRasterContext,
  materialProgramContextKey,
} from '@forgeax/engine-pack/material-cook';
import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { Children, GlobalTransform, MorphWeights } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { err, type MeshAsset, ok, type Result, type SkeletonAsset } from '@forgeax/engine-types';
import { buildCameraFrusta } from '../camera-frusta';
import { Instances, Lines, Points, SpriteInstances } from '../components';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
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
import { fingerprintNumericArray, InstanceBoundsCache } from '../instances-derived-bounds';
import { isReflectedTransform } from '../material-render-state';
import { MaterialResource, materialResource } from '../material-resource';
import { expandPointsLinesBounds } from '../points-lines/bounds';
import type { PointsLinesInspection } from '../points-lines/inspection';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import { RenderPublicationError, type RenderPublicationIdentity } from '../publication/contract';
import { publicationFrameDependencies, renderableAssetRoots } from '../publication/dependencies';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { RenderResourceScope } from '../publication/resource-scope';
import { worldRenderResources } from '../publication/resource-scope';
import { type ValidatedRenderable, worldEntityKey } from '../record/frame-snapshot';
import { MeshDrawSlots } from '../record/mesh-draw-slots';
import {
  type ReflectionProbeFact,
  ReflectionProbeProjection,
  type ReflectionProbeSelectionResult,
} from '../reflection/projection';
import type {
  DispatchEntry,
  DispatchList,
  ExtractedFrame,
  MaterialSnapshotCachesByWorld,
  RenderableSnapshot,
  RenderableTemporalSnapshot,
} from '../render-system-extract';
import { materialSnapshotContext, resolveMaterialSnapshot } from '../render-system-extract';
import { expandDisplacementBounds } from '../standard-displacement-bounds';
import { type SubsurfaceDemand, SubsurfaceSelection } from '../subsurface/selection';
import { standardSceneTemporalDemand } from '../temporal/standard-scene-data';
import type { TerrainLayers } from '../terrain/layers';
import { TerrainSourceCache } from '../terrain/source';
import { projectTerrainView, terrainSectionKey } from '../terrain/view.js';
import { projectTilemapView, TilemapSources } from '../tilemap-source';
import type { TransmissionDemand } from '../transmission/projection';
import { SceneAssetClosure } from './asset-closure';
import { CompositionSkinAdoption } from './composition-skin';
import { projectDrawDispatch } from './draw-dispatch';
import { type FrameList, FrameProjection, RetainedFrameProjection } from './frame-list';
import { FrameSet } from './frame-set';
import { MaterialDispatch, type MaterialFrame } from './material-dispatch';
import { meshDrawMaterials, meshDrawSnapshot } from './mesh-draw';
import { MeshFrame, type MeshGeometry } from './mesh-frame';
import type { MeshMaterialGeometry } from './mesh-materials';
import { attachProbeRecord, attachProbeRecords, type ProbeAttachMemo } from './probe-attach';
import {
  type ProbeBlendBufferProjection,
  ProbeBlendSceneProjection,
  type ProbeSceneObjectInput,
} from './probe-blend';
import {
  boundsFromArray,
  type CachedWorldBounds,
  createTemporalSnapshot,
  cullingDisplacementRadius,
  type FrameCacheTally,
  hasDisplacementSource,
  identityKey,
  intersects,
  ownInstances,
  ownPointsLinesSnapshot,
  ownSnapshot,
  type TemporalCache,
  temporalDrawSnapshot,
  worldBounds,
  writeBounds,
} from './render-scene-snapshots';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneInspection,
  RenderSceneOperation,
  RenderSceneRecord,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';
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
import { SceneSlotFrame, SceneSlots } from './scene-slots';
import { buildShadowFrusta } from './shadow-visibility';
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

/** Project a complete retained scene through the same writer as frame deltas. */
function sceneSnapshotDelta(slots: FrameList<RenderSceneSlot>): RenderSceneApplyResult {
  return {
    created: slots.length,
    updated: 0,
    removed: 0,
    recreated: 0,
    ignoredLateUpdates: 0,
    createdSlots: [...slots],
    updatedSlots: [],
    contentUpdatedSlots: [],
    instanceUpdatedSlots: [],
    removedSlots: [],
    recreatedSlots: [],
    resynced: 1,
  };
}

/**
 * World boxes seeded by a rebuild so the change log proves the old box of
 * each slot's first later change instead of reporting it unbounded.
 */
function sceneSnapshotBounds(projection: RenderScene): GpuSceneSlotBounds {
  return (slot) => projection.cullingWorldBoundsAt(slot);
}

interface PendingIdentity {
  readonly worldId: number;
  readonly entityKey: number;
  readonly initial: RenderSceneSlot | undefined;
  current: RenderableSnapshot | undefined;
  removed: boolean;
  contentChanged: boolean;
  /** An Instances row changed during this apply batch. */
  instanceChanged: boolean;
  /** A retained world transform changed during this apply batch. */
  transformChanged: boolean;
}

interface WorldTransformSpan {
  readonly worldId: number;
  readonly entities: Readonly<Uint32Array>;
  readonly worlds: Readonly<Float32Array>;
}

/** The normal extract request used by the persistent scene owner. */
export type PersistentRenderCandidateRequest =
  | 'full'
  | 'none'
  | {
      readonly kind: 'partial';
      /** Entity keys are local to the corresponding World entry. */
      readonly entitiesByWorld: readonly (ReadonlySet<number> | undefined)[];
    };

export interface RenderSceneSubmissionCapture {
  readonly frame: SceneSlotFrame;
  readonly revision: number;
  readonly slots: readonly {
    readonly slot: number;
    readonly current: RenderSceneSlot | undefined;
  }[];
  readonly visible: ReadonlyMap<number, number>;
}

export interface RenderSceneSubmissionDelta {
  readonly epoch: number;
  readonly slots: readonly number[];
}

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
  /** Writes borrowed task scratch; false leaves out unchanged and means uncullable. */
  readonly worldBoundsOf: (source: RenderableSnapshot, out: box3.Box3) => boolean;
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly dispatch: DispatchList;
  /** Immediate preparation of actual draw work against this accepted material root. */
  readonly prepareDrawDispatch: (draws: readonly ValidatedRenderable[]) => DispatchList;
  readonly materialPrograms?: GpuDrivenMaterialProgramIndex;
}

const EMPTY_SLOT_FRAME = new SceneSlotFrame(undefined, 0, undefined);

/**
 * The renderer's single rebuildable CPU scene authority.
 *
 * World/entity identity maps, stable slot generations, material reverse
 * lookup, and spatial facts live together here. Frame-local consumers read
 * snapshots from this owner and never create a second projection ledger.
 */
export class RenderScene {
  private meshes = new MeshFrame();
  private readonly meshHolders = new Map<string, number>();

  constructor(private sources: readonly RenderResourceScope[] = []) {}

  setSources(sources: readonly RenderResourceScope[]): void {
    this.sources = sources;
  }
  meshFrame(): MeshFrame {
    return this.meshes;
  }

  /** Direct asset evidence changes one shared geometry row, without visiting its instances. */
  adoptMesh(worldId: number, handle: number, mesh: MeshAsset | undefined): boolean {
    if (!this.meshHolders.has(identityKey(worldId, handle))) return false;
    this.meshes =
      mesh === undefined
        ? this.meshes.without(worldId, handle)
        : this.meshes.with(worldId, handle, mesh);
    return mesh !== undefined;
  }

  private acquireMesh(snapshot: RenderableSnapshot): void {
    if (snapshot.assetHandle === undefined) return;
    const key = identityKey(snapshot.worldId, snapshot.assetHandle);
    const holders = this.meshHolders.get(key) ?? 0;
    this.meshHolders.set(key, holders + 1);
    if (holders > 0) return;
    const scope = this.sources[snapshot.worldId];
    if (scope === undefined) return;
    const asset = scope.resolveAsset<MeshAsset>(snapshot.assetHandle);
    if (asset.ok && asset.value.kind === 'mesh')
      this.meshes = this.meshes.with(snapshot.worldId, snapshot.assetHandle, asset.value);
  }

  private releaseMesh(snapshot: RenderableSnapshot): void {
    if (snapshot.assetHandle === undefined) return;
    const key = identityKey(snapshot.worldId, snapshot.assetHandle);
    const holders = (this.meshHolders.get(key) ?? 1) - 1;
    if (holders > 0) this.meshHolders.set(key, holders);
    else {
      this.meshHolders.delete(key);
      this.meshes = this.meshes.without(snapshot.worldId, snapshot.assetHandle);
    }
  }
  private readonly meshDrawSlots = new MeshDrawSlots();
  private preparationSlots = new FrameSet();

  get pipelinePreparationSlots(): ReadonlySet<number> {
    return this.preparationSlots;
  }

  private updatePreparation(slot: RenderSceneSlot): void {
    if (slot.snapshot.pipelinePreparation === undefined)
      this.preparationSlots = this.preparationSlots.without(slot.slot);
    else this.preparationSlots = this.preparationSlots.with(slot.slot);
  }

  beginMeshDrawFrame(sources?: FrameList<RenderableSnapshot>): void {
    const scene = this;
    this.meshDrawSlots.beginFrame(
      sources === undefined
        ? undefined
        : (function* () {
            for (const source of sources) {
              const key =
                source.nativeDraw?.key ??
                (source.terrainSection === undefined
                  ? undefined
                  : `section:${source.terrainSection.index}`);
              if (key === undefined) continue;
              const record = scene.lookup(source.worldId, source.entityKey);
              if (record === undefined) throw new Error('A draw must belong to the retained Scene');
              yield { record, key };
            }
          })(),
    );
  }

  /** Source, terrain and folded draws share addresses across this view and its captures. */
  meshDrawSlot(source: RenderableSnapshot, folded = false): number {
    const record = this.lookup(source.worldId, source.entityKey);
    if (record === undefined) throw new Error('A draw must belong to the retained Scene');
    return this.meshDrawSlots.index(
      record,
      folded
        ? 'folded'
        : source.nativeDraw !== undefined
          ? source.nativeDraw
          : source.terrainSection === undefined
            ? 'source'
            : { key: `section:${source.terrainSection.index}` },
    );
  }

  get meshDrawCapacity(): number {
    return this.meshDrawSlots.capacity;
  }
  private slots = new SceneSlots();
  private lastSubmittedFrame = new SceneSlotFrame(undefined, 0, undefined);
  private readonly generations: number[] = [];
  private readonly freeSlots: number[] = [];
  private dirtySinceSubmitted = new Set<number>();
  private temporalTracking = false;
  private lastSubmittedVisible: ReadonlyMap<number, number> = new Map();
  private submittedEpoch = 0;
  // Neither a live record nor a cold cache retains an obsolete Mesh version.
  private readonly meshWorldBounds = new WeakMap<
    MeshGeometry,
    WeakMap<RenderSceneSlot, CachedWorldBounds>
  >();
  private readonly sourceWorldBounds = new WeakMap<RenderSceneSlot, CachedWorldBounds>();
  private readonly slotBySnapshot = new WeakMap<RenderableSnapshot, RenderSceneSlot>();
  private readonly instanceBoundsCache = new InstanceBoundsCache();
  private materialized:
    | {
        readonly meshes: MeshFrame;
        readonly value: FrameProjection<RenderSceneSlot, RenderableSnapshot>;
      }
    | undefined;
  private temporalMaterialized:
    | {
        readonly current: SceneSlotFrame;
        readonly submitted: SceneSlotFrame;
        readonly visible: ReadonlyMap<number, number>;
        readonly materials: MaterialFrame;
        readonly meshes: MeshFrame;
        readonly unavailable: FrameSet | undefined;
        readonly value: FrameList<RenderableSnapshot>;
      }
    | undefined;
  private temporalBySlot: TemporalCache = new WeakMap();
  private revision = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private renderableScans = 0;
  private fullRebuilds = 0;
  private resyncs = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;

  /** Bounded current-scene facts for the Standard temporal producer. */
  temporalContributorCount(): number {
    return this.slots.size;
  }

  apply(
    operations: readonly RenderSceneOperation[],
    spans: readonly WorldTransformSpan[] = [],
  ): RenderSceneApplyResult {
    if (operations.length === 0 && spans.length === 0) {
      this.noChangeFrames += 1;
      this.renderableScans = 0;
      return this.emptyResult();
    }

    // Prepare every potentially fallible payload copy before mutating retained
    // columns. The commit loop below only uses owned POD and borrowed numeric spans.
    const preparedOperations = operations.map((operation): RenderSceneOperation => {
      if (operation.kind === 'remove') return operation;
      if (
        operation.snapshot !== undefined &&
        (operation.worldId !== operation.snapshot.worldId ||
          operation.entityKey !== operation.snapshot.entityKey)
      ) {
        throw new RangeError('RenderScene update identity must match its source snapshot');
      }
      return {
        ...operation,
        ...(operation.snapshot === undefined ? {} : { snapshot: ownSnapshot(operation.snapshot) }),
        ...(operation.instances === undefined
          ? {}
          : { instances: ownInstances(operation.instances) }),
      };
    });
    this.deltaFrames += 1;
    this.renderableScans = operations.length;
    const pendingByWorld = new Map<number, Map<number, PendingIdentity>>();
    const pendingOrder: PendingIdentity[] = [];
    let ignoredLateUpdates = 0;

    const pendingFor = (worldId: number, entityKey: number): PendingIdentity => {
      let entities = pendingByWorld.get(worldId);
      if (entities === undefined) {
        entities = new Map<number, PendingIdentity>();
        pendingByWorld.set(worldId, entities);
      }
      let pending = entities.get(entityKey);
      if (pending !== undefined) return pending;
      const initial = this.lookup(worldId, entityKey);
      pending = {
        worldId,
        entityKey,
        initial,
        current: initial?.snapshot,
        removed: false,
        contentChanged: false,
        instanceChanged: false,
        transformChanged: false,
      };
      entities.set(entityKey, pending);
      pendingOrder.push(pending);
      return pending;
    };

    const updateWorld = (pending: PendingIdentity, source: Float32Array, offset: number): void => {
      const current = pending.current;
      if (current === undefined) return;
      const target = current.transform.world;
      for (let lane = 0; lane < 16; lane += 1) {
        if (target[lane] === (source[offset + lane] ?? 0)) continue;
        // Draw caches key the accepted snapshot identity. A changed transform
        // gets a new snapshot; unchanged rows retain their allocation-free path.
        const world = new Float32Array(16);
        for (let index = 0; index < 16; index += 1) world[index] = source[offset + index] ?? 0;
        pending.current = { ...current, transform: { ...current.transform, world } };
        pending.transformChanged = true;
        // Only a parity change moves this source into another raster batch.
        if (isReflectedTransform(target) !== isReflectedTransform(world))
          pending.contentChanged = true;
        return;
      }
    };
    for (const operation of preparedOperations) {
      const pending = pendingFor(operation.worldId, operation.entityKey);
      if (operation.kind === 'remove') {
        pending.current = undefined;
        pending.removed = true;
        continue;
      }
      if (operation.snapshot !== undefined) {
        const previousMaterials = pending.current?.materials;
        const next = operation.snapshot;
        pending.current =
          previousMaterials !== undefined &&
          previousMaterials.length === next.materials.length &&
          previousMaterials.every((material, index) => material === next.materials[index])
            ? { ...next, materials: previousMaterials }
            : next;
        pending.contentChanged = true;
      }
      if (pending.current === undefined) {
        ignoredLateUpdates += 1;
        continue;
      }
      if (operation.instances !== undefined) {
        pending.current = {
          ...pending.current,
          instances: operation.instances,
        };
        pending.instanceChanged = true;
      }
      if (operation.world !== undefined) {
        updateWorld(pending, operation.world, 0);
      }
    }
    // The same pending identity merges column updates with all other source
    // edits. There is one publication and one consumer delta per entity.
    for (const span of spans) {
      this.renderableScans += span.entities.length;
      for (let row = 0; row < span.entities.length; row += 1) {
        const entity = span.entities[row];
        if (entity === undefined) continue;
        const pending = pendingFor(span.worldId, entity);
        if (pending.current === undefined) {
          ignoredLateUpdates += 1;
          continue;
        }
        updateWorld(pending, span.worlds, row * 16);
      }
    }

    let created = 0;
    let updated = 0;
    let removed = 0;
    let recreated = 0;
    const createdSlots: RenderSceneSlot[] = [];
    const updatedSlots: RenderSceneSlot[] = [];
    const contentUpdatedSlots: RenderSceneSlot[] = [];
    const instanceUpdatedSlots: RenderSceneSlot[] = [];
    const removedSlots: RenderSceneRecord[] = [];
    const recreatedSlots: RenderSceneSlot[] = [];
    for (const pending of pendingOrder) {
      if (pending.initial === undefined) {
        if (pending.current === undefined) continue;
        const createdSlot = this.allocate(pending.current);
        this.dirtySinceSubmitted.add(createdSlot.slot);
        createdSlots.push(createdSlot);
        created += 1;
        continue;
      }
      if (pending.current === undefined) {
        this.dirtySinceSubmitted.add(pending.initial.slot);
        this.release(pending.initial);
        removedSlots.push(pending.initial);
        removed += 1;
        continue;
      }
      if (pending.removed) {
        this.dirtySinceSubmitted.add(pending.initial.slot);
        this.release(pending.initial);
        const recreatedSlot = this.allocate(pending.current);
        this.dirtySinceSubmitted.add(recreatedSlot.slot);
        recreatedSlots.push(recreatedSlot);
        recreated += 1;
        continue;
      }
      if (!pending.contentChanged && !pending.instanceChanged && !pending.transformChanged)
        continue;
      const updatedSlot: RenderSceneSlot =
        pending.current === pending.initial.snapshot
          ? pending.initial
          : { ...pending.initial, snapshot: pending.current };
      if (pending.initial.snapshot.assetHandle !== updatedSlot.snapshot.assetHandle) {
        this.releaseMesh(pending.initial.snapshot);
        this.acquireMesh(updatedSlot.snapshot);
      }
      this.slots.set(pending.initial.slot, updatedSlot);
      if (pending.contentChanged) this.updatePreparation(updatedSlot);

      if (this.temporalTracking) this.dirtySinceSubmitted.add(updatedSlot.slot);
      updatedSlots.push(updatedSlot);
      if (pending.contentChanged) {
        contentUpdatedSlots.push(updatedSlot);
      } else if (pending.instanceChanged) instanceUpdatedSlots.push(updatedSlot);
      updated += 1;
    }

    const changed = created + updated + removed + recreated > 0;
    if (changed) {
      this.revision += 1;
      if (
        created + removed + recreated > 0 ||
        pendingOrder.some((pending) => pending.current !== pending.initial?.snapshot)
      ) {
        this.invalidateSnapshots();
      }
    }
    return {
      created,
      updated,
      removed,
      recreated,
      ignoredLateUpdates,
      createdSlots,
      updatedSlots,
      contentUpdatedSlots,
      instanceUpdatedSlots,
      removedSlots,
      recreatedSlots,
      resynced: 0,
    };
  }

  /** Rebind positional World indices while retaining stable slot and submission history. */
  remapWorlds(indices: readonly number[]): void {
    this.meshes = new MeshFrame();
    this.meshHolders.clear();
    for (const slot of this.slots.capture()) {
      if (slot === undefined) continue;
      this.instanceBoundsCache.invalidate(slot.entityKey, slot.worldId);
      const mapped = indices[slot.worldId];
      const worldId = mapped === undefined || mapped < 0 ? -1 - slot.worldId : mapped;
      const remapped = { ...slot, worldId, snapshot: { ...slot.snapshot, worldId } };
      this.acquireMesh(remapped.snapshot);
      this.slots.set(slot.slot, remapped);
    }
    this.invalidateSnapshots();
  }

  /** Reconcile the current identity set while retaining slots for survivors. */
  reset(snapshots: FrameList<RenderableSnapshot>, countAsRebuild = true): void {
    // A full reconciliation is a temporal cut.  Survivors may keep their
    // stable slot, but no prior slot is valid until this frame submits.
    this.temporalBySlot = new WeakMap();
    this.lastSubmittedFrame = EMPTY_SLOT_FRAME;
    this.lastSubmittedVisible = new Map();
    this.dirtySinceSubmitted.clear();
    this.submittedEpoch = 0;
    const desired = new Map<string, RenderableSnapshot>();
    for (const snapshot of snapshots) {
      desired.set(identityKey(snapshot.worldId, snapshot.entityKey), snapshot);
    }

    for (const slot of this.slots.capture()) {
      if (slot === undefined) continue;
      if (!desired.has(identityKey(slot.worldId, slot.entityKey))) this.release(slot);
    }

    for (const snapshot of desired.values()) {
      const existing = this.lookup(snapshot.worldId, snapshot.entityKey);
      if (existing === undefined) {
        const created = this.allocate(ownSnapshot(snapshot));
        this.dirtySinceSubmitted.add(created.slot);
        continue;
      }
      const updated: RenderSceneSlot = {
        ...existing,
        snapshot: ownSnapshot(snapshot),
      };
      if (existing.snapshot.assetHandle !== snapshot.assetHandle) {
        this.releaseMesh(existing.snapshot);
        this.acquireMesh(snapshot);
      }
      this.slots.set(existing.slot, updated);
      this.updatePreparation(updated);

      this.dirtySinceSubmitted.add(updated.slot);
    }

    this.revision += 1;
    if (countAsRebuild) this.fullRebuilds += 1;
    this.invalidateSnapshots();
  }

  /** Recovery changes device receipts, preserving exact membership and slot generations. */
  prepareRecoverySlots(slots: FrameList<RenderSceneSlot>): { validate(): void; publish(): void } {
    const before = this.slots.capture(),
      revision = this.revision,
      meshes = this.meshes;
    if (slots.length !== before.length)
      throw new Error('Recovery must preserve complete Scene membership');
    const next = this.slots.fork(),
      dirty = new Set<number>();
    for (const slot of slots) {
      const prior = before.slotAt(slot.slot);
      if (
        prior === undefined ||
        prior.generation !== slot.generation ||
        prior.worldId !== slot.worldId ||
        prior.entityKey !== slot.entityKey ||
        prior.snapshot.assetHandle !== slot.snapshot.assetHandle
      )
        throw new Error('Recovery must preserve Scene slot identity and shared geometry');
      if (dirty.has(slot.slot)) throw new Error('Recovery cannot duplicate a Scene slot');
      const snapshot = ownSnapshot(slot.snapshot);
      next.set(slot.slot, { ...slot, snapshot });
      dirty.add(slot.slot);
    }
    if (dirty.size !== before.length) throw new Error('Recovery must contain every Scene slot');
    next.capture();
    const temporal: TemporalCache = new WeakMap(),
      visible = new Map<number, number>();
    return {
      validate: () => {
        if (this.revision !== revision || this.slots.capture() !== before || this.meshes !== meshes)
          throw new Error('Recovery Scene source changed before publication');
      },
      publish: () => {
        // All copying, page writes and validation are complete before activation.
        this.slots = next;
        this.dirtySinceSubmitted = dirty;
        this.temporalBySlot = temporal;
        this.lastSubmittedFrame = EMPTY_SLOT_FRAME;
        this.lastSubmittedVisible = visible;
        this.submittedEpoch = 0;
        this.revision = revision + 1;
        this.materialized = undefined;
        this.temporalMaterialized = undefined;
      },
    };
  }

  rebuild(snapshots: FrameList<RenderableSnapshot>): void {
    this.reset(snapshots);
  }

  /** Enable previous-frame publication only while a temporal feature consumes it. */
  setTemporalTracking(enabled: boolean): void {
    if (enabled === this.temporalTracking) return;
    this.temporalTracking = enabled;
    if (!enabled) {
      this.temporalBySlot = new WeakMap();
      this.temporalMaterialized = undefined;
      this.lastSubmittedFrame = EMPTY_SLOT_FRAME;
      this.lastSubmittedVisible = new Map();
      this.dirtySinceSubmitted.clear();
      return;
    }
    for (const record of this.slots.capture()) this.dirtySinceSubmitted.add(record.slot);
  }

  hasSource(kind: 'terrain' | 'glyph' | 'tilemap'): boolean {
    return this.slots.hasSource(kind);
  }

  materialize(): FrameList<RenderableSnapshot> {
    const current = this.slots.capture(),
      meshes = this.meshes;
    if (this.materialized?.value.source !== current || this.materialized.meshes !== meshes)
      this.materialized = {
        meshes,
        value: new RetainedFrameProjection(current, (record) =>
          meshDrawSnapshot(record.snapshot, meshes),
        ),
      };
    return this.materialized.value;
  }

  lastSubmittedSlotByIndex(slot: number): RenderSceneSlot | undefined {
    return this.lastSubmittedFrame.slotAt(slot);
  }

  temporalSnapshotBySlot(
    slot: number,
    resetHistory = false,
  ): RenderableTemporalSnapshot | undefined {
    const current = this.slots.get(slot);
    return current === undefined ? undefined : this.temporalSnapshot(current, resetHistory);
  }

  /** Indexed draw consumption shares the temporal owner used by full view publications. */
  readonly drawSnapshotAt = (
    slot: number,
    counters?: FrameCacheTally,
    meshes = this.meshes,
  ): RenderableSnapshot | undefined => {
    const initial = this.slots.get(slot)?.snapshot;
    const source = initial === undefined ? undefined : meshDrawSnapshot(initial, meshes);
    return source === undefined || !this.temporalTracking
      ? source
      : temporalDrawSnapshot(
          source,
          counters,
          this.slots.capture(),
          this.lastSubmittedFrame,
          this.lastSubmittedVisible,
          undefined,
          this.temporalBySlot,
        );
  };

  drawFrame(
    materials: MaterialFrame,
    counters?: FrameCacheTally,
    meshes = this.meshes,
  ): (slot: number) => RenderableSnapshot | undefined {
    const current = this.slots.capture();
    const submitted = this.lastSubmittedFrame;
    const visible = this.lastSubmittedVisible;
    const temporal = this.temporalTracking;
    const memo = this.temporalBySlot;
    // Several Scene Passes read the same slots in one recording; resolve each once.
    const resolved = new Map<number, RenderableSnapshot | undefined>();
    return (slot) => {
      if (resolved.has(slot)) return resolved.get(slot);
      const record = current.slotAt(slot);
      const source = record === undefined ? undefined : meshDrawSnapshot(record.snapshot, meshes);
      const value =
        source === undefined || !temporal
          ? source
          : temporalDrawSnapshot(source, counters, current, submitted, visible, materials, memo);
      resolved.set(slot, value);
      return value;
    };
  }

  /**
   * Current snapshots carrying their temporal facts. A slot's temporal
   * snapshot is a pure function of its current record, its last submitted
   * record and that record's visibility, so an unchanged slot returns the same
   * object. The lazy roster captures fixed roots without resolving any row;
   * actual query/record reads consume effective Mesh facts once and reuse the
   * per-record temporal memo. Previous transforms borrow the immutable submitted
   * scene root, without replaying or copying its rows.
   */
  materializeTemporal(
    counters: FrameCacheTally,
    materials: MaterialFrame,
    unavailable?: FrameSet,
  ): FrameList<RenderableSnapshot> {
    const current = this.slots.capture(),
      submitted = this.lastSubmittedFrame;
    const visible = this.lastSubmittedVisible,
      meshes = this.meshes;
    const previous = this.temporalMaterialized;
    if (
      previous !== undefined &&
      previous.current === current &&
      previous.submitted === submitted &&
      previous.visible === visible &&
      previous.materials === materials &&
      previous.meshes === meshes &&
      previous.unavailable === unavailable
    )
      return previous.value;
    const memo = this.temporalBySlot;
    // The unavailable roster is live; only a fixed frame without it retains rows.
    const Projection = unavailable === undefined ? RetainedFrameProjection : FrameProjection;
    const value = new Projection(current, (record) => {
      // Pending source rows are retained for retry but have no accepted material.
      // Keep them hidden before consuming temporal facts from the accepted root.
      if (unavailable?.has(record.slot)) return { ...record.snapshot, authorVisible: false };
      return temporalDrawSnapshot(
        meshDrawSnapshot(record.snapshot, meshes),
        counters,
        current,
        submitted,
        visible,
        materials,
        memo,
      );
    });
    this.temporalMaterialized = {
      current,
      submitted,
      visible,
      materials,
      meshes,
      unavailable,
      value,
    };
    return value;
  }

  wasLastSubmittedVisible(slot: number, generation: number): boolean {
    return this.lastSubmittedVisible.get(slot) === generation;
  }

  captureSubmission(
    visible: Iterable<Pick<RenderableSnapshot, 'worldId' | 'entityKey'>>,
  ): RenderSceneSubmissionCapture {
    const visibleSlots = new Map<number, number>();
    for (const snapshot of visible) {
      const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
      if (slot !== undefined) visibleSlots.set(slot.slot, slot.generation);
    }
    return {
      revision: this.revision,
      frame: this.slots.capture(),
      slots: [...this.dirtySinceSubmitted].map((slot) => ({
        slot,
        current: this.slots.get(slot),
      })),
      visible: visibleSlots,
    };
  }

  commitSubmission(capture: RenderSceneSubmissionCapture): RenderSceneSubmissionDelta {
    if (capture.revision !== this.revision) {
      throw new RangeError('render scene changed while its temporal submission was active');
    }
    for (const update of capture.slots) {
      this.dirtySinceSubmitted.delete(update.slot);
    }
    this.lastSubmittedFrame = capture.frame;
    this.lastSubmittedVisible = capture.visible;
    this.submittedEpoch += 1;
    return {
      epoch: this.submittedEpoch,
      slots: capture.slots.map((update) => update.slot),
    };
  }

  /** O(1) current record by stable slot index; bound so frame state can publish it. */
  readonly slotAt = (slot: number): RenderSceneSlot | undefined => this.slots.get(slot);

  slotsSnapshot(): SceneSlotFrame {
    return this.slots.capture();
  }

  /** Cheap owner revision for retained derived projections. */
  revisionValue(): number {
    return this.revision;
  }

  readonly slot = (worldId: number, entityKey: number): RenderSceneSlot | undefined => {
    return this.lookup(worldId, entityKey);
  };

  /** Current slot of a projected snapshot; immutable snapshots memoize the identity search. */
  slotOf(snapshot: RenderableSnapshot): RenderSceneSlot | undefined {
    const cached = this.slotBySnapshot.get(snapshot);
    if (cached !== undefined && this.slots.get(cached.slot) === cached) return cached;
    const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
    if (slot !== undefined) this.slotBySnapshot.set(snapshot, slot);
    return slot;
  }

  has(worldId: number, entityKey: number): boolean {
    return this.lookup(worldId, entityKey) !== undefined;
  }

  snapshot(worldId: number, entityKey: number): RenderableSnapshot | undefined {
    return this.lookup(worldId, entityKey)?.snapshot;
  }

  pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
    const snapshots: PointsLinesRetainedSnapshot[] = [];
    for (const record of this.slots.capture()) {
      const snapshot = record?.snapshot.pointsLines;
      if (record !== undefined && snapshot !== undefined) {
        snapshots.push(ownPointsLinesSnapshot({ ...snapshot, worldId: record.worldId }));
      }
    }
    return Object.freeze(snapshots);
  }

  /** Explicit inspection query; asset adoption never enumerates material users. */
  slotsForMaterial(materialHandle: number): FrameList<RenderSceneSlot> {
    const records: RenderSceneSlot[] = [];
    for (const record of this.slots.capture()) {
      if (
        record?.snapshot.materials.some(
          (material) => material.snapshot.materialHandle === materialHandle,
        )
      )
        records.push(record);
    }
    return records;
  }

  querySpatial(bounds: RenderSceneBounds): FrameList<RenderSceneSlot> {
    const records: RenderSceneSlot[] = [];
    for (const record of this.slots.capture()) {
      if (record === undefined) continue;
      const candidate = this.cullingWorldBoundsAt(record);
      if (candidate === null || candidate === undefined) continue;
      if (intersects(candidate, bounds)) records.push(record);
    }
    return records;
  }

  get contentRevision(): number {
    return this.revision;
  }

  get recordCount(): number {
    return this.slots.size;
  }
  get slotCapacity(): number {
    return this.slots.capacity;
  }
  instanceBoundsStatistics(): ReturnType<InstanceBoundsCache['inspect']> {
    return this.instanceBoundsCache.inspect();
  }

  inspect(): RenderSceneInspection {
    return {
      records: this.slotsSnapshot().map(({ slot, generation, worldId, entityKey }) => ({
        slot,
        generation,
        worldId,
        entityKey,
      })),
      slotCapacity: this.slots.capacity,
      freeSlots: this.freeSlots.length,
      revision: this.revision,
      noChangeFrames: this.noChangeFrames,
      deltaFrames: this.deltaFrames,
      renderableScans: this.renderableScans,
      fullRebuilds: this.fullRebuilds,
      resyncs: this.resyncs,
      lastResyncReason: this.lastResyncReason,
      instanceBoundsCache: this.instanceBoundsCache.inspect(),
    };
  }

  private emptyResult(): RenderSceneApplyResult {
    return {
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
      resynced: 0,
    };
  }

  private lookup(worldId: number, entityKey: number): RenderSceneSlot | undefined {
    return this.slots.lookup(worldId, entityKey);
  }

  private allocate(snapshot: RenderableSnapshot): RenderSceneSlot {
    this.acquireMesh(snapshot);
    const reused = this.freeSlots.pop();
    const slot = reused ?? this.slots.capacity;
    const generation = reused === undefined ? 0 : (this.generations[slot] ?? -1) + 1;
    const record: RenderSceneSlot = {
      slot,
      generation,
      worldId: snapshot.worldId,
      entityKey: snapshot.entityKey,
      snapshot,
    };
    this.generations[slot] = generation;
    this.slots.set(slot, record);
    this.updatePreparation(record);

    return record;
  }

  private release(record: RenderSceneSlot): void {
    this.releaseMesh(record.snapshot);
    this.meshDrawSlots.release(record);
    this.slots.set(record.slot, undefined);
    this.preparationSlots = this.preparationSlots.without(record.slot);

    this.instanceBoundsCache.invalidate(record.entityKey, record.worldId);
    this.freeSlots.push(record.slot);
  }

  private temporalSnapshot(
    slot: RenderSceneSlot,
    resetHistory = false,
    submittedFrame = this.lastSubmittedFrame,
    visible = this.lastSubmittedVisible,
    displacementSource = hasDisplacementSource(meshDrawMaterials(slot.snapshot, this.meshes)),
  ): RenderableTemporalSnapshot {
    return createTemporalSnapshot(slot, resetHistory, submittedFrame, visible, displacementSource);
  }

  private invalidateSnapshots(): void {
    this.materialized = undefined;
    this.temporalMaterialized = undefined;
  }

  /**
   * Return the CPU culling projection for one retained snapshot. Instances
   * use a renderer-derived union, while the GPU scene keeps the mesh-local
   * bounds for its independent per-instance visibility pass. Unknown or
   * empty instance facts deliberately return undefined (conservative no-cull).
   */
  cullingWorldBoundsAt(
    slot: RenderSceneSlot,
    meshes = this.meshes,
    materials?: MaterialFrame,
  ): RenderSceneBounds | undefined {
    const snapshot = slot.snapshot;
    const geometry = meshes.get(snapshot.worldId, snapshot.assetHandle);
    // A static Skin Binding never grants permission to use bind-pose bounds.
    // Its caller must provide the fixed recording root to the numeric writer.
    if (snapshot.skinBinding !== undefined) return undefined;
    let bounds =
      geometry === undefined ? this.sourceWorldBounds : this.meshWorldBounds.get(geometry);
    if (bounds === undefined) {
      bounds = new WeakMap();
      // Only the geometry-present branch can be missing its cache.
      if (geometry !== undefined) this.meshWorldBounds.set(geometry, bounds);
    }
    const cached = bounds.get(slot);
    // The slot, geometry and fixed material frame all match, so the material
    // radius is the one already proven; mutable material roots re-derive it.
    if (cached !== undefined && materials !== undefined && cached.materials === materials)
      return cached.bounds ?? undefined;
    const radius = cullingDisplacementRadius(snapshot, geometry, materials);
    if (cached !== undefined && cached.radius === radius) {
      cached.materials = materials;
      return cached.bounds ?? undefined;
    }
    let candidate: RenderSceneBounds | undefined;
    let local =
      geometry === undefined ||
      snapshot.morph !== undefined ||
      snapshot.terrainSection !== undefined
        ? snapshot.localAabb
        : expandDisplacementBounds(geometry.bounds, radius);
    if (local !== undefined && geometry !== undefined && snapshot.pointsLines !== undefined)
      local = expandPointsLinesBounds(local, snapshot.pointsLines.style);
    if (local === undefined) {
      bounds.set(slot, { radius, bounds: null });
      return undefined;
    }
    if (snapshot.instances !== undefined) {
      const instanceCount = snapshot.instances.instanceCount;
      if (instanceCount === 0 || local === undefined) {
        bounds.set(slot, { radius, bounds: null });
        return undefined;
      }
      const derived = this.instanceBoundsCache.get({
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        meshGeneration: fingerprintNumericArray(local) ^ ((snapshot.assetHandle ?? 0) >>> 0),
        transformGeneration: fingerprintNumericArray(snapshot.transform.world),
        matrixGeneration: snapshot.instances.revision ?? snapshot.instances.archVersion,
        meshAabb: local,
        entityWorld: snapshot.transform.world,
        transforms: snapshot.instances.transforms,
        ...(snapshot.instances.collectionId === undefined
          ? {}
          : { collectionId: snapshot.instances.collectionId }),
        ...(snapshot.instances.revision === undefined
          ? {}
          : { revision: snapshot.instances.revision }),
        ...(snapshot.instances.dirtyRanges === undefined
          ? {}
          : { dirtyRows: snapshot.instances.dirtyRanges }),
      });
      candidate = boundsFromArray(derived ?? []);
    } else {
      candidate = worldBounds(snapshot, undefined, local);
    }
    bounds.set(slot, { radius, bounds: candidate ?? null, materials });
    return candidate;
  }

  private skinBoundsScratch:
    | { matrix: ReturnType<typeof mat4.create>; inverse: ReturnType<typeof mat4.create> }
    | undefined;

  /** Actual visibility/shadow demand writes caller-owned coordinates. Shared
   * Skin reads the fixed Scene identity and raw pose; no pose-result cache or
   * per-candidate allocation. A missing proof never falls back to bind pose.
   */
  writeCullingWorldBoundsAt(
    slot: RenderSceneSlot,
    out: box3.Box3,
    meshes = this.meshes,
    materials?: MaterialFrame,
    skin?: SkinSceneFrame,
  ): boolean {
    const snapshot = slot.snapshot;
    if (snapshot.skinBinding === undefined)
      return writeBounds(this.cullingWorldBoundsAt(slot, meshes, materials), out);
    if (
      skin === undefined ||
      skin.slots.slotAt(slot.slot) !== slot ||
      snapshot.morph !== undefined ||
      snapshot.pointsLines !== undefined
    )
      return false;
    const geometry = meshes.get(slot.worldId, snapshot.assetHandle);
    this.skinBoundsScratch ??= { matrix: mat4.create(), inverse: mat4.create() };
    const scratch = this.skinBoundsScratch;
    return skin.current.bounds(
      slot.slot,
      geometry?.skinEnvelopes,
      cullingDisplacementRadius(snapshot, geometry, materials, true),
      out,
      scratch.matrix,
      scratch.inverse,
    );
  }

  /**
   * Old and new world boxes of the instance rows the slot's current revision
   * moved (six floats per box), valid after `cullingWorldBoundsAt` answered
   * that revision; undefined when only whole-collection bounds are proven.
   */
  instanceRowBoxesAt(slot: RenderSceneSlot): Float32Array | undefined {
    const revision = slot.snapshot.instances?.revision;
    if (revision === undefined) return undefined;
    const change = this.instanceBoundsCache.rowChange(slot.entityKey, slot.worldId);
    return change?.revision === revision ? change.boxes : undefined;
  }

  cullingWorldBounds(snapshot: RenderableSnapshot): RenderSceneBounds | undefined {
    const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
    return slot === undefined ? worldBounds(snapshot) : this.cullingWorldBoundsAt(slot);
  }
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
  readonly unbatchedSlots?: readonly number[];
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

/** Detached GPU scene prepared from the retained CPU composition. */
export interface PersistentGpuDrivenCandidate {
  readonly state: PersistentGpuDrivenState | undefined;
  /** Candidate-owned scene root; never references the active GPU scene. */
  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown>;
  publish(): void;
  discard(): void;
  /** Release the candidate scene even after it has crossed publication. */
  release(): void;
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

let cullProjectedIndexScratch = new Int32Array(0);

/**
 * Previous cull output keyed by its exact inputs. Camera motion changes the
 * frustum every frame, but the admitted set is usually unchanged; reusing the
 * output arrays keeps every identity-keyed consumer downstream (visibility
 * projection, residency validation, render bundles) on its cached path.
 */
interface PersistentCullMemo {
  readonly meshes: MeshFrame | undefined;
  readonly sourceSubsurface: SubsurfaceSelection;
  readonly authorSubsurface: SubsurfaceSelection;
  readonly admittedSubsurface: SubsurfaceSelection;
  readonly sourceRenderables: FrameList<RenderableSnapshot>;
  readonly sourceOwner: object;
  readonly sourceRevision: number;
  readonly sourceDispatch: DispatchList;
  readonly projectedIndex: Int32Array;
  readonly shadowOnly: ReadonlySet<number>;
  readonly renderables: RenderableSnapshot[];
  readonly dispatch: DispatchEntry[];
  /** Private address scratch; published entries themselves stay immutable. */
  readonly dispatchRemapping: ReadonlyMap<DispatchEntry, DispatchEntry>;
}

/** Draw keys the GPU-driven raster owned last primary frame, in its world-key space. */
export interface GpuRasterOwnership {
  readonly selection: GpuDrawSelection;
}

const casterIndexCache = new WeakMap<DispatchList, ReadonlySet<number>>();

/** Fixed dispatch lists are retained across pose frames; scan their casters once. */
function shadowCasterIndices(dispatch: DispatchList): ReadonlySet<number> {
  let indices = casterIndexCache.get(dispatch);
  if (indices === undefined) {
    const collected = new Set<number>();
    for (const draw of dispatch)
      if (draw.tags.LightMode === 'ShadowCaster') collected.add(draw.renderableIndex);
    indices = collected;
    casterIndexCache.set(dispatch, indices);
  }
  return indices;
}

function cullPersistentFrame(
  frame: ExtractedFrame,
  materials: import('./material-dispatch').MaterialFrame,
  boundsOf: (snapshot: RenderableSnapshot, index: number, out: box3.Box3) => boolean = (
    snapshot,
    _index,
    out,
  ) => writeBounds(worldBounds(snapshot), out),
  memo?: { value: PersistentCullMemo | undefined },
  gpuCulled?: (snapshot: RenderableSnapshot) => boolean,
  meshes?: MeshFrame,
  sourceOwner: object = frame.renderables,
  sourceRevision = 0,
): {
  frame: ExtractedFrame;
  subsurface: PersistentShadowCasterProjection['content']['subsurface'];
} {
  const candidates = frame.renderables;
  const previous = memo?.value;
  const newSources =
    previous?.sourceOwner !== sourceOwner ||
    previous?.sourceRevision !== sourceRevision ||
    previous?.meshes !== meshes;
  const sourceSubsurface = newSources ? new SubsurfaceSelection() : previous.sourceSubsurface;
  const authorSubsurface = newSources ? new SubsurfaceSelection() : previous.authorSubsurface;
  const planes = buildCameraFrusta(frame.cameras);
  // Shadow casters are not constrained by the display camera. Keep the
  // primary camera cull intact, but admit a caster that is outside every
  // camera frustum when its bounds intersect one of the active light-space
  // frusta. This is especially important for point-light cube faces: the
  // caster can be behind the camera while still occluding the receiver.
  let casterIndices: ReadonlySet<number> | undefined;
  let shadowFrusta: ReturnType<typeof buildShadowFrusta> | undefined;
  const shadowOnly = new Set<number>();
  const hidden = new Set<number>();
  const hiddenSections = new Map<number, Set<number>>();
  // GPU-owned candidates are culled by their view pass. Their CPU test is
  // deferred: only camera-visibility readers and frustum statistics pay it.
  const deferredSources: RenderableSnapshot[] = [];
  const deferredIndices: number[] = [];
  // Readers pass their own snapshot of the same row (for example a scene
  // slot), so look candidates up by entity identity, not object identity.
  let deferredByEntity: Map<number, number> | undefined;
  let deferredBySection: Map<number, Map<number, number>> | undefined;
  const deferredVisible = new Map<number, boolean | undefined>();
  const deferredAabb = box3.create();
  const deferredAt = (source: RenderableSnapshot): number | undefined => {
    if (deferredSources.length === 0) return undefined;
    if (deferredByEntity === undefined || deferredBySection === undefined) {
      deferredByEntity = new Map();
      deferredBySection = new Map();
      for (let i = 0; i < deferredSources.length; i++) {
        const deferred = deferredSources[i] as RenderableSnapshot;
        const key = worldEntityKey(deferred.worldId, deferred.entityKey);
        if (deferred.terrainSection === undefined) deferredByEntity.set(key, i);
        else {
          let sections = deferredBySection.get(key);
          if (sections === undefined) {
            sections = new Map();
            deferredBySection.set(key, sections);
          }
          sections.set(deferred.terrainSection.index, i);
        }
      }
    }
    const key = worldEntityKey(source.worldId, source.entityKey);
    return source.terrainSection === undefined
      ? deferredByEntity.get(key)
      : deferredBySection.get(key)?.get(source.terrainSection.index);
  };
  const testDeferred = (position: number): boolean | undefined => {
    if (deferredVisible.has(position)) return deferredVisible.get(position);
    const source = deferredSources[position] as RenderableSnapshot;
    let visible: boolean | undefined;
    if (boundsOf(source, deferredIndices[position] as number, deferredAabb)) {
      visible = planes.length === 0;
      for (const cameraPlanes of planes)
        if (
          cameraPlanes.length === 0 ||
          frustum.intersectsBox(cameraPlanes as frustum.Frustum, deferredAabb as box3.Box3Like)
        ) {
          visible = true;
          break;
        }
    }
    deferredVisible.set(position, visible);
    return visible;
  };
  const cameraVisible = (source: RenderableSnapshot) => {
    const deferred = deferredAt(source);
    if (deferred !== undefined) return testDeferred(deferred) !== false;
    const key = worldEntityKey(source.worldId, source.entityKey);
    return source.terrainSection === undefined
      ? !hidden.has(key)
      : hiddenSections.get(key)?.has(source.terrainSection.index) !== true;
  };
  if (cullProjectedIndexScratch.length < candidates.length) {
    cullProjectedIndexScratch = new Int32Array(candidates.length);
  }
  const projectedIndex = cullProjectedIndexScratch;
  projectedIndex.fill(-1, 0, candidates.length);
  const worldAabb = box3.create();
  let total = 0;
  let culled = 0;
  let visibleCount = 0;
  let sameProjection =
    previous !== undefined && previous.projectedIndex.length === candidates.length;
  let visible: RenderableSnapshot[] | undefined;

  let index = -1;
  for (const candidate of candidates) {
    index++;
    if (candidate === undefined) continue;
    if (newSources) {
      sourceSubsurface.add(candidate, materials);
      if (candidate.authorVisible !== false) authorSubsurface.add(candidate, materials);
    }
    if (candidate.authorVisible === false) {
      culled += 1;
      if ((previous?.projectedIndex[index] ?? -1) !== -1) sameProjection = false;
      continue;
    }
    let isVisible = true;
    let isShadowVisible = false;
    // A GPU-owned candidate stays in the plan (its view pass culls it against
    // the same bounds), but the CPU test still feeds `frustumStats` so the
    // statistic does not depend on which lane executed the cull.
    const gpuOwned = gpuCulled?.(candidate) === true;
    if (gpuOwned) {
      // Always admitted; its view pass owns the frustum test.
      deferredSources.push(candidate);
      deferredIndices.push(index);
    } else if (boundsOf(candidate, index, worldAabb)) {
      total += 1;
      isVisible = planes.length === 0;
      for (const cameraPlanes of planes) {
        if (
          cameraPlanes.length === 0 ||
          frustum.intersectsBox(cameraPlanes as frustum.Frustum, worldAabb as box3.Box3Like)
        ) {
          isVisible = true;
          break;
        }
      }
      if (!isVisible && !gpuOwned) {
        casterIndices ??= shadowCasterIndices(frame.dispatch);
        if (casterIndices.has(index)) {
          shadowFrusta ??= buildShadowFrusta(frame.lights);
          isShadowVisible = shadowFrusta.some((lightPlanes) =>
            frustum.intersectsBox(lightPlanes, worldAabb as box3.Box3Like),
          );
        }
      }
    }
    if (!isVisible) {
      culled += 1;
      const key = worldEntityKey(candidate.worldId, candidate.entityKey);
      if (candidate.terrainSection === undefined) hidden.add(key);
      else {
        let sections = hiddenSections.get(key);
        if (sections === undefined) {
          sections = new Set();
          hiddenSections.set(key, sections);
        }
        sections.add(candidate.terrainSection.index);
      }
      if (!gpuOwned) {
        if (!isShadowVisible) {
          if ((previous?.projectedIndex[index] ?? -1) !== -1) sameProjection = false;
          continue;
        }
        shadowOnly.add(index);
      }
    }
    projectedIndex[index] = visibleCount;
    if (
      previous?.projectedIndex[index] !== visibleCount ||
      previous.shadowOnly.has(index) !== shadowOnly.has(index)
    )
      sameProjection = false;
    const source = candidate;
    if (visible === undefined && previous?.renderables[visibleCount] !== source)
      visible = previous?.renderables.slice(0, visibleCount) ?? [];
    visible?.push(source);
    visibleCount += 1;
  }
  const cpuCulled = culled;
  const cpuTotal = total;
  let deferredStats: { readonly culled: number; readonly total: number } | undefined;
  const statsOf = () => {
    if (deferredStats === undefined) {
      let deferredCulled = 0;
      let deferredTotal = 0;
      for (let i = 0; i < deferredSources.length; i++) {
        const visible = testDeferred(i);
        if (visible === undefined) continue;
        deferredTotal++;
        if (!visible) deferredCulled++;
      }
      deferredStats = { culled: deferredCulled, total: deferredTotal };
    }
    return deferredStats;
  };
  const frustumStats = {
    get culled() {
      return cpuCulled + (deferredSources.length === 0 ? 0 : statsOf().culled);
    },
    get total() {
      return cpuTotal + (deferredSources.length === 0 ? 0 : statsOf().total);
    },
  };
  sourceSubsurface.adopt(materials);
  authorSubsurface.adopt(materials);
  // Dispatch addresses depend only on the projection, not on row snapshots.
  const sameAddresses =
    previous !== undefined &&
    sameProjection &&
    previous.shadowOnly.size === shadowOnly.size &&
    previous.renderables.length === visibleCount;
  const sameVisibility = sameAddresses && visible === undefined;
  const admittedSubsurface = sameVisibility
    ? previous.admittedSubsurface
    : new SubsurfaceSelection();
  if (sameVisibility) admittedSubsurface.adopt(materials);
  const result = (frame: ExtractedFrame) => ({
    frame,
    subsurface: {
      source: sourceSubsurface.demand,
      authorVisible: authorSubsurface.demand,
      admitted: admittedSubsurface.demand,
    },
  });
  if (sameVisibility && previous.sourceDispatch === frame.dispatch) {
    if (memo !== undefined)
      memo.value = {
        ...previous,
        sourceRenderables: frame.renderables,
        meshes,
        sourceOwner,
        sourceRevision,
        sourceSubsurface,
        authorSubsurface,
      };
    return result({
      ...frame,
      renderables: previous.renderables,
      dispatch: previous.dispatch,
      frustumStats,
      cameraVisible,
    });
  }

  const selected = sameVisibility
    ? previous.renderables
    : (visible ?? previous?.renderables.slice(0, visibleCount) ?? []);
  if (!sameVisibility) for (const source of selected) admittedSubsurface.add(source, materials);

  admittedSubsurface.adopt(materials);
  if (sameAddresses && previous.sourceDispatch === frame.dispatch) {
    if (memo !== undefined)
      memo.value = {
        ...previous,
        meshes,
        sourceSubsurface,
        authorSubsurface,
        admittedSubsurface,
        sourceRenderables: frame.renderables,
        sourceOwner,
        sourceRevision,
        shadowOnly,
        renderables: selected,
      };
    return result({
      ...frame,
      renderables: selected,
      dispatch: previous.dispatch,
      frustumStats,
      cameraVisible,
    });
  }
  const dispatch: DispatchEntry[] = [];
  // Strong per-run table: only the entries this cull remapped stay reachable,
  // with no ephemeron churn when a scene edit shifts every later address.
  const previousRemapping = previous?.dispatchRemapping;
  const dispatchRemapping = new Map<DispatchEntry, DispatchEntry>();
  for (const entry of frame.dispatch) {
    const candidateIndex = entry.renderableIndex;
    // Shadow-only candidates must never enter the main forward/transparent
    // dispatch. Their ShadowCaster entries remain available to the depth
    // passes, which consume the same validated ordered list.
    if (shadowOnly.has(candidateIndex) && entry.tags.LightMode !== 'ShadowCaster') {
      continue;
    }
    const renderableIndex = projectedIndex[candidateIndex];
    if (renderableIndex === undefined || renderableIndex < 0) {
      continue;
    }
    if (renderableIndex === entry.renderableIndex) {
      dispatch.push(entry);
    } else {
      let mapped = previousRemapping?.get(entry);
      if (mapped?.renderableIndex !== renderableIndex) mapped = { ...entry, renderableIndex };
      dispatchRemapping.set(entry, mapped);
      dispatch.push(mapped);
    }
  }
  // Published once; readers may key derived classifications on its identity.
  Object.freeze(dispatch);
  if (memo !== undefined) {
    memo.value = {
      meshes,
      sourceSubsurface,
      authorSubsurface,
      admittedSubsurface,
      sourceRenderables: frame.renderables,
      sourceOwner,
      sourceRevision,
      sourceDispatch: frame.dispatch,
      projectedIndex: projectedIndex.slice(0, candidates.length),
      shadowOnly,
      renderables: selected,
      dispatch,
      dispatchRemapping,
    };
  }
  return result({
    ...frame,
    renderables: selected,
    dispatch,
    frustumStats,
    cameraVisible,
  });
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
  /** Lifetime visibility-projection cache counters (camera-independent key). */
  visibilityProjectionCacheInspection(): FrameCacheCounters {
    return { hits: this.visibilityProjectionHits, misses: this.visibilityProjectionMisses };
  }

  /** Lifetime per-renderable temporal snapshot memo counters. */
  temporalSnapshotCacheInspection(): FrameCacheCounters {
    return { ...this.temporalCounters };
  }

  /** Bumps whenever a stable entity's (slot, generation) identity may change. */
  private stableSlotRevision = 0;
  private readonly temporalCounters: FrameCacheTally = { hits: 0, misses: 0 };
  private visibilityProjectionHits = 0;
  private visibilityProjectionMisses = 0;
  private visibilityProjectionCache:
    | {
        readonly stableSlotRevision: number;
        readonly worlds: readonly RenderResourceScope[];
        readonly renderables: FrameList<RenderableSnapshot>;
        readonly dispatch: DispatchList;
        readonly projection: PersistentVisibilityProjection;
      }
    | undefined;
  private visibilityProjectionRevision = 0;
  private lastActiveEntityKeys: ReadonlySet<number> | undefined;
  /** Stable renderer-world/entity lookup; rebuilt only with composition topology. */
  private readonly stableSlotByEntity = new Map<number, RenderSceneSlot>();
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
  publicationBaselineRequired(resources: RenderResourceScope): boolean {
    this.retireFailedInputArena();
    const entry = this.composition;
    return entry === undefined || entry.worlds.length !== 1 || entry.worlds[0] !== resources;
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

  /** Stable renderer-world/entity lookup shared by inspection and final projection paths. */
  compositionSlotByStableEntity(): ReadonlyMap<number, RenderSceneSlot> {
    return this.stableSlotByEntity;
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
  ): PersistentVisibilityProjection {
    const cached = this.visibilityProjectionCache;
    if (
      cached?.stableSlotRevision === this.stableSlotRevision &&
      sameWorldSequence(cached.worlds, worlds) &&
      cached.renderables === renderables &&
      cached.dispatch === dispatch
    ) {
      this.visibilityProjectionHits += 1;
      return cached.projection;
    }
    this.visibilityProjectionMisses += 1;
    const activeEntityKeys = new Set<number>();
    for (const renderable of renderables) {
      activeEntityKeys.add(this.stableEntityKey(worlds, renderable));
    }
    const projection = {
      renderables,
      dispatch,
      activeEntityKeys,
      activeEntityRevision: this.activeEntityRevision(activeEntityKeys),
    };
    this.visibilityProjectionCache = {
      stableSlotRevision: this.stableSlotRevision,
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

  private invalidateActiveEntityRevision(): void {
    this.lastActiveEntityKeys = undefined;
    this.visibilityProjectionRevision += 1;
  }

  /** Project probe facts and per-primitive selection into the persistent scene owner. */
  projectReflectionProbes(probes: readonly ReflectionProbeFact[]): void {
    const projection = this.composition?.projection;
    if (projection === undefined) return;
    if (probes.length === 0) {
      this.reflectionProbes.update([], []);
      return;
    }
    const primitives = projection
      .slotsSnapshot()
      .map((slot) => {
        const resolved = projection.cullingWorldBoundsAt(slot);
        if (resolved === undefined || resolved === null) return undefined;
        return {
          worldId: slot.worldId,
          entityKey: slot.entityKey,
          renderableKey: `${slot.worldId}:${slot.entityKey}`,
          center: [
            (resolved.min[0] + resolved.max[0]) / 2,
            (resolved.min[1] + resolved.max[1]) / 2,
            (resolved.min[2] + resolved.max[2]) / 2,
          ] as [number, number, number],
        };
      })
      .filter((primitive): primitive is NonNullable<typeof primitive> => primitive !== undefined);
    this.reflectionProbes.update(probes, primitives);
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
    if (this.publicationBaselineRequired(resources) && !packet.baseline)
      throw new RenderPublicationError({
        reason: 'base',
        subject: 'complete source baseline for cold scene admission',
      });
    let entry = this.composition;
    if (entry === undefined || packet.baseline) {
      this.invalidate();
      const projection = new RenderScene([resources]);
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
    const before = entry.projection.slotsSnapshot();
    const delta = entry.projection.apply(input.operations);
    this.skinAdoption.apply(entry, before, delta);
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
      this.stableSlotByEntity.delete(worldEntityKey(entry.worldKeys[0] ?? 0, removed.entityKey));
      this.stableSlotRevision += 1;
    }
    for (const recreated of delta.recreatedSlots) entry.materialDispatch.remove(recreated.slot);
    bindMaterialDispatch(frame, entry.projection, entry.materialDispatch);
    if (frame.renderables.length || packet.removed.length) {
      this.invalidateActiveEntityRevision();
    }
    for (const slot of [...delta.createdSlots, ...delta.updatedSlots, ...delta.recreatedSlots]) {
      const key = worldEntityKey(entry.worldKeys[0] ?? 0, slot.entityKey);
      const current = this.stableSlotByEntity.get(key);
      if (current?.slot !== slot.slot || current.generation !== slot.generation) {
        this.stableSlotRevision += 1;
      }
      this.stableSlotByEntity.set(key, slot);
    }
    entry.topology.apply(delta);
    for (const material of input.materialUpdates) entry.materialDispatch.adopt(material);
    entry.materialDispatch.prepare(entry.projection.meshFrame());
    if (input.operations.length) this.deltaFrames++;
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
    const sameWorldSet =
      entry !== undefined &&
      entry.worlds.length === worlds.length &&
      entry.worlds.every((world) => worlds.some((local) => local === world.world));
    const worldOrderChanged =
      entry !== undefined &&
      sameWorldSet &&
      entry.worlds.some((world, index) => world.world !== worlds[index]);
    const leaseSetPreserved =
      entry !== undefined &&
      leases !== undefined &&
      leases.length === worlds.length &&
      entry.readLeases.length === leases.length &&
      entry.readLeases.every((lease) => leases.includes(lease));
    const preserveVisibilityOnReorder =
      entry !== undefined && worldOrderChanged && leaseSetPreserved;
    if (
      entry === undefined ||
      entry.worlds.length !== worlds.length ||
      entry.worlds.some((world, index) => world.world !== worlds[index]) ||
      leases === undefined ||
      leases.length !== worlds.length
    ) {
      return this.reconcileComposition(
        worlds,
        owner,
        buildCandidateFrame,
        leases,
        preserveVisibilityOnReorder,
      );
    }
    const changedEntitiesByWorld = worlds.map(
      (_, worldId) => new Set(entry.pendingRenderableEntitiesByWorld[worldId] ?? []),
    );
    const contentChangedByWorld = worlds.map(
      (_, worldId) => new Set(entry.pendingRenderableEntitiesByWorld[worldId] ?? []),
    );
    const nextReadVersions = entry.readVersions.slice();
    const sourceBatches: StateProjectionBatch[] = [];
    const sourceRowsByWorld: (readonly (RenderSourceEntity | undefined)[])[] = [];
    const removedSlots: RenderSceneSlot[] = [];
    const transformSpans: WorldTransformSpan[] = [];
    for (let worldId = 0; worldId < worlds.length; worldId++) {
      const world = worlds[worldId];
      const source = entry.sourceStates[worldId];
      const lease = leases[worldId];
      const version = entry.readVersions[worldId];
      if (
        world === undefined ||
        source === undefined ||
        lease === undefined ||
        version === undefined
      )
        continue;
      const read = lease.readChanges(version);
      nextReadVersions[worldId] = read.version;
      const changed = changedEntitiesByWorld[worldId];
      const content = contentChangedByWorld[worldId];
      if (changed === undefined || content === undefined) continue;
      if (version.structureEpoch !== read.version.structureEpoch) {
        this.invalidateActiveEntityRevision();
      }
      const batch = source.projection.read();
      sourceBatches[worldId] = batch;
      const sourceRows = captureRenderSourceEntities(world, source, batch);
      sourceRowsByWorld[worldId] = sourceRows;
      this.worldEntitiesScanned += batch.scannedRows;
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
        const previous = source.entities.get(index)?.entity;
        const current = currentSource?.entity;
        if (previous !== undefined) {
          if (
            previous !== current ||
            !world.hasComponent(previous as EntityHandle, GlobalTransform)
          )
            this.skinAdoption.joint(entry, worldId, previous);
          const slot = entry.projection.slot(worldId, previous);
          if (
            batch.membershipChanged &&
            slot !== undefined &&
            (current !== previous || !isRenderableMember(world, previous))
          ) {
            removedSlots.push(slot);
            changed.add(previous);
          }
        }
        if (current === undefined) continue;
        const existing = entry.projection.slot(worldId, current);
        const membershipChanged =
          batch.hasStructuralChange(index) ||
          (batch.membershipChanged &&
            (existing === undefined || sourceMembershipChanged(world, existing)));
        let contentChanged = membershipChanged;
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
          renderSourceHierarchyChanged(source, index, currentSource)
        ) {
          if (!dependencyVisited.has(current)) {
            const pending = [current];
            while (pending.length > 0) {
              const dependent = pending.pop();
              if (dependent === undefined || dependencyVisited.has(dependent)) continue;
              dependencyVisited.add(dependent);
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
        }
      }
      for (const entity of content) changed.add(entity);
      const query = entry.transformQueries[worldId];
      if (query !== undefined) {
        for (const span of query.spans().unwrap()) {
          const matrices = span.get(GlobalTransform).world;
          if (!(matrices instanceof Float32Array))
            throw new Error('GlobalTransform projection must expose a numeric column.');
          transformSpans.push({ worldId, entities: span.entities, worlds: matrices });
          if (entry.skin !== undefined)
            for (const entity of span.entities) this.skinAdoption.joint(entry, worldId, entity);
        }
      }
    }

    // Query iteration is an observation step, not publication. Persist every
    // requested identity before invoking any producer so a thrown or omitted
    // partial extraction is retried even after ECS change evidence is drained.
    for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
      const pending = entry.pendingRenderableEntitiesByWorld[worldId];
      if (pending === undefined) continue;
      for (const entityKey of changedEntitiesByWorld[worldId] ?? []) pending.add(entityKey);
    }

    const resourceFrame = buildCandidateFrame('none');
    for (const batch of sourceBatches) batch.validate();
    let changedDelta: RenderSceneApplyResult | undefined;
    const hasChangedEntities = changedEntitiesByWorld.some((entities) => entities.size > 0);
    if (hasChangedEntities || removedSlots.length > 0 || transformSpans.length > 0) {
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
        // Change queries have been observed, but this publication never ran.
        // Retain every consumed transform identity for the producer retry.
        for (const span of transformSpans) {
          const pending = entry.pendingRenderableEntitiesByWorld[span.worldId];
          for (const entity of span.entities) {
            if (entry.projection.has(span.worldId, entity)) pending?.add(entity);
          }
        }
        throw cause;
      }
      const publishedEntitiesByWorld = worlds.map(() => new Set<number>());
      for (const snapshot of partial?.renderables ?? []) {
        const existing = entry.projection.slot(snapshot.worldId, snapshot.entityKey);
        const contentChanged =
          existing === undefined ||
          contentChangedByWorld[snapshot.worldId]?.has(snapshot.entityKey);
        operations.push({
          kind: 'update',
          worldId: snapshot.worldId,
          entityKey: snapshot.entityKey,
          ...(contentChanged || snapshot.instances === undefined
            ? { snapshot }
            : { instances: snapshot.instances }),
        });
        publishedEntitiesByWorld[snapshot.worldId]?.add(snapshot.entityKey);
      }
      for (const batch of sourceBatches) batch.validate();
      const before = entry.projection.slotsSnapshot();
      changedDelta = entry.projection.apply(operations, transformSpans);
      this.skinAdoption.apply(entry, before, changedDelta);
      for (const slot of changedDelta.removedSlots) {
        const world = worlds[slot.worldId];
        if (world !== undefined) this.options.instanceCollections?.release(world, slot.entityKey);
      }
      for (const snapshot of partial?.renderables ?? []) {
        const world = worlds[snapshot.worldId];
        if (world === undefined) continue;
        if (snapshot.instances === undefined)
          this.options.instanceCollections?.release(world, snapshot.entityKey);
        else
          this.options.instanceCollections?.accept(world, snapshot.entityKey, snapshot.instances);
      }
      for (const removed of changedDelta.removedSlots) entry.materialDispatch.remove(removed.slot);
      for (const recreated of changedDelta.recreatedSlots)
        entry.materialDispatch.remove(recreated.slot);
      if (partial !== undefined || removedSlots.length > 0) {
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
      if (partial !== undefined) {
        // Every published renderable replaces its slot list, including an
        // empty list after failed producer validation.
        bindMaterialDispatch(partial, entry.projection, entry.materialDispatch);
      }
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
          if (slot !== undefined) entry.materialDispatch.remove(slot.slot);
        }
      }
      const newlyUnavailable: RenderSceneSlot[] = [];
      for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
        const requested = changedEntitiesByWorld[worldId];
        const published = publishedEntitiesByWorld[worldId];
        if (requested === undefined || published === undefined) continue;
        for (const entityKey of requested) {
          const slot = entry.projection.slot(worldId, entityKey);
          if (slot === undefined || published.has(entityKey)) {
            if (slot !== undefined)
              entry.unavailableSlots = entry.unavailableSlots.without(slot.slot);
            continue;
          }
          if (!entry.unavailableSlots.has(slot.slot)) newlyUnavailable.push(slot);
          entry.unavailableSlots = entry.unavailableSlots.with(slot.slot);
        }
      }
      for (const removed of changedDelta.removedSlots)
        entry.unavailableSlots = entry.unavailableSlots.without(removed.slot);
      for (const recreated of changedDelta.recreatedSlots)
        entry.unavailableSlots = entry.unavailableSlots.without(recreated.slot);
      entry.topology.apply(
        topologyDeltaForAvailable(changedDelta, entry.unavailableSlots, newlyUnavailable),
      );
      entry.materialDispatch.prepare(entry.projection.meshFrame());
      this.deltaFrames +=
        changedDelta.created +
          changedDelta.updated +
          changedDelta.removed +
          changedDelta.recreated >
        0
          ? 1
          : 0;
      this.transformUpdates += changedDelta.updated;
    }

    if (changedDelta === undefined) {
      this.noChangeFrames += 1;
      entry.materialDispatch.prepare(entry.projection.meshFrame());
    }
    if (changedDelta !== undefined) {
      for (const removed of changedDelta.removedSlots) {
        const world = worlds[removed.worldId];
        if (world !== undefined) entry.assetClosures.get(world)?.replace(removed.entityKey, []);
      }
      for (const slot of [
        ...changedDelta.createdSlots,
        ...changedDelta.contentUpdatedSlots,
        ...changedDelta.recreatedSlots,
      ]) {
        const world = worlds[slot.worldId];
        if (world !== undefined)
          entry.assetClosures
            .get(world)
            ?.replace(slot.entityKey, renderableAssetRoots(slot.snapshot));
      }
    }
    const resourceWorld = worlds[owner.resourceOwner];
    if (resourceWorld !== undefined)
      entry.assetClosures
        .get(resourceWorld)
        ?.replace(-1, publicationFrameDependencies(resourceFrame));
    this.skinAdoption.initializeJoints(entry);
    const result = this.deriveFramePlan(entry, resourceFrame, changedDelta, materialUpdates);
    for (let worldId = 0; worldId < sourceBatches.length; worldId++) {
      const batch = sourceBatches[worldId];
      const source = entry.sourceStates[worldId];
      if (batch === undefined || source === undefined) continue;
      const sourceRows = sourceRowsByWorld[worldId];
      if (sourceRows === undefined) throw new Error('Missing captured source observations');
      batch.accept();
      if (!batch.membershipChanged) continue;
      acceptRenderSourceEntities(source, batch.indices, sourceRows);
    }
    entry.readLeases = [...leases];
    for (let worldId = 0; worldId < nextReadVersions.length; worldId += 1) {
      const version = nextReadVersions[worldId];
      if (version !== undefined) entry.readVersions[worldId] = version;
    }
    return result;
  }

  invalidate(): void {
    const skin = this.composition?.skin;
    if (this.composition !== undefined) this.composition.skin = undefined;
    this.composition = undefined;
    this.probeAttachMemo.previous = undefined;
    this.cullMemo.value = undefined;
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
    this.stableSlotByEntity.clear();
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
      this.stableSlotByEntity.clear();
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

  /** Prepare a detached GPU scene without changing the active scene owner. */
  prepareRecoveryGpuDrivenCandidate(
    device: RhiDevice,
  ): Result<PersistentGpuDrivenCandidate, RhiError> {
    const composition = this.composition;
    if (composition === undefined) {
      return ok({
        state: undefined,
        createRecoveryRoot: (scope) => ({
          kind: 'scene-table',
          create: () => {
            if (!scope.isAlive()) throw new Error('GPU-driven candidate scope is not active.');
            throw new Error('GPU-driven candidate has no scene resource.');
          },
          cleanup: () => undefined,
        }),
        publish: () => undefined,
        discard: () => undefined,
        release: () => undefined,
      });
    }
    const slots = composition.projection.slotsSnapshot().map((slot) => {
      const { temporal: _temporal, ...snapshot } = slot.snapshot;
      return { ...slot, snapshot };
    });
    const projection = composition.projection.prepareRecoverySlots(slots);
    const sourceAssetRevision = composition.assetRevision;
    const sourceMaterials = composition.materialDispatch.materials();
    const created = GpuScene.create(
      device,
      Math.max(256, composition.projection.slotCapacity),
      this.options.shaderRegistry,
      this.inputArena(),
    );
    if (!created.ok) return created;
    const scene = created.value.status === 'available' ? created.value.scene : undefined;
    let state: PersistentGpuDrivenState | undefined;
    if (scene !== undefined) {
      const rebuilt = scene.sync(
        {
          ...sceneSnapshotDelta(slots),
          materials: composition.materialDispatch.materials(),
          meshes: composition.projection.meshFrame(),
        },
        // The replacement GPU tables start a new temporal history even when
        // the retained World emits no changes after recovery is published.
        (slot) => composition.projection.temporalSnapshotBySlot(slot.slot, true),
        sceneSnapshotBounds(composition.projection),
      );
      if (!rebuilt.ok) {
        scene.dispose();
        return rebuilt;
      }
      const slotsByIndex = new Map(slots.map((slot) => [slot.slot, slot]));
      const slotsByEntity = new Map(
        slots.map((slot) => [worldEntityKey(slot.snapshot.worldId, slot.snapshot.entityKey), slot]),
      );
      const sourcePlan = composition.topology.sourcePlan();
      const sourceMeshes = composition.projection.meshFrame();
      state = Object.freeze({
        skin: composition.skin?.recordingFrame(),
        scene,
        meshes: composition.projection.meshFrame(),
        plan: sourcePlan,
        queryPlan: () => composition.topology.query(sourcePlan, sourceMeshes),
        completeGeometry: composition.topology.completeGeometry,
        unbatchedSlots: composition.topology.unbatchedSlots,
        pipelinePreparationSlots: new Set(composition.projection.pipelinePreparationSlots),
        slots,
        slotAt: (slot: number) => slotsByIndex.get(slot),
        drawSnapshotAt: (slot: number) =>
          composition.unavailableSlots.has(slot) ? undefined : slotsByIndex.get(slot)?.snapshot,
        slotForEntity: (worldId: number, entityKey: number) =>
          slotsByEntity.get(worldEntityKey(worldId, entityKey)),
        worldKeys: composition.worldKeys,
        worldIdentities: composition.worlds.map((world) => world.identity),
        probeBlend: composition.probeProjection.recordBufferProjection(),
      });
    }
    let published = false;
    let released = false;
    return ok({
      state,
      createRecoveryRoot: (scope) => ({
        kind: 'scene-table',
        create: () => {
          if (!scope.isAlive()) throw new Error('GPU-driven candidate scope is not active.');
          if (scene === undefined) throw new Error('GPU-driven candidate has no scene resource.');
          return scene;
        },
        cleanup: () => undefined,
      }),
      publish: () => {
        if (published || released) return;
        if (
          this.composition !== composition ||
          composition.assetRevision !== sourceAssetRevision ||
          composition.materialDispatch.materials() !== sourceMaterials
        )
          throw new Error('Recovery Scene composition changed before publication');
        projection.validate();
        try {
          composition.skin?.resetHistory();
        } catch (cause) {
          this.skinAdoption.fail(composition, cause);
        }
        scene?.inputs.activate();
        projection.publish();
        published = true;
        this.shadowProjection = undefined;
        this.materialProgramProjection.clear();
        this.temporalCapture = undefined;
        this.visibilityProjectionCache = undefined;
        if (scene === undefined) return;
        this.retireGpuScene(this.gpuScene);
        this.gpuScene = scene;
        this.gpuOwner = composition.token;
        this.gpuDevice = device;
        this.gpuStatus = 'resident';
      },
      discard: () => {
        if (published || released) return;
        released = true;
        scene?.dispose();
      },
      release: () => {
        if (published || released) return;
        released = true;
        scene?.dispose();
      },
    });
  }

  createRecoveryRoot(scope: DeviceScope): LifecycleResourceSpec<unknown> {
    return {
      kind: 'scene-table',
      create: () => {
        const composition = this.composition;
        if (!scope.isAlive() || composition === undefined) {
          throw new Error('RenderScene CPU projection is not ready for recovery.');
        }
        return Object.freeze({
          generation: scope.generation,
          revision: composition.projection.revisionValue(),
          visibleSlots: composition.projection.slotsSnapshot().length,
        });
      },
      cleanup: () => undefined,
    };
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
    this.stableSlotByEntity.clear();
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
    const drawAt = entry.projection.drawFrame(
      entry.materialDispatch.materials(),
      this.temporalCounters,
      meshes,
    );
    const probeAt = entry.probeProjection.captureRecordLookup();
    const probeMemo = this.probeAttachMemo.bySnapshot;
    const sourcePlan = entry.topology.sourcePlan();
    return {
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
      drawSnapshotAt: (slot) => {
        if (unavailable.has(slot)) return undefined;
        const source = drawAt(slot);
        return source === undefined
          ? undefined
          : attachProbeRecord(source, probeAt(slot), probeMemo);
      },
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

  /** Publish renderer-owned previous transforms after queue submission. */
  commitTemporalFrame(terrainReady = true): Result<void, RhiError> {
    // Previous transforms are consumed only by TAA and motion blur. Ordinary
    // frames must not copy and upload the complete GPU transform table.
    const gpuCommit = this.gpuScene?.commitTemporalFrame(this.temporalCapture !== undefined);
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
  prepareTemporalFrame(visible: Iterable<Pick<RenderableSnapshot, 'worldId' | 'entityKey'>>): void {
    const projection = this.composition?.projection;
    this.temporalCapture =
      projection === undefined || this.composition?.temporalDemanded !== true
        ? undefined
        : { projection, capture: projection.captureSubmission(visible) };
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
    this.stableSlotByEntity.clear();
    this.stableSlotRevision += 1;
    for (const slot of projection.slotsSnapshot()) {
      const stableWorld = worldKeys[slot.worldId] ?? slot.worldId;
      this.stableSlotByEntity.set(worldEntityKey(stableWorld, slot.entityKey), slot);
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
      probeProjection: new ProbeBlendSceneProjection(),
      probeObjects: undefined,
      temporalDemanded: standardSceneTemporalDemand(
        candidateFrame.cameras[0],
        this.options.getTemporalConsumerDemand?.(),
      ),
    };
    this.composition = entry;
    if (stableCandidateFrame.renderables.some((snapshot) => snapshot.skinBinding !== undefined))
      this.skinAdoption.apply(
        entry,
        EMPTY_SLOT_FRAME,
        sceneSnapshotDelta(projection.slotsSnapshot()),
      );
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
    const { frame: result, subsurface } = cullPersistentFrame(
      ownedFrame,
      materialFrame,
      (snapshot, _index, out) => {
        const slot = entry.projection.slotOf(snapshot);
        if (snapshot.terrainSection !== undefined || snapshot.generatedMesh !== undefined)
          return writeBounds(worldBounds(snapshot), out);
        return slot === undefined
          ? writeBounds(projection.cullingWorldBounds(snapshot), out)
          : projection.writeCullingWorldBoundsAt(slot, out, meshFrame, materialFrame, skinFrame);
      },
      this.cullMemo,
      this.gpuCullBypass(token),
      meshFrame,
      hasGeneratedDraws ? ownedFrame.renderables : entry.materialDispatch,
      entry.materialDispatch.revisionValue(),
    );
    const materialProgramProjection = this.materialProgramProjection;
    const shadowSlots = entry.projection.slotsSnapshot();
    this.shadowProjection = {
      meshDraws: projection,
      prepareDrawDispatch: (draws) => projectDrawDispatch(draws, materialFrame),
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
      worldBoundsOf: (source, out) => {
        const slot = shadowSlots.lookup(source.worldId, source.entityKey);
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
    const { frame: result, subsurface } = cullPersistentFrame(
      ownedFrame,
      materialFrame,
      (snapshot, _index, out) => {
        const slot = entry.projection.slotOf(snapshot);
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
      },
      this.cullMemo,
      this.gpuCullBypass(entry.token),
      meshFrame,
      hasGeneratedDraws || entry.unavailableSlots.size > 0
        ? ownedFrame.renderables
        : entry.materialDispatch,
      entry.materialDispatch.revisionValue(),
    );
    const materialProgramProjection = this.materialProgramProjection;
    const shadowSlots = entry.projection.slotsSnapshot();
    this.shadowProjection = {
      meshDraws: entry.projection,
      prepareDrawDispatch: (draws) => projectDrawDispatch(draws, materialFrame),
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
      worldBoundsOf: (source, out) => {
        const slot = shadowSlots.lookup(source.worldId, source.entityKey);
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
    if (this.gpuScene !== undefined && this.gpuDevice === device) {
      // Composition rebuilds replace the CPU projection token, but the GPU
      // table resource can be rebuilt in place. Keeping one scene identity
      // avoids destroying buffers that cached frame graphs still reference
      // and lets queue ordering preserve writes across the next submission.
      const slots = projection.slotsSnapshot();
      const rebuilt = this.gpuScene.sync(
        { ...sceneSnapshotDelta(slots), meshes: projection.meshFrame(), materials },
        undefined,
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
      undefined,
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
