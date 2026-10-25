import { type box3, mat4 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { fingerprintNumericArray, InstanceBoundsCache } from '../instances-derived-bounds';
import { expandPointsLinesBounds } from '../points-lines/bounds';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { RenderResourceScope } from '../publication/resource-scope';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { RenderableSnapshot } from '../render-system-extract';
import { expandDisplacementBounds } from '../standard-displacement-bounds';
import type { RetainedRowFacts } from './frame-list';
import { FrameSet } from './frame-set';
import type { MaterialFrame } from './material-dispatch';
import { meshDrawSnapshot } from './mesh-draw';
import { MeshFrame } from './mesh-frame';
import {
  boundsFromArray,
  cullingDisplacementRadius,
  identityKey,
  intersects,
  ownInstances,
  ownPointsLinesSnapshot,
  ownSnapshot,
  worldBounds,
} from './render-scene-snapshots';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneOperation,
  RenderSceneSlot,
} from './render-scene-types';
import type { RowContent } from './row-contents';
import { RowContents } from './row-contents';
import { type SceneSlotFrame, SceneSlots } from './scene-slots';
import type { SkinSceneFrame } from './skin-scene-inputs';

/**
 * The RenderBounds column: six numbers per slot plus the facts that proved
 * them (row record, geometry identity, displacement radius, material frame).
 * No per-row object; a row write invalidates its entry.
 */
const BOUNDS_SCRATCH = new Float64Array(6);
/** Consumed before the next derivation: copied into the column and the caller's box. */
const WORLD_BOUNDS_SCRATCH: RenderSceneBounds = { min: [0, 0, 0], max: [0, 0, 0] };

class RowBounds {
  /** Row version that proved each box; 0 = none. */
  private versions = new Float64Array(64);
  private geometry = new Float64Array(64);
  materials = new Float64Array(64);
  radius = new Float64Array(64);
  private known = new Uint8Array(64);
  private boxes = new Float64Array(64 * 6);

  valid(slot: number, version: number, geometry: number): boolean {
    return version !== 0 && this.versions[slot] === version && this.geometry[slot] === geometry;
  }

  /** Copy the cached box; false when the row's bounds are unknown. */
  read(slot: number, out: { [lane: number]: number }): boolean {
    if (this.known[slot] !== 1) return false;
    const offset = slot * 6;
    for (let lane = 0; lane < 6; lane++) out[lane] = this.boxes[offset + lane] as number;
    return true;
  }

  write(
    slot: number,
    version: number,
    geometry: number,
    radius: number,
    materials: number,
    bounds: RenderSceneBounds | undefined,
  ): void {
    this.ensure(slot);
    this.versions[slot] = version;
    this.geometry[slot] = geometry;
    this.radius[slot] = radius;
    this.materials[slot] = materials;
    this.known[slot] = bounds === undefined ? 0 : 1;
    if (bounds === undefined) return;
    const offset = slot * 6;
    this.boxes[offset] = bounds.min[0];
    this.boxes[offset + 1] = bounds.min[1];
    this.boxes[offset + 2] = bounds.min[2];
    this.boxes[offset + 3] = bounds.max[0];
    this.boxes[offset + 4] = bounds.max[1];
    this.boxes[offset + 5] = bounds.max[2];
  }

  invalidate(slot: number): void {
    if (slot < this.versions.length) this.versions[slot] = 0;
  }

  clear(): void {
    this.versions.fill(0);
  }

  private ensure(slot: number): void {
    if (slot < this.known.length) return;
    let capacity = this.known.length;
    while (capacity <= slot) capacity *= 2;
    const grow = <T extends Float64Array | Uint8Array>(from: T, to: T): T => {
      to.set(from);
      return to;
    };
    this.versions = grow(this.versions, new Float64Array(capacity));
    this.geometry = grow(this.geometry, new Float64Array(capacity));
    this.materials = grow(this.materials, new Float64Array(capacity));
    this.radius = grow(this.radius, new Float64Array(capacity));
    this.known = grow(this.known, new Uint8Array(capacity));
    this.boxes = grow(this.boxes, new Float64Array(capacity * 6));
  }
}

