import type { FrameArena, World } from '@forgeax/engine-ecs';
import { type box3, mat4 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import {
  type InstanceBoundsCacheInspection,
  writeInstancesUnionBounds,
} from '../instances-derived-bounds';
import { expandPointsLinesBounds } from '../points-lines/bounds';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { RenderResourceScope } from '../publication/resource-scope';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { RenderableSnapshot } from '../render-system-extract';
import { expandDisplacementBounds } from '../standard-displacement-bounds';
import {
  CapturedSceneTransform,
  COMPACT_SCENE_POSE_ROWS,
  ScenePoseWriter,
} from './captured-transform';
import type { RetainedRowFacts } from './frame-list';
import { FrameSet } from './frame-set';
import type { MaterialFrame } from './material-dispatch';
import { slotContent, slotDrawSnapshot, slotPoseColumn, slotPoseOffset } from './mesh-draw';
import { MeshFrame, type MeshGeometry } from './mesh-frame';
import {
  cullingDisplacementRadius,
  cullingMaterialBinding,
  ownInstances,
  ownPointsLinesSnapshot,
  ownSnapshot,
  writeTransformedWorldBounds,
} from './render-scene-snapshots';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneOperation,
  RenderSceneSlot,
  ReservedSceneRow,
  SceneRowGeometry,
} from './render-scene-types';
import type { RowContent } from './row-contents';
import { RowContents } from './row-contents';
import { SCENE_POSE_CHUNK_ROWS, ScenePoseAdmission } from './scene-pose-admission';
import {
  reflectedPose,
  type SceneGeneratedSource,
  type SceneRowPose,
  type SceneSlotFrame,
  type SceneSlotReservation,
  SceneSlots,
} from './scene-slots';
import type { SkinSceneFrame } from './skin-scene-inputs';

const BOUNDS_SCRATCH = new Float64Array(6);

/** Exact original publication facts, not a currentness or resource-residency authority. */
const publications = new WeakMap<ReservedSceneRow, WeakRef<RenderSceneSlot>>();

export function sceneRowPublicationMatches(
  source: ReservedSceneRow,
  record: RenderSceneSlot,
): boolean {
  return publications.get(source)?.deref() === record;
}

const BOUNDS_PAGE_ROWS = 64;
const BOUNDS_COLUMN_BYTES = BOUNDS_PAGE_ROWS * Float64Array.BYTES_PER_ELEMENT;
const BOUNDS_PAGE_BYTES =
  3 * BOUNDS_COLUMN_BYTES +
  6 * BOUNDS_PAGE_ROWS * Float32Array.BYTES_PER_ELEMENT +
  BOUNDS_PAGE_ROWS;

/** World unions for instance sets. Ordinary affine boxes write directly to the consumer. */
class RowBoundsPage {
  private readonly backing = new ArrayBuffer(BOUNDS_PAGE_BYTES);
  private readonly versions = new Float64Array(this.backing, 0, BOUNDS_PAGE_ROWS);
  private readonly geometry = new Float64Array(this.backing, BOUNDS_COLUMN_BYTES, BOUNDS_PAGE_ROWS);
  readonly radius = new Float64Array(this.backing, 2 * BOUNDS_COLUMN_BYTES, BOUNDS_PAGE_ROWS);
  private readonly boxes = new Float32Array(
    this.backing,
    3 * BOUNDS_COLUMN_BYTES,
    6 * BOUNDS_PAGE_ROWS,
  );
  private readonly known = new Uint8Array(this.backing, BOUNDS_PAGE_BYTES - BOUNDS_PAGE_ROWS);
  private occupied = 0;

  valid(lane: number, version: number, geometry: number): boolean {
    return version !== 0 && this.versions[lane] === version && this.geometry[lane] === geometry;
  }

  read(lane: number, out: { [index: number]: number }): boolean {
    if (this.known[lane] !== 1) return false;
    const start = lane * 6;
    for (let i = 0; i < 6; i++) out[i] = this.boxes[start + i] as number;
    return true;
  }

  write(
    lane: number,
    version: number,
    geometry: number,
    radius: number,
    bounds: Float32Array | undefined,
  ): void {
    if (this.versions[lane] === 0) this.occupied++;
    this.versions[lane] = version;
    this.geometry[lane] = geometry;
    this.radius[lane] = radius;
    this.known[lane] = bounds === undefined ? 0 : 1;
    if (bounds === undefined) return;
    const start = lane * 6;
    this.boxes.set(bounds, start);
  }

  has(lane: number): boolean {
    return this.versions[lane] !== 0;
  }

  release(lane: number): boolean {
    this.versions[lane] = 0;
    this.occupied--;
    return this.occupied === 0;
  }
}

/** This draft is borrowed for one commit. Only issued rows can escape publication. */
class PendingIdentity {
  entityKey = 0;
  /** The live row address this identity resolved to before the batch. */
  slot: number | undefined;
  initial: RenderSceneSlot | undefined;
  /** A full edit supplies replacement content. A pose edit borrows the initial columns. */
  replacement: RowContent | undefined;
  live = false;
  /** Latest pose source of this batch, read at `poseOffset`. */
  pose: SceneRowPose | undefined;
  poseOffset = 0;
  removed = false;
  contentChange: 'none' | 'winding' | 'authored' = 'none';
  /** Instance content is merged once, after the last write in the batch. */
  instances: RenderableSnapshot['instances'];
  /** A retained world transform changed during this apply batch. */
  transformChanged = false;

