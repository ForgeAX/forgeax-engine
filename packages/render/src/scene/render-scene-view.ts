import type { box3 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import type { InstanceBoundsCache } from '../instances-derived-bounds';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { RenderResourceScope } from '../publication/resource-scope';
import { MeshDrawSlots } from '../record/mesh-draw-slots';
import type { RenderableSnapshot, RenderableTemporalSnapshot } from '../render-system-extract';
import { type FrameList, FrameProjection, RetainedFrameProjection } from './frame-list';
import type { FrameSet } from './frame-set';
import { GenerationalWeakMap } from './generational-weak-map';
import type { MaterialFrame } from './material-dispatch';
import { meshDrawMaterials, meshDrawSnapshot, rotateMeshDraws } from './mesh-draw';
import type { MeshFrame } from './mesh-frame';
import {
  createTemporalSnapshot,
  type FrameCacheTally,
  hasDisplacementSource,
  SubmittedHistory,
  type TemporalCache,
  temporalDrawSnapshot,
  worldBounds,
} from './render-scene-snapshots';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneInspection,
  RenderSceneOperation,
  RenderSceneResyncReason,
  RenderSceneSlot,
} from './render-scene-types';
import { SceneRows, type WorldTransformSpan } from './scene-rows';
import { SceneSlotFrame } from './scene-slots';
import type { SkinSceneFrame } from './skin-scene-inputs';

/** One view's prepared submission: its rows revision and the slots it drew visible. */
export interface RenderSceneSubmissionCapture {
  readonly revision: number;
  /** Slot to visible generation; absent when the frame drew its whole roster. */
  readonly visible: ReadonlyMap<number, number> | undefined;
}

export const EMPTY_SLOT_FRAME = new SceneSlotFrame(undefined, 0);

/**
 * One view's private state over shared retained rows.
 *
 * The rows (identity, GPU row addresses, pose column, retained records, Mesh
 * holds and bounds caches) belong to their ingest owner. A view pins the row
 * roster it last observed, so every read agrees with its derived state, and
 * keeps only temporal history, draw-address allocation and frame memos. The
 * history is written when rows change, never copied from a submitted frame.
 */
export class RenderScene {
  private readonly rows: SceneRows;
  private readonly ownsRows: boolean;
  private frame: SceneSlotFrame;
  private meshes: MeshFrame;
  private preparation: FrameSet;
  private readonly meshDrawSlots = new MeshDrawSlots();
  private temporalTracking = false;
  private history = SubmittedHistory.cut();
  private materialized:
    | {
        readonly meshes: MeshFrame;
        readonly value: FrameProjection<RenderSceneSlot, RenderableSnapshot>;
      }
    | undefined;
  private temporalMaterialized:
    | {
        readonly current: SceneSlotFrame;
        readonly history: SubmittedHistory;
        readonly materials: MaterialFrame;
        readonly meshes: MeshFrame;
        readonly unavailable: FrameSet | undefined;
        readonly value: FrameList<RenderableSnapshot>;
      }
    | undefined;
  private temporalBySlot: TemporalCache = new GenerationalWeakMap();
  private revision = 0;
  private observedRowsRevision = 0;
  private noChangeFrames = 0;
  private deltaFrames = 0;
  private renderableScans = 0;
  private fullRebuilds = 0;
  private resyncs = 0;
  private lastResyncReason: RenderSceneResyncReason | undefined;

  /** Private rows over `source` scopes, or a view over rows another owner writes. */
  constructor(source: readonly RenderResourceScope[] | SceneRows = []) {
    if (source instanceof SceneRows) {
      this.rows = source;
      this.ownsRows = false;
    } else {
      this.rows = new SceneRows(source);
      this.ownsRows = true;
    }
    this.frame = this.rows.capture();
    this.meshes = this.rows.meshFrame();
    this.preparation = this.rows.pipelinePreparationSlots;
    this.observedRowsRevision = this.rows.revision;
  }

  get sceneRows(): SceneRows {
    return this.rows;
  }

  /** Release owned rows; borrowed rows stay with their owner. */
  dispose(): void {
    if (this.ownsRows) this.rows.dispose();
    this.pin();
  }

  setSources(sources: readonly RenderResourceScope[]): void {
    if (this.ownsRows) this.rows.setSources(sources);
  }

  meshFrame(): MeshFrame {
    return this.meshes;
  }

  /** Read the shared rows' current Mesh frame after the owner adopted geometry. */
  observeMeshes(): void {
    this.meshes = this.rows.meshFrame();
  }

