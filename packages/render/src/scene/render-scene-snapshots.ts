import type { box3 } from '@forgeax/engine-math';
import { captureBatchGeometry } from '../gpu-driven/batch-execution';
import { freezePreparedGpuDrivenDraw, ownGpuDrivenVertexInputs } from '../gpu-driven/prepared-draw';
import { sealSourceDraws } from '../gpu-driven/source-draw-indices';
import {
  captureInstanceGenerations,
  type InstanceOrdinalOrder,
  survivingInstanceOrdinals,
} from '../instance-generations';
import { type MaterialResource, materialHasTemporalDisplacement } from '../material-resource';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type {
  InstancesSnapshot,
  RenderableReactiveReason,
  RenderableSnapshot,
  RenderableTemporalSnapshot,
} from '../render-system-extract';
import { materialDisplacementRadius } from '../standard-displacement-bounds';
import { CapturedSceneTransform, type ScenePoseWriter } from './captured-transform';
import { FrameSet } from './frame-set';
import type { GenerationalWeakMap } from './generational-weak-map';
import type { MaterialFrame } from './material-dispatch';
import {
  drawPoseStorage,
  meshDrawSnapshot,
  SceneDrawSlot,
  slotContent,
  slotTransform,
} from './mesh-draw';
import type { MeshFrame, MeshGeometry } from './mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from './mesh-materials';
import type { GpuSceneMotion, RenderSceneBounds, RenderSceneSlot } from './render-scene-types';
import type { RowContent } from './row-contents';
import type { SceneSlotFrame } from './scene-slots';
import { sharedAabb } from './shared-aabb';

/** Mutable accumulator behind a readonly `FrameCacheCounters` inspection. */
export interface FrameCacheTally {
  hits: number;
  misses: number;
}

export function writeBounds(bounds: RenderSceneBounds | undefined, out: box3.Box3): boolean {
  if (bounds === undefined) return false;
  out[0] = bounds.min[0];
  out[1] = bounds.min[1];
  out[2] = bounds.min[2];
  out[3] = bounds.max[0];
  out[4] = bounds.max[1];
  out[5] = bounds.max[2];
  return true;
}

export function cullingDisplacementRadius(
  snapshot: RowContent,
  geometry: MeshGeometry | undefined,
  materials: MaterialFrame | undefined,
  requirePositionProof = false,
): number {
  return boundDisplacementRadius(
    cullingMaterialBinding(snapshot, geometry),
    materials,
    requirePositionProof,
  );
}

export function cullingMaterialBinding(snapshot: RowContent, geometry: MeshGeometry | undefined) {
  return geometry === undefined || snapshot.materialOverrides === undefined
    ? snapshot
    : effectiveMeshMaterials(snapshot, geometry, meshMaterialGeometry(snapshot));
}

export function boundDisplacementRadius(
  effective: Pick<RowContent, 'materials' | 'material'>,
  materials: MaterialFrame | undefined,
  requirePositionProof = false,
): number {
  let radius = 0;
  for (let index = 0; index < Math.max(1, effective.materials.length); index++) {
    const resource = effective.materials[index] ?? effective.material;
    const material =
      materials === undefined ? resource.snapshot : materials.get(resource)?.snapshot;
    if (material === undefined) throw new Error('Culling requires a fixed material version');
    if (requirePositionProof && material.positionBounds !== 'standard-input') return Infinity;
    radius = Math.max(radius, materialDisplacementRadius(material));
  }
  return radius;
}

function materialHasDisplacement(resource: MaterialResource, materials?: MaterialFrame): boolean {
  const material = materials === undefined ? resource.snapshot : materials.get(resource)?.snapshot;
  if (material === undefined) throw new Error('Temporal draw has no accepted material version');
  return materialHasTemporalDisplacement(material);
}

/** Consume the actual material slots. Borrowed material values can change in place. */
export function hasDisplacementSource(
  snapshot: Pick<RenderableSnapshot, 'material' | 'materials'>,
  materials?: MaterialFrame,
): boolean {
  const slots = snapshot.materials;
  if (slots.length === 0) return materialHasDisplacement(snapshot.material, materials);
  for (let index = 0; index < slots.length; index++) {
    if (materialHasDisplacement(slots[index] as MaterialResource, materials)) return true;
  }
  return false;
}

