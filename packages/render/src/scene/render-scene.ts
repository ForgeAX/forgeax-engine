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
import { box3, frustum } from '@forgeax/engine-math';
import {
  type MaterialCookRasterContext,
  materialProgramContextKey,
} from '@forgeax/engine-pack/material-cook';
import { type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import { ChildOf, Children, GlobalTransform, MorphWeights } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { err, type MeshAsset, ok, type Result } from '@forgeax/engine-types';
import { buildCameraFrusta } from '../camera-frusta';
import { Instances, Lines, Points, SpriteInstances, Visibility } from '../components';
import type { DeviceScope, LifecycleResourceSpec } from '../device/device-scope';
import { GlyphSources, projectGlyphView } from '../glyph-source';
import { captureBatchGeometry } from '../gpu-driven/batch-execution';
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
import { freezePreparedGpuDrivenDraw, ownGpuDrivenVertexInputs } from '../gpu-driven/prepared-draw';
import { GpuScene } from '../gpu-scene';
import type { GpuSceneSlotBounds } from '../gpu-scene-change-log';
import type {
  FrameCacheCounters,
  GpuDrivenStructureMetrics,
  PersistentRenderSceneInspection,
} from '../inspection-types';
import { type InstanceProjectionStore, uniqueInstanceIdentities } from '../instances';
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
  InstancesSnapshot,
  MaterialSnapshotCachesByWorld,
  RenderableReactiveReason,
  RenderableSnapshot,
  RenderableTemporalSnapshot,
} from '../render-system-extract';
import { materialSnapshotContext, resolveMaterialSnapshot } from '../render-system-extract';
import {
  expandDisplacementBounds,
  materialDisplacementRadius,
} from '../standard-displacement-bounds';
import { type SubsurfaceDemand, SubsurfaceSelection } from '../subsurface/selection';
import { prepareSkinPalette, type SkinPaletteAllocator } from '../systems/skin-palette-allocator';
import { standardSceneTemporalDemand } from '../temporal/standard-scene-data';
import type { TerrainLayers } from '../terrain/layers';
import { TerrainSourceCache } from '../terrain/source';
import { projectTerrainView, terrainSectionKey } from '../terrain/view.js';
import { projectTilemapView, TilemapSources } from '../tilemap-source';
import type { TransmissionDemand } from '../transmission/projection';
import { SceneAssetClosure } from './asset-closure';
import { type FrameList, FrameProjection } from './frame-list';
import { FrameSet } from './frame-set';
import { MaterialDispatch, type MaterialFrame } from './material-dispatch';
import { meshDrawSnapshot } from './mesh-draw';
import { MeshFrame, type MeshGeometry } from './mesh-frame';
import {
  effectiveMeshMaterials,
  type MeshMaterialGeometry,
  meshMaterialGeometry,
} from './mesh-materials';
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
import { SceneSlotFrame, SceneSlots } from './scene-slots';
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
  readonly worldBoundsOf: (source: RenderableSnapshot) => RenderSceneBounds | undefined;
  readonly renderables: FrameList<RenderableSnapshot>;
  readonly dispatch: DispatchList;
  /** Immediate preparation of actual draw work against this accepted material root. */
  readonly prepareDrawDispatch: (draws: readonly ValidatedRenderable[]) => DispatchList;
  readonly materialPrograms?: GpuDrivenMaterialProgramIndex;
}

const EMPTY_SLOT_FRAME = new SceneSlotFrame(undefined, 0, undefined);

function materialHasDisplacement(resource: MaterialResource, materials?: MaterialFrame): boolean {
  const material = materials === undefined ? resource.snapshot : materials.get(resource)?.snapshot;
  if (material === undefined) throw new Error('Temporal draw has no accepted material version');
  return (
    (material.paramSnapshot?.displacementScale ?? 0) !== 0 &&
    (material.textureSources?.has('displacementTexture') === true ||
      material.videoTextureFields?.has('displacementTexture') === true)
  );
}

function hasDisplacementSource(snapshot: RenderableSnapshot, materials?: MaterialFrame): boolean {
  if (snapshot.materials.length === 0) return materialHasDisplacement(snapshot.material, materials);
  for (const resource of snapshot.materials) {
    if (materialHasDisplacement(resource, materials)) return true;
  }
  return false;
}

