import type { box3 } from '@forgeax/engine-math';
import { captureBatchGeometry } from '../gpu-driven/batch-execution';
import { freezePreparedGpuDrivenDraw, ownGpuDrivenVertexInputs } from '../gpu-driven/prepared-draw';
import { captureInstanceGenerations, instanceRowsSurvived } from '../instance-generations';
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
import { SceneDrawSlot, slotContent, slotTransform } from './mesh-draw';
import type { MeshGeometry } from './mesh-frame';
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
  const effective =
    geometry === undefined
      ? snapshot
      : effectiveMeshMaterials(snapshot, geometry, meshMaterialGeometry(snapshot));
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
  readonly source: RenderableSnapshot;
  readonly submitted: RenderableSnapshot | RenderableSnapshot['transform'] | undefined;
  readonly submittedGeneration: number | undefined;
  readonly wasVisible: boolean;
  readonly displacementSource: boolean;
  readonly value: RenderableSnapshot;
}
// Slots and their snapshots are replaced every frame; see GenerationalWeakMap.
export type TemporalCache = GenerationalWeakMap<RenderSceneSlot, TemporalMemo>;

/**
 * The last submitted frame of one view, written at change time: each row that
 * changed since that frame keeps the record the frame drew (`undefined` when
 * it drew none), and every other row is still its submitted record. Memory is
 * O(changed rows); a submission starts a fresh history, so an earlier one
 * stays exact for the frame lists that captured it.
 */
/** Submissions a temporal draw reader may lag and still diff instead of re-reading. */
const HISTORY_LINK_DEPTH = 4;

/** Native view selections retain their fixed addresses. Borrowed iterables
 * record each generation at its public read, including reentrant Scene writes. */
export type SubmittedVisibility = FrameSet | ReadonlyMap<number, number>;

export class SubmittedHistory {
  private readonly changed = new Map<number, RenderSceneSlot | undefined>();
  /** The history this submission replaced; linked only across roster submissions. */
  private predecessor: SubmittedHistory | undefined;

  /** No submitted frame since the last temporal cut: every row is new. */
  static cut(): SubmittedHistory {
    return new SubmittedHistory(true);
  }

  /**
   * `visible` maps slot to its submitted visible generation; absent: every
   * submitted row was visible. `previous` is the history this submission
   * replaces; with no visible map on either side, the two link.
   */
  static submitted(visible?: SubmittedVisibility, previous?: SubmittedHistory): SubmittedHistory {
    // A completed submission can publish the same previous poses and roster.
    // The first subsequent row write still records its exact pre-change value.
    if (
      previous !== undefined &&
      !previous.isCut &&
      previous.changed.size === 0 &&
      visible === previous.visible
    )
      return previous;
    const next = new SubmittedHistory(false, visible);
    // A cut records no rows, so nothing submitted under it can be diffed.
    if (
      previous !== undefined &&
      !previous.isCut &&
      ((visible === undefined && previous.visible === undefined) ||
        (visible instanceof FrameSet && previous.visible instanceof FrameSet))
    ) {
      next.predecessor = previous;
      // A bounded chain: a reader further behind relinks by a full re-read.
      let tail = previous;
      for (let depth = 1; depth < HISTORY_LINK_DEPTH && tail.predecessor !== undefined; depth++)
        tail = tail.predecessor;
      tail.predecessor = undefined;
    }
    return next;
  }

  private constructor(
    readonly isCut: boolean,
    private readonly visible?: SubmittedVisibility,
  ) {}

  /**
   * Visit every slot whose submitted record or visibility can differ between
   * `before` and this history, both read against Scene frames whose own row
   * diff the caller visits. Each replaced history holds exactly the rows
   * written between its submission and the next, so their union names every
   * slot whose submitted record moved. False when `before` is not linked.
   */
  changesSince(before: SubmittedHistory, visit: (slot: number) => void): boolean {
    if (before === this) return true;
    let cursor: SubmittedHistory | undefined = this;
    while (cursor !== undefined && cursor !== before) cursor = cursor.predecessor;
    if (cursor === undefined) return false;
    cursor = this;
    while (cursor !== undefined) {
      for (const slot of cursor.changed.keys()) visit(slot);
      if (cursor === before) break;
      const prior: SubmittedHistory | undefined = cursor.predecessor;
      if (cursor.visible instanceof FrameSet && prior?.visible instanceof FrameSet)
        cursor.visible.changesSince(prior.visible, visit);
      cursor = prior;
    }
    return true;
  }