  begin(entityKey: number, slot: number | undefined, initial: RenderSceneSlot | undefined): void {
    this.entityKey = entityKey;
    this.slot = slot;
    this.initial = initial;
    this.live = initial !== undefined;
    this.pose = initial === undefined ? undefined : slotPoseColumn(initial);
    this.poseOffset = initial === undefined ? 0 : slotPoseOffset(initial);
    this.removed = false;
    this.contentChange = 'none';
    this.transformChanged = false;
  }

  release(): void {
    this.initial = this.replacement = this.pose = undefined;
    this.instances = undefined;
  }

  content(): RowContent | undefined {
    if (this.instances === undefined) return this.replacement;
    const source =
      this.replacement ?? (this.initial === undefined ? undefined : slotContent(this.initial));
    if (source === undefined) throw new Error('A live instance edit requires an authored row');
    return { ...source, instances: this.instances };
  }
}

export interface WorldTransformSpan {
  readonly entities: Readonly<Uint32Array>;
  readonly worlds: Readonly<Float32Array>;
  /** Selected physical rows, consumed synchronously before publication buffers recycle. */
  readonly rows?: readonly number[];
}

function stageWorldPose(pending: PendingIdentity, source: ArrayLike<number>, offset: number): void {
  const pose = pending.pose;
  if (pose === undefined) return;
  const target = CapturedSceneTransform.column(pose);
  const targetOffset = CapturedSceneTransform.offset(pose) + pending.poseOffset;
  for (let lane = 0; lane < 16; lane += 1) {
    if (target[targetOffset + lane] === (source[offset + lane] ?? 0)) continue;
    pending.pose = source;
    pending.poseOffset = offset;
    pending.transformChanged = true;
    // Only a parity change moves this source into another raster batch.
    if (
      pending.contentChange === 'none' &&
      reflectedPose(target, targetOffset) !== reflectedPose(source, offset)
    )
      pending.contentChange = 'winding';
    return;
  }
}

function stageRowOperations(
  operations: readonly RenderSceneOperation[],
  pendingFor: (entityKey: number) => PendingIdentity,
): number {
  let ignored = 0;
  for (const operation of operations) {
    const pending = pendingFor(operation.entityKey);
    if (operation.kind === 'remove') {
      pending.live = false;
      pending.replacement = undefined;
      pending.pose = undefined;
      pending.instances = undefined;
      pending.removed = true;
      continue;
    }
    if (operation.snapshot !== undefined) {
      pending.live = true;
      pending.replacement = operation.snapshot;
      pending.pose = CapturedSceneTransform.storage(operation.snapshot.transform);
      pending.poseOffset = 0;
      pending.contentChange = 'authored';
      pending.instances = undefined;
    }
    if (!pending.live) {
      ignored += 1;
      continue;
    }
    if (operation.instances !== undefined) pending.instances = operation.instances;
    if (operation.world !== undefined) stageWorldPose(pending, operation.world, 0);
  }
  return ignored;
}