interface CachedWorldBounds {
  readonly radius: number;
  readonly bounds: RenderSceneBounds | null;
}

interface TemporalMemo {
  readonly source: RenderableSnapshot;
  readonly submitted: RenderableSnapshot | undefined;
  readonly submittedGeneration: number | undefined;
  readonly wasVisible: boolean;
  readonly previousWorld: Float32Array | undefined;
  readonly displacementSource: boolean;
  readonly value: RenderableSnapshot;
}
type TemporalCache = WeakMap<RenderSceneSlot, TemporalMemo>;

function temporalDrawSnapshot(
  snapshot: RenderableSnapshot,
  counters: FrameCacheTally | undefined,
  current: SceneSlotFrame,
  submittedFrame: SceneSlotFrame,
  visible: ReadonlyMap<number, number>,
  materials: MaterialFrame | undefined,
  cache: TemporalCache,
): RenderableSnapshot {
  const slot = current.lookup(snapshot.worldId, snapshot.entityKey);
  if (slot === undefined) return snapshot;
  const submitted = submittedFrame.slotAt(slot.slot);
  const wasVisible =
    submitted?.generation === slot.generation && visible.get(slot.slot) === slot.generation;
  const previousWorld = submitted?.snapshot.transform.world;
  const displacementSource = hasDisplacementSource(snapshot, materials);
  const memo = cache.get(slot);
  if (
    memo !== undefined &&
    memo.source === snapshot &&
    memo.submitted === submitted?.snapshot &&
    memo.submittedGeneration === submitted?.generation &&
    memo.wasVisible === wasVisible &&
    memo.previousWorld === previousWorld &&
    memo.displacementSource === displacementSource
  ) {
    if (counters !== undefined) counters.hits += 1;
    return memo.value;
  }
  if (counters !== undefined) counters.misses += 1;
  const value = {
    ...snapshot,
    temporal: createTemporalSnapshot(slot, false, submittedFrame, visible, displacementSource),
  };
  cache.set(slot, {
    source: snapshot,
    submitted: submitted?.snapshot,
    submittedGeneration: submitted?.generation,
    wasVisible,
    previousWorld,
    displacementSource,
    value,
  });
  return value;
}