interface PendingIdentity {
  readonly worldId: number;
  readonly entityKey: number;
  readonly initial: RenderSceneSlot | undefined;
  /** Content-bearing snapshot; its own pose is superseded by `pose` when set. */
  current: RenderableSnapshot | undefined;
  /** Latest pose source of this batch, read at `poseOffset`. */
  pose: ArrayLike<number> | undefined;
  poseOffset: number;
  removed: boolean;
  contentChanged: boolean;
  /** An Instances row changed during this apply batch. */
  instanceChanged: boolean;
  /** A retained world transform changed during this apply batch. */
  transformChanged: boolean;
}

export interface WorldTransformSpan {
  readonly worldId: number;
  readonly entities: Readonly<Uint32Array>;
  readonly worlds: Readonly<Float32Array>;
}

const EMPTY_APPLY: RenderSceneApplyResult = Object.freeze({
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
});

function reflected(pose: ArrayLike<number>, offset: number): boolean {
  const a = pose[offset] ?? 0,
    b = pose[offset + 1] ?? 0,
    c = pose[offset + 2] ?? 0;
  const d = pose[offset + 4] ?? 0,
    e = pose[offset + 5] ?? 0,
    f = pose[offset + 6] ?? 0;
  const g = pose[offset + 8] ?? 0,
    h = pose[offset + 9] ?? 0,
    i = pose[offset + 10] ?? 0;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) < 0;
}

/**
 * The shared retained rows of one ingest owner: the single store of row facts.
 *
 * A row's GPU address (slot) stays dense per owner so per-view GPU tables
 * never span another owner's rows. Row facts live in numeric `SceneSlotFrame`
 * pages that in-flight frames, temporal history and asynchronous consumers
 * hold as immutable captures; equal drawable facts share one interned content,
 * and a `RenderSceneSlot` is a read view built on request. Views keep only
 * view-private derived state over these rows.
 */
export class SceneRows {
  private meshes = new MeshFrame();
  /** Holder counts per World and Mesh handle; numeric keys, no per-row key string. */
  private readonly meshHolders = new Map<number, Map<number, number>>();
  private preparation = new FrameSet();
  private slots = new SceneSlots();
  private readonly contents = new RowContents();
  private readonly bounds = new RowBounds();
  private readonly instanceBoundsCache = new InstanceBoundsCache();
  private skinBoundsScratch:
    | { matrix: ReturnType<typeof mat4.create>; inverse: ReturnType<typeof mat4.create> }
    | undefined;
  private revisionValue = 0;

  constructor(private sources: readonly RenderResourceScope[] = []) {}

  setSources(sources: readonly RenderResourceScope[]): void {
    this.sources = sources;
  }

  get revision(): number {
    return this.revisionValue;
  }

  meshFrame(): MeshFrame {
    return this.meshes;
  }

  get pipelinePreparationSlots(): FrameSet {
    return this.preparation;
  }

  holdsMesh(worldId: number, handle: number): boolean {
    return this.meshHolders.get(worldId)?.has(handle) === true;
  }

  /** Direct asset evidence changes one shared geometry row, without visiting its instances. */
  adoptMesh(worldId: number, handle: number, mesh: MeshAsset | undefined): boolean {
    if (!this.holdsMesh(worldId, handle)) return false;
    this.setMesh(worldId, handle, mesh);
    return mesh !== undefined;
  }

  private setMesh(worldId: number, handle: number, mesh: MeshAsset | undefined): void {
    this.meshes =
      mesh === undefined
        ? this.meshes.without(worldId, handle)
        : this.meshes.with(worldId, handle, mesh);
    this.slots.setMeshLods(
      worldId,
      handle,
      mesh === undefined ? undefined : (this.meshes.get(worldId, handle)?.lods?.length ?? 0) > 0,
    );
  }

