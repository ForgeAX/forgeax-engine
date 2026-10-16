import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type {
  RenderReadLease,
  RenderReadVersion,
  StateProjectionBatch,
} from '@forgeax/engine-ecs/projection';
import { box3, frustum } from '@forgeax/engine-math';
import {
  type MaterialCookRasterContext,
  materialProgramContextKey,
} from '@forgeax/engine-pack/material-cook';
import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { ChildOf, Children, GlobalTransform, MorphWeights } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { err, ok, type Result } from '@forgeax/engine-types';
import { buildCameraFrusta } from '../camera-frusta';
import { Instances, Lines, Points, SpriteInstances, Visibility } from '../components';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import { gpuDrivenDrawKey, gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import {
  BatchTopology,
  type BatchTopologyInspection,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import {
  type GpuDrivenMaterialProgramIndex,
  GpuDrivenMaterialProgramProjection,
} from '../gpu-driven/material-artifacts';
import { freezePreparedGpuDrivenDraw, ownGpuDrivenVertexInputs } from '../gpu-driven/prepared-draw';
import { ShadowCasterOwnershipProjection } from '../gpu-driven/shadow-ownership';
import { GpuScene } from '../gpu-scene';
import type { GpuSceneSlotBounds } from '../gpu-scene-change-log';
import type {
  FrameCacheCounters,
  GpuDrivenStructureMetrics,
  PersistentRenderSceneInspection,
} from '../inspection-types';
import { type InstanceProjectionStore, uniqueInstanceIdentities } from '../instances';
import { fingerprintNumericArray, InstanceBoundsCache } from '../instances-derived-bounds';
import type { PointsLinesInspection } from '../points-lines/inspection';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { RenderPublicationIdentity } from '../publication/contract';
import { publicationDispatchGroups } from '../publication/dispatch-groups';
import type { PreparedRenderPublication } from '../publication/receiver';
import type { PublishedRenderResources, RenderResourceScope } from '../publication/resource-scope';
import { worldEntityKey } from '../record/frame-snapshot';
import {
  type ReflectionProbeFact,
  ReflectionProbeProjection,
  type ReflectionProbeSelectionResult,
} from '../reflection/projection';
import type {
  DispatchEntry,
  ExtractedFrame,
  InstancesSnapshot,
  MaterialSnapshot,
  MaterialSnapshotCachesByWorld,
  RenderableReactiveReason,
  RenderableSnapshot,
  RenderableTemporalSnapshot,
} from '../render-system-extract';
import { prepareSkinPalette, type SkinPaletteAllocator } from '../systems/skin-palette-allocator';
import { standardSceneTemporalDemand } from '../temporal/standard-scene-data';
import { projectTerrainView, terrainSectionKey } from '../terrain/view.js';
import {
  PersistentTransmissionDemandProjection,
  type TransmissionDemand,
  type TransmissionDemandOperation,
} from '../transmission/projection';
import {
  type ProbeBlendBufferProjection,
  ProbeBlendSceneProjection,
  type ProbeSceneObjectInput,
} from './probe-blend';
import type { ProbeBlendRecord } from './probe-blend-record';
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
  createGlobalTransformChangeQuery,
  createRenderSourceState,
  type GlobalTransformChangeQuery,
  isRenderableMember,
} from './render-source';
import { buildShadowFrusta } from './shadow-visibility';

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
function sceneSnapshotDelta(slots: readonly RenderSceneSlot[]): RenderSceneApplyResult {
  return {
    created: slots.length,
    updated: 0,
    removed: 0,
    recreated: 0,
    ignoredLateUpdates: 0,
    createdSlots: slots,
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

function sameInstanceIdentitySet(
  current: Uint32Array | undefined,
  previous: Uint32Array | undefined,
): boolean {
  // An instanced producer without generation tokens cannot prove that a
  // compacted/reordered row is the same logical object. Keep that legacy
  // snapshot conservative: the record stage will seed its previous matrix
  // instead of borrowing a velocity from an unknown ordinal.
  if (current === undefined || previous === undefined) return false;
  if (current === previous) return uniqueInstanceIdentities(current);
  const currentSet = new Set(current);
  const previousSet = new Set(previous);
  if (
    currentSet.size !== current.length ||
    previousSet.size !== previous.length ||
    current.some((identity) => identity === 0) ||
    previous.some((identity) => identity === 0)
  ) {
    return false;
  }
  if (current.length === previous.length) {
    let sameOrder = true;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] !== previous[index]) {
        sameOrder = false;
        break;
      }
    }
    if (sameOrder) return true;
  }
  // Reorder and retirement are valid when every current token is unique and
  // survives. The set is built only on the topology-change path; steady pose
  // updates stay on the linear same-order check and do not allocate.
  return current.every((identity) => previousSet.has(identity));
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
  readonly revision: number;
  readonly slots: readonly {
    readonly slot: number;
    readonly current: RenderSceneSlot | undefined;
  }[];
  readonly visible: ReadonlySet<string>;
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
  readonly resources: PublishedRenderResources;
  readonly revision: number;
  readonly isCurrent: () => boolean;
}

export interface PersistentShadowCasterProjection {
  /**
   * Caster content evidence: unchanged owner and revisions prove every
   * published renderable and its dispatch are unchanged, whatever else the
   * ECS mutated (a camera Transform, gameplay state).
   */
  readonly content: {
    readonly owner: object;
    readonly sceneRevision: number;
    readonly dispatchRevision: number;
    readonly publicationSource?: ShadowPublicationSource;
    /** Actual view-derived surfaces; root scene revisions do not encode their LOD. */
    readonly terrainSections?: readonly RenderableSnapshot[];
  };
  readonly worldBoundsOf: (source: RenderableSnapshot) => RenderSceneBounds | undefined;
  readonly renderables: readonly RenderableSnapshot[];
  readonly dispatch: readonly DispatchEntry[];
  readonly materialPrograms?: GpuDrivenMaterialProgramIndex;
}

function identityKey(worldId: number, entityKey: number): string {
  return `${worldId}:${entityKey}`;
}

const STANDARD_TRANSMISSION_SHADER = 'forgeax::default-standard-pbr';

function transmissionValue(material: MaterialSnapshot): number {
  const value = material.paramSnapshot?.transmission;
  return typeof value === 'number' ? value : 0;
}

function transmissionRoughness(material: MaterialSnapshot): number {
  const value = material.paramSnapshot?.roughness;
  return typeof value === 'number' ? value : material.roughness;
}

function transmissionDemandOperations(
  renderables: readonly RenderableSnapshot[],
): readonly TransmissionDemandOperation[] {
  const operations: TransmissionDemandOperation[] = [];
  for (const renderable of renderables) {
    for (const [materialIndex, material] of renderable.materials.entries()) {
      operations.push({
        kind: 'upsert',
        key: `${renderable.worldId}:${renderable.entityKey}:${materialIndex}`,
        candidate: {
          attached: true,
          ready:
            material.materialShaderId === STANDARD_TRANSMISSION_SHADER &&
            material.paramSnapshot !== undefined,
          transmission: transmissionValue(material),
          roughness: transmissionRoughness(material),
        },
      });
    }
  }
  return operations;
}

/**
 * Collection-owned columns come from the renderer's `InstanceProjectionStore`,
 * which never mutates an accepted revision until two newer revisions were
 * projected; RenderScene is its single retaining consumer and only reads the
 * submitted revision while it is exactly one behind (see `temporalSnapshot`).
 * Retaining them by reference keeps a one-row move O(1). Borrowed columns
 * without a collection identity are still copied.
 */
function ownInstances(instances: InstancesSnapshot): InstancesSnapshot {
  if (instances.collectionId !== undefined) return instances;
  return {
    ...instances,
    transforms: new Float32Array(instances.transforms),
    ...(instances.generations === undefined
      ? {}
      : { generations: new Uint32Array(instances.generations) }),
  };
}

function ownSnapshot(snapshot: RenderableSnapshot): RenderableSnapshot {
  const { temporal: _temporal, ...current } = snapshot;
  return {
    ...current,
    ...(snapshot.gpuDrivenDraws === undefined
      ? {}
      : {
          gpuDrivenDraws: snapshot.gpuDrivenDraws.map((draw) =>
            draw.prepared === undefined
              ? draw
              : {
                  ...draw,
                  prepared: freezePreparedGpuDrivenDraw({
                    ...draw.prepared,
                    identity: Object.freeze({ ...draw.prepared.identity }),
                    vertexInputs: ownGpuDrivenVertexInputs(draw.prepared.vertexInputs),
                  }),
                },
          ),
        }),
    transform: { ...snapshot.transform, world: new Float32Array(snapshot.transform.world) },
    ...(snapshot.localAabb === undefined
      ? {}
      : { localAabb: new Float32Array(snapshot.localAabb) }),
    ...(snapshot.instances === undefined ? {} : { instances: ownInstances(snapshot.instances) }),
    ...(snapshot.spriteInstances === undefined
      ? {}
      : {
          spriteInstances: {
            ...snapshot.spriteInstances,
            transforms: new Float32Array(snapshot.spriteInstances.transforms),
            regions: new Float32Array(snapshot.spriteInstances.regions),
          },
        }),
    ...(snapshot.pointsLines === undefined
      ? {}
      : { pointsLines: ownPointsLinesSnapshot(snapshot.pointsLines) }),
    ...(snapshot.skinJointEntities === undefined
      ? {}
      : { skinJointEntities: [...snapshot.skinJointEntities] }),
  };
}

function ownPointsLinesSnapshot(
  snapshot: PointsLinesRetainedSnapshot,
): PointsLinesRetainedSnapshot {
  return {
    ...snapshot,
    style: snapshot.style === undefined ? undefined : { ...snapshot.style },
    sourceBounds: new Float32Array(snapshot.sourceBounds),
    viewport: { ...snapshot.viewport },
    projection: new Float32Array(snapshot.projection),
  };
}

function intersects(left: RenderSceneBounds, right: RenderSceneBounds): boolean {
  return (
    left.min[0] <= right.max[0] &&
    left.max[0] >= right.min[0] &&
    left.min[1] <= right.max[1] &&
    left.max[1] >= right.min[1] &&
    left.min[2] <= right.max[2] &&
    left.max[2] >= right.min[2]
  );
}