  /** Direct asset evidence changes one shared geometry row, without visiting its instances. */
  adoptMesh(worldId: number, handle: number, mesh: MeshAsset | undefined): boolean {
    const adopted = this.ownsRows
      ? this.rows.adoptMesh(worldId, handle, mesh)
      : this.rows.holdsMesh(worldId, handle) && mesh !== undefined;
    this.meshes = this.rows.meshFrame();
    return adopted;
  }

  get pipelinePreparationSlots(): ReadonlySet<number> {
    return this.preparation;
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
  meshDrawSlot(source: RenderableSnapshot, folded = false, row?: RenderSceneSlot): number {
    const record = sceneRow(row, source) ?? this.lookup(source.worldId, source.entityKey);
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

  /** Bounded current-scene facts for the Standard temporal producer. */
  temporalContributorCount(): number {
    return this.frame.length;
  }

  /** Write owned rows, then observe the delta. */
  apply(
    operations: readonly RenderSceneOperation[],
    spans: readonly WorldTransformSpan[] = [],
  ): RenderSceneApplyResult {
    if (!this.ownsRows) throw new Error('A view over shared rows observes its owner’s deltas');
    let scans = operations.length;
    for (const span of spans) scans += span.entities.length;
    // One read generation per row write; every view of the write shares it.
    rotateMeshDraws();
    const delta = this.rows.apply(operations, spans);
    this.observe(delta, scans);
    return delta;
  }

  /**
   * Consume one committed row delta: view-private dirty tracking, draw
   * addresses and memos follow, and the view pins the rows it now matches.
   */
  observe(delta: RenderSceneApplyResult, scans = 0): void {
    const changed = delta.created + delta.updated + delta.removed + delta.recreated > 0;
    this.renderableScans = scans;
    if (changed || scans > 0) this.deltaFrames += 1;
    else this.noChangeFrames += 1;
    if (!changed) {
      this.pin();
      return;
    }
    // Prior records come from the delta. A slot first written by a create or
    // recreate was free unless a removal recorded it earlier.
    const history = this.history;
    for (const record of delta.removedSlots) {
      history.record(record.slot, record);
      this.meshDrawSlots.release(record);
    }
    for (const before of delta.previous.values()) history.record(before.slot, before);
    for (const record of delta.createdSlots) {
      this.meshDrawSlots.releaseStale(record);
      history.record(record.slot, undefined);
    }
    for (const record of delta.recreatedSlots) {
      this.meshDrawSlots.releaseStale(record);
      history.record(record.slot, undefined);
    }
    this.revision += 1;
    this.pin();
    this.invalidateSnapshots();
  }

  /** Seed a cold view from the owner's complete current rows. */
  observeBaseline(): RenderSceneApplyResult {
    this.pin();
    const delta = sceneSnapshotDelta(this.frame);
    this.history = SubmittedHistory.cut();
    this.revision += 1;
    this.fullRebuilds += 1;
    this.invalidateSnapshots();
    return delta;
  }

  /** Rows revision this view last observed; a delta applies only on top of it. */
  get observedRows(): number {
    return this.observedRowsRevision;
  }

  private pin(): void {
    this.observedRowsRevision = this.rows.revision;
    this.frame = this.rows.capture();
    this.meshes = this.rows.meshFrame();
    this.preparation = this.rows.pipelinePreparationSlots;
  }

  /** Rebind positional World indices while retaining stable slot and submission history. */
  remapWorlds(indices: readonly number[]): void {
    this.rows.remapWorlds(indices);
    this.pin();
    this.invalidateSnapshots();
  }

  /** The owner remapped the shared rows' World indices; the next observed delta re-pins them. */
  observeRemap(): void {
    this.invalidateSnapshots();
  }

  /** Reconcile the current identity set while retaining slots for survivors. */
  reset(snapshots: FrameList<RenderableSnapshot>, countAsRebuild = true): void {
    // A full reconciliation is a temporal cut.  Survivors may keep their
    // stable slot, but no prior slot is valid until this frame submits.
    this.temporalBySlot = new GenerationalWeakMap();
    this.history = SubmittedHistory.cut();
    const before = this.frame;
    this.rows.reconcile(snapshots);
    this.pin();
    for (const record of before)
      if (this.frame.slotAt(record.slot)?.generation !== record.generation)
        this.meshDrawSlots.release(record);
    for (const record of this.frame) this.meshDrawSlots.releaseStale(record);
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
    // Either edge is a temporal cut: history restarts at the next submission.
    this.history = SubmittedHistory.cut();
    if (!enabled) {
      this.temporalBySlot = new GenerationalWeakMap();
      this.temporalMaterialized = undefined;
    }
  }

  /**
   * Identity of the submitted history temporal draw snapshots read; it
   * changes with every committed submission. Undefined while untracked.
   */
  temporalDrawInputs(): SubmittedHistory | undefined {
    return this.temporalTracking ? this.history : undefined;
  }

  hasSource(kind: 'terrain' | 'glyph' | 'tilemap'): boolean {
    return this.rows.hasSource(kind);
  }

  materialize(): FrameList<RenderableSnapshot> {
    const current = this.frame,
      meshes = this.meshes;
    if (this.materialized?.value.source !== current || this.materialized.meshes !== meshes)
      this.materialized = {
        meshes,
        value: new RetainedFrameProjection(
          current,
          (record) => meshDrawSnapshot(record.snapshot, meshes),
          this.rows.rowFacts(current, meshes),
        ),
      };
    return this.materialized.value;
  }

  lastSubmittedSlotByIndex(slot: number): RenderSceneSlot | undefined {
    return this.history.at(slot, this.frame);
  }

  temporalSnapshotBySlot(
    slot: number,
    resetHistory = false,
  ): RenderableTemporalSnapshot | undefined {
    const current = this.frame.slotAt(slot);
    return current === undefined ? undefined : this.temporalSnapshot(current, resetHistory);
  }

  /** Indexed draw consumption shares the temporal owner used by full view publications. */
  readonly drawSnapshotAt = (
    slot: number,
    counters?: FrameCacheTally,
    meshes = this.meshes,
  ): RenderableSnapshot | undefined => {
    const initial = this.frame.slotAt(slot)?.snapshot;
    const source = initial === undefined ? undefined : meshDrawSnapshot(initial, meshes);
    return source === undefined || !this.temporalTracking
      ? source
      : temporalDrawSnapshot(
          source,
          counters,
          this.frame,
          this.history,
          undefined,
          this.temporalBySlot,
        );
  };

  drawFrame(
    materials: MaterialFrame,
    counters?: FrameCacheTally,
    meshes = this.meshes,
  ): (slot: number) => RenderableSnapshot | undefined {
    const current = this.frame;
    const history = this.history;
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
          : temporalDrawSnapshot(source, counters, current, history, materials, memo);
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
   * per-record temporal memo. Submitted records come from the write-time
   * history, which holds only rows changed since that submission.
   */
  materializeTemporal(
    counters: FrameCacheTally,
    materials: MaterialFrame,
    unavailable?: FrameSet,
  ): FrameList<RenderableSnapshot> {
    const current = this.frame,
      history = this.history,
      meshes = this.meshes;
    const previous = this.temporalMaterialized;
    if (
      previous !== undefined &&
      previous.current === current &&
      previous.history === history &&
      previous.materials === materials &&
      previous.meshes === meshes &&
      previous.unavailable === unavailable
    )
      return previous.value;
    const memo = this.temporalBySlot;
    // The unavailable roster is live; only a fixed frame without it retains rows.
    const project = (record: RenderSceneSlot): RenderableSnapshot => {
      // Pending source rows are retained for retry but have no accepted material.
      // Keep them hidden before consuming temporal facts from the accepted root.
      if (unavailable?.has(record.slot)) return { ...record.snapshot, authorVisible: false };
      return temporalDrawSnapshot(
        meshDrawSnapshot(record.snapshot, meshes),
        counters,
        current,
        history,
        materials,
        memo,
      );
    };
    // The temporal row keeps its draw projection's LOD levels, so the Scene's
    // maintained facts hold; sparse rows yield the same temporal projection.
    const value =
      unavailable === undefined
        ? new RetainedFrameProjection(
            current,
            project,
            this.rows.rowFacts(current, meshes, project),
          )
        : new FrameProjection(current, project);
    this.temporalMaterialized = {
      current,
      history,
      materials,
      meshes,
      unavailable,
      value,
    };
    return value;
  }

  wasLastSubmittedVisible(slot: number, generation: number): boolean {
    return this.history.wasVisible(slot, generation, this.frame);
  }

  /**
   * `roster` states that `visible` covers that whole slot roster (a GPU-owned
   * frame), so no visible slot is visited.
   */
  captureSubmission(
    visible: Iterable<Pick<RenderableSnapshot, 'worldId' | 'entityKey'>>,
    roster?: SceneSlotFrame,
  ): RenderSceneSubmissionCapture {
    if (roster !== undefined) return { revision: this.revision, visible: undefined };
    const slots = new Map<number, number>();
    for (const snapshot of visible) {
      const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
      if (slot !== undefined) slots.set(slot.slot, slot.generation);
    }
    return { revision: this.revision, visible: slots };
  }

  /** Receipt of a submitted frame: the rows it drew become the history's origin. */
  commitSubmission(capture: RenderSceneSubmissionCapture): void {
    if (capture.revision !== this.revision) {
      throw new RangeError('render scene changed while its temporal submission was active');
    }
    this.history = SubmittedHistory.submitted(capture.visible, this.history);
  }

  /** O(1) current record by stable slot index; bound so frame state can publish it. */
  readonly slotAt = (slot: number): RenderSceneSlot | undefined => this.frame.slotAt(slot);

  slotsSnapshot(): SceneSlotFrame {
    return this.frame;
  }

  /** Cheap owner revision for retained derived projections. */
  revisionValue(): number {
    return this.revision;
  }

  readonly slot = (worldId: number, entityKey: number): RenderSceneSlot | undefined => {
    return this.lookup(worldId, entityKey);
  };

  /** Current slot of a projected snapshot: one identity-root descent. */
  slotOf(snapshot: RenderableSnapshot): RenderSceneSlot | undefined {
    return this.lookup(snapshot.worldId, snapshot.entityKey);
  }

  has(worldId: number, entityKey: number): boolean {
    return this.lookup(worldId, entityKey) !== undefined;
  }

  snapshot(worldId: number, entityKey: number): RenderableSnapshot | undefined {
    return this.lookup(worldId, entityKey)?.snapshot;
  }

  pointsLinesSnapshots(): readonly PointsLinesRetainedSnapshot[] {
    return this.rows.pointsLinesSnapshots(this.frame);
  }

  /** Explicit inspection query; asset adoption never enumerates material users. */
  slotsForMaterial(materialHandle: number): FrameList<RenderSceneSlot> {
    const records: RenderSceneSlot[] = [];
    for (const record of this.frame) {
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
    return this.rows.querySpatial(bounds, this.frame);
  }

  get contentRevision(): number {
    return this.revision;
  }

  get recordCount(): number {
    return this.frame.length;
  }
  get slotCapacity(): number {
    return this.frame.capacity;
  }
  instanceBoundsStatistics(): ReturnType<InstanceBoundsCache['inspect']> {
    return this.rows.instanceBoundsStatistics();
  }

  inspect(): RenderSceneInspection {
    return {
      records: this.frame.map(({ slot, generation, worldId, entityKey }) => ({
        slot,
        generation,
        worldId,
        entityKey,
      })),
      slotCapacity: this.frame.capacity,
      freeSlots: this.rows.freeSlotCount,
      revision: this.revision,
      noChangeFrames: this.noChangeFrames,
      deltaFrames: this.deltaFrames,
      renderableScans: this.renderableScans,
      fullRebuilds: this.fullRebuilds,
      resyncs: this.resyncs,
      lastResyncReason: this.lastResyncReason,
      instanceBoundsCache: this.rows.instanceBoundsStatistics(),
    };
  }

  private lookup(worldId: number, entityKey: number): RenderSceneSlot | undefined {
    return this.frame.lookup(worldId, entityKey);
  }

  private temporalSnapshot(
    slot: RenderSceneSlot,
    resetHistory = false,
    displacementSource = hasDisplacementSource(meshDrawMaterials(slot.snapshot, this.meshes)),
  ): RenderableTemporalSnapshot {
    return createTemporalSnapshot(slot, resetHistory, this.frame, this.history, displacementSource);
  }

  private invalidateSnapshots(): void {
    this.materialized = undefined;
    this.temporalMaterialized = undefined;
  }

  cullingWorldBoundsAt(
    slot: RenderSceneSlot,
    meshes = this.meshes,
    materials?: MaterialFrame,
  ): RenderSceneBounds | undefined {
    return this.rows.cullingWorldBoundsAt(slot, meshes, materials);
  }

  writeCullingWorldBoundsAt(
    slot: RenderSceneSlot,
    out: box3.Box3,
    meshes = this.meshes,
    materials?: MaterialFrame,
    skin?: SkinSceneFrame,
  ): boolean {
    return this.rows.writeCullingWorldBoundsAt(slot, out, meshes, materials, skin);
  }

  instanceRowBoxesAt(slot: RenderSceneSlot): Float32Array | undefined {
    return this.rows.instanceRowBoxesAt(slot);
  }

  cullingWorldBounds(snapshot: RenderableSnapshot): RenderSceneBounds | undefined {
    const slot = this.lookup(snapshot.worldId, snapshot.entityKey);
    return slot === undefined ? worldBounds(snapshot) : this.cullingWorldBoundsAt(slot);
  }
}

/** Project a complete retained scene through the same writer as frame deltas. */
/** The draw's own Scene row when it still names this source. */
export function sceneRow(
  row: RenderSceneSlot | undefined,
  source: RenderableSnapshot,
): RenderSceneSlot | undefined {
  return row !== undefined && row.worldId === source.worldId && row.entityKey === source.entityKey
    ? row
    : undefined;
}

export function sceneSnapshotDelta(slots: FrameList<RenderSceneSlot>): RenderSceneApplyResult {
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
    previous: new Map(),
    resynced: 1,
  };
}