  private acquireMesh(worldId: number, assetHandle: number | undefined): void {
    if (assetHandle === undefined) return;
    let world = this.meshHolders.get(worldId);
    if (world === undefined) {
      world = new Map();
      this.meshHolders.set(worldId, world);
    }
    const holders = world.get(assetHandle) ?? 0;
    world.set(assetHandle, holders + 1);
    if (holders > 0) return;
    const scope = this.sources[worldId];
    if (scope === undefined) return;
    const asset = scope.resolveAsset<MeshAsset>(assetHandle);
    if (asset.ok && asset.value.kind === 'mesh') this.setMesh(worldId, assetHandle, asset.value);
  }

  private releaseMesh(worldId: number, assetHandle: number | undefined): void {
    if (assetHandle === undefined) return;
    const world = this.meshHolders.get(worldId);
    const holders = (world?.get(assetHandle) ?? 1) - 1;
    if (holders > 0) world?.set(assetHandle, holders);
    else {
      world?.delete(assetHandle);
      if (world?.size === 0) this.meshHolders.delete(worldId);
      this.setMesh(worldId, assetHandle, undefined);
    }
  }

  private updatePreparation(slot: number, content: RowContent): void {
    this.preparation =
      content.pipelinePreparation === undefined
        ? this.preparation.without(slot)
        : this.preparation.with(slot);
  }

  capture(): SceneSlotFrame {
    return this.slots.capture();
  }

  get(slot: number): RenderSceneSlot | undefined {
    return this.slots.get(slot);
  }

  lookup(worldId: number, entityKey: number): RenderSceneSlot | undefined {
    return this.slots.lookup(worldId, entityKey);
  }

  get size(): number {
    return this.slots.size;
  }

  get capacity(): number {
    return this.slots.capacity;
  }

  get freeSlotCount(): number {
    return this.slots.freeCount;
  }

  hasSource(kind: 'terrain' | 'glyph' | 'tilemap'): boolean {
    return this.slots.hasSource(kind);
  }

  inspectPages(): ReturnType<SceneSlots['inspect']> {
    return this.slots.inspect();
  }