export interface SceneRowPreparation {
  readonly row: ReservedSceneRow;
  isCurrent(): boolean;
  publish(geometry?: SceneRowGeometry): RenderSceneApplyResult;
  release(): void;
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

function localDisplacedBounds(
  snapshot: RowContent,
  geometry: ReturnType<MeshFrame['get']>,
  radius: number,
  scratch: Float32Array,
) {
  let local =
    geometry === undefined || snapshot.morph !== undefined || snapshot.terrainSection !== undefined
      ? snapshot.localAabb
      : expandDisplacementBounds(geometry.bounds, radius, scratch);
  if (local !== undefined && geometry !== undefined && snapshot.pointsLines !== undefined)
    local = expandPointsLinesBounds(local, snapshot.pointsLines.style, scratch);
  return local;
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
export type SceneRowWriteAccess = Pick<SceneRows, 'prepareRow' | 'apply' | 'commitTransformSpans'>;

export class SceneRows {
  private meshes = new MeshFrame();
  /** Holder counts per Mesh handle; numeric keys, no per-row key string. */
  private readonly meshHolders = new Map<number, number>();
  private preparation = new FrameSet();
  private readonly poses = new ScenePoseWriter(COMPACT_SCENE_POSE_ROWS);
  private readonly slots = new SceneSlots(this.poses);
  private readonly contents = new RowContents();
  private readonly bounds = new Map<number, RowBoundsPage>();
  private readonly localBoundsScratch = new Float32Array(6);
  private readonly unionScratch = new Float32Array(6);
  private readonly instanceBoundsWork = { hits: 0, misses: 0, derives: 0, invalidations: 0 };
  private skinBoundsScratch:
    | { matrix: ReturnType<typeof mat4.create>; inverse: ReturnType<typeof mat4.create> }
    | undefined;
  private revisionValue = 0;
  private readonly poseAdmission = new ScenePoseAdmission();
  /** Commit-local pending identities by live slot; emptied when each commit ends. */
  private readonly pendingBySlot: (PendingIdentity | number | undefined)[] = [];
  /** Absent identities can only be resolved by their source key. */
  private readonly pendingEntities = new Map<number, PendingIdentity>();
  private readonly pendingOrder: PendingIdentity[] = [];
  private pendingIdentityAllocations = 0;
  private committing = false;
  private readonly preparedRows = new Map<number, SceneRowPreparation>();

  constructor(private source?: RenderResourceScope) {}
  setSource(source: RenderResourceScope | undefined): void {
    this.source = source;
  }

  /** Reserve identity without accepting content, geometry, a journal change or a view row. */
  prepareRow(snapshot: RenderableSnapshot): SceneRowPreparation {
    const entityKey = snapshot.entityKey;
    this.assertUnreserved(entityKey);
    if (this.committing || this.lookup(entityKey) !== undefined)
      throw new Error('Scene row preparation requires an absent identity and an idle owner');
    const owned = Object.freeze(ownSnapshot(snapshot, this.poses));
    if (owned.entityKey !== entityKey) throw new Error('Scene row identity changed during capture');
    this.assertUnreserved(entityKey);
    if (this.committing || this.lookup(entityKey) !== undefined)
      throw new Error('Scene row preparation changed during source capture');
    const allocation = this.slots.reserve();
    let scope: { owner: SceneRows; row: ReservedSceneRow } | undefined = {
      owner: this,
      row: Object.freeze({
        entityKey,
        slot: allocation.slot,
        generation: allocation.generation,
        snapshot: owned,
      }),
    };
    const current = () =>
      scope?.owner.preparedRows.get(entityKey) === api && allocation.isCurrent();
    const api: SceneRowPreparation = Object.freeze({
      get row() {
        if (scope === undefined) throw new Error('Scene row preparation is closed');
        return scope.row;
      },
      isCurrent: current,
      publish: (publication?: SceneRowGeometry) => {
        const target = scope;
        if (target === undefined || !current() || target.owner.committing)
          throw new Error('Scene row preparation is not current');
        target.owner.committing = true;
        try {
          const geometry =
            publication === undefined
              ? undefined
              : target.owner.publicationGeometry(target.row, publication);
          if (scope !== target || !current())
            throw new Error('Scene row preparation changed during geometry qualification');
          const source = target.row.snapshot;
          const record = target.owner.allocate(
            source.entityKey,
            source,
            CapturedSceneTransform.storage(source.transform),
            0,
            undefined,
            allocation,
            geometry,
          );
          publications.set(target.row, new WeakRef(record));
          target.owner.revisionValue++;
          target.owner.preparedRows.delete(entityKey);
          scope = undefined;
          return {
            ...EMPTY_APPLY,
            created: 1,
            createdSlots: [record],
            journal: target.owner.slots.journal,
          };
        } finally {
          target.owner.committing = false;
        }
      },
      release: () => {
        const target = scope;
        if (
          target?.owner.preparedRows.get(entityKey) === api &&
          target.owner.lookup(entityKey) !== undefined
        )
          throw new Error('A partially published Scene row retains its cleanup responsibility');
        allocation.release();
        if (target?.owner.preparedRows.get(entityKey) === api)
          target.owner.preparedRows.delete(entityKey);
        scope = undefined;
      },
    });
    this.preparedRows.set(entityKey, api);
    return api;
  }

  private assertUnreserved(entityKey: number): void {
    if (this.preparedRows.has(entityKey))
      throw new Error('Scene identity belongs to an unpublished row preparation');
  }

  private publicationGeometry(row: ReservedSceneRow, publication: SceneRowGeometry): MeshGeometry {
    const { source, geometry } = publication;
    const scope = this.source;
    const handle = row.snapshot.assetHandle;
    if (source !== row || handle !== geometry.handle || scope === undefined)
      throw new Error('Prepared Scene publication does not match its reserved source');
    const revision = scope.assetRevision(handle);
    const accepted = this.meshes.get(handle);
    const provenance = geometry.source;
    if (
      this.source !== scope ||
      provenance?.identity !== scope.identity ||
      provenance.revision !== revision ||
      (accepted !== undefined && accepted !== geometry)
    )
      throw new Error('Prepared Scene geometry is not the current canonical source');
    return geometry;
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

  holdsMesh(handle: number): boolean {
    return this.meshHolders.has(handle);
  }

  /** Direct asset evidence changes one shared geometry row, without visiting its instances. */
  adoptMesh(handle: number, mesh: MeshAsset | undefined): boolean {
    if (!this.holdsMesh(handle)) return false;
    this.setMesh(handle, mesh);
    return mesh !== undefined;
  }

  private setMesh(handle: number, mesh: MeshAsset | undefined): void {
    const before = this.meshes;
    const scope = this.source;
    const revision = mesh === undefined ? undefined : scope?.assetRevision(handle);
    const resolved = revision === undefined ? undefined : scope?.resolveAsset<MeshAsset>(handle);
    const provenance =
      scope !== undefined && revision !== undefined && resolved?.ok && resolved.value === mesh
        ? { identity: scope.identity, revision }
        : undefined;
    const captured = before.get(handle);
    const sameSource =
      provenance !== undefined &&
      captured?.source?.identity === provenance.identity &&
      captured.source.revision === provenance.revision &&
      captured.materials.length === 0;
    const next =
      mesh === undefined
        ? before.without(handle)
        : sameSource
          ? before
          : before.with(handle, mesh, undefined, provenance);
    const lods = mesh === undefined ? undefined : (next.get(handle)?.lods?.length ?? 0) > 0;
    if (
      this.meshes !== before ||
      this.source !== scope ||
      (revision !== undefined && scope?.assetRevision(handle) !== revision)
    )
      throw new Error('Scene Mesh ownership changed during geometry capture');
    this.slots.setMeshLods(handle, lods);
    this.meshes = next;
  }

  private acquireMesh(assetHandle: number | undefined, geometry?: MeshGeometry): void {
    if (assetHandle === undefined) return;
    const holders = this.meshHolders.get(assetHandle) ?? 0;
    if (holders > 0) {
      this.meshHolders.set(assetHandle, holders + 1);
      return;
    }
    if (geometry !== undefined) {
      this.meshes = this.meshes.withGeometry(geometry);
      this.slots.setMeshLods(assetHandle, (geometry.lods?.length ?? 0) > 0);
      this.meshHolders.set(assetHandle, 1);
      return;
    }
    const scope = this.source;
    const before = this.meshes;
    if (scope !== undefined) {
      const asset = scope.resolveAsset<MeshAsset>(assetHandle);
      if (this.source !== scope || this.meshes !== before)
        throw new Error('Scene Mesh ownership changed during asset resolution');
      if (asset.ok && asset.value.kind === 'mesh') this.setMesh(assetHandle, asset.value);
    }
    this.meshHolders.set(assetHandle, 1);
  }

  private releaseMesh(assetHandle: number | undefined): void {
    if (assetHandle === undefined) return;
    const holders = (this.meshHolders.get(assetHandle) ?? 1) - 1;
    if (holders > 0) this.meshHolders.set(assetHandle, holders);
    else {
      this.meshHolders.delete(assetHandle);
      this.setMesh(assetHandle, undefined);
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

  lookup(entityKey: number): RenderSceneSlot | undefined {
    return this.slots.lookup(entityKey);
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

  hasSource(kind: SceneGeneratedSource): boolean {
    return this.slots.hasSource(kind);
  }

  get cullingBoundsBackingBytes(): number {
    return this.bounds.size * BOUNDS_PAGE_BYTES;
  }

  get changeJournalBackingBytes(): number {
    return this.slots.journal.backingBytes;
  }

  inspectPages() {
    return {
      ...this.slots.inspect(),
      poseAdmissionBackingBytes: this.poseAdmission.backingBytes,
      pendingIdentityCapacity: this.pendingOrder.length,
      pendingIdentityAllocations: this.pendingIdentityAllocations,
    };
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
    memory?: World,
  ): RenderSceneApplyResult {
    if (operations.length === 0 && spans.length === 0) return EMPTY_APPLY;
    for (const operation of operations)
      if (operation.kind === 'update' && operation.snapshot !== undefined)
        this.assertUnreserved(operation.entityKey);
    if (owned && operations.length === 0 && memory !== undefined)
      return this.commitTransformSpans(spans, memory);

    // Prepare every potentially fallible payload copy before mutating retained
    // columns. The commit loop below only uses owned POD and borrowed numeric spans.
    const preparedOperations = owned
      ? operations
      : operations.map((operation): RenderSceneOperation => {
          if (operation.kind === 'remove') return operation;
          if (
            operation.snapshot !== undefined &&
            operation.entityKey !== operation.snapshot.entityKey
          ) {
            throw new RangeError('RenderScene update identity must match its source snapshot');
          }
          return {
            ...operation,
            ...(operation.snapshot === undefined
              ? {}
              : { snapshot: ownSnapshot(operation.snapshot, this.poses) }),
            ...(operation.instances === undefined
              ? {}
              : { instances: ownInstances(operation.instances) }),
          };
        });
    for (const operation of preparedOperations)
      if (operation.kind === 'update' && operation.snapshot !== undefined)
        this.assertUnreserved(operation.entityKey);
    return this.commit(preparedOperations, spans);
  }

  /** A producer validated unique rows and owns the numeric inputs for this synchronous commit. */
  commitDistinctTransformSpans(spans: readonly WorldTransformSpan[]): RenderSceneApplyResult {
    if (spans.length === 0) return EMPTY_APPLY;
    if (this.committing) throw new Error('Scene commit cannot reenter');
    this.committing = true;
    try {
      const first = this.slots.journal.position;
      const content: RenderSceneSlot[] = [];
      const ignored = this.slots.writeDistinctPoseSpans(spans, content);
      return this.poseDelta(first, content, ignored);
    } finally {
      this.committing = false;
    }
  }

  commitTransformSpans(spans: readonly WorldTransformSpan[], world: World): RenderSceneApplyResult {
    if (spans.length === 0) return EMPTY_APPLY;
    // Small and dense spans use the same versioned row writer. Only overflow needs an arena scope.
    let demand = 0;
    for (const span of spans) {
      demand += span.rows?.length ?? span.entities.length;
      if (demand > SCENE_POSE_CHUNK_ROWS) break;
    }
    if (this.committing) throw new Error('Scene commit cannot reenter');
    this.committing = true;
    try {
      if (demand <= SCENE_POSE_CHUNK_ROWS) return this.writeTransformSpans(spans).unwrap();
      return world.withFrameArena(() => this.writeTransformSpans(spans, world.frameArena)).unwrap();
    } finally {
      this.committing = false;
    }
  }

  private writeTransformSpans(spans: readonly WorldTransformSpan[], arena?: FrameArena) {
    const poses = this.poseAdmission;
    try {
      const staged = poses.stage(this.slots, spans, this.pendingBySlot, arena);
      if (!staged.ok) return staged;
      const { count, ignored } = poses;
      if (count === 0)
        return ok(ignored === 0 ? EMPTY_APPLY : { ...EMPTY_APPLY, ignoredLateUpdates: ignored });
      const first = this.slots.journal.position;
      const contentUpdatedSlots: RenderSceneSlot[] = [];
      poses.write(this.slots, contentUpdatedSlots);
      return ok(this.poseDelta(first, contentUpdatedSlots, ignored));
    } finally {
      poses.end();
    }
  }

  private poseDelta(
    first: number,
    contentUpdatedSlots: readonly RenderSceneSlot[],
    ignored: number,
  ): RenderSceneApplyResult {
    if (first === this.slots.journal.position)
      return ignored === 0 ? EMPTY_APPLY : { ...EMPTY_APPLY, ignoredLateUpdates: ignored };
    const updatedSlots = this.slots.capturePoseChanges(first);
    this.revisionValue++;
    return {
      ...EMPTY_APPLY,
      updated: updatedSlots.length,
      ignoredLateUpdates: ignored,
      updatedSlots,
      contentUpdatedSlots,
      journal: this.slots.journal,
    };
  }

  private commit(
    preparedOperations: readonly RenderSceneOperation[],
    spans: readonly WorldTransformSpan[],
  ): RenderSceneApplyResult {
    if (this.committing) throw new Error('Scene commit cannot reenter');
    this.committing = true;
    try {
      return this.commitOperations(preparedOperations, spans);
    } finally {
      this.committing = false;
    }
  }

  private commitOperations(
    preparedOperations: readonly RenderSceneOperation[],
    spans: readonly WorldTransformSpan[],
  ): RenderSceneApplyResult {
    // Live identities resolve through their dense slot address; only identities
    // without a row (new in this batch) need a keyed map.
    const pendingBySlot = this.pendingBySlot;
    const { pendingEntities, pendingOrder } = this;
    let pendingCount = 0;

    const pendingFor = (entityKey: number): PendingIdentity => {
      const slot = this.slots.slotOf(entityKey);
      const staged = slot === undefined ? pendingEntities.get(entityKey) : pendingBySlot[slot];
      if (typeof staged === 'number') throw new Error('Scene pose staging is already active');
      if (staged !== undefined) return staged;
      const initial = slot === undefined ? undefined : this.slots.get(slot);
      let pending = pendingOrder[pendingCount];
      if (pending === undefined) {
        pending = new PendingIdentity();
        pendingOrder.push(pending);
        this.pendingIdentityAllocations++;
      }
      pendingCount++;
      pending.begin(entityKey, slot, initial);
      if (slot === undefined) pendingEntities.set(entityKey, pending);
      else pendingBySlot[slot] = pending;
      return pending;
    };
    try {
      const ignored =
        stageRowOperations(preparedOperations, pendingFor) + this.stageMixedPoses(spans);
      const liveBefore = this.slots.size;
      const delta = this.commitStagedRows(pendingCount, ignored);
      if (this.slots.size < liveBefore) this.poseAdmission.trim(this.slots.size);
      return delta;
    } finally {
      this.poseAdmission.end();
      for (let index = 0; index < pendingCount; index++) {
        const pending = pendingOrder[index] as PendingIdentity;
        if (pending.slot !== undefined) pendingBySlot[pending.slot] = undefined;
        pending.release();
      }
      if (pendingEntities.size > 0) pendingEntities.clear();
      this.trimPendingIdentities();
    }
  }

  private trimPendingIdentities(): void {
    const live = this.slots.size;
    if (live === 0) this.pendingOrder.length = 0;
    else if (this.pendingOrder.length > 4 * Math.max(SCENE_POSE_CHUNK_ROWS, live))
      this.pendingOrder.length = Math.max(SCENE_POSE_CHUNK_ROWS, live);
  }

  private stageMixedPoses(spans: readonly WorldTransformSpan[]): number {
    if (spans.length === 0) return 0;
    const poses = this.poseAdmission;
    poses
      .stage(this.slots, spans, this.pendingBySlot, undefined, (entity, edit, span, offset) => {
        const pending = edit ?? this.pendingEntities.get(entity);
        if (!pending?.live) return false;
        stageWorldPose(pending, span.worlds, offset);
        return true;
      })
      .unwrap();
    return poses.ignored;
  }

  /** Begin with the exact pure-pose lane and add known in-place moves from the mixed lane. */
  private pendingPoseWrites(count: number): number {
    let writes = this.poseAdmission.count;
    for (let index = 0; index < count; index++) {
      const draft = this.pendingOrder[index] as PendingIdentity;
      if (draft.initial !== undefined && draft.live && !draft.removed && draft.transformChanged)
        writes++;
    }
    return writes;
  }

  private commitStagedRows(
    pendingCount: number,
    ignoredLateUpdates: number,
  ): RenderSceneApplyResult {
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
    let previous: Map<RenderSceneSlot, RenderSceneSlot> | undefined;
    let adjacentNewContent: RowContent | undefined;
    let pendingPoses = this.pendingPoseWrites(pendingCount);
    for (let index = 0; index < pendingCount; index++) {
      const pending = this.pendingOrder[index] as PendingIdentity;
      const current = pending.content();
      if (pending.initial === undefined) {
        if (!pending.live || current === undefined) continue;
        const createdSlot = this.allocate(
          pending.entityKey,
          current,
          pending.pose,
          pending.poseOffset,
          adjacentNewContent,
        );
        adjacentNewContent = slotContent(createdSlot);
        createdSlots.push(createdSlot);
        created += 1;
        continue;
      }
      if (!pending.live) {
        this.release(pending.initial.slot);
        removedSlots.push(pending.initial);
        removed += 1;
        continue;
      }
      if (pending.removed && current !== undefined) {
        this.release(pending.initial.slot);
        const recreatedSlot = this.allocate(
          pending.entityKey,
          current,
          pending.pose,
          pending.poseOffset,
          adjacentNewContent,
        );
        adjacentNewContent = slotContent(recreatedSlot);
        recreatedSlots.push(recreatedSlot);
        previous ??= new Map();
        previous.set(recreatedSlot, pending.initial);
        recreated += 1;
        continue;
      }
      if (
        pending.contentChange === 'none' &&
        pending.instances === undefined &&
        !pending.transformChanged
      )
        continue;
      const updatedSlot = this.writePending(pending, current, pending.initial, pendingPoses);
      if (pending.transformChanged) pendingPoses--;
      updatedSlots.push(updatedSlot);
      if (pending.contentChange === 'authored') {
        previous ??= new Map();
        previous.set(updatedSlot, pending.initial);
      }
      if (pending.contentChange !== 'none') contentUpdatedSlots.push(updatedSlot);
      else if (pending.instances !== undefined) instanceUpdatedSlots.push(updatedSlot);
      updated += 1;
    }
    const poseStart = this.slots.journal.position;
    this.poseAdmission.write(this.slots, contentUpdatedSlots);
    updated += this.poseAdmission.count;
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
      updatedSlots: this.slots.capturePoseChanges(poseStart, updatedSlots),
      contentUpdatedSlots,
      instanceUpdatedSlots,
      removedSlots,
      recreatedSlots,
      previous: previous ?? EMPTY_APPLY.previous,
      resynced: 0,
      journal: this.slots.journal,
    };
  }

  private writePending(
    pending: PendingIdentity,
    current: RowContent | undefined,
    initial: RenderSceneSlot,
    pendingPoses: number,
  ): RenderSceneSlot {
    const slot = initial.slot;
    const pose = pending.pose;
    if (pose === undefined) throw new Error('A live Scene row edit requires an accepted pose');
    let updatedSlot: RenderSceneSlot;
    if (current !== undefined) {
      const before = this.slots.content(slot);
      const content = this.contents.acquire(current, before);
      if (before?.assetHandle !== content.assetHandle) {
        this.releaseMesh(before?.assetHandle);
        this.acquireMesh(content.assetHandle);
      }
      updatedSlot = this.slots.write(
        slot,
        {
          entityKey: pending.entityKey,
          generation: initial.generation,
          content,
          pose,
          poseOffset: pending.poseOffset,
        },
        pendingPoses,
      );
      if (before?.instances !== undefined && content.instances === undefined)
        this.releaseInstanceBounds(slot);
      if (before !== undefined) this.contents.release(before);
      this.updatePreparation(slot, content);
    } else updatedSlot = this.slots.writePose(slot, pose, pending.poseOffset, pendingPoses);
    return updatedSlot;
  }

  /** Reconcile the current identity set while retaining slots for survivors. */
  reconcile(snapshots: Iterable<RenderableSnapshot>): void {
    if (this.committing) throw new Error('Scene commit cannot reenter');
    const desired = new Map<number, RenderableSnapshot>();
    for (const snapshot of snapshots) {
      this.assertUnreserved(snapshot.entityKey);
      desired.set(snapshot.entityKey, ownSnapshot(snapshot, this.poses));
    }
    for (const entity of desired.keys()) this.assertUnreserved(entity);
    for (const slot of this.slots.capture()) {
      if (slot === undefined) continue;
      if (!desired.has(slot.entityKey)) this.release(slot.slot);
    }
    let adjacentNewContent: RowContent | undefined;
    for (const snapshot of desired.values()) {
      const existing = this.lookup(snapshot.entityKey);
      const pose = CapturedSceneTransform.storage(snapshot.transform);
      if (existing === undefined) {
        adjacentNewContent = slotContent(
          this.allocate(snapshot.entityKey, snapshot, pose, 0, adjacentNewContent),
        );
        continue;
      }
      const before = this.slots.content(existing.slot);
      const content = this.contents.acquire(snapshot, before);
      if (before?.assetHandle !== content.assetHandle) {
        this.releaseMesh(before?.assetHandle);
        this.acquireMesh(content.assetHandle);
      }
      this.slots.write(existing.slot, {
        entityKey: snapshot.entityKey,
        generation: existing.generation,
        content,
        pose,
      });
      if (before?.instances !== undefined && content.instances === undefined)
        this.releaseInstanceBounds(existing.slot);
      if (before !== undefined) this.contents.release(before);
      this.updatePreparation(existing.slot, content);
    }
    this.poseAdmission.trim(this.slots.size);
    this.trimPendingIdentities();
    this.revisionValue += 1;
  }

  /** Release every row. */
  dispose(): void {
    if (this.committing) throw new Error('Scene commit cannot reenter');
    this.preparedRows.clear();
    this.slots.clear();
    this.contents.clear();
    if (this.bounds.size > 0) this.instanceBoundsWork.invalidations++;
    this.bounds.clear();
    this.skinBoundsScratch = undefined;
    this.pendingBySlot.length = 0;
    this.pendingOrder.length = 0;
    this.poseAdmission.end();
    this.poseAdmission.trim(0);
    this.meshes = new MeshFrame();
    this.meshHolders.clear();
    this.preparation = new FrameSet();
  }

  private allocate(
    entityKey: number,
    drawable: RowContent,
    pose: SceneRowPose | undefined,
    poseOffset = 0,
    adjacentContent?: RowContent,
    reservation?: SceneSlotReservation,
    geometry?: MeshGeometry,
  ): RenderSceneSlot {
    if (pose === undefined) throw new Error('A new Scene row requires an accepted pose');
    const content = this.contents.acquire(drawable, adjacentContent);
    const before = this.meshes;
    let acquired = false;
    let after = before;
    let address: Pick<SceneSlotReservation, 'slot' | 'generation'> | undefined = reservation;
    try {
      this.acquireMesh(content.assetHandle, geometry);
      acquired = true;
      after = this.meshes;
      address ??= this.slots.allocate();
      const { slot, generation } = address;
      const write = { entityKey, generation, content, pose, poseOffset };
      const record =
        reservation === undefined
          ? this.slots.write(slot, write, this.poseAdmission.count)
          : reservation.publish(write);
      this.updatePreparation(slot, content);
      return record;
    } catch (cause) {
      // A written/unknown row retains its content, Mesh and address responsibility.
      if (address !== undefined && this.slots.content(address.slot) !== undefined) throw cause;
      const failures = [cause];
      const restore = this.meshes === after;
      if (acquired) {
        try {
          this.releaseMesh(content.assetHandle);
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }
      try {
        this.contents.release(content);
      } catch (cleanup) {
        failures.push(cleanup);
      }
      if (restore && failures.length === 1) this.meshes = before;
      if (failures.length > 1)
        throw new AggregateError(failures, 'Scene row allocation and rollback failed', { cause });
      throw cause;
    }
  }

  private release(slot: number): void {
    const content = this.slots.content(slot);
    if (content === undefined) return;
    this.releaseMesh(content.assetHandle);
    this.slots.remove(slot);
    this.releaseInstanceBounds(slot);
    this.contents.release(content);
    this.preparation = this.preparation.without(slot);
  }

  private releaseInstanceBounds(slot: number): void {
    const page = Math.floor(slot / BOUNDS_PAGE_ROWS);
    const owned = this.bounds.get(page);
    if (owned === undefined || !owned.has(slot % BOUNDS_PAGE_ROWS)) return;
    this.instanceBoundsWork.invalidations++;
    if (owned.release(slot % BOUNDS_PAGE_ROWS)) this.bounds.delete(page);
  }

  get lodCandidateCount(): number {
    return this.slots.lodCandidateCount;
  }

  /** Facts the rows maintain while writing, so frame consumers need not walk them. */
  rowFacts(
    current: SceneSlotFrame,
    meshes: MeshFrame,
    project: (record: RenderSceneSlot) => RenderableSnapshot = (record) =>
      slotDrawSnapshot(record, meshes),
  ): RetainedRowFacts<RenderableSnapshot> {
    const lodCandidateCount = this.lodCandidateCount;
    const indexes = {
      terrain: current.indexedSlots('terrain') ?? this.slots.indexedSlots('terrain'),
      capsule: current.indexedSlots('capsule') ?? this.slots.indexedSlots('capsule'),
      pointsLines: current.indexedSlots('pointsLines') ?? this.slots.indexedSlots('pointsLines'),
      skin: current.indexedSlots('skin') ?? this.slots.indexedSlots('skin'),
      raster: current.indexedSlots('raster'),
      viewSource: current.indexedSlots('viewSource'),
    };
    return {
      lodCandidateCount,
      terrainRowCount: indexes.terrain.size,
      rasterRowCount: indexes.raster?.size,
      allDefaultRenderLayers: current.allDefaultRenderLayers,
      *sparseRows(kind) {
        const index = indexes[kind];
        if (index === undefined) {
          for (const record of current) yield project(record);
          return;
        }
        for (const slot of index.borrowKeys()) {
          const record = current.slotAt(slot);
          if (record !== undefined) yield project(record);
        }
      },
    };
  }

  pointsLinesSnapshots(current = this.slots.capture()): readonly PointsLinesRetainedSnapshot[] {
    const snapshots: PointsLinesRetainedSnapshot[] = [];
    for (const record of current) {
      const snapshot = slotContent(record).pointsLines;
      if (snapshot !== undefined) {
        snapshots.push(ownPointsLinesSnapshot({ ...snapshot }));
      }
    }
    return Object.freeze(snapshots);
  }

  instanceBoundsStatistics(): InstanceBoundsCacheInspection {
    return { ...this.instanceBoundsWork };
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

  private resolveBounds(
    slot: RenderSceneSlot,
    meshes: MeshFrame,
    materials: MaterialFrame | undefined,
    out: { [lane: number]: number },
  ): boolean {
    return this.writePoseBounds(
      slot.slot,
      slot.version,
      slotContent(slot),
      slotPoseColumn(slot),
      slotPoseOffset(slot),
      out,
      meshes,
      materials,
    );
  }

  /** Read accepted rigid pose coordinates directly into caller-owned bounds. */
  writePoseBounds(
    index: number,
    version: number,
    snapshot: RowContent,
    column: Float32Array,
    offset: number,
    out: { [lane: number]: number },
    meshes = this.meshes,
    materials?: MaterialFrame,
  ): boolean {
    if (snapshot.skinBinding !== undefined) return false;
    const geometry = meshes.get(snapshot.assetHandle);
    const radius = this.contents.displacementRadius(
      snapshot,
      cullingMaterialBinding(snapshot, geometry),
      materials,
    );
    if (snapshot.instances === undefined) {
      const local = localDisplacedBounds(snapshot, geometry, radius, this.localBoundsScratch);
      return writeTransformedWorldBounds(out, local, column, offset);
    }
    const page = Math.floor(index / BOUNDS_PAGE_ROWS);
    const lane = index % BOUNDS_PAGE_ROWS;
    const current = this.slots.version(index) === version;
    const columns = current ? this.bounds.get(page) : undefined;
    const geometryId = geometry === undefined ? 0 : getOpaqueResourceIdentity(geometry);
    if (columns?.valid(lane, version, geometryId) && columns.radius[lane] === radius) {
      this.instanceBoundsWork.hits++;
      return columns.read(lane, out);
    }
    let candidate: Float32Array | undefined;
    const local = localDisplacedBounds(snapshot, geometry, radius, this.localBoundsScratch);
    if (local !== undefined && snapshot.instances.instanceCount !== 0) {
      this.instanceBoundsWork.misses++;
      this.instanceBoundsWork.derives++;
      candidate = writeInstancesUnionBounds(
        this.unionScratch,
        local,
        column,
        snapshot.instances.transforms,
        offset,
      );
    }
    // A held frame can answer a historical query without taking storage from a live owner.
    // A borrowed material or geometry reader can release the row while deriving the result.
    if (current && this.slots.version(index) === version) {
      let owned = this.bounds.get(page);
      if (owned === undefined) {
        owned = new RowBoundsPage();
        this.bounds.set(page, owned);
      }
      owned.write(lane, version, geometryId, radius, candidate);
    }
    if (candidate === undefined) return false;
    if (candidate !== out) for (let i = 0; i < 6; i++) out[i] = candidate[i] as number;
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
    return this.writeCullingPoseBounds(
      slot.slot,
      slot.version,
      slotContent(slot),
      slotPoseColumn(slot),
      slotPoseOffset(slot),
      out,
      meshes,
      materials,
      skin,
    );
  }

  /** The same bounds contract applied to a captured slot's numeric coordinates. */
  writeCullingPoseBounds(
    slot: number,
    version: number,
    snapshot: RowContent,
    column: Float32Array,
    offset: number,
    out: box3.Box3,
    meshes = this.meshes,
    materials?: MaterialFrame,
    skin?: SkinSceneFrame,
  ): boolean {
    if (snapshot.skinBinding === undefined)
      return this.writePoseBounds(slot, version, snapshot, column, offset, out, meshes, materials);
    if (
      skin === undefined ||
      !skin.current.readable ||
      skin.slots.versionAt(slot) !== version ||
      snapshot.morph !== undefined ||
      snapshot.pointsLines !== undefined
    )
      return false;
    const geometry = meshes.get(snapshot.assetHandle);
    this.skinBoundsScratch ??= { matrix: mat4.create(), inverse: mat4.create() };
    const scratch = this.skinBoundsScratch;
    return skin.current.bounds(
      slot,
      geometry?.skinEnvelopes,
      cullingDisplacementRadius(snapshot, geometry, materials, true),
      out,
      scratch.matrix,
      scratch.inverse,
      snapshot.skinBinding.affinePoint ? column : undefined,
      offset,
    );
  }

  querySpatial(bounds: RenderSceneBounds, current = this.slots.capture()): RenderSceneSlot[] {
    const records: RenderSceneSlot[] = [];
    const candidate = new Float64Array(6);
    for (const record of current) {
      if (record === undefined || !this.resolveBounds(record, this.meshes, undefined, candidate))
        continue;
      if (
        (candidate[0] as number) <= bounds.max[0] &&
        (candidate[3] as number) >= bounds.min[0] &&
        (candidate[1] as number) <= bounds.max[1] &&
        (candidate[4] as number) >= bounds.min[1] &&
        (candidate[2] as number) <= bounds.max[2] &&
        (candidate[5] as number) >= bounds.min[2]
      )
        records.push(record);
    }
    return records;
  }
}