function createTemporalSnapshot(
  slot: RenderSceneSlot,
  resetHistory: boolean,
  submittedFrame: SceneSlotFrame,
  visible: ReadonlyMap<number, number>,
  displacementSource: boolean,
): RenderableTemporalSnapshot {
  const submitted = resetHistory ? undefined : submittedFrame.slotAt(slot.slot);
  const sameGeneration = submitted?.generation === slot.generation;
  const wasVisible = sameGeneration && visible.get(slot.slot) === slot.generation;
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
  if (displacementSource) reasons.push('displacement-source');
  const seedCurrent =
    !sameGeneration ||
    !wasVisible ||
    reasons.includes('geometry-revision') ||
    reasons.includes('material-revision') ||
    reasons.includes('displacement-source');
  const previous = seedCurrent || submitted === undefined ? slot.snapshot : submitted.snapshot;
  const previousWorld = submitted?.snapshot.transform.world;
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

function identityKey(worldId: number, entityKey: number): string {
  return `${worldId}:${entityKey}`;
}

function projectDrawDispatch(
  draws: readonly ValidatedRenderable[],
  materials: import('./material-dispatch').MaterialFrame,
): DispatchList {
  return materials.project(
    draws.map((draw) => {
      return {
        source: draw.source,
        renderableIndex: draw.renderableIndex,
        materials: [...(draw.submeshIndices ?? draw.mesh.submeshes.keys())].map((index) => {
          const submesh = draw.mesh.submeshes[index];
          if (submesh === undefined) throw new Error('Direct draw has no selected submesh');
          return draw.source.materials[submesh.materialSlot] ?? draw.source.material;
        }),
      };
    }),
  );
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
          gpuDrivenDraws: snapshot.gpuDrivenDraws.map((draw) => ({
            ...draw,
            geometry: captureBatchGeometry(draw.geometry),
            ...(draw.prepared === undefined
              ? {}
              : {
                  prepared: freezePreparedGpuDrivenDraw({
                    ...draw.prepared,
                    identity: Object.freeze({ ...draw.prepared.identity }),
                    vertexInputs: ownGpuDrivenVertexInputs(draw.prepared.vertexInputs),
                  }),
                }),
          })),
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
  local = snapshot.localAabb,
): RenderSceneBounds | undefined {
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
  adoptMesh(worldId: number, handle: number, mesh: MeshAsset | undefined): void {
    if (!this.meshHolders.has(identityKey(worldId, handle))) return;
    this.meshes =
      mesh === undefined
        ? this.meshes.without(worldId, handle)
        : this.meshes.with(worldId, handle, mesh);
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
  private readonly slots = new SceneSlots();
  private lastSubmittedFrame = new SceneSlotFrame(undefined, 0, undefined);
  private readonly generations: number[] = [];
  private readonly freeSlots: number[] = [];
  private readonly dirtySinceSubmitted = new Set<number>();
  private temporalTracking = false;
  private lastSubmittedVisible: ReadonlyMap<number, number> = new Map();
  private submittedEpoch = 0;
  // Neither a live record nor a cold cache retains an obsolete Mesh version.
  private readonly meshWorldBounds = new WeakMap<
    MeshGeometry,
    WeakMap<RenderSceneSlot, CachedWorldBounds>
  >();
  private readonly sourceWorldBounds = new WeakMap<RenderSceneSlot, CachedWorldBounds>();
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
        value: new FrameProjection(current, (record) => meshDrawSnapshot(record.snapshot, meshes)),
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
    return (slot) => {
      const record = current.slotAt(slot);
      if (record === undefined) return undefined;
      const source = meshDrawSnapshot(record.snapshot, meshes);
      return temporal
        ? temporalDrawSnapshot(source, counters, current, submitted, visible, materials, memo)
        : source;
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
      previous.meshes === meshes
    )
      return previous.value;
    const memo = this.temporalBySlot;
    const value = new FrameProjection(current, (record) =>
      temporalDrawSnapshot(
        meshDrawSnapshot(record.snapshot, meshes),
        counters,
        current,
        submitted,
        visible,
        materials,
        memo,
      ),
    );
    this.temporalMaterialized = { current, submitted, visible, materials, meshes, value };
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
    displacementSource = hasDisplacementSource(meshDrawSnapshot(slot.snapshot, this.meshes)),
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
    let radius = 0;
    const effective =
      geometry === undefined
        ? snapshot
        : effectiveMeshMaterials(snapshot, geometry, meshMaterialGeometry(snapshot));
    for (const resource of effective.materials.length > 0
      ? effective.materials
      : [effective.material]) {
      const material =
        materials === undefined ? resource.snapshot : materials.get(resource)?.snapshot;
      if (material === undefined) throw new Error('Culling requires a fixed material version');
      radius = Math.max(radius, materialDisplacementRadius(material));
    }
    let bounds =
      geometry === undefined ? this.sourceWorldBounds : this.meshWorldBounds.get(geometry);
    if (bounds === undefined) {
      bounds = new WeakMap();
      // Only the geometry-present branch can be missing its cache.
      if (geometry !== undefined) this.meshWorldBounds.set(geometry, bounds);
    }
    const cached = bounds.get(slot);
    if (cached !== undefined && cached.radius === radius) return cached.bounds ?? undefined;
    let candidate: RenderSceneBounds | undefined;
    let local =
      geometry === undefined ||
      snapshot.skinPose !== undefined ||
      snapshot.morph !== undefined ||
      snapshot.terrainSection !== undefined
        ? snapshot.localAabb
        : expandDisplacementBounds(geometry.bounds, radius);
    if (snapshot.skinPose !== undefined && radius > 0) local = undefined;
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
    bounds.set(slot, { radius, bounds: candidate ?? null });
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
  readonly skinConsumersByJoint: Map<string, Set<number>>;
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
  readonly dispatchRemapping: WeakMap<DispatchEntry, DispatchEntry>;
}

/** Draw keys the GPU-driven raster owned last primary frame, in its world-key space. */
export interface GpuRasterOwnership {
  readonly selection: GpuDrawSelection;
}

function cullPersistentFrame(
  frame: ExtractedFrame,
  materials: import('./material-dispatch').MaterialFrame,
  boundsOf: (snapshot: RenderableSnapshot, index: number) => RenderSceneBounds | undefined = (
    snapshot,
  ) => worldBounds(snapshot),
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
  let casterIndices: Set<number> | undefined;
  let shadowFrusta: ReturnType<typeof buildShadowFrusta> | undefined;
  const shadowOnly = new Set<number>();
  const hidden = new Set<number>();
  const hiddenSections = new Map<number, Set<number>>();
  const cameraVisible = (source: RenderableSnapshot) => {
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
  const frustumStats = { culled, total };
  sourceSubsurface.adopt(materials);
  authorSubsurface.adopt(materials);
  const sameVisibility =
    previous !== undefined &&
    sameProjection &&
    previous.shadowOnly.size === shadowOnly.size &&
    previous.renderables.length === visibleCount &&
    visible === undefined;
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
  const dispatch: DispatchEntry[] = [];
  const dispatchRemapping =
    previous?.dispatchRemapping ?? new WeakMap<DispatchEntry, DispatchEntry>();
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
      let mapped = dispatchRemapping.get(entry);
      if (mapped?.renderableIndex !== renderableIndex) {
        mapped = { ...entry, renderableIndex };
        dispatchRemapping.set(entry, mapped);
      }
      dispatch.push(mapped);
    }
  }
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
  previous:
    | {
        readonly candidates: FrameList<RenderableSnapshot>;
        readonly slots: SceneSlotFrame;
        readonly records: ProbeBlendBufferProjection;
        readonly value: FrameList<RenderableSnapshot>;
      }
    | undefined;
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

function attachProbeRecord(
  candidate: RenderableSnapshot,
  record: RenderableSnapshot['probeBlendRecord'],
  memo: ProbeAttachMemo['bySnapshot'],
): RenderableSnapshot {
  if (record === undefined) return candidate;
  const cached = memo.get(candidate);
  if (cached?.record === record) return cached.value;
  const value = { ...candidate, probeBlendRecord: record };
  memo.set(candidate, { record, value });
  return value;
}

function attachProbeRecords(
  frame: ExtractedFrame,
  candidates: FrameList<RenderableSnapshot>,
  slots: SceneSlotFrame,
  projection: ProbeBlendSceneProjection,
  memo: ProbeAttachMemo,
): ExtractedFrame {
  if (!projection.hasRecords()) {
    memo.previous = undefined;
    return frame.renderables === candidates ? frame : { ...frame, renderables: candidates };
  }
  const records = projection.recordBufferProjection();
  const previous = memo.previous;
  if (
    previous?.candidates === candidates &&
    previous.slots === slots &&
    previous.records === records
  )
    return { ...frame, renderables: previous.value };
  const probeAt = projection.captureRecordLookup();
  const attachments = memo.bySnapshot;
  const value = new FrameProjection(candidates, (candidate) => {
    const slot = slots.lookup(candidate.worldId, candidate.entityKey);
    return attachProbeRecord(
      candidate,
      slot === undefined ? undefined : probeAt(slot.slot),
      attachments,
    );
  });
  memo.previous = { candidates, slots, records, value };
  return { ...frame, renderables: value };
}

const EMPTY_MATERIAL_UPDATES: readonly MaterialResource[] = Object.freeze([]);

/** Persistent scene projection used by the renderer's multi-World composition path. */
export class PersistentRenderScene {
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
        if (change.removed || (mesh?.ok && mesh.value.kind === 'mesh'))
          this.composition?.projection.adoptMesh(
            worldId,
            change.handle,
            mesh?.ok ? mesh.value : undefined,
          );
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

  constructor(private readonly options: PersistentRenderSceneOptions = {}) {}

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
        skinConsumersByJoint: new Map(),
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
      if (change.removed || (mesh?.ok && mesh.value.kind === 'mesh'))
        entry.projection.adoptMesh(0, change.handle, mesh?.ok ? mesh.value : undefined);
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
    const delta = entry.projection.apply(input.operations);
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
      const contentComponents = source.renderableComponents.filter(
        (component) => component !== Instances && batch.changedComponents.includes(component),
      );
      const instancesChanged = batch.changedComponents.includes(Instances);
      const reconcileIdentities =
        batch.membershipChanged || contentComponents.length > 0 || instancesChanged;
      for (const index of reconcileIdentities ? batch.indices : []) {
        const previous = source.entities.get(index);
        const current = source.projection.entity(index);
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
      const replacedSkinSnapshots: RenderableSnapshot[] = [];
      for (let worldId = 0; worldId < changedEntitiesByWorld.length; worldId += 1) {
        for (const entityKey of changedEntitiesByWorld[worldId] ?? []) {
          const slot = entry.projection.slot(worldId, entityKey);
          if (slot !== undefined) replacedSkinSnapshots.push(slot.snapshot);
        }
      }
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
      if (partial !== undefined || removedSlots.length > 0) {
      }
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
    const result = this.deriveFramePlan(entry, resourceFrame, changedDelta, materialUpdates);
    for (let worldId = 0; worldId < sourceBatches.length; worldId++) {
      const batch = sourceBatches[worldId];
      const source = entry.sourceStates[worldId];
      if (batch === undefined || source === undefined) continue;
      batch.accept();
      if (!batch.membershipChanged) continue;
      for (const index of batch.indices) {
        const entity = source.projection.entity(index);
        if (entity === undefined) source.entities.delete(index);
        else source.entities.set(index, entity);
      }
    }
    entry.readLeases = [...leases];
    for (let worldId = 0; worldId < nextReadVersions.length; worldId += 1) {
      const version = nextReadVersions[worldId];
      if (version !== undefined) entry.readVersions[worldId] = version;
    }
    return result;
  }

  invalidate(): void {
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
      Math.max(256, composition.projection.slotCapacity),
      this.options.shaderRegistry,
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
    for (const observer of this.assetObservers.values()) observer.dispose();
    this.assetObservers.clear();
    this.retireGpuScene(this.gpuScene);
    this.gpuScene = undefined;
    this.gpuOwner = undefined;
    this.gpuDevice = undefined;
    this.gpuStatus = 'inactive';
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
      entitiesByWorld: sourceStates.map((source) => new Set(source.entities.values())),
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
    const skinConsumersByJoint = new Map<string, Set<number>>();
    for (const snapshot of stableCandidateFrame.renderables) {
      if (snapshot.skinJointEntities !== undefined) addSkinConsumer(skinConsumersByJoint, snapshot);
    }
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
      skinConsumersByJoint,
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
    const { frame: result, subsurface } = cullPersistentFrame(
      ownedFrame,
      materialFrame,
      (snapshot) => {
        const slot = entry.projection.slot(snapshot.worldId, snapshot.entityKey);
        if (snapshot.terrainSection !== undefined || snapshot.generatedMesh !== undefined)
          return worldBounds(snapshot);
        return slot === undefined
          ? projection.cullingWorldBounds(snapshot)
          : projection.cullingWorldBoundsAt(slot, meshFrame, materialFrame);
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
      worldBoundsOf: (source) => {
        const slot = shadowSlots.lookup(source.worldId, source.entityKey);
        return source.terrainSection !== undefined || source.generatedMesh !== undefined
          ? worldBounds(source)
          : slot === undefined
            ? undefined
            : projection.cullingWorldBoundsAt(slot, meshFrame, materialFrame);
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
        )
      : materialized;
    const acceptedSlots = entry.projection.slotsSnapshot();
    const unavailable = entry.unavailableSlots;
    const drawableCandidates =
      unavailable.size === 0
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
    const { frame: result, subsurface } = cullPersistentFrame(
      ownedFrame,
      materialFrame,
      (snapshot) => {
        const slot = entry.projection.slot(snapshot.worldId, snapshot.entityKey);
        if (snapshot.terrainSection !== undefined || snapshot.generatedMesh !== undefined)
          return worldBounds(snapshot);
        return slot === undefined
          ? entry.projection.cullingWorldBounds(snapshot)
          : entry.projection.cullingWorldBoundsAt(slot, meshFrame, materialFrame);
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
      worldBoundsOf: (source) => {
        const slot = shadowSlots.lookup(source.worldId, source.entityKey);
        return source.terrainSection !== undefined || source.generatedMesh !== undefined
          ? worldBounds(source)
          : slot === undefined
            ? undefined
            : entry.projection.cullingWorldBoundsAt(slot, meshFrame, materialFrame);
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