export interface CachedWorldBounds {
  /** Ordinal of the Mesh version that proved the bounds; 0 without geometry. */
  readonly version: number;
  readonly radius: number;
  readonly bounds: RenderSceneBounds | null;
  /** Fixed material frame that proved `radius`; the same frame proves it again. */
  materials?: MaterialFrame | undefined;
}

interface TemporalMemo {
  readonly source: RowContent;
  readonly submitted: RenderableSnapshot | RenderableSnapshot['transform'] | undefined;
  readonly submittedGeneration: number | undefined;
  readonly wasVisible: boolean;
  readonly displacementSource: boolean;
  readonly value: RenderableSnapshot;
}
// Slots and their snapshots are replaced every frame; see GenerationalWeakMap.
export type TemporalCache = GenerationalWeakMap<RenderSceneSlot, TemporalMemo>;

/** Native view selections retain their fixed addresses. Borrowed iterables
 * record each generation at its public read, including reentrant Scene writes. */
export type SubmittedVisibility = FrameSet | ReadonlyMap<number, number>;

/** One accepted Scene root with the actual visible selection. A later submission
 * replaces the root without retaining its predecessor. Independent readers pin
 * their own roots and compare them through the Scene's bounded change journal. */
export class SubmittedHistory {
  /** No submitted frame since the last temporal cut: every row is new. */
  static cut(): SubmittedHistory {
    return new SubmittedHistory();
  }

  static submitted(
    frame: SceneSlotFrame,
    visible?: SubmittedVisibility,
    previous?: SubmittedHistory,
  ): SubmittedHistory {
    return previous?.frame === frame && previous.visible === visible
      ? previous
      : new SubmittedHistory(frame, visible);
  }

  private constructor(
    private readonly frame?: SceneSlotFrame,
    private readonly visible?: SubmittedVisibility,
  ) {}

  /** Compare the two submitted roots and their visibility evidence. */
  changesSince(before: SubmittedHistory, visit: (slot: number) => void): boolean {
    if (before === this) return true;
    const current = this.frame;
    const previous = before.frame;
    if (current === undefined || previous === undefined) return false;
    const visible = this.visible;
    const oldVisible = before.visible;
    const compareSelection = visible instanceof FrameSet && oldVisible instanceof FrameSet;
    if (visible !== oldVisible && !compareSelection) return false;
    if (current !== previous && !current.changesSince(previous, visit)) return false;
    if (compareSelection && visible !== oldVisible) visible.changesSince(oldVisible, visit);
    return true;
  }

  at(slot: number): RenderSceneSlot | undefined {
    return this.frame?.slotAt(slot);
  }

  before(row: RenderSceneSlot): RenderSceneSlot | undefined {
    return this.at(row.slot);
  }

  admitted(submitted: RenderSceneSlot): boolean {
    return (
      this.frame !== undefined &&
      (this.visible === undefined ||
        (this.visible instanceof FrameSet
          ? this.visible.has(submitted.slot)
          : this.visible.get(submitted.slot) === submitted.generation))
    );
  }

  gpuMotionAt(
    slot: number,
    generation: number,
    current: RowContent,
    displacement: boolean,
    into: GpuSceneMotion,
  ): GpuSceneMotion {
    const previous = this.frame?.contentAt(slot);
    const seed =
      !this.wasVisible(slot, generation) ||
      this.frame?.generationAt(slot) !== generation ||
      previous?.assetHandle !== current.assetHandle ||
      previous?.materials !== current.materials ||
      displacement;
    writeMotion(current, previous, seed, into, true);
    return into;
  }

  wasVisible(slot: number, generation: number): boolean {
    if (this.frame === undefined) return false;
    if (this.visible instanceof FrameSet && !this.visible.has(slot)) return false;
    return this.visible === undefined || this.visible instanceof FrameSet
      ? this.frame.generationAt(slot) === generation
      : this.visible.get(slot) === generation;
  }
}