  /** Keep the first pre-change record of `slot` since the submitted frame. */
  record(slot: number, before: RenderSceneSlot | undefined): void {
    if (!this.isCut && !this.changed.has(slot)) this.changed.set(slot, before);
  }

  /** The record `slot` had in the submitted frame; `current` is any later frame of this history. */
  at(slot: number, current: SceneSlotFrame): RenderSceneSlot | undefined {
    if (this.isCut) return undefined;
    return this.changed.has(slot) ? this.changed.get(slot) : current.slotAt(slot);
  }

  /** Previous facts for an already resolved current row, without another Scene index read. */
  before(row: RenderSceneSlot): RenderSceneSlot | undefined {
    if (this.isCut) return undefined;
    return this.changed.has(row.slot) ? this.changed.get(row.slot) : row;
  }

  admitted(submitted: RenderSceneSlot): boolean {
    return (
      !this.isCut &&
      (this.visible === undefined ||
        (this.visible instanceof FrameSet
          ? this.visible.has(submitted.slot)
          : this.visible.get(submitted.slot) === submitted.generation))
    );
  }

  wasVisible(slot: number, generation: number, current: SceneSlotFrame): boolean {
    if (this.isCut) return false;
    if (this.visible instanceof FrameSet && !this.visible.has(slot)) return false;
    return this.visible === undefined || this.visible instanceof FrameSet
      ? this.at(slot, current)?.generation === generation
      : this.visible.get(slot) === generation;
  }
}

export function temporalDrawSnapshot(
  snapshot: RenderableSnapshot,
  counters: FrameCacheTally | undefined,
  slot: RenderSceneSlot,
  history: SubmittedHistory,
  materials: MaterialFrame | undefined,
  cache: TemporalCache,
): RenderableSnapshot {
  // Hidden authored rows keep their source identity but own no accepted draw materials.
  if (snapshot.authorVisible === false) return snapshot;
  const submitted = history.before(slot);
  const wasVisible = submitted?.generation === slot.generation && history.admitted(submitted);
  // The pose wrapper is unique to an issued native row. A memo must not keep
  // the previous row key alive and thereby chain its earlier submission history.
  const submittedSource =
    submitted instanceof SceneDrawSlot ? submitted.transform : submitted?.snapshot;
  const displacementSource = hasDisplacementSource(snapshot, materials);
  const memo = cache.get(slot);
  if (
    memo !== undefined &&
    memo.source === snapshot &&
    memo.submitted === submittedSource &&
    memo.submittedGeneration === submitted?.generation &&
    memo.wasVisible === wasVisible &&
    memo.displacementSource === displacementSource
  ) {
    if (counters !== undefined) counters.hits += 1;
    return memo.value;
  }
  if (counters !== undefined) counters.misses += 1;
  const value = {
    ...snapshot,
    temporal: createTemporalSnapshot(slot, submitted, wasVisible, displacementSource),
  };
  cache.set(slot, {
    source: snapshot,
    submitted: submittedSource,
    submittedGeneration: submitted?.generation,
    wasVisible,
    displacementSource,
    value,
  });
  return value;
}