function worldBounds(
  snapshot: RenderableSnapshot,
  target?: RenderSceneBounds,
): RenderSceneBounds | undefined {
  const local = snapshot.localAabb;
  if (local === undefined || local.length < 6) return undefined;
  const world = snapshot.transform.world;
  const min = (target?.min ?? [0, 0, 0]) as [number, number, number];
  const max = (target?.max ?? [0, 0, 0]) as [number, number, number];
  const centerX = ((local[0] ?? 0) + (local[3] ?? 0)) * 0.5;
  const centerY = ((local[1] ?? 0) + (local[4] ?? 0)) * 0.5;
  const centerZ = ((local[2] ?? 0) + (local[5] ?? 0)) * 0.5;
  const extentX = ((local[3] ?? 0) - (local[0] ?? 0)) * 0.5;
  const extentY = ((local[4] ?? 0) - (local[1] ?? 0)) * 0.5;
  const extentZ = ((local[5] ?? 0) - (local[2] ?? 0)) * 0.5;
  const worldCenterX =
    (world[0] ?? 0) * centerX +
    (world[4] ?? 0) * centerY +
    (world[8] ?? 0) * centerZ +
    (world[12] ?? 0);
  const worldCenterY =
    (world[1] ?? 0) * centerX +
    (world[5] ?? 0) * centerY +
    (world[9] ?? 0) * centerZ +
    (world[13] ?? 0);
  const worldCenterZ =
    (world[2] ?? 0) * centerX +
    (world[6] ?? 0) * centerY +
    (world[10] ?? 0) * centerZ +
    (world[14] ?? 0);
  const worldExtentX =
    Math.abs(world[0] ?? 0) * extentX +
    Math.abs(world[4] ?? 0) * extentY +
    Math.abs(world[8] ?? 0) * extentZ;
  const worldExtentY =
    Math.abs(world[1] ?? 0) * extentX +
    Math.abs(world[5] ?? 0) * extentY +
    Math.abs(world[9] ?? 0) * extentZ;
  const worldExtentZ =
    Math.abs(world[2] ?? 0) * extentX +
    Math.abs(world[6] ?? 0) * extentY +
    Math.abs(world[10] ?? 0) * extentZ;
  min[0] = worldCenterX - worldExtentX;
  min[1] = worldCenterY - worldExtentY;
  min[2] = worldCenterZ - worldExtentZ;
  max[0] = worldCenterX + worldExtentX;
  max[1] = worldCenterY + worldExtentY;
  max[2] = worldCenterZ + worldExtentZ;
  return target ?? { min, max };
}

function boundsFromArray(bounds: ArrayLike<number>): RenderSceneBounds | undefined {
  if (bounds.length < 6) return undefined;
  const min: [number, number, number] = [Number(bounds[0]), Number(bounds[1]), Number(bounds[2])];
  const max: [number, number, number] = [Number(bounds[3]), Number(bounds[4]), Number(bounds[5])];
  if (
    !min.every(Number.isFinite) ||
    !max.every(Number.isFinite) ||
    min[0] > max[0] ||
    min[1] > max[1] ||
    min[2] > max[2]
  ) {
    return undefined;
  }
  return { min, max };
}

/**
 * The renderer's single rebuildable CPU scene authority.
 *
 * World/entity identity maps, stable slot generations, material reverse
 * lookup, and spatial facts live together here. Frame-local consumers read
 * snapshots from this owner and never create a second projection ledger.
 */
export class RenderScene {
  private readonly slots: Array<RenderSceneSlot | undefined> = [];
  private readonly lastSubmittedSlots: Array<RenderSceneSlot | undefined> = [];
  private readonly previousWorldBySlot: Array<Float32Array | undefined> = [];
  private readonly generations: number[] = [];
  private readonly freeSlots: number[] = [];
  private readonly slotsByWorld = new Map<number, Map<number, number>>();
  private readonly slotsByMaterial = new Map<number, Set<number>>();
  private readonly slotsByAsset = new Map<number, Set<number>>();
  private readonly dirtySinceSubmitted = new Set<number>();
  private temporalTracking = false;
  private lastSubmittedVisible = new Set<string>();
  private submittedEpoch = 0;
  // Bounds are a derived column of the stable render slot, not metadata of a
  // transient snapshot wrapper. Undefined means dirty; null means that the
  // retained row has no usable bounds and must be conservatively visible.
  private readonly worldBoundsBySlot: Array<RenderSceneBounds | null | undefined> = [];
  private readonly instanceBoundsCache = new InstanceBoundsCache();
  private orderedSlots: number[] = [];
  private materialized: RenderableSnapshot[] | undefined;
  private temporalMaterialized: RenderableSnapshot[] | undefined;
  private readonly temporalBySlot: Array<
    | {
        readonly current: RenderSceneSlot;
        readonly source: RenderableSnapshot;
        readonly submitted: RenderSceneSlot | undefined;
        readonly wasVisible: boolean;
        readonly previousWorld: Float32Array | undefined;
        readonly value: RenderableSnapshot;
      }
    | undefined
  > = [];
  private slotSnapshot: readonly RenderSceneSlot[] | undefined;
  private revision = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private renderableScans = 0;
  private fullRebuilds = 0;
  private resyncs = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;

  /** Bounded current-scene facts for the Standard temporal producer. */
  temporalContributorCount(): number {
    return this.orderedSlots.length;
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
      const target = pending.current?.transform.world;
      if (target === undefined) return;
      for (let lane = 0; lane < 16; lane += 1) {
        const value = source[offset + lane] ?? 0;
        if (target[lane] !== value) {
          target[lane] = value;
          pending.transformChanged = true;
        }
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
      if (pending.contentChanged) this.unindexMaterials(pending.initial);
      this.slots[pending.initial.slot] = updatedSlot;
      if (pending.current.instances === undefined && !pending.contentChanged) {
        const cached = this.worldBoundsBySlot[updatedSlot.slot];
        this.worldBoundsBySlot[updatedSlot.slot] =
          worldBounds(pending.current, cached ?? undefined) ?? null;
      } else {
        this.worldBoundsBySlot[updatedSlot.slot] = undefined;
      }
      if (pending.contentChanged) this.indexMaterials(updatedSlot);
      if (this.temporalTracking) this.dirtySinceSubmitted.add(updatedSlot.slot);
      updatedSlots.push(updatedSlot);
      if (pending.contentChanged) contentUpdatedSlots.push(updatedSlot);
      else if (pending.instanceChanged) instanceUpdatedSlots.push(updatedSlot);
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
    this.slotsByWorld.clear();
    for (const slot of this.slots) {
      if (slot === undefined) continue;
      this.instanceBoundsCache.invalidate(slot.entityKey, slot.worldId);
      const mapped = indices[slot.worldId];
      const worldId = mapped === undefined || mapped < 0 ? -1 - slot.worldId : mapped;
      const remapped = { ...slot, worldId, snapshot: { ...slot.snapshot, worldId } };
      this.slots[slot.slot] = remapped;
      let entities = this.slotsByWorld.get(worldId);
      if (entities === undefined) {
        entities = new Map<number, number>();
        this.slotsByWorld.set(worldId, entities);
      }
      entities.set(slot.entityKey, slot.slot);
    }
    this.invalidateSnapshots();
  }

  /** Reconcile the current identity set while retaining slots for survivors. */
  reset(snapshots: readonly RenderableSnapshot[], countAsRebuild = true): void {
    // A full reconciliation is a temporal cut.  Survivors may keep their
    // stable slot, but no prior slot is valid until this frame submits.
    this.lastSubmittedSlots.length = 0;
    this.lastSubmittedVisible.clear();
    this.dirtySinceSubmitted.clear();
    this.submittedEpoch = 0;
    const desired = new Map<string, RenderableSnapshot>();
    for (const snapshot of snapshots) {
      desired.set(identityKey(snapshot.worldId, snapshot.entityKey), snapshot);
    }

    for (const slot of this.slots) {
      if (slot === undefined) continue;
      if (!desired.has(identityKey(slot.worldId, slot.entityKey))) this.release(slot);
    }

    this.orderedSlots = [];
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
      this.unindexMaterials(existing);
      this.slots[existing.slot] = updated;
      this.worldBoundsBySlot[updated.slot] = undefined;
      this.indexMaterials(updated);
      this.dirtySinceSubmitted.add(updated.slot);
      this.orderedSlots.push(existing.slot);
    }

    this.revision += 1;
    if (countAsRebuild) this.fullRebuilds += 1;
    this.invalidateSnapshots();
  }

  rebuild(snapshots: readonly RenderableSnapshot[]): void {
    this.reset(snapshots);
  }

  /** Enable previous-frame publication only while a temporal feature consumes it. */
  setTemporalTracking(enabled: boolean): void {
    if (enabled === this.temporalTracking) return;
    this.temporalTracking = enabled;
    if (!enabled) {
      this.dirtySinceSubmitted.clear();
      return;
    }
    for (const slot of this.orderedSlots) this.dirtySinceSubmitted.add(slot);
  }

