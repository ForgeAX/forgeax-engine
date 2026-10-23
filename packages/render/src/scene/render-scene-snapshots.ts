import type { box3 } from '@forgeax/engine-math';
import { captureBatchGeometry } from '../gpu-driven/batch-execution';
import { freezePreparedGpuDrivenDraw, ownGpuDrivenVertexInputs } from '../gpu-driven/prepared-draw';
import { uniqueInstanceIdentities } from '../instances';
import type { MaterialResource } from '../material-resource';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type {
  InstancesSnapshot,
  RenderableReactiveReason,
  RenderableSnapshot,
  RenderableTemporalSnapshot,
} from '../render-system-extract';
import { materialDisplacementRadius } from '../standard-displacement-bounds';
import type { MaterialFrame } from './material-dispatch';
import type { MeshGeometry } from './mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from './mesh-materials';
import type { RenderSceneBounds, RenderSceneSlot } from './render-scene-types';
import type { SceneSlotFrame } from './scene-slots';

/** Mutable accumulator behind a readonly `FrameCacheCounters` inspection. */
export interface FrameCacheTally {
  hits: number;
  misses: number;
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
  snapshot: RenderableSnapshot,
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
  return (
    (material.paramSnapshot?.displacementScale ?? 0) !== 0 &&
    (material.textureSources?.has('displacementTexture') === true ||
      material.videoTextureFields?.has('displacementTexture') === true)
  );
}

/** A fixed MaterialFrame answers each material table once; per-frame temporal reads reuse it. */
const displacementByFrame = new WeakMap<MaterialFrame, WeakMap<object, boolean>>();

export function hasDisplacementSource(
  snapshot: Pick<RenderableSnapshot, 'material' | 'materials'>,
  materials?: MaterialFrame,
): boolean {
  let answers: WeakMap<object, boolean> | undefined;
  if (materials !== undefined) {
    answers = displacementByFrame.get(materials);
    if (answers === undefined) {
      answers = new WeakMap();
      displacementByFrame.set(materials, answers);
    }
  }
  // Without a fixed frame the live resource snapshot is read on every call.
  const key = snapshot.materials.length === 0 ? snapshot.material : snapshot.materials;
  const cached = answers?.get(key);
  if (cached !== undefined) return cached;
  let found = false;
  if (snapshot.materials.length === 0)
    found = materialHasDisplacement(snapshot.material, materials);
  else
    for (const resource of snapshot.materials)
      if (materialHasDisplacement(resource, materials)) {
        found = true;
        break;
      }
  answers?.set(key, found);
  return found;
}

export interface CachedWorldBounds {
  readonly radius: number;
  readonly bounds: RenderSceneBounds | null;
  /** Fixed material frame that proved `radius`; the same frame proves it again. */
  materials?: MaterialFrame | undefined;
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
export type TemporalCache = WeakMap<RenderSceneSlot, TemporalMemo>;

export function temporalDrawSnapshot(
  snapshot: RenderableSnapshot,
  counters: FrameCacheTally | undefined,
  current: SceneSlotFrame,
  submittedFrame: SceneSlotFrame,
  visible: ReadonlyMap<number, number>,
  materials: MaterialFrame | undefined,
  cache: TemporalCache,
): RenderableSnapshot {
  // Hidden authored rows keep their source identity but own no accepted draw materials.
  if (snapshot.authorVisible === false) return snapshot;
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

export function createTemporalSnapshot(
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
    previousMorphWeights: previous.morph?.weights,
  };
}

export function identityKey(worldId: number, entityKey: number): string {
  return `${worldId}:${entityKey}`;
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
      : { generations: new Uint32Array(instances.generations) }),
  };
}

export function ownSnapshot(snapshot: RenderableSnapshot): RenderableSnapshot {
  const { temporal: _temporal, skinBinding: sourceBinding, ...current } = snapshot;
  let skinBinding: RenderableSnapshot['skinBinding'];
  if (sourceBinding !== undefined) {
    const { skeleton, joints } = sourceBinding;
    skinBinding = Object.freeze({
      skeleton,
      joints: Object.freeze([...joints]),
    });
  }
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
