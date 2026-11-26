import type { FrameArena, World } from '@forgeax/engine-ecs';
import { type box3, mat4 } from '@forgeax/engine-math';
import type { PresentationSpan } from '@forgeax/engine-scene/internal';
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
import { CapturedSceneTransform, ScenePoseWriter } from './captured-transform';
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
import {
  createInlineScenePoseChunk,
  PreviousPoseRows,
  SCENE_POSE_CHUNK_ROWS,
  type StagedScenePoses,
  scenePoseChunk,
  scenePoseOffset,
  stageScenePoses,
} from './scene-pose-admission';
import {
  reflectedPose,
  type SceneGeneratedSource,
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

interface PendingIdentity {
  readonly entityKey: number;
  /** The live row address this identity resolved to before the batch. */
  readonly slot: number | undefined;
  readonly initial: RenderSceneSlot | undefined;
  /** A full or instance edit supplies replacement content. A pose edit borrows the initial columns. */
  replacement: RenderableSnapshot | undefined;
  live: boolean;
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
  readonly entities: Readonly<Uint32Array>;
  readonly worlds: Readonly<Float32Array>;
  /** Selected physical rows, consumed synchronously before publication buffers recycle. */
  readonly rows?: readonly number[];
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
  private slots = new SceneSlots();
  private readonly contents = new RowContents();
  private readonly poses = new ScenePoseWriter();
  private readonly bounds = new Map<number, RowBoundsPage>();
  private readonly localBoundsScratch = new Float32Array(6);
  private readonly unionScratch = new Float32Array(6);
  private readonly instanceBoundsWork = { hits: 0, misses: 0, derives: 0, invalidations: 0 };
  private skinBoundsScratch:
    | { matrix: ReturnType<typeof mat4.create>; inverse: ReturnType<typeof mat4.create> }
    | undefined;
  private revisionValue = 0;
  /** Commit-local pending identities by live slot; emptied when each commit ends. */
  private inlinePoses: Float64Array | undefined;
  private readonly pendingBySlot: (PendingIdentity | number | undefined)[] = [];
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
          const record = target.owner.allocate(source, undefined, 0, allocation, geometry);
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

  /** Local ECS presentation runs contain each entity once in stable query order. */
  commitPresentationSpans(spans: readonly PresentationSpan[]): RenderSceneApplyResult {
    if (spans.length === 0) return EMPTY_APPLY;
    if (this.committing) throw new Error('Scene commit cannot reenter');
    this.committing = true;
    try {
      const initial: RenderSceneSlot[] = [];
      const updated: RenderSceneSlot[] = [];
      const content: RenderSceneSlot[] = [];
      const ignored = this.slots.writePresentationSpans(spans, initial, updated, content);
      return this.poseDelta(initial, updated, content, ignored);
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
      if (demand <= SCENE_POSE_CHUNK_ROWS) {
        this.inlinePoses ??= createInlineScenePoseChunk();
        return this.writeTransformSpans(spans, this.inlinePoses).unwrap();
      }
      return world.withFrameArena(() => this.writeTransformSpans(spans, world.frameArena)).unwrap();
    } finally {
      this.committing = false;
    }
  }

  private writeTransformSpans(
    spans: readonly WorldTransformSpan[],
    storage: FrameArena | Float64Array,
  ) {
    const staged = stageScenePoses(this.slots, spans, storage, this.pendingBySlot);
    if (!staged.ok) return staged;
    const { initial, ignored } = staged.value;
    if (initial.length === 0)
      return ok(ignored === 0 ? EMPTY_APPLY : { ...EMPTY_APPLY, ignoredLateUpdates: ignored });
    const updatedSlots: RenderSceneSlot[] = [];
    const contentUpdatedSlots: RenderSceneSlot[] = [];
    this.writeStagedPoses(staged.value, updatedSlots, contentUpdatedSlots);
    return ok(this.poseDelta(initial, updatedSlots, contentUpdatedSlots, ignored));
  }

  private writeStagedPoses(
    { initial, chunks, columns }: StagedScenePoses,
    updatedSlots: RenderSceneSlot[],
    contentUpdatedSlots: RenderSceneSlot[],
  ): void {
    for (let index = 0; index < initial.length; index++) {
      const before = initial[index] as RenderSceneSlot;
      const chunk = scenePoseChunk(chunks, index);
      const base = scenePoseOffset(index);
      const worlds = columns[chunk[base] as number] as Readonly<Float32Array>;
      const after = this.slots.writePose(before.slot, worlds, chunk[base + 1] as number);
      updatedSlots.push(after);
      if (chunk[base + 2] === 1) contentUpdatedSlots.push(after);
    }
  }

  private poseDelta(
    initial: readonly RenderSceneSlot[],
    updatedSlots: readonly RenderSceneSlot[],
    contentUpdatedSlots: readonly RenderSceneSlot[],
    ignored: number,
  ): RenderSceneApplyResult {
    if (updatedSlots.length === 0)
      return ignored === 0 ? EMPTY_APPLY : { ...EMPTY_APPLY, ignoredLateUpdates: ignored };
    this.revisionValue++;
    return {
      ...EMPTY_APPLY,
      updated: updatedSlots.length,
      ignoredLateUpdates: ignored,
      updatedSlots,
      contentUpdatedSlots,
      previous: new PreviousPoseRows(updatedSlots, initial),
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
    const pendingEntities = new Map<number, PendingIdentity>();
    const pendingOrder: PendingIdentity[] = [];

    const pendingFor = (entityKey: number, knownSlot?: number): PendingIdentity => {
      const slot = knownSlot ?? this.slots.slotOf(entityKey);
      let pending: PendingIdentity | undefined;
      let entities: Map<number, PendingIdentity> | undefined;
      if (slot !== undefined) {
        const staged = pendingBySlot[slot];
        if (typeof staged === 'number') throw new Error('Scene pose staging is already active');
        pending = staged;
        if (pending !== undefined) return pending;
      } else {
        entities = pendingEntities;
        pending = entities.get(entityKey);
        if (pending !== undefined) return pending;
      }
      const initial = slot === undefined ? undefined : this.slots.get(slot);
      pending = {
        entityKey,
        slot,
        initial,
        replacement: undefined,
        live: initial !== undefined,
        pose: initial === undefined ? undefined : slotPoseColumn(initial),
        poseOffset: initial === undefined ? 0 : slotPoseOffset(initial),
        removed: false,
        contentChanged: false,
        instanceChanged: false,
        transformChanged: false,
      };
      if (slot !== undefined) pendingBySlot[slot] = pending;
      else entities?.set(entityKey, pending);
      pendingOrder.push(pending);
      return pending;
    };
    try {
      return this.commitPending(
        preparedOperations,
        spans,
        pendingFor,
        pendingOrder,
        pendingEntities,
      );
    } finally {
      for (const pending of pendingOrder)
        if (pending.slot !== undefined) pendingBySlot[pending.slot] = undefined;
    }
  }

  private commitPending(
    preparedOperations: readonly RenderSceneOperation[],
    spans: readonly WorldTransformSpan[],
    pendingFor: (entityKey: number) => PendingIdentity,
    pendingOrder: readonly PendingIdentity[],
    pendingEntities: ReadonlyMap<number, PendingIdentity>,
  ): RenderSceneApplyResult {
    let ignoredLateUpdates = 0;

    const updateWorld = (pending: PendingIdentity, source: ArrayLike<number>, offset: number) => {
      const target = pending.pose;
      if (target === undefined) return;
      const targetOffset = pending.poseOffset;
      for (let lane = 0; lane < 16; lane += 1) {
        if (target[targetOffset + lane] === (source[offset + lane] ?? 0)) continue;
        pending.pose = source;
        pending.poseOffset = offset;
        pending.transformChanged = true;
        // Only a parity change moves this source into another raster batch.
        if (reflectedPose(target, targetOffset) !== reflectedPose(source, offset))
          pending.contentChanged = true;
        return;
      }
    };
    for (const operation of preparedOperations) {
      const pending = pendingFor(operation.entityKey);
      if (operation.kind === 'remove') {
        pending.live = false;
        pending.replacement = undefined;
        pending.pose = undefined;
        pending.removed = true;
        continue;
      }
      if (operation.snapshot !== undefined) {
        pending.live = true;
        pending.replacement = operation.snapshot;
        const pose = CapturedSceneTransform.storage(operation.snapshot.transform);
        pending.pose = CapturedSceneTransform.column(pose);
        pending.poseOffset = CapturedSceneTransform.offset(pose);
        pending.contentChanged = true;
      }
      if (!pending.live) {
        ignoredLateUpdates += 1;
        continue;
      }
      if (operation.instances !== undefined) {
        const source = pending.replacement ?? pending.initial?.snapshot;
        if (source === undefined) throw new Error('A live instance edit requires an authored row');
        pending.replacement = { ...source, instances: operation.instances };
        pending.instanceChanged = true;
      }
      if (operation.world !== undefined) updateWorld(pending, operation.world, 0);
    }
    let poses: StagedScenePoses | undefined;
    if (spans.length > 0) {
      this.inlinePoses ??= createInlineScenePoseChunk();
      poses = stageScenePoses(
        this.slots,
        spans,
        this.inlinePoses,
        this.pendingBySlot,
        (entity, edit, span, offset) => {
          const pending = edit ?? pendingEntities.get(entity);
          if (!pending?.live) return false;
          updateWorld(pending, span.worlds, offset);
          return true;
        },
      ).unwrap();
      ignoredLateUpdates += poses.ignored;
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
      const current = pending.replacement;
      if (pending.initial === undefined) {
        if (!pending.live || current === undefined) continue;
        createdSlots.push(this.allocate(current, pending.pose, pending.poseOffset));
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
        const recreatedSlot = this.allocate(current, pending.pose, pending.poseOffset);
        recreatedSlots.push(recreatedSlot);
        previous.set(recreatedSlot, pending.initial);
        recreated += 1;
        continue;
      }
      if (!pending.contentChanged && !pending.instanceChanged && !pending.transformChanged)
        continue;
      const updatedSlot = this.writePending(pending, current, pending.initial);
      updatedSlots.push(updatedSlot);
      previous.set(updatedSlot, pending.initial);
      if (pending.contentChanged) contentUpdatedSlots.push(updatedSlot);
      else if (pending.instanceChanged) instanceUpdatedSlots.push(updatedSlot);
      updated += 1;
    }
    if (poses !== undefined) {
      this.writeStagedPoses(poses, updatedSlots, contentUpdatedSlots);
      updated += poses.initial.length;
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
      previous: poses?.initial.length
        ? new PreviousPoseRows(updatedSlots, poses.initial, previous.size ? previous : undefined)
        : previous,
      resynced: 0,
      journal: this.slots.journal,
    };
  }

  private writePending(
    pending: PendingIdentity,
    current: RenderableSnapshot | undefined,
    initial: RenderSceneSlot,
  ): RenderSceneSlot {
    const slot = initial.slot;
    let updatedSlot: RenderSceneSlot;
    if (current !== undefined) {
      const before = this.slots.content(slot);
      const content = this.contents.acquire(current);
      if (before?.assetHandle !== content.assetHandle) {
        this.releaseMesh(before?.assetHandle);
        this.acquireMesh(content.assetHandle);
      }
      updatedSlot = this.slots.write(slot, {
        entityKey: pending.entityKey,
        generation: initial.generation,
        content,
        pose: pending.pose ?? current.transform.world,
        poseOffset: pending.poseOffset,
      });
      if (before?.instances !== undefined && content.instances === undefined)
        this.releaseInstanceBounds(slot);
      if (before !== undefined) this.contents.release(before);
      this.updatePreparation(slot, content);
    } else updatedSlot = this.slots.writePose(slot, pending.pose ?? [], pending.poseOffset);
    return updatedSlot;
  }

  /** Reconcile the current identity set while retaining slots for survivors. */
  reconcile(snapshots: Iterable<RenderableSnapshot>): void {
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
    for (const snapshot of desired.values()) {
      const existing = this.lookup(snapshot.entityKey);
      if (existing === undefined) {
        this.allocate(snapshot);
        continue;
      }
      const before = this.slots.content(existing.slot);
      const content = this.contents.acquire(snapshot);
      if (before?.assetHandle !== content.assetHandle) {
        this.releaseMesh(before?.assetHandle);
        this.acquireMesh(content.assetHandle);
      }
      const pose = CapturedSceneTransform.storage(snapshot.transform);
      this.slots.write(existing.slot, {
        entityKey: snapshot.entityKey,
        generation: existing.generation,
        content,
        pose: CapturedSceneTransform.column(pose),
        poseOffset: CapturedSceneTransform.offset(pose),
      });
      if (before?.instances !== undefined && content.instances === undefined)
        this.releaseInstanceBounds(existing.slot);
      if (before !== undefined) this.contents.release(before);
      this.updatePreparation(existing.slot, content);
    }
    this.revisionValue += 1;
  }

  /** Release every row. */
  dispose(): void {
    this.preparedRows.clear();
    this.slots.clear();
    this.contents.clear();
    this.poses.clear();
    if (this.bounds.size > 0) this.instanceBoundsWork.invalidations++;
    this.bounds.clear();
    this.skinBoundsScratch = undefined;
    this.pendingBySlot.length = 0;
    this.inlinePoses = undefined;
    this.meshes = new MeshFrame();
    this.meshHolders.clear();
    this.preparation = new FrameSet();
  }

  private allocate(
    snapshot: RenderableSnapshot,
    pose?: ArrayLike<number>,
    poseOffset = 0,
    reservation?: SceneSlotReservation,
    geometry?: MeshGeometry,
  ): RenderSceneSlot {
    if (pose === undefined) {
      const storage = CapturedSceneTransform.storage(snapshot.transform);
      pose = CapturedSceneTransform.column(storage);
      poseOffset = CapturedSceneTransform.offset(storage);
    }
    const content = this.contents.acquire(snapshot);
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
      const write = { entityKey: snapshot.entityKey, generation, content, pose, poseOffset };
      const record =
        reservation === undefined ? this.slots.write(slot, write) : reservation.publish(write);
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
      const snapshot = record?.snapshot.pointsLines;
      if (record !== undefined && snapshot !== undefined) {
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
    snapshot = slotContent(slot),
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
      return writeTransformedWorldBounds(out, local, slotPoseColumn(slot), slotPoseOffset(slot));
    }
    const index = slot.slot;
    const page = Math.floor(index / BOUNDS_PAGE_ROWS);
    const lane = index % BOUNDS_PAGE_ROWS;
    const current = this.slots.version(index) === slot.version;
    const columns = current ? this.bounds.get(page) : undefined;
    const geometryId = geometry === undefined ? 0 : getOpaqueResourceIdentity(geometry);
    if (columns?.valid(lane, slot.version, geometryId) && columns.radius[lane] === radius) {
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
        slotPoseColumn(slot),
        snapshot.instances.transforms,
        slotPoseOffset(slot),
      );
    }
    // A held frame can answer a historical query without taking storage from a live owner.
    // A borrowed material or geometry reader can release the row while deriving the result.
    if (current && this.slots.version(index) === slot.version) {
      let owned = this.bounds.get(page);
      if (owned === undefined) {
        owned = new RowBoundsPage();
        this.bounds.set(page, owned);
      }
      owned.write(lane, slot.version, geometryId, radius, candidate);
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
    const snapshot = slotContent(slot);
    if (snapshot.skinBinding === undefined) {
      return this.resolveBounds(slot, meshes, materials, out, snapshot);
    }
    if (
      skin === undefined ||
      !skin.current.readable ||
      skin.slots.versionAt(slot.slot) !== slot.version ||
      snapshot.morph !== undefined ||
      snapshot.pointsLines !== undefined
    )
      return false;
    const geometry = meshes.get(snapshot.assetHandle);
    this.skinBoundsScratch ??= { matrix: mat4.create(), inverse: mat4.create() };
    const scratch = this.skinBoundsScratch;
    return skin.current.bounds(
      slot.slot,
      geometry?.skinEnvelopes,
      cullingDisplacementRadius(snapshot, geometry, materials, true),
      out,
      scratch.matrix,
      scratch.inverse,
      snapshot.skinBinding.affinePoint ? slotPoseColumn(slot) : undefined,
      slotPoseOffset(slot),
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