export function temporalDrawSnapshot(
  slot: RenderSceneSlot,
  meshes: MeshFrame,
  counters: FrameCacheTally | undefined,
  history: SubmittedHistory,
  materials: MaterialFrame | undefined,
  cache: TemporalCache,
): RenderableSnapshot {
  const native = slot instanceof SceneDrawSlot;
  const source = native ? slot.drawContent(meshes) : meshDrawSnapshot(slot.snapshot, meshes);
  // Hidden authored rows keep their source identity but own no accepted draw materials.
  if (source.authorVisible === false)
    return native ? slot.draw(meshes) : (source as RenderableSnapshot);
  const submitted = history.before(slot);
  const wasVisible = submitted?.generation === slot.generation && history.admitted(submitted);
  // The pose wrapper is unique to an issued native row. A memo must not keep
  // the previous row key alive and thereby chain its earlier submission history.
  const submittedSource =
    submitted instanceof SceneDrawSlot ? submitted.transform : submitted?.snapshot;
  const displacementSource = hasDisplacementSource(source, materials);
  const memo = cache.get(slot);
  if (
    memo !== undefined &&
    memo.source === source &&
    memo.submitted === submittedSource &&
    memo.submittedGeneration === submitted?.generation &&
    memo.wasVisible === wasVisible &&
    memo.displacementSource === displacementSource
  ) {
    if (counters !== undefined) counters.hits += 1;
    return memo.value;
  }
  if (counters !== undefined) counters.misses += 1;
  const temporal = createTemporalSnapshot(slot, submitted, wasVisible, displacementSource);
  // Bound geometry is shared by pose versions. Only the final temporal reader needs a draw row.
  const value: RenderableSnapshot = native
    ? { ...source, entityKey: slot.entityKey, transform: slot.transform, temporal }
    : { ...(source as RenderableSnapshot), temporal };
  cache.set(slot, {
    source,
    submitted: submittedSource,
    submittedGeneration: submitted?.generation,
    wasVisible,
    displacementSource,
    value,
  });
  return value;
}

const NO_REACTIVE_REASONS: readonly RenderableReactiveReason[] = Object.freeze([]);

function compatibleInstanceOrder(
  current: InstancesSnapshot | undefined,
  previous: InstancesSnapshot | undefined,
): InstanceOrdinalOrder | undefined {
  if (
    current === undefined ||
    previous === undefined ||
    (current.collectionId !== undefined &&
      previous.collectionId !== undefined &&
      current.collectionId !== previous.collectionId) ||
    current.transforms.length < current.instanceCount * 16 ||
    previous.transforms.length < previous.instanceCount * 16 ||
    current.generations?.length !== current.instanceCount ||
    previous.generations?.length !== previous.instanceCount
  )
    return undefined;
  return survivingInstanceOrdinals(current.generations, previous.generations);
}

export function createTemporalSnapshot(
  slot: RenderSceneSlot,
  submitted: RenderSceneSlot | undefined,
  wasVisible: boolean,
  displacementSource: boolean,
): RenderableTemporalSnapshot;
export function createTemporalSnapshot(
  slot: RenderSceneSlot,
  submitted: RenderSceneSlot | undefined,
  wasVisible: boolean,
  displacementSource: boolean,
  into: GpuSceneMotion,
): GpuSceneMotion;
export function createTemporalSnapshot(
  slot: RenderSceneSlot,
  submitted: RenderSceneSlot | undefined,
  wasVisible: boolean,
  displacementSource: boolean,
  into?: GpuSceneMotion,
): RenderableTemporalSnapshot | GpuSceneMotion {
  const sameGeneration = submitted?.generation === slot.generation;
  const current = slotContent(slot);
  const previous = submitted === undefined ? undefined : slotContent(submitted);
  const geometryChanged = sameGeneration && previous?.assetHandle !== current.assetHandle;
  const materialsChanged = sameGeneration && previous?.materials !== current.materials;
  // Displacement bytes can change independently of the material version.
  const seedCurrent =
    !sameGeneration || !wasVisible || geometryChanged || materialsChanged || displacementSource;
  if (into !== undefined) {
    writeMotion(current, previous, seedCurrent, into, true);
    return into;
  }
  const priorTransform =
    seedCurrent || submitted === undefined ? undefined : slotTransform(submitted);
  let reactiveReasons = NO_REACTIVE_REASONS;
  if (seedCurrent) {
    const reasons: RenderableReactiveReason[] = [];
    if (!sameGeneration) reasons.push(submitted === undefined ? 'new-slot' : 'generation-reuse');
    else if (!wasVisible) reasons.push('reentered');
    if (geometryChanged) reasons.push('geometry-revision');
    if (materialsChanged) reasons.push('material-revision');
    if (displacementSource) reasons.push('displacement-source');
    reactiveReasons = reasons;
  }
  const result = {
    previousSource: seedCurrent ? ('current-seed' as const) : ('last-submitted' as const),
    motionValid: false,
    reactive: seedCurrent,
    reactiveReasons,
    previousTransform:
      seedCurrent || priorTransform === undefined
        ? slotTransform(slot)
        : submitted instanceof SceneDrawSlot
          ? priorTransform
          : { ...priorTransform, world: priorTransform.world },
    // A collection identity/count break is a temporal cut for that
    // renderable. The record stage receives the current snapshot as its
    // baseline, while stable collections retain the submitted column and
    // use identity generations to map reordered entries and seed replaced
    // entries.
    previousInstances: undefined as RenderableTemporalSnapshot['previousInstances'],
  };
  writeMotion(current, previous, seedCurrent, result, false);
  return result;
}