  materialize(): RenderableSnapshot[] {
    if (this.materialized !== undefined) return this.materialized;
    const snapshots: RenderableSnapshot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      if (record !== undefined) snapshots.push(record.snapshot);
    }
    this.materialized = snapshots;
    return this.materialized;
  }

  lastSubmittedSlotByIndex(slot: number): RenderSceneSlot | undefined {
    return this.lastSubmittedSlots[slot];
  }

  temporalSnapshotBySlot(slot: number): RenderableTemporalSnapshot | undefined {
    const current = this.slots[slot];
    return current === undefined ? undefined : this.temporalSnapshot(current);
  }

  /**
   * Current snapshots carrying their temporal facts. A slot's temporal
   * snapshot is a pure function of its current record, its last submitted
   * record and that record's visibility, so an unchanged slot returns the same
   * object and an unchanged scene returns the same array. Identity-keyed
   * consumers (visibility projection, residency validation) therefore hit on
   * steady frames. The previous world matrix is a retained per-slot column
   * updated in place at submission, never a per-frame copy.
   */
  materializeTemporal(counters: FrameCacheTally): RenderableSnapshot[] {
    const materialized = this.materialize();
    const previous = this.temporalMaterialized;
    let next: RenderableSnapshot[] | undefined =
      previous === undefined || previous.length !== materialized.length ? [] : undefined;
    for (let index = 0; index < materialized.length; index += 1) {
      const source = materialized[index] as RenderableSnapshot;
      const value = this.withTemporal(source, counters);
      if (next !== undefined) {
        next.push(value);
      } else if (previous?.[index] !== value) {
        next = previous?.slice(0, index) ?? [];
        next.push(value);
      }
    }
    if (next !== undefined) this.temporalMaterialized = next;
    return this.temporalMaterialized ?? [];
  }

  private withTemporal(
    snapshot: RenderableSnapshot,
    counters: FrameCacheTally,
  ): RenderableSnapshot {
    const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
    if (slot === undefined) return snapshot;
    const submitted = this.lastSubmittedSlots[slot.slot];
    const wasVisible =
      submitted?.generation === slot.generation &&
      this.lastSubmittedVisible.has(`${slot.slot}:${slot.generation}`);
    const previousWorld = this.previousWorldBySlot[slot.slot];
    const memo = this.temporalBySlot[slot.slot];
    if (
      memo !== undefined &&
      memo.current === slot &&
      memo.source === snapshot &&
      memo.submitted === submitted &&
      memo.wasVisible === wasVisible &&
      memo.previousWorld === previousWorld
    ) {
      counters.hits += 1;
      return memo.value;
    }
    counters.misses += 1;
    const value = { ...snapshot, temporal: this.temporalSnapshot(slot) };
    this.temporalBySlot[slot.slot] = {
      current: slot,
      source: snapshot,
      submitted,
      wasVisible,
      previousWorld,
      value,
    };
    return value;
  }

  wasLastSubmittedVisible(slot: number, generation: number): boolean {
    return this.lastSubmittedVisible.has(`${slot}:${generation}`);
  }

  captureSubmission(
    visible: readonly Pick<RenderableSnapshot, 'worldId' | 'entityKey'>[],
  ): RenderSceneSubmissionCapture {
    const visibleSlots = new Set<string>();
    for (const snapshot of visible) {
      const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
      if (slot !== undefined) visibleSlots.add(`${slot.slot}:${slot.generation}`);
    }
    return {
      revision: this.revision,
      slots: [...this.dirtySinceSubmitted].map((slot) => ({
        slot,
        current: this.slots[slot],
      })),
      visible: visibleSlots,
    };
  }

  commitSubmission(capture: RenderSceneSubmissionCapture): RenderSceneSubmissionDelta {
    if (capture.revision !== this.revision) {
      throw new RangeError('render scene changed while its temporal submission was active');
    }
    for (const update of capture.slots) {
      this.lastSubmittedSlots[update.slot] = update.current;
      const currentWorld = update.current?.snapshot.transform.world;
      if (currentWorld !== undefined) {
        let previousWorld = this.previousWorldBySlot[update.slot];
        if (previousWorld === undefined) {
          previousWorld = new Float32Array(16);
          this.previousWorldBySlot[update.slot] = previousWorld;
        }
        previousWorld.set(currentWorld);
      }
      this.dirtySinceSubmitted.delete(update.slot);
    }
    this.lastSubmittedVisible = new Set(capture.visible);
    this.submittedEpoch += 1;
    return {
      epoch: this.submittedEpoch,
      slots: capture.slots.map((update) => update.slot),
    };
  }

  /** O(1) current record by stable slot index; bound so frame state can publish it. */
  readonly slotAt = (slot: number): RenderSceneSlot | undefined => this.slots[slot];

  slotsSnapshot(): readonly RenderSceneSlot[] {
    if (this.slotSnapshot !== undefined) return this.slotSnapshot;
    const records: RenderSceneSlot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      if (record !== undefined) records.push(record);
    }
    this.slotSnapshot = Object.freeze(records);
    return this.slotSnapshot;
  }

  /** Cheap owner revision for retained derived projections. */
  revisionValue(): number {
    return this.revision;
  }

  readonly slot = (worldId: number, entityKey: number): RenderSceneSlot | undefined => {
    return this.lookup(worldId, entityKey);
  };

  has(worldId: number, entityKey: number): boolean {
    return this.lookup(worldId, entityKey) !== undefined;
  }

  snapshot(worldId: number, entityKey: number): RenderableSnapshot | undefined {
    return this.lookup(worldId, entityKey)?.snapshot;
  }

  pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
    const snapshots: PointsLinesRetainedSnapshot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
      const snapshot = record?.snapshot.pointsLines;
      if (record !== undefined && snapshot !== undefined) {
        snapshots.push(ownPointsLinesSnapshot({ ...snapshot, worldId: record.worldId }));
      }
    }
    return Object.freeze(snapshots);
  }

  slotsForMaterial(materialHandle: number): readonly RenderSceneSlot[] {
    const slots = this.slotsByMaterial.get(materialHandle);
    if (slots === undefined) return [];
    const records: RenderSceneSlot[] = [];
    for (const slot of slots) {
      const record = this.slots[slot];
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  querySpatial(bounds: RenderSceneBounds): readonly RenderSceneSlot[] {
    const records: RenderSceneSlot[] = [];
    for (const slot of this.orderedSlots) {
      const record = this.slots[slot];
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

  inspect(): RenderSceneInspection {
    return {
      records: this.slotsSnapshot().map(({ slot, generation, worldId, entityKey }) => ({
        slot,
        generation,
        worldId,
        entityKey,
      })),
      slotCapacity: this.slots.length,
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
    const slot = this.slotsByWorld.get(worldId)?.get(entityKey);
    return slot === undefined ? undefined : this.slots[slot];
  }

  private allocate(snapshot: RenderableSnapshot): RenderSceneSlot {
    const reused = this.freeSlots.pop();
    const slot = reused ?? this.slots.length;
    const generation = reused === undefined ? 0 : (this.generations[slot] ?? -1) + 1;
    const record: RenderSceneSlot = {
      slot,
      generation,
      worldId: snapshot.worldId,
      entityKey: snapshot.entityKey,
      snapshot,
    };
    let previousWorld = this.previousWorldBySlot[slot];
    if (previousWorld === undefined) {
      previousWorld = new Float32Array(16);
      this.previousWorldBySlot[slot] = previousWorld;
    }
    previousWorld.set(record.snapshot.transform.world);
    this.generations[slot] = generation;
    this.slots[slot] = record;
    this.worldBoundsBySlot[slot] = undefined;
    let entities = this.slotsByWorld.get(snapshot.worldId);
    if (entities === undefined) {
      entities = new Map<number, number>();
      this.slotsByWorld.set(snapshot.worldId, entities);
    }
    entities.set(snapshot.entityKey, slot);
    this.indexMaterials(record);
    this.orderedSlots.push(slot);
    return record;
  }

  private release(record: RenderSceneSlot): void {
    this.slots[record.slot] = undefined;
    this.worldBoundsBySlot[record.slot] = undefined;
    this.instanceBoundsCache.invalidate(record.entityKey, record.worldId);
    this.unindexMaterials(record);
    const entities = this.slotsByWorld.get(record.worldId);
    entities?.delete(record.entityKey);
    if (entities?.size === 0) this.slotsByWorld.delete(record.worldId);
    const orderIndex = this.orderedSlots.indexOf(record.slot);
    if (orderIndex >= 0) this.orderedSlots.splice(orderIndex, 1);
    this.freeSlots.push(record.slot);
  }

  addSharedRefConsumers(worldId: number, handle: number, target: Set<number>): void {
    for (const index of [this.slotsByAsset, this.slotsByMaterial]) {
      for (const slot of index.get(handle) ?? []) {
        const record = this.slots[slot];
        if (record?.worldId === worldId) target.add(record.entityKey);
      }
    }
  }

  private indexMaterials(record: RenderSceneSlot): void {
    const asset = record.snapshot.assetHandle;
    let assetSlots = this.slotsByAsset.get(asset);
    if (assetSlots === undefined) {
      assetSlots = new Set<number>();
      this.slotsByAsset.set(asset, assetSlots);
    }
    assetSlots.add(record.slot);
    for (const material of record.snapshot.materials) {
      const handle = material.materialHandle ?? 0;
      let slots = this.slotsByMaterial.get(handle);
      if (slots === undefined) {
        slots = new Set<number>();
        this.slotsByMaterial.set(handle, slots);
      }
      slots.add(record.slot);
    }
  }

  private unindexMaterials(record: RenderSceneSlot): void {
    const asset = record.snapshot.assetHandle;
    const assetSlots = this.slotsByAsset.get(asset);
    assetSlots?.delete(record.slot);
    if (assetSlots?.size === 0) this.slotsByAsset.delete(asset);
    for (const material of record.snapshot.materials) {
      const handle = material.materialHandle ?? 0;
      const slots = this.slotsByMaterial.get(handle);
      slots?.delete(record.slot);
      if (slots?.size === 0) this.slotsByMaterial.delete(handle);
    }
  }

  private temporalSnapshot(slot: RenderSceneSlot): RenderableTemporalSnapshot {
    const submitted = this.lastSubmittedSlots[slot.slot];
    const sameGeneration = submitted?.generation === slot.generation;
    const wasVisible =
      sameGeneration && this.lastSubmittedVisible.has(`${slot.slot}:${slot.generation}`);
    const reasons: RenderableReactiveReason[] = [];
    if (!sameGeneration) {
      reasons.push(submitted === undefined ? 'new-slot' : 'generation-reuse');
    } else if (!wasVisible) {
      reasons.push('reentered');
    }
    if (
      sameGeneration &&
      submitted !== undefined &&
      submitted.snapshot.assetHandle !== slot.snapshot.assetHandle
    ) {
      reasons.push('geometry-revision');
    }
    if (
      sameGeneration &&
      submitted !== undefined &&
      submitted.snapshot.materials !== slot.snapshot.materials
    ) {
      reasons.push('material-revision');
    }
    // Runtime texture bytes may change without a material revision. The
    // current displaced local position cannot stand in for its unknown prior
    // shape; expose invalid motion and reject color history through the same
    // submitted-scene authority used by rigid, instance and skin consumers.
    if (
      slot.snapshot.materials.some(
        (material) =>
          (material.paramSnapshot?.displacementScale ?? 0) !== 0 &&
          (material.textureSources?.has('displacementTexture') === true ||
            material.videoTextureFields?.has('displacementTexture') === true),
      )
    )
      reasons.push('displacement-source');
    const seedCurrent =
      !sameGeneration ||
      !wasVisible ||
      reasons.includes('geometry-revision') ||
      reasons.includes('material-revision') ||
      reasons.includes('displacement-source');
    const previous = seedCurrent || submitted === undefined ? slot.snapshot : submitted.snapshot;
    const previousWorld = this.previousWorldBySlot[slot.slot];
    const currentInstances = slot.snapshot.instances;
    const submittedInstances = submitted?.snapshot.instances;
    // A collection-owned column is retained by reference and the projection
    // store recycles it two revisions later; a submission that lags further
    // (failed or skipped submit) is a temporal cut, never a stale read.
    const submittedRecycled =
      currentInstances?.collectionId !== undefined &&
      submittedInstances?.collectionId === currentInstances.collectionId &&
      submittedInstances.transforms !== currentInstances.transforms &&
      (currentInstances.revision ?? 0) - (submittedInstances.revision ?? 0) > 1;
    const instancesCompatible =
      !submittedRecycled &&
      (currentInstances === undefined && submittedInstances === undefined
        ? true
        : currentInstances !== undefined &&
          submittedInstances !== undefined &&
          (currentInstances.collectionId === undefined ||
            submittedInstances.collectionId === undefined ||
            currentInstances.collectionId === submittedInstances.collectionId) &&
          currentInstances.transforms.length >= currentInstances.instanceCount * 16 &&
          submittedInstances.transforms.length >= submittedInstances.instanceCount * 16 &&
          sameInstanceIdentitySet(currentInstances.generations, submittedInstances.generations));
    const motionValid = !seedCurrent && previousWorld !== undefined && instancesCompatible;
    return {
      previousSource: seedCurrent ? 'current-seed' : 'last-submitted',
      motionValid,
      reactive: reasons.length > 0,
      reactiveReasons: reasons,
      previousTransform:
        seedCurrent || previousWorld === undefined
          ? previous.transform
          : { ...previous.transform, world: previousWorld },
      // A collection identity/count break is a temporal cut for that
      // renderable. The record stage receives the current snapshot as its
      // baseline, while stable collections retain the submitted column and
      // use identity generations to map reordered entries and seed replaced
      // entries.
      previousInstances:
        seedCurrent || submittedRecycled ? slot.snapshot.instances : previous.instances,
      previousSkin: previous.skin,
      previousMorphWeights: previous.morph?.weights,
    };
  }

  private invalidateSnapshots(): void {
    this.materialized = undefined;
    this.slotSnapshot = undefined;
  }

  /**
   * Return the CPU culling projection for one retained snapshot. Instances
   * use a renderer-derived union, while the GPU scene keeps the mesh-local
   * bounds for its independent per-instance visibility pass. Unknown or
   * empty instance facts deliberately return undefined (conservative no-cull).
   */
  cullingWorldBoundsAt(slot: RenderSceneSlot): RenderSceneBounds | undefined {
    let candidate = this.worldBoundsBySlot[slot.slot];
    if (candidate !== undefined) return candidate ?? undefined;
    const snapshot = slot.snapshot;
    if (snapshot.instances !== undefined) {
      const instanceCount = snapshot.instances.instanceCount;
      if (instanceCount === 0 || snapshot.localAabb === undefined) {
        this.worldBoundsBySlot[slot.slot] = null;
        return undefined;
      }
      const derived = this.instanceBoundsCache.get({
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        meshGeneration: fingerprintNumericArray(snapshot.localAabb) ^ (snapshot.assetHandle >>> 0),
        transformGeneration: fingerprintNumericArray(snapshot.transform.world),
        matrixGeneration: snapshot.instances.revision ?? snapshot.instances.archVersion,
        meshAabb: snapshot.localAabb,
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
      candidate = worldBounds(snapshot, candidate ?? undefined);
    }
    this.worldBoundsBySlot[slot.slot] = candidate ?? null;
    return candidate;
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
  readonly shaderRegistry?: ShaderRegistry | undefined;
  /** Profile consumers that need the same submitted history as camera effects. */
  readonly getTemporalConsumerDemand?: (() => boolean) | undefined;
  readonly getDevice?: (() => RhiDevice) | undefined;
  readonly onGpuError?: ((error: RhiError) => void) | undefined;
  readonly onRuntimeAssetChange?: ((worldId: number, handle: number) => void) | undefined;
  /** Instance projection accepted by the same World source update flow. */
  readonly instanceCollections?: InstanceProjectionStore | undefined;
}

export interface PersistentGpuDrivenState {
  /** Present only for the complete retained composition, never a filtered view. */
  readonly retained?: {
    readonly identity: object;
    readonly revision: number;
    readonly worlds: readonly RenderResourceScope[];
    readonly slots: readonly RenderSceneSlot[];
    isCurrent(): boolean;
    /** The current source still matches the versions consumed by extraction. */
    isSourceCurrent(): boolean;
  };
  readonly scene: GpuScene;
  readonly plan: SubmissionPlan;
  readonly slots: readonly RenderSceneSlot[];
  /**
   * O(1) current record by stable slot index. Frame consumers resolve rows
   * through this instead of retaining records from an older slots snapshot.
   */
  readonly slotAt: (slot: number) => RenderSceneSlot | undefined;
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
  readonly renderables: readonly RenderableSnapshot[];
  readonly dispatch: readonly DispatchEntry[];
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
  readonly topology: BatchTopology;
  readonly transmissionDemand: PersistentTransmissionDemandProjection;
  hiddenEntityReports: ExtractedFrame['hiddenEntityReports'];
  /** Stable renderer-local World keys; unlike RenderableSnapshot.worldId they survive reorder. */
  readonly worldKeys: readonly number[];
  readonly readVersions: RenderReadVersion[];
  readLeases: readonly RenderReadLease[];
  publicationRevision: number | undefined;
  readonly transformQueries: readonly GlobalTransformChangeQuery[];
  readonly sourceStates: readonly ReturnType<typeof createRenderSourceState>[];
  readonly dispatchBySlot: Map<number, readonly DispatchEntry[]>;
  dispatchRevision: number;
  dispatchCache: { readonly revision: number; readonly value: DispatchEntry[] } | undefined;
  readonly skinConsumersByJoint: Map<string, Set<number>>;
  /** Renderable identities whose partial producer still needs a successful publish. */
  readonly pendingRenderableEntitiesByWorld: Set<number>[];
  /** Slots retained for recovery but excluded from direct and indirect submission. */
  readonly unavailableSlots: Set<number>;
  catalogEpoch: number;
  readonly probeProjection: ProbeBlendSceneProjection;
  probeObjects:
    | {
        readonly revision: number;
        readonly surfaceOnly: boolean;
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
    (snapshot.skin !== undefined) !== world.hasComponent(entity, skin) ||
    (snapshot.morph !== undefined) !== world.hasComponent(entity, MorphWeights) ||
    (snapshot.pointsLines?.component === 'Points') !== world.hasComponent(entity, Points) ||
    (snapshot.pointsLines?.component === 'Lines') !== world.hasComponent(entity, Lines)
  );
}

function skinJointKey(worldId: number, jointEntity: number): string {
  return `${worldId}:${jointEntity}`;
}

function addSkinConsumer(index: Map<string, Set<number>>, snapshot: RenderableSnapshot): void {
  for (const jointEntity of snapshot.skinJointEntities ?? []) {
    const key = skinJointKey(snapshot.worldId, jointEntity);
    let consumers = index.get(key);
    if (consumers === undefined) {
      consumers = new Set<number>();
      index.set(key, consumers);
    }
    consumers.add(snapshot.entityKey);
  }
}

function removeSkinConsumer(index: Map<string, Set<number>>, snapshot: RenderableSnapshot): void {
  for (const jointEntity of snapshot.skinJointEntities ?? []) {
    const key = skinJointKey(snapshot.worldId, jointEntity);
    const consumers = index.get(key);
    consumers?.delete(snapshot.entityKey);
    if (consumers?.size === 0) index.delete(key);
  }
}

function dispatchEntriesBySlot(
  frame: ExtractedFrame,
  projection: RenderScene,
  bySlot = new Map<number, readonly DispatchEntry[]>(),
): Map<number, readonly DispatchEntry[]> {
  const published = publicationDispatchGroups(frame);
  if (published !== undefined) {
    for (let index = 0; index < frame.renderables.length; index++) {
      const renderable = frame.renderables[index];
      if (renderable === undefined) continue;
      const slot = projection.slot(renderable.worldId, renderable.entityKey);
      if (slot !== undefined) bySlot.set(slot.slot, published[index] ?? []);
    }
    return bySlot;
  }
  const byRenderable = new Map<number, DispatchEntry[]>();
  for (const entry of frame.dispatch) {
    const list = byRenderable.get(entry.renderableIndex);
    if (list === undefined) byRenderable.set(entry.renderableIndex, [entry]);
    else list.push(entry);
  }
  for (let index = 0; index < frame.renderables.length; index += 1) {
    const renderable = frame.renderables[index];
    if (renderable === undefined) continue;
    const slot = projection.slot(renderable.worldId, renderable.entityKey);
    if (slot === undefined) continue;
    bySlot.set(slot.slot, byRenderable.get(index) ?? []);
  }
  return bySlot;
}

function dispatchForProjection(
  dispatchBySlot: Map<number, readonly DispatchEntry[]>,
  projection: RenderScene,
  unavailableSlots: ReadonlySet<number>,
): DispatchEntry[] {
  const dispatch: DispatchEntry[] = [];
  const slots = projection.slotsSnapshot();
  for (let renderableIndex = 0; renderableIndex < slots.length; renderableIndex += 1) {
    const slot = slots[renderableIndex];
    if (slot === undefined) continue;
    if (unavailableSlots.has(slot.slot)) continue;
    const entries = dispatchBySlot.get(slot.slot);
    if (entries === undefined) continue;
    let rebased: DispatchEntry[] | undefined;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry === undefined) continue;
      if (renderableIndex === entry.renderableIndex) {
        dispatch.push(entry);
      } else {
        // The existing slot owner keeps the corrected frame address. Replace
        // its list, never an entry already published to an earlier frame.
        rebased ??= entries.slice();
        const current = { ...entry, renderableIndex };
        rebased[index] = current;
        dispatch.push(current);
      }
    }
    if (rebased !== undefined) dispatchBySlot.set(slot.slot, rebased);
  }
  return dispatch;
}

function topologyDeltaForAvailable(
  delta: RenderSceneApplyResult,
  unavailableSlots: ReadonlySet<number>,
  newlyUnavailable: readonly RenderSceneSlot[],
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

/** Mutable accumulator behind a readonly `FrameCacheCounters` inspection. */
interface FrameCacheTally {
  hits: number;
  misses: number;
}

let cullProjectedIndexScratch = new Int32Array(0);

/**
 * Previous cull output keyed by its exact inputs. Camera motion changes the
 * frustum every frame, but the admitted set is usually unchanged; reusing the
 * output arrays keeps every identity-keyed consumer downstream (visibility
 * projection, residency validation, render bundles) on its cached path.
 */
interface PersistentCullMemo {
  readonly sourceRenderables: readonly RenderableSnapshot[];
  readonly sourceDispatch: readonly DispatchEntry[];
  readonly projectedIndex: Int32Array;
  readonly shadowOnly: ReadonlySet<number>;
  readonly renderables: RenderableSnapshot[];
  readonly dispatch: DispatchEntry[];
}

function sameCullProjection(
  memo: PersistentCullMemo,
  frame: ExtractedFrame,
  projectedIndex: Int32Array,
  count: number,
  shadowOnly: ReadonlySet<number>,
): boolean {
  if (memo.sourceRenderables !== frame.renderables || memo.sourceDispatch !== frame.dispatch) {
    return false;
  }
  if (memo.projectedIndex.length !== count || memo.shadowOnly.size !== shadowOnly.size) {
    return false;
  }
  for (let index = 0; index < count; index += 1) {
    if (memo.projectedIndex[index] !== projectedIndex[index]) return false;
  }
  for (const index of shadowOnly) if (!memo.shadowOnly.has(index)) return false;
  return true;
}

/** Draw keys the GPU-driven raster owned last primary frame, in its world-key space. */
export interface GpuRasterOwnership {
  readonly drawKeys: ReadonlySet<string>;
  readonly worldKeys: readonly number[] | undefined;
}

function cullPersistentFrame(
  frame: ExtractedFrame,
  candidates: readonly RenderableSnapshot[],
  boundsOf: (snapshot: RenderableSnapshot, index: number) => RenderSceneBounds | undefined = (
    snapshot,
  ) => worldBounds(snapshot),
  memo?: { value: PersistentCullMemo | undefined },
  gpuCulled?: (snapshot: RenderableSnapshot) => boolean,
): ExtractedFrame {
  const planes = buildCameraFrusta(frame.cameras);
  // Shadow casters are not constrained by the display camera. Keep the
  // primary camera cull intact, but admit a caster that is outside every
  // camera frustum when its bounds intersect one of the active light-space
  // frusta. This is especially important for point-light cube faces: the
  // caster can be behind the camera while still occluding the receiver.
  let casterIndices: Set<number> | undefined;
  let shadowFrusta: ReturnType<typeof buildShadowFrusta> | undefined;
  const shadowOnly = new Set<number>();
  let gpuRasterCulledEntityKeys: Set<number> | undefined;
  if (cullProjectedIndexScratch.length < candidates.length) {
    cullProjectedIndexScratch = new Int32Array(candidates.length);
  }
  const projectedIndex = cullProjectedIndexScratch;
  projectedIndex.fill(-1, 0, candidates.length);
  const worldAabb = box3.create();
  let total = 0;
  let culled = 0;
  let visibleCount = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    if (candidate.authorVisible === false) {
      culled += 1;
      continue;
    }
    let isVisible = true;
    let isShadowVisible = false;
    // A GPU-owned candidate stays in the plan (its view pass culls it against
    // the same bounds), but the CPU test still feeds `frustumStats` so the
    // statistic does not depend on which lane executed the cull.
    const gpuOwned = gpuCulled?.(candidate) === true;
    const candidateBounds = boundsOf(candidate, index);
    if (candidateBounds !== undefined) {
      total += 1;
      worldAabb[0] = candidateBounds.min[0] ?? 0;
      worldAabb[1] = candidateBounds.min[1] ?? 0;
      worldAabb[2] = candidateBounds.min[2] ?? 0;
      worldAabb[3] = candidateBounds.max[0] ?? 0;
      worldAabb[4] = candidateBounds.max[1] ?? 0;
      worldAabb[5] = candidateBounds.max[2] ?? 0;
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
        if (casterIndices === undefined) {
          casterIndices = new Set<number>();
          for (const draw of frame.dispatch)
            if (draw.tags.LightMode === 'ShadowCaster') casterIndices.add(draw.renderableIndex);
        }
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
      if (gpuOwned) {
        gpuRasterCulledEntityKeys ??= new Set();
        gpuRasterCulledEntityKeys.add(worldEntityKey(candidate.worldId, candidate.entityKey));
      }
      if (!gpuOwned) {
        if (!isShadowVisible) continue;
        shadowOnly.add(index);
      }
    }
    projectedIndex[index] = visibleCount;
    visibleCount += 1;
  }
  const frustumStats = { culled, total };
  const previous = memo?.value;
  if (
    previous !== undefined &&
    sameCullProjection(previous, frame, projectedIndex, candidates.length, shadowOnly)
  ) {
    return {
      ...frame,
      renderables: previous.renderables,
      dispatch: previous.dispatch,
      frustumStats,
      gpuRasterCulledEntityKeys,
    };
  }

  const visible: RenderableSnapshot[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if ((projectedIndex[index] ?? -1) < 0) continue;
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    // The culling candidate is the persistent projection snapshot used for
    // bounds, while `frame.renderables[index]` may carry frame-owned
    // attachments (for example the probe blend record). Preserve that
    // attached renderable in the output; pushing the bare candidate here
    // silently drops the object-level Probe ABI before record selection.
    visible.push(frame.renderables[index] ?? candidate);
  }

  const dispatch: DispatchEntry[] = [];
  for (const entry of frame.dispatch) {
    const candidateIndex = entry.renderableIndex;
    // Shadow-only candidates must never enter the main forward/transparent
    // dispatch. Their ShadowCaster entries remain available to the depth
    // passes, which consume the same validated ordered list.
    if (shadowOnly.has(candidateIndex) && entry.tags.LightMode !== 'ShadowCaster') continue;
    const renderableIndex = projectedIndex[candidateIndex];
    if (renderableIndex === undefined || renderableIndex < 0) continue;
    dispatch.push(
      renderableIndex === entry.renderableIndex ? entry : { ...entry, renderableIndex },
    );
  }
  if (memo !== undefined) {
    memo.value = {
      sourceRenderables: frame.renderables,
      sourceDispatch: frame.dispatch,
      projectedIndex: projectedIndex.slice(0, candidates.length),
      shadowOnly,
      renderables: visible,
      dispatch,
    };
  }
  return {
    ...frame,
    renderables: visible,
    dispatch,
    frustumStats,
    gpuRasterCulledEntityKeys,
  };
}

/**
 * Probe attachment memo: a candidate keeps its attached snapshot while its
 * record is unchanged, and the output array keeps its identity while every
 * element does, so camera-only frames stay on identity-keyed caches.
 */
interface ProbeAttachMemo {
  readonly bySnapshot: WeakMap<
    RenderableSnapshot,
    { readonly record: ProbeBlendRecord; readonly value: RenderableSnapshot }
  >;
  previous: readonly RenderableSnapshot[] | undefined;
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

function attachProbeRecords(
  frame: ExtractedFrame,
  candidates: RenderableSnapshot[],
  slots: readonly RenderSceneSlot[],
  projection: ProbeBlendSceneProjection,
  memo: ProbeAttachMemo,
): ExtractedFrame {
  if (!projection.hasRecords()) {
    memo.previous = undefined;
    return frame.renderables === candidates ? frame : { ...frame, renderables: candidates };
  }
  let objectKeys: Map<string, number> | undefined;
  const slotOf = (candidate: RenderableSnapshot, index: number): number | undefined => {
    const direct = slots[index];
    if (
      direct !== undefined &&
      direct.worldId === candidate.worldId &&
      direct.snapshot.entityKey === candidate.entityKey
    ) {
      return direct.slot;
    }
    if (objectKeys === undefined) {
      objectKeys = new Map<string, number>();
      for (const slot of slots)
        objectKeys.set(identityKey(slot.worldId, slot.snapshot.entityKey), slot.slot);
    }
    return objectKeys.get(identityKey(candidate.worldId, candidate.entityKey));
  };
  const previous = memo.previous;
  let renderables: RenderableSnapshot[] | undefined;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as RenderableSnapshot;
    const slot = slotOf(candidate, index);
    const record = slot === undefined ? undefined : projection.getRecord(slot);
    let value = candidate;
    if (record !== undefined) {
      const cached = memo.bySnapshot.get(candidate);
      if (cached?.record === record) {
        value = cached.value;
      } else {
        value = { ...candidate, probeBlendRecord: record };
        memo.bySnapshot.set(candidate, { record, value });
      }
    }
    if (renderables === undefined) {
      if (
        previous !== undefined &&
        previous.length === candidates.length &&
        previous[index] === value
      ) {
        continue;
      }
      renderables = (previous ?? []).slice(0, index);
    }
    renderables.push(value);
  }
  const result =
    renderables ??
    (previous !== undefined && previous.length === candidates.length ? previous : []);
  memo.previous = result;
  return { ...frame, renderables: result as RenderableSnapshot[] };
}

/** Persistent scene projection used by the renderer's multi-World composition path. */
export class PersistentRenderScene {
  /** World identity is the author/runtime identity; array position is only a frame routing detail. */
  private readonly visibilityWorldKeys = new Map<string, number>();
  private nextVisibilityWorldKey = 0;
  private materialSnapshotCaches: MaterialSnapshotCachesByWorld = new WeakMap();
  private materialContextKey: string | undefined;
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
  private readonly shadowOwnership = new ShadowCasterOwnershipProjection();
  private gpuOwner: object | undefined;
  private gpuRasterOwned: GpuRasterOwnership | undefined;
  private readonly gpuOwnedBySnapshot = new WeakMap<
    RenderableSnapshot,
    GpuRasterOwnership & { readonly owned: boolean }
  >();
  private gpuDevice: RhiDevice | undefined;
  private gpuStatus: 'inactive' | 'unsupported' | 'resident' | 'rebuild-pending' | 'error' =
    'inactive';
  private terrainCandidate: readonly RenderableSnapshot[] = [];
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
        readonly renderables: readonly RenderableSnapshot[];
        readonly dispatch: readonly DispatchEntry[];
        readonly projection: PersistentVisibilityProjection;
      }
    | undefined;
  private visibilityProjectionRevision = 0;
  private lastActiveEntityKeys: ReadonlySet<number> | undefined;
  /** Stable renderer-world/entity lookup; rebuilt only with composition topology. */
  private readonly stableSlotByEntity = new Map<number, RenderSceneSlot>();
  private pointsLinesInspections: readonly PointsLinesInspection[] = [];
  private readonly reflectionProbes = new ReflectionProbeProjection();

  constructor(private readonly options: PersistentRenderSceneOptions = {}) {}

  /** RenderScene owns the per-World material fact cache used during extraction. */
  materialSnapshotCacheStore(context?: MaterialCookRasterContext): MaterialSnapshotCachesByWorld {
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
  compositionSlots(): readonly RenderSceneSlot[] {
    return this.composition?.projection.slotsSnapshot() ?? [];
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
    renderables: readonly RenderableSnapshot[],
    dispatch: readonly DispatchEntry[],
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
    let entry = this.composition;
    if (entry === undefined || packet.baseline) {
      this.invalidate();
      const projection = new RenderScene();
      entry = {
        token: {},
        worlds: [resources],
        projection,
        topology: new BatchTopology(),
        transmissionDemand: new PersistentTransmissionDemandProjection(),
        hiddenEntityReports: [],
        worldKeys: this.visibilityWorldKeysFor([resources]),
        readVersions: [],
        readLeases: [],
        publicationRevision: packet.revision,
        transformQueries: [],
        sourceStates: [],
        dispatchBySlot: new Map(),
        dispatchRevision: 0,
        dispatchCache: undefined,
        skinConsumersByJoint: new Map(),
        pendingRenderableEntitiesByWorld: [],
        unavailableSlots: new Set(),
        catalogEpoch: 0,
        probeProjection: new ProbeBlendSceneProjection(),
        probeObjects: undefined,
        temporalDemanded: false,
      };
      this.composition = entry;
      this.fullRebuilds++;
      this.lastResyncReason = 'attach';
    }
    this.worldEntitiesScanned = 0;
    this.sceneTableUploadBytes = 0;
    const removedDemand: TransmissionDemandOperation[] = [];
    for (const operation of input.operations) {
      if (operation.kind !== 'remove' && operation.snapshot === undefined) continue;
      const previous = entry.projection.slot(0, operation.entityKey);
      for (let index = 0; index < (previous?.snapshot.materials.length ?? 0); index++)
        removedDemand.push({ kind: 'remove', key: `0:${operation.entityKey}:${index}` });
    }
    const delta = entry.projection.apply(input.operations);
    for (const removed of delta.removedSlots) {
      entry.dispatchBySlot.delete(removed.slot);
      this.stableSlotByEntity.delete(worldEntityKey(entry.worldKeys[0] ?? 0, removed.entityKey));
      this.stableSlotRevision += 1;
    }
    for (const recreated of delta.recreatedSlots) entry.dispatchBySlot.delete(recreated.slot);
    dispatchEntriesBySlot(frame, entry.projection, entry.dispatchBySlot);
    if (frame.renderables.length || packet.removed.length) {
      entry.dispatchRevision++;
      entry.dispatchCache = undefined;
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
    entry.transmissionDemand.apply([
      ...removedDemand,
      ...transmissionDemandOperations(frame.renderables),
    ]);
    entry.topology.apply(delta);
    this.syncGpuOwner(entry.token, entry.projection, delta);
    if (input.operations.length) this.deltaFrames++;
    else this.noChangeFrames++;
    this.transformUpdates += delta.updated;
    entry.publicationRevision = packet.revision;
    return this.deriveFramePlan(entry, frame);
  }

  extractComposition(
    worlds: readonly World[],
    owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    catalogEpoch: number,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases?: readonly RenderReadLease[],
  ): ExtractedFrame {
    this.worldEntitiesScanned = 0;
    this.sceneTableUploadBytes = 0;
    const entry = this.composition;
    const sameWorldSet =
      entry !== undefined &&
      entry.worlds.length === worlds.length &&
      entry.worlds.every((world) => worlds.some((local) => local === world));
    const worldOrderChanged =
      entry !== undefined &&
      sameWorldSet &&
      entry.worlds.some((world, index) => world !== worlds[index]);
    const leaseSetPreserved =
      entry !== undefined &&
      leases !== undefined &&
      leases.length === worlds.length &&
      entry.readLeases.length === leases.length &&
      entry.readLeases.every((lease) => leases.includes(lease));
    const preserveVisibilityOnReorder =
      entry !== undefined &&
      worldOrderChanged &&
      entry.catalogEpoch === catalogEpoch &&
      leaseSetPreserved;
    if (
      entry === undefined ||
      entry.worlds.length !== worlds.length ||
      entry.worlds.some((world, index) => world !== worlds[index]) ||
      leases === undefined ||
      leases.length !== worlds.length
    ) {
      return this.reconcileComposition(
        worlds,
        owner,
        catalogEpoch,
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
    if (entry.catalogEpoch !== catalogEpoch) {
      for (const slot of entry.projection.slotsSnapshot()) {
        changedEntitiesByWorld[slot.worldId]?.add(slot.entityKey);
        contentChangedByWorld[slot.worldId]?.add(slot.entityKey);
      }
    }
    const nextReadVersions = entry.readVersions.slice();
    const sourceBatches: StateProjectionBatch[] = [];
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
      sourceBatches.push(batch);
      this.worldEntitiesScanned += batch.scannedRows;
      const dependencyVisited = new Set<number>();
      const runtimeAssets = new Set<number>();
      const runtimeContentChanged =
        batch.membershipChanged ||
        batch.changedComponents.includes(source.runtimeMaterialValue) ||
        batch.changedComponents.includes(source.runtimeMeshVertices);
      const contentComponents = source.renderableComponents.filter(
        (component) => component !== Instances && batch.changedComponents.includes(component),
      );
      const instancesChanged = batch.changedComponents.includes(Instances);
      const reconcileIdentities =
        batch.membershipChanged ||
        runtimeContentChanged ||
        contentComponents.length > 0 ||
        instancesChanged;
      for (const index of reconcileIdentities ? batch.indices : []) {
        const previous = source.entities.get(index);
        const current = source.projection.entity(index);
        if (runtimeContentChanged) {
          const runtimeHandles = new Set(source.contentHandles.get(index));
          if (current !== undefined) {
            const material = world.hasComponent(current, source.runtimeMaterialValue)
              ? world.get(current, source.runtimeMaterialValue)
              : undefined;
            const mesh = world.hasComponent(current, source.runtimeMeshVertices)
              ? world.get(current, source.runtimeMeshVertices)
              : undefined;
            if (material?.ok) runtimeHandles.add(Number(material.value.asset));
            if (mesh?.ok) runtimeHandles.add(Number(mesh.value.asset));
          }
          for (const handle of runtimeHandles) runtimeAssets.add(handle);
        }
        if (previous !== undefined) {
          const slot = entry.projection.slot(worldId, previous);
          if (
            batch.membershipChanged &&
            slot !== undefined &&
            (current !== previous || !isRenderableMember(world, previous))
          ) {
            removedSlots.push(slot);
            changed.add(previous);
          }
          for (const consumer of entry.skinConsumersByJoint.get(skinJointKey(worldId, previous)) ??
            []) {
            changed.add(consumer);
            content.add(consumer);
          }
        }
        if (current === undefined) continue;
        const existing = entry.projection.slot(worldId, current);
        const membershipChanged =
          batch.membershipChanged &&
          (existing === undefined || sourceMembershipChanged(world, existing));
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
          version.structureEpoch !== read.version.structureEpoch ||
          source.projection.changed(current, ChildOf) ||
          source.projection.changed(current, Visibility)
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
      for (const handle of runtimeAssets) {
        // Runtime values change without a Catalog epoch. Re-extraction must
        // resolve their new payload instead of retaining a frozen material fact.
        this.materialSnapshotCaches.get(world)?.delete(handle);
        this.options.onRuntimeAssetChange?.(worldId, handle);
        entry.projection.addSharedRefConsumers(worldId, handle, content);
      }
      for (const entity of content) changed.add(entity);
      const query = entry.transformQueries[worldId];
      if (query !== undefined) {
        for (const span of query.spans().unwrap()) {
          const matrices = span.get(GlobalTransform).world;
          if (!(matrices instanceof Float32Array))
            throw new Error('GlobalTransform projection must expose a numeric column.');
          transformSpans.push({ worldId, entities: span.entities, worlds: matrices });
          if (entry.skinConsumersByJoint.size > 0) {
            for (const entity of span.entities) {
              for (const consumer of entry.skinConsumersByJoint.get(
                skinJointKey(worldId, entity),
              ) ?? []) {
                changed.add(consumer);
                content.add(consumer);
              }
            }
          }
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
      const removedDemand: TransmissionDemandOperation[] = [];
      const replacedSkinSnapshots: RenderableSnapshot[] = [];
      for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
        for (const entityKey of changedEntitiesByWorld[worldId] ?? []) {
          const slot = entry.projection.slot(worldId, entityKey);
          if (slot !== undefined) replacedSkinSnapshots.push(slot.snapshot);
        }
      }
      for (const slot of removedSlots) {
        operations.push({ kind: 'remove', worldId: slot.worldId, entityKey: slot.entityKey });
        for (
          let materialIndex = 0;
          materialIndex < slot.snapshot.materials.length;
          materialIndex += 1
        ) {
          removedDemand.push({
            kind: 'remove',
            key: `${slot.worldId}:${slot.entityKey}:${materialIndex}`,
          });
        }
      }
      for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
        for (const entityKey of changedEntitiesByWorld[worldId] ?? []) {
          const slot = entry.projection.slot(worldId, entityKey);
          if (slot === undefined) continue;
          for (
            let materialIndex = 0;
            materialIndex < slot.snapshot.materials.length;
            materialIndex += 1
          ) {
            removedDemand.push({ kind: 'remove', key: `${worldId}:${entityKey}:${materialIndex}` });
          }
        }
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
      changedDelta = entry.projection.apply(operations, transformSpans);
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
      for (const slot of removedSlots)
        if (slot.snapshot.skinJointEntities !== undefined)
          removeSkinConsumer(entry.skinConsumersByJoint, slot.snapshot);
      const publishedSkinKeys = new Set<string>();
      for (const snapshot of partial?.renderables ?? []) {
        publishedSkinKeys.add(`${snapshot.worldId}:${snapshot.entityKey}`);
      }
      for (const snapshot of replacedSkinSnapshots) {
        // Keep the old dependency while a failed/omitted partial publication
        // retains its CPU slot.  The pending identity must still be woken by
        // a later joint transform change so the producer gets another chance.
        if (
          snapshot.skinJointEntities !== undefined &&
          publishedSkinKeys.has(`${snapshot.worldId}:${snapshot.entityKey}`)
        ) {
          removeSkinConsumer(entry.skinConsumersByJoint, snapshot);
        }
      }
      for (const snapshot of partial?.renderables ?? []) {
        if (snapshot.skinJointEntities !== undefined) {
          addSkinConsumer(entry.skinConsumersByJoint, snapshot);
        }
      }
      entry.transmissionDemand.apply([
        ...removedDemand,
        ...transmissionDemandOperations(partial?.renderables ?? []),
      ]);
      for (const removed of changedDelta.removedSlots) entry.dispatchBySlot.delete(removed.slot);
      for (const recreated of changedDelta.recreatedSlots)
        entry.dispatchBySlot.delete(recreated.slot);
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
        dispatchEntriesBySlot(partial, entry.projection, entry.dispatchBySlot);
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
          if (slot !== undefined) entry.dispatchBySlot.set(slot.slot, []);
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
            if (slot !== undefined) entry.unavailableSlots.delete(slot.slot);
            continue;
          }
          if (!entry.unavailableSlots.has(slot.slot)) newlyUnavailable.push(slot);
          entry.unavailableSlots.add(slot.slot);
        }
      }
      for (const removed of changedDelta.removedSlots) entry.unavailableSlots.delete(removed.slot);
      for (const recreated of changedDelta.recreatedSlots)
        entry.unavailableSlots.delete(recreated.slot);
      if (partial !== undefined || removedSlots.length > 0) {
        entry.dispatchRevision += 1;
        entry.dispatchCache = undefined;
      }
      entry.topology.apply(
        topologyDeltaForAvailable(changedDelta, entry.unavailableSlots, newlyUnavailable),
      );
      this.syncGpuOwner(entry.token, entry.projection, changedDelta);
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
      this.syncGpuOwner(entry.token, entry.projection);
    }
    const result = this.deriveFramePlan(entry, resourceFrame);
    for (let worldId = 0; worldId < sourceBatches.length; worldId++) {
      const batch = sourceBatches[worldId];
      const source = entry.sourceStates[worldId];
      if (batch === undefined || source === undefined) continue;
      batch.accept();
      if (
        !batch.membershipChanged &&
        !batch.changedComponents.includes(source.runtimeMaterialValue) &&
        !batch.changedComponents.includes(source.runtimeMeshVertices)
      )
        continue;
      for (const index of batch.indices) {
        const entity = source.projection.entity(index);
        if (entity === undefined) {
          source.entities.delete(index);
          source.contentHandles.delete(index);
        } else {
          source.entities.set(index, entity);
          const handles: number[] = [];
          const world = worlds[worldId];
          if (world !== undefined) {
            const material = world.hasComponent(entity, source.runtimeMaterialValue)
              ? world.get(entity, source.runtimeMaterialValue)
              : undefined;
            const mesh = world.hasComponent(entity, source.runtimeMeshVertices)
              ? world.get(entity, source.runtimeMeshVertices)
              : undefined;
            if (material?.ok) handles.push(Number(material.value.asset));
            if (mesh?.ok) handles.push(Number(mesh.value.asset));
          }
          if (handles.length === 0) source.contentHandles.delete(index);
          else source.contentHandles.set(index, handles);
        }
      }
    }
    entry.catalogEpoch = catalogEpoch;
    entry.readLeases = [...leases];
    for (let worldId = 0; worldId < nextReadVersions.length; worldId += 1) {
      const version = nextReadVersions[worldId];
      if (version !== undefined) entry.readVersions[worldId] = version;
    }
    return result;
  }

  invalidate(): void {
    this.composition = undefined;
    this.shadowProjection = undefined;
    this.materialProgramProjection.clear();
    this.temporalCapture = undefined;
    this.terrainCandidate = [];
    this.terrainAccepted.clear();
    this.invalidateActiveEntityRevision();
    this.visibilityProjectionCache = undefined;
    this.stableSlotByEntity.clear();
    this.lastResyncReason = 'explicit-invalidate';
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
    const memo = this.gpuOwnedBySnapshot;
    return (snapshot) => {
      const draws = snapshot.gpuDrivenDraws;
      if (draws === undefined || draws.length === 0) return false;
      const cached = memo.get(snapshot);
      if (cached?.drawKeys === owned.drawKeys && cached.worldKeys === owned.worldKeys) {
        return cached.owned;
      }
      const worldEntity = worldEntityKey(
        owned.worldKeys?.[snapshot.worldId] ?? snapshot.worldId,
        snapshot.entityKey,
      );
      const fullyOwned = draws.every((draw, compactIndex) =>
        owned.drawKeys.has(
          gpuDrivenDrawKey(
            worldEntity,
            (snapshot.materials[draw.materialSlot] ?? snapshot.material).materialHandle ?? -1,
            gpuDrivenSourceDrawItemIndex(draw, compactIndex),
          ),
        ),
      );
      memo.set(snapshot, { ...owned, owned: fullyOwned });
      return fullyOwned;
    };
  }

  detach(world: World): void {
    this.materialSnapshotCaches.delete(world);
    const detachedComposition = this.composition?.worlds.includes(world)
      ? this.composition
      : undefined;
    if (detachedComposition !== undefined) {
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
    if (this.gpuOwner !== world && this.gpuOwner !== detachedComposition?.token) return;
    // The GPU Scene is renderer-owned. A frame graph recorded for the current
    // device may retain its table bindings after a World detaches, while the
    // next attached composition can rebuild the same tables in place. Keep
    // that single scene resident until device replacement or renderer
    // disposal; retiring it here lets a reused graph submit destroyed buffers.
    this.gpuOwner = undefined;
    this.gpuStatus = this.gpuScene === undefined ? 'inactive' : 'resident';
  }

  /** Drop only device-owned tables; the CPU projection remains the recovery authority. */
  resetGpuForRecover(): void {
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = this.options.getDevice === undefined ? 'inactive' : 'rebuild-pending';
  }

  /** Prepare a detached GPU scene without changing the active scene owner. */
  prepareRecoveryGpuDrivenCandidate(
    device: RhiDevice,
    palette: SkinPaletteAllocator | null = null,
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
      if (snapshot.skinPose === undefined) {
        if (snapshot.skin !== undefined) {
          throw new Error('Retained Skin requires CPU pose facts for device recovery.');
        }
        return { ...slot, snapshot };
      }
      if (palette === null) throw new Error('Skin recovery requires a replacement palette owner.');
      return {
        ...slot,
        snapshot: { ...snapshot, skin: prepareSkinPalette(snapshot.skinPose, palette) },
      };
    });
    const publishProjection = () => {
      composition.projection.reset(
        slots.map((slot) => slot.snapshot),
        false,
      );
      this.shadowProjection = undefined;
      this.materialProgramProjection.clear();
      this.temporalCapture = undefined;
      this.visibilityProjectionCache = undefined;
    };
    const created = GpuScene.create(
      device,
      Math.max(256, composition.projection.inspect().slotCapacity),
      this.options.shaderRegistry,
    );
    if (!created.ok) return created;
    const scene = created.value.status === 'available' ? created.value.scene : undefined;
    let state: PersistentGpuDrivenState | undefined;
    if (scene !== undefined) {
      const rebuilt = scene.sync(
        sceneSnapshotDelta(slots),
        undefined,
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
      state = Object.freeze({
        scene,
        plan: composition.topology.plan(),
        slots,
        slotAt: (slot: number) => slotsByIndex.get(slot),
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
        published = true;
        publishProjection();
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
          revision: composition.projection.inspect().revision,
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
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = 'inactive';
    this.composition = undefined;
    this.shadowProjection = undefined;
    this.materialProgramProjection.clear();
    this.temporalCapture = undefined;
    this.terrainCandidate = [];
    this.terrainAccepted.clear();
    this.invalidateActiveEntityRevision();
    this.visibilityProjectionCache = undefined;
    this.stableSlotByEntity.clear();
    this.pointsLinesInspections = [];
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
    const bounds = entry.projection.cullingWorldBoundsAt(slot);
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

  reflectionCaptureRevision(): string {
    return `${this.fullRebuilds}:${this.composition?.projection.contentRevision ?? 0}`;
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
      projectionRecords: entry?.projection.inspect().records.length ?? 0,
      ...(entry === undefined
        ? {}
        : { instanceBoundsCache: entry.projection.inspect().instanceBoundsCache }),
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
    const revision = entry.projection.contentRevision;
    const slots = entry.projection.slotsSnapshot();
    const sourceVersions = entry.readVersions.map((version) => ({ ...version }));
    const sourceLeases = [...entry.readLeases];
    const publicationRevision = entry.publicationRevision;
    return {
      identity: entry.token,
      revision,
      worlds: entry.worlds,
      slots,
      isCurrent: () => this.composition === entry && entry.projection.contentRevision === revision,
      isSourceCurrent: () => {
        if (this.composition !== entry) return false;
        try {
          return entry.worlds.every((world, index) => {
            if ('resolveAsset' in world) return world.revision === publicationRevision;
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
    const retained = this.compositionRetainedScene();
    return {
      ...(retained === undefined ? {} : { retained }),
      scene: this.gpuScene,
      plan: entry.topology.plan(),
      slots,
      slotAt: entry.projection.slotAt,
      slotForEntity: entry.projection.slot,
      worldKeys: entry.worldKeys,
      worldIdentities: entry.worlds.map((world) => world.identity),
      structureMetrics: {
        worldEntitiesScanned: this.worldEntitiesScanned,
        sceneTableUploadBytes: this.sceneTableUploadBytes,
        paletteUploadBytes: 0,
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
  prepareTemporalFrame(
    visible: readonly Pick<RenderableSnapshot, 'worldId' | 'entityKey'>[],
  ): void {
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
    _owner: { readonly cameraOwner: number; readonly resourceOwner: number },
    catalogEpoch: number,
    buildCandidateFrame: (request: PersistentRenderCandidateRequest) => ExtractedFrame,
    leases?: readonly RenderReadLease[],
    preserveVisibilityOnReorder = false,
  ): ExtractedFrame {
    const previousEntry = this.composition;
    const sourceStates = worlds.map((world) => createRenderSourceState(world));
    const candidateFrame = buildCandidateFrame({
      kind: 'partial',
      entitiesByWorld: sourceStates.map((source) => new Set(source.entities.values())),
    });
    for (const source of sourceStates) source.batch.validate();
    this.temporalCapture = undefined;
    this.worldEntitiesScanned = candidateFrame.renderables.length;
    const worldKeys = this.visibilityWorldKeysFor(worlds);
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
    const projection = previousEntry?.projection ?? new RenderScene();
    if (previousEntry !== undefined) {
      projection.remapWorlds(
        previousEntry.worlds.map((world) =>
          (worlds as readonly RenderResourceScope[]).indexOf(world),
        ),
      );
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
    this.options.instanceCollections?.retain(
      new Set(
        projection
          .slotsSnapshot()
          .flatMap((slot) =>
            slot.snapshot.instances?.collectionId === undefined
              ? []
              : [slot.snapshot.instances.collectionId],
          ),
      ),
    );
    this.stableSlotByEntity.clear();
    this.stableSlotRevision += 1;
    for (const slot of projection.slotsSnapshot()) {
      const stableWorld = worldKeys[slot.worldId] ?? slot.worldId;
      this.stableSlotByEntity.set(worldEntityKey(stableWorld, slot.entityKey), slot);
    }
    const transmissionDemand = new PersistentTransmissionDemandProjection();
    transmissionDemand.apply(transmissionDemandOperations(candidateFrame.renderables));
    const topology = previousEntry?.topology ?? new BatchTopology();
    topology.apply(delta);
    const skinConsumersByJoint = new Map<string, Set<number>>();
    for (const snapshot of stableCandidateFrame.renderables) {
      if (snapshot.skinJointEntities !== undefined) addSkinConsumer(skinConsumersByJoint, snapshot);
    }
    const token = previousEntry?.token ?? {};
    const entry: PersistentCompositionEntry = {
      token,
      worlds: [...worlds],
      projection,
      topology,
      transmissionDemand,
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
      dispatchBySlot: dispatchEntriesBySlot(stableCandidateFrame, projection),
      dispatchRevision: 0,
      dispatchCache: undefined,
      skinConsumersByJoint,
      pendingRenderableEntitiesByWorld: worlds.map(() => new Set<number>()),
      unavailableSlots: new Set<number>(),
      catalogEpoch,
      probeProjection: new ProbeBlendSceneProjection(),
      probeObjects: undefined,
      temporalDemanded: standardSceneTemporalDemand(
        candidateFrame.cameras[0],
        this.options.getTemporalConsumerDemand?.(),
      ),
    };
    this.composition = entry;
    projection.setTemporalTracking(entry.temporalDemanded);
    // The projection must be installed before deriving probe primitives.  On
    // the first composition rebuild `projectReflectionProbes` otherwise sees
    // no composition and silently drops every per-renderable selection,
    // leaving the producer on its neutral/no-demand path until an unrelated
    // later rebuild.
    this.projectReflectionProbes(candidateFrame.reflectionProbes ?? []);
    this.projectProbes(entry, candidateFrame);
    this.syncGpuOwner(token, projection, delta);
    if (previousEntry === undefined) this.fullRebuilds += 1;
    this.lastResyncReason = 'attach';
    const materialized = projection.materialize();
    const candidates = entry.temporalDemanded
      ? projection.materializeTemporal(this.temporalCounters)
      : materialized;
    const frameWithProbes = attachProbeRecords(
      { ...stableCandidateFrame, renderables: candidates },
      candidates,
      projection.slotsSnapshot(),
      entry.probeProjection,
      this.probeAttachMemo,
    );
    const terrainFrame = projectTerrainView(frameWithProbes, this.terrainAccepted);
    const ownedFrame = this.projectShadowOwnership(terrainFrame);
    const materialProgramProjection = this.materialProgramProjection;
    this.shadowProjection = {
      content: {
        owner: entry,
        sceneRevision: projection.revisionValue(),
        dispatchRevision: entry.dispatchRevision,
        terrainSections: ownedFrame.renderables.filter(
          (source) => source.terrainSection !== undefined,
        ),
      },
      renderables: ownedFrame.renderables,
      dispatch: ownedFrame.dispatch,
      get materialPrograms() {
        return materialProgramProjection.project(ownedFrame.dispatch);
      },
      worldBoundsOf: (source) => {
        const slot = projection.slot(source.worldId, source.entityKey);
        return source.terrainSection !== undefined
          ? worldBounds(source)
          : slot === undefined
            ? undefined
            : projection.cullingWorldBoundsAt(slot);
      },
    };
    const result = cullPersistentFrame(
      ownedFrame,
      ownedFrame.renderables,
      (snapshot) => {
        const slot = entry.projection.slot(snapshot.worldId, snapshot.entityKey);
        if (snapshot.terrainSection !== undefined) return worldBounds(snapshot);
        return slot === undefined
          ? projection.cullingWorldBounds(snapshot)
          : projection.cullingWorldBoundsAt(slot);
      },
      this.cullMemo,
      this.gpuCullBypass(token),
    );
    for (const source of sourceStates) source.batch.accept();
    this.terrainCandidate = result.renderables.filter(
      (source) => source.terrainSection !== undefined,
    );
    return result;
  }

  /** Internal topology fact; the renderer does not expose demand as public API. */
  transmissionTopologyDemand(): TransmissionDemand {
    return (
      this.composition?.transmissionDemand.inspect() ?? {
        activeCount: 0,
        needsRoughMips: false,
      }
    );
  }

  /**
   * Derive an ephemeral frame plan from persistent scene facts. The scene
   * retains identity/topology/read versions; no prior frame object is an authority.
   */
  private deriveFramePlan(
    entry: PersistentCompositionEntry,
    resourceFrame: ExtractedFrame,
  ): ExtractedFrame {
    const cachedDispatch = entry.dispatchCache;
    const dispatch =
      cachedDispatch?.revision === entry.dispatchRevision
        ? cachedDispatch.value
        : dispatchForProjection(entry.dispatchBySlot, entry.projection, entry.unavailableSlots);
    if (cachedDispatch?.revision !== entry.dispatchRevision) {
      entry.dispatchCache = { revision: entry.dispatchRevision, value: dispatch };
    }
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
      ? entry.projection.materializeTemporal(this.temporalCounters)
      : materialized;
    const drawableCandidates =
      entry.unavailableSlots.size === 0
        ? candidates
        : candidates.map((snapshot) => {
            const slot = entry.projection.slot(snapshot.worldId, snapshot.entityKey);
            return slot !== undefined && entry.unavailableSlots.has(slot.slot)
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
    const terrainFrame = projectTerrainView(frameWithProbes, this.terrainAccepted);
    const ownedFrame = this.projectShadowOwnership(terrainFrame);
    const resource = entry.worlds[0];
    const publicationRevision = entry.publicationRevision;
    const sceneRevision = entry.projection.revisionValue();
    const dispatchRevision = entry.dispatchRevision;
    const publicationSource: ShadowPublicationSource | undefined =
      resourceFrame.lights.directionalCsmConfig?.staggerCascades !== true ||
      publicationRevision === undefined ||
      resource === undefined ||
      !('resolveAsset' in resource)
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
              entry.dispatchRevision === dispatchRevision,
          };
    const materialProgramProjection = this.materialProgramProjection;
    this.shadowProjection = {
      content: {
        owner: entry,
        sceneRevision: entry.projection.revisionValue(),
        dispatchRevision: entry.dispatchRevision,
        ...(publicationSource === undefined ? {} : { publicationSource }),
        terrainSections: ownedFrame.renderables.filter(
          (source) => source.terrainSection !== undefined,
        ),
      },
      renderables: ownedFrame.renderables,
      dispatch: ownedFrame.dispatch,
      get materialPrograms() {
        return materialProgramProjection.project(ownedFrame.dispatch);
      },
      worldBoundsOf: (source) => {
        const slot = entry.projection.slot(source.worldId, source.entityKey);
        return source.terrainSection !== undefined
          ? worldBounds(source)
          : slot === undefined
            ? undefined
            : entry.projection.cullingWorldBoundsAt(slot);
      },
    };
    const result = cullPersistentFrame(
      ownedFrame,
      ownedFrame.renderables,
      (snapshot) => {
        const slot = entry.projection.slot(snapshot.worldId, snapshot.entityKey);
        if (snapshot.terrainSection !== undefined) return worldBounds(snapshot);
        return slot === undefined
          ? entry.projection.cullingWorldBounds(snapshot)
          : entry.projection.cullingWorldBoundsAt(slot);
      },
      this.cullMemo,
      this.gpuCullBypass(entry.token),
    );
    this.terrainCandidate = result.renderables.filter(
      (source) => source.terrainSection !== undefined,
    );
    return result;
  }

  private projectShadowOwnership(frame: ExtractedFrame): ExtractedFrame {
    const ownership = this.shadowOwnership.project(frame.renderables, frame.dispatch);
    return {
      ...frame,
      shadowCasterEntityKeys: ownership.entityKeys,
      shadowCasterDrawKeys: ownership.drawKeys,
      shadowCasterMembership: ownership.membership,
    };
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
    const surfaceOnly = probes.length === 0;
    const revision = entry.projection.revisionValue();
    if (
      entry.probeObjects?.revision !== revision ||
      entry.probeObjects.surfaceOnly !== surfaceOnly
    ) {
      const value: ProbeSceneObjectInput[] = [];
      for (const slot of entry.projection.slotsSnapshot()) {
        // Without local probes only medium surfaces consume sky-residual
        // records. Reject other slots before allocating their probe positions.
        if (
          surfaceOnly &&
          !slot.snapshot.materials.some(
            (material) => material.surfaceModel === 'single-layer-medium',
          )
        )
          continue;
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
      entry.probeObjects = { revision, surfaceOnly, value: Object.freeze(value) };
    }
    entry.probeProjection.apply({
      objects: entry.probeObjects.value,
      probes,
      sky,
      worldRevision: revision,
      ...(surfaceOnly ? { retainSkyResidualRecords: true } : {}),
    });
  }

  private syncGpuOwner(
    owner: object,
    projection: RenderScene,
    delta?: RenderSceneApplyResult,
  ): void {
    const acquired = this.acquireGpuScene(owner, projection);
    if (acquired === undefined) {
      this.sceneTableUploadBytes = 0;
      return;
    }
    if (acquired.rebuilt) {
      this.sceneTableUploadBytes = acquired.uploadBytes;
      return;
    }
    const result = acquired.scene.sync(
      delta ?? {
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
        sceneSnapshotDelta(slots),
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
      Math.max(256, projection.inspect().slotCapacity),
      this.options.shaderRegistry,
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
      sceneSnapshotDelta(slots),
      undefined,
      sceneSnapshotBounds(projection),
    );
    if (!rebuilt.ok) {
      scene.dispose();
      this.failGpu(rebuilt.error);
      return undefined;
    }
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