const NO_REACTIVE_REASONS: readonly RenderableReactiveReason[] = Object.freeze([]);

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
        currentInstances.generations?.length === currentInstances.instanceCount &&
        submittedInstances.generations?.length === submittedInstances.instanceCount &&
        instanceRowsSurvived(currentInstances.generations, submittedInstances.generations));
  const motionValid = !seedCurrent && submitted !== undefined && instancesCompatible;
  const previousInstances =
    seedCurrent || submittedRecycled ? currentInstances : submittedInstances;
  if (into !== undefined) {
    into.motionValid = motionValid;
    into.reactive = seedCurrent;
    into.previousInstances = previousInstances;
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
  return {
    previousSource: seedCurrent ? 'current-seed' : 'last-submitted',
    motionValid,
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
    previousInstances,
  };
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
  const shared = Object.isFrozen(draws) && draws.every((draw) => Object.isFrozen(draw));
  const cached = shared ? ownedDrawTables.get(draws) : undefined;
  if (cached !== undefined) return cached;
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
  if (shared) ownedDrawTables.set(draws, owned);
  return owned;
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
    transform: poses.capture(
      CapturedSceneTransform.column(pose),
      CapturedSceneTransform.offset(pose),
    ),
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

export function intersects(left: RenderSceneBounds, right: RenderSceneBounds): boolean {
  return (
    left.min[0] <= right.max[0] &&
    left.max[0] >= right.min[0] &&
    left.min[1] <= right.max[1] &&
    left.max[1] >= right.min[1] &&
    left.min[2] <= right.max[2] &&
    left.max[2] >= right.min[2]
  );
}

export function worldBounds(
  snapshot: RenderableSnapshot,
  target?: RenderSceneBounds,
  local = snapshot.localAabb,
): RenderSceneBounds | undefined {
  return local === undefined || local.length < 6
    ? undefined
    : transformedWorldBounds(local, snapshot.transform.world, target);
}

export function transformedWorldBounds(
  local: RowContent['localAabb'],
  world: Float32Array,
  target?: RenderSceneBounds,
  offset = 0,
): RenderSceneBounds | undefined {
  if (local === undefined || local.length < 6) return undefined;
  const min = (target?.min ?? [0, 0, 0]) as [number, number, number];
  const max = (target?.max ?? [0, 0, 0]) as [number, number, number];
  const centerX = ((local[0] ?? 0) + (local[3] ?? 0)) * 0.5;
  const centerY = ((local[1] ?? 0) + (local[4] ?? 0)) * 0.5;
  const centerZ = ((local[2] ?? 0) + (local[5] ?? 0)) * 0.5;
  const extentX = ((local[3] ?? 0) - (local[0] ?? 0)) * 0.5;
  const extentY = ((local[4] ?? 0) - (local[1] ?? 0)) * 0.5;
  const extentZ = ((local[5] ?? 0) - (local[2] ?? 0)) * 0.5;
  const worldCenterX =
    (world[offset] ?? 0) * centerX +
    (world[offset + 4] ?? 0) * centerY +
    (world[offset + 8] ?? 0) * centerZ +
    (world[offset + 12] ?? 0);
  const worldCenterY =
    (world[offset + 1] ?? 0) * centerX +
    (world[offset + 5] ?? 0) * centerY +
    (world[offset + 9] ?? 0) * centerZ +
    (world[offset + 13] ?? 0);
  const worldCenterZ =
    (world[offset + 2] ?? 0) * centerX +
    (world[offset + 6] ?? 0) * centerY +
    (world[offset + 10] ?? 0) * centerZ +
    (world[offset + 14] ?? 0);
  const worldExtentX =
    Math.abs(world[offset] ?? 0) * extentX +
    Math.abs(world[offset + 4] ?? 0) * extentY +
    Math.abs(world[offset + 8] ?? 0) * extentZ;
  const worldExtentY =
    Math.abs(world[offset + 1] ?? 0) * extentX +
    Math.abs(world[offset + 5] ?? 0) * extentY +
    Math.abs(world[offset + 9] ?? 0) * extentZ;
  const worldExtentZ =
    Math.abs(world[offset + 2] ?? 0) * extentX +
    Math.abs(world[offset + 6] ?? 0) * extentY +
    Math.abs(world[offset + 10] ?? 0) * extentZ;
  min[0] = worldCenterX - worldExtentX;
  min[1] = worldCenterY - worldExtentY;
  min[2] = worldCenterZ - worldExtentZ;
  max[0] = worldCenterX + worldExtentX;
  max[1] = worldCenterY + worldExtentY;
  max[2] = worldCenterZ + worldExtentZ;
  return target ?? { min, max };
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