function writeMotion(
  current: RowContent,
  previous: RowContent | undefined,
  seedCurrent: boolean,
  into: GpuSceneMotion,
  retainInstanceOrder: boolean,
): void {
  const currentInstances = current.instances;
  const submittedInstances = previous?.instances;
  // A collection-owned column is retained by reference and the projection
  // store recycles it two revisions later; a submission that lags further
  // (failed or skipped submit) is a temporal cut, never a stale read.
  const submittedRecycled =
    currentInstances?.collectionId !== undefined &&
    submittedInstances?.collectionId === currentInstances.collectionId &&
    submittedInstances.transforms !== currentInstances.transforms &&
    (currentInstances.revision ?? 0) - (submittedInstances.revision ?? 0) > 1;
  const instanceOrder =
    seedCurrent || submittedRecycled
      ? undefined
      : compatibleInstanceOrder(currentInstances, submittedInstances);
  const motionValid =
    !seedCurrent &&
    previous !== undefined &&
    (instanceOrder !== undefined ||
      (currentInstances === undefined && submittedInstances === undefined));
  const previousInstances =
    seedCurrent || submittedRecycled ? currentInstances : submittedInstances;
  into.motionValid = motionValid;
  into.reactive = seedCurrent;
  into.previousInstances = previousInstances;
  if (retainInstanceOrder) {
    into.instanceOrder = instanceOrder;
    into.instanceOrderGenerations =
      instanceOrder === undefined ? undefined : currentInstances?.generations;
  }
}

/**
 * Collection-owned columns come from the renderer's `InstanceProjectionStore`,
 * which never mutates an accepted revision until two newer revisions were
 * projected; RenderScene is its single retaining consumer and only reads the
 * submitted revision while it is exactly one behind (see `temporalSnapshot`).
 * Retaining them by reference keeps a one-row move O(1). Borrowed columns
 * without a collection identity are still copied.
 */
export function ownInstances(instances: InstancesSnapshot): InstancesSnapshot {
  if (instances.collectionId !== undefined) return instances;
  return {
    ...instances,
    transforms: new Float32Array(instances.transforms),
    ...(instances.generations === undefined
      ? {}
      : { generations: captureInstanceGenerations(instances.generations) }),
  };
}

// Owned draw tables of frozen (shared) sources are themselves shared: rows of
// one template retain one table instead of one deep copy per row.
const ownedDrawTables = new WeakMap<
  NonNullable<RenderableSnapshot['gpuDrivenDraws']>,
  NonNullable<RenderableSnapshot['gpuDrivenDraws']>
>();

function ownGpuDrivenDraws(
  draws: NonNullable<RenderableSnapshot['gpuDrivenDraws']>,
): NonNullable<RenderableSnapshot['gpuDrivenDraws']> {
  const prior = ownedDrawTables.get(draws);
  if (prior !== undefined) return prior;
  const shared = Object.isFrozen(draws) && draws.every((draw) => Object.isFrozen(draw));
  const owned = draws.map((draw) => ({
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
  }));
  const sealed = sealSourceDraws(owned);
  if (shared) ownedDrawTables.set(draws, sealed);
  return sealed;
}