  /**
   * Merge the edits of one batch per identity and commit them. `owned`
   * operations carry snapshots their producer already owns immutably (a
   * publication receiver); borrowed snapshots are copied once here.
   */
  apply(
    operations: readonly RenderSceneOperation[],
    spans: readonly WorldTransformSpan[] = [],
    owned = false,
  ): RenderSceneApplyResult {
    // Each ingest batch starts a read generation for materialized row views.
    this.slots.rotateViews();
    if (operations.length === 0 && spans.length === 0) return EMPTY_APPLY;

    // Prepare every potentially fallible payload copy before mutating retained
    // columns. The commit loop below only uses owned POD and borrowed numeric spans.
    const preparedOperations = owned
      ? operations
      : operations.map((operation): RenderSceneOperation => {
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
            ...(operation.snapshot === undefined
              ? {}
              : { snapshot: ownSnapshot(operation.snapshot) }),
            ...(operation.instances === undefined
              ? {}
              : { instances: ownInstances(operation.instances) }),
          };
        });
    return this.commit(preparedOperations, spans);
  }

  private commit(
    preparedOperations: readonly RenderSceneOperation[],
    spans: readonly WorldTransformSpan[],
  ): RenderSceneApplyResult {
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
        pose: undefined,
        poseOffset: 0,
        removed: false,
        contentChanged: false,
        instanceChanged: false,
        transformChanged: false,
      };
      entities.set(entityKey, pending);
      pendingOrder.push(pending);
      return pending;
    };

    const updateWorld = (pending: PendingIdentity, source: ArrayLike<number>, offset: number) => {
      const current = pending.current;
      if (current === undefined) return;
      const target = pending.pose ?? current.transform.world;
      const targetOffset = pending.pose === undefined ? 0 : pending.poseOffset;
      for (let lane = 0; lane < 16; lane += 1) {
        if (target[targetOffset + lane] === (source[offset + lane] ?? 0)) continue;
        pending.pose = source;
        pending.poseOffset = offset;
        pending.transformChanged = true;
        // Only a parity change moves this source into another raster batch.
        if (reflected(target, targetOffset) !== reflected(source, offset))
          pending.contentChanged = true;
        return;
      }
    };
    for (const operation of preparedOperations) {
      const pending = pendingFor(operation.worldId, operation.entityKey);
      if (operation.kind === 'remove') {
        pending.current = undefined;
        pending.pose = undefined;
        pending.removed = true;
        continue;
      }
      if (operation.snapshot !== undefined) {
        pending.current = operation.snapshot;
        pending.pose = undefined;
        pending.contentChanged = true;
      }
      if (pending.current === undefined) {
        ignoredLateUpdates += 1;
        continue;
      }
      if (operation.instances !== undefined) {
        pending.current = { ...pending.current, instances: operation.instances };
        pending.instanceChanged = true;
      }
      if (operation.world !== undefined) updateWorld(pending, operation.world, 0);
    }
    // The same pending identity merges column updates with all other source
    // edits. There is one publication and one consumer delta per entity.
    for (const span of spans) {
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
    const removedSlots: RenderSceneSlot[] = [];
    const recreatedSlots: RenderSceneSlot[] = [];
    const previous = new Map<RenderSceneSlot, RenderSceneSlot>();
    for (const pending of pendingOrder) {
      const current = pending.current;
      if (pending.initial === undefined) {
        if (current === undefined) continue;
        createdSlots.push(this.allocate(current, pending.pose, pending.poseOffset));
        created += 1;
        continue;
      }
      if (current === undefined) {
        this.release(pending.initial.slot);
        removedSlots.push(pending.initial);
        removed += 1;
        continue;
      }
      if (pending.removed) {
        this.release(pending.initial.slot);
        const recreatedSlot = this.allocate(current, pending.pose, pending.poseOffset);
        recreatedSlots.push(recreatedSlot);
        previous.set(recreatedSlot, pending.initial);
        recreated += 1;
        continue;
      }
      if (!pending.contentChanged && !pending.instanceChanged && !pending.transformChanged)
        continue;
      const slot = pending.initial.slot;
      let updatedSlot: RenderSceneSlot;
      if (current !== pending.initial.snapshot) {
        const before = this.slots.content(slot);
        const content = this.contents.acquire(current);
        if (before?.assetHandle !== content.assetHandle) {
          this.releaseMesh(pending.worldId, before?.assetHandle);
          this.acquireMesh(pending.worldId, content.assetHandle);
        }
        updatedSlot = this.slots.write(slot, {
          worldId: pending.worldId,
          entityKey: pending.entityKey,
          generation: pending.initial.generation,
          content,
          pose: pending.pose ?? current.transform.world,
          poseOffset: pending.pose === undefined ? 0 : pending.poseOffset,
        });
        if (before !== undefined) this.contents.release(before);
        this.updatePreparation(slot, content);
      } else updatedSlot = this.slots.writePose(slot, pending.pose ?? [], pending.poseOffset);
      this.bounds.invalidate(slot);
      updatedSlots.push(updatedSlot);
      previous.set(updatedSlot, pending.initial);
      if (pending.contentChanged) contentUpdatedSlots.push(updatedSlot);
      else if (pending.instanceChanged) instanceUpdatedSlots.push(updatedSlot);
      updated += 1;
    }
    if (created + updated + removed + recreated === 0)
      return ignoredLateUpdates === 0 ? EMPTY_APPLY : { ...EMPTY_APPLY, ignoredLateUpdates };
    this.revisionValue += 1;
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
      previous,
      resynced: 0,
    };
  }

  /** Rebind positional World indices while retaining stable slots. */
  remapWorlds(indices: readonly number[]): void {
    this.meshes = new MeshFrame();
    this.slots.clearMeshLods();
    this.meshHolders.clear();
    for (const slot of this.slots.capture()) {
      if (slot === undefined) continue;
      this.instanceBoundsCache.invalidate(slot.entityKey, slot.worldId);
      const mapped = indices[slot.worldId];
      const worldId = mapped === undefined || mapped < 0 ? -1 - slot.worldId : mapped;
      const content = this.slots.content(slot.slot);
      if (content === undefined) continue;
      this.acquireMesh(worldId, content.assetHandle);
      this.slots.write(slot.slot, {
        worldId,
        entityKey: slot.entityKey,
        generation: slot.generation,
        content,
        pose: slot.snapshot.transform.world,
      });
      this.bounds.invalidate(slot.slot);
    }
    this.revisionValue += 1;
  }

  /** Reconcile the current identity set while retaining slots for survivors. */
  reconcile(snapshots: Iterable<RenderableSnapshot>): void {
    const desired = new Map<string, RenderableSnapshot>();
    for (const snapshot of snapshots)
      desired.set(identityKey(snapshot.worldId, snapshot.entityKey), ownSnapshot(snapshot));
    for (const slot of this.slots.capture()) {
      if (slot === undefined) continue;
      if (!desired.has(identityKey(slot.worldId, slot.entityKey))) this.release(slot.slot);
    }
    for (const snapshot of desired.values()) {
      const existing = this.lookup(snapshot.worldId, snapshot.entityKey);
      if (existing === undefined) {
        this.allocate(snapshot);
        continue;
      }
      const before = this.slots.content(existing.slot);
      const content = this.contents.acquire(snapshot);
      if (before?.assetHandle !== content.assetHandle) {
        this.releaseMesh(snapshot.worldId, before?.assetHandle);
        this.acquireMesh(snapshot.worldId, content.assetHandle);
      }
      this.slots.write(existing.slot, {
        worldId: snapshot.worldId,
        entityKey: snapshot.entityKey,
        generation: existing.generation,
        content,
        pose: snapshot.transform.world,
      });
      if (before !== undefined) this.contents.release(before);
      this.bounds.invalidate(existing.slot);
      this.updatePreparation(existing.slot, content);
    }
    this.revisionValue += 1;
  }

  /** Release every row. */
  dispose(): void {
    this.slots.clear();
    this.contents.clear();
    this.bounds.clear();
    this.meshes = new MeshFrame();
    this.meshHolders.clear();
    this.preparation = new FrameSet();
  }

  private allocate(
    snapshot: RenderableSnapshot,
    pose: ArrayLike<number> = snapshot.transform.world,
    poseOffset = 0,
  ): RenderSceneSlot {
    const content = this.contents.acquire(snapshot);
    this.acquireMesh(snapshot.worldId, content.assetHandle);
    const { slot, generation } = this.slots.allocate();
    const record = this.slots.write(slot, {
      worldId: snapshot.worldId,
      entityKey: snapshot.entityKey,
      generation,
      content,
      pose,
      poseOffset,
    });
    this.bounds.invalidate(slot);
    this.updatePreparation(slot, content);
    return record;
  }

  private release(slot: number): void {
    const content = this.slots.content(slot);
    const record = this.slots.get(slot);
    if (content === undefined || record === undefined) return;
    this.releaseMesh(record.worldId, content.assetHandle);
    this.slots.remove(slot);
    this.contents.release(content);
    this.bounds.invalidate(slot);
    this.preparation = this.preparation.without(slot);
    this.instanceBoundsCache.invalidate(record.entityKey, record.worldId);
  }

  /** Facts the rows maintain while writing, so frame consumers need not walk them. */
  rowFacts(
    current: SceneSlotFrame,
    meshes: MeshFrame,
    project: (record: RenderSceneSlot) => RenderableSnapshot = (record) =>
      meshDrawSnapshot(record.snapshot, meshes),
  ): RetainedRowFacts<RenderableSnapshot> {
    const lodCandidateCount = this.slots.lodCandidateCount;
    const indexes = {
      terrain: this.slots.indexedSlots('terrain'),
      capsule: this.slots.indexedSlots('capsule'),
    };
    return {
      lodCandidateCount,
      *sparseRows(kind) {
        for (const slot of indexes[kind]) {
          const record = current.slotAt(slot);
          if (record !== undefined) yield project(record);
        }
      },
    };
  }

  pointsLinesSnapshots(current = this.slots.capture()): readonly PointsLinesRetainedSnapshot[] {
    const snapshots: PointsLinesRetainedSnapshot[] = [];
    for (const record of current) {
      const snapshot = record?.snapshot.pointsLines;
      if (record !== undefined && snapshot !== undefined) {
        snapshots.push(ownPointsLinesSnapshot({ ...snapshot, worldId: record.worldId }));
      }
    }
    return Object.freeze(snapshots);
  }

  instanceBoundsStatistics(): ReturnType<InstanceBoundsCache['inspect']> {
    return this.instanceBoundsCache.inspect();
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
    const box = BOUNDS_SCRATCH;
    return this.resolveBounds(slot, meshes, materials, box)
      ? {
          min: [box[0] as number, box[1] as number, box[2] as number],
          max: [box[3] as number, box[4] as number, box[5] as number],
        }
      : undefined;
  }

  /**
   * The row's RenderBounds column, derived on demand from its pose, geometry
   * and fixed material radius. The current row caches its box in the slot's
   * numeric column; another record of that slot (a captured older frame)
   * derives into scratch without replacing the current row's value.
   */
  private resolveBounds(
    slot: RenderSceneSlot,
    meshes: MeshFrame,
    materials: MaterialFrame | undefined,
    out: { [lane: number]: number },
  ): boolean {
    const snapshot = slot.snapshot;
    // A static Skin Binding never grants permission to use bind-pose bounds.
    // Its caller must provide the fixed recording root to the numeric writer.
    if (snapshot.skinBinding !== undefined) return false;
    const geometry = meshes.get(snapshot.worldId, snapshot.assetHandle);
    const columns = this.bounds;
    const index = slot.slot;
    const current = this.slots.version(index) === slot.version;
    const geometryId = geometry === undefined ? 0 : getOpaqueResourceIdentity(geometry);
    const materialsId = materials === undefined ? -1 : getOpaqueResourceIdentity(materials);
    const cached = current && columns.valid(index, slot.version, geometryId);
    // The slot, geometry and fixed material frame all match, so the material
    // radius is the one already proven; mutable material roots re-derive it.
    if (cached && materials !== undefined && columns.materials[index] === materialsId)
      return columns.read(index, out);
    const radius = cullingDisplacementRadius(snapshot, geometry, materials);
    if (cached && columns.radius[index] === radius) {
      columns.materials[index] = materialsId;
      return columns.read(index, out);
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
    if (local !== undefined && snapshot.instances !== undefined) {
      if (snapshot.instances.instanceCount !== 0) {
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
      }
    } else if (local !== undefined) candidate = worldBounds(snapshot, WORLD_BOUNDS_SCRATCH, local);
    // Unknown or empty facts read as undefined (conservative no-cull) and prove no material frame.
    const proven = candidate === undefined ? -1 : materialsId;
    if (current) columns.write(index, slot.version, geometryId, radius, proven, candidate);
    if (candidate === undefined) return false;
    out[0] = candidate.min[0];
    out[1] = candidate.min[1];
    out[2] = candidate.min[2];
    out[3] = candidate.max[0];
    out[4] = candidate.max[1];
    out[5] = candidate.max[2];
    return true;
  }

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
    if (snapshot.skinBinding === undefined) {
      return this.resolveBounds(slot, meshes, materials, out);
    }
    if (
      skin === undefined ||
      !skin.current.readable ||
      skin.slots.versionAt(slot.slot) !== slot.version ||
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

  querySpatial(bounds: RenderSceneBounds, current = this.slots.capture()): RenderSceneSlot[] {
    const records: RenderSceneSlot[] = [];
    for (const record of current) {
      if (record === undefined) continue;
      const candidate = this.cullingWorldBoundsAt(record);
      if (candidate === null || candidate === undefined) continue;
      if (intersects(candidate, bounds)) records.push(record);
    }
    return records;
  }
}