export function ownSnapshot(
  snapshot: RenderableSnapshot,
  poses: ScenePoseWriter,
): RenderableSnapshot {
  const pose = CapturedSceneTransform.storage(snapshot.transform);
  const { temporal: _temporal, skinBinding: sourceBinding, ...current } = snapshot;
  let skinBinding: RenderableSnapshot['skinBinding'];
  if (sourceBinding !== undefined) {
    const { skeleton, joints } = sourceBinding;
    skinBinding = Object.freeze({
      skeleton,
      ...(sourceBinding.affinePoint ? { affinePoint: true } : {}),
      joints: Object.freeze([...joints]),
    });
  }
  return {
    ...current,
    ...(snapshot.gpuDrivenDraws === undefined
      ? {}
      : { gpuDrivenDraws: ownGpuDrivenDraws(snapshot.gpuDrivenDraws) }),
    transform: pose instanceof CapturedSceneTransform ? pose.retain() : poses.capture(pose),
    ...(snapshot.localAabb === undefined ? {} : { localAabb: sharedAabb(snapshot.localAabb) }),
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
    ...(skinBinding === undefined ? {} : { skinBinding }),
  };
}

export function ownPointsLinesSnapshot(
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

const detachedBox = new Float64Array(6);

export function worldBounds(snapshot: RenderableSnapshot): RenderSceneBounds | undefined {
  if (!writeSnapshotWorldBounds(detachedBox, snapshot)) return undefined;
  return {
    min: [detachedBox[0] as number, detachedBox[1] as number, detachedBox[2] as number],
    max: [detachedBox[3] as number, detachedBox[4] as number, detachedBox[5] as number],
  };
}

export function writeSnapshotWorldBounds(
  out: { [lane: number]: number },
  snapshot: Pick<RenderableSnapshot, 'localAabb' | 'transform'>,
): boolean {
  const local = snapshot.localAabb;
  const pose = drawPoseStorage(snapshot);
  return writeTransformedWorldBounds(
    out,
    local,
    CapturedSceneTransform.column(pose),
    CapturedSceneTransform.offset(pose),
  );
}

/** Read the addressed matrix and local extents once and write all six world coordinates. */
export function writeTransformedWorldBounds(
  out: { [lane: number]: number },
  local: RowContent['localAabb'],
  world: Float32Array,
  offset = 0,
): boolean {
  if (local === undefined || local.length < 6) return false;
  const xx = world[offset] ?? 0;
  const xy = world[offset + 1] ?? 0;
  const xz = world[offset + 2] ?? 0;
  const yx = world[offset + 4] ?? 0;
  const yy = world[offset + 5] ?? 0;
  const yz = world[offset + 6] ?? 0;
  const zx = world[offset + 8] ?? 0;
  const zy = world[offset + 9] ?? 0;
  const zz = world[offset + 10] ?? 0;
  const minX = local[0] ?? 0;
  const minY = local[1] ?? 0;
  const minZ = local[2] ?? 0;
  const maxX = local[3] ?? 0;
  const maxY = local[4] ?? 0;
  const maxZ = local[5] ?? 0;
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const extentX = (maxX - minX) * 0.5;
  const extentY = (maxY - minY) * 0.5;
  const extentZ = (maxZ - minZ) * 0.5;
  const worldCenterX = xx * centerX + yx * centerY + zx * centerZ + (world[offset + 12] ?? 0);
  const worldCenterY = xy * centerX + yy * centerY + zy * centerZ + (world[offset + 13] ?? 0);
  const worldCenterZ = xz * centerX + yz * centerY + zz * centerZ + (world[offset + 14] ?? 0);
  const worldExtentX = Math.abs(xx) * extentX + Math.abs(yx) * extentY + Math.abs(zx) * extentZ;
  const worldExtentY = Math.abs(xy) * extentX + Math.abs(yy) * extentY + Math.abs(zy) * extentZ;
  const worldExtentZ = Math.abs(xz) * extentX + Math.abs(yz) * extentY + Math.abs(zz) * extentZ;
  out[0] = worldCenterX - worldExtentX;
  out[1] = worldCenterY - worldExtentY;
  out[2] = worldCenterZ - worldExtentZ;
  out[3] = worldCenterX + worldExtentX;
  out[4] = worldCenterY + worldExtentY;
  out[5] = worldCenterZ + worldExtentZ;
  return true;
}

export function boundsFromArray(bounds: ArrayLike<number>): RenderSceneBounds | undefined {
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
