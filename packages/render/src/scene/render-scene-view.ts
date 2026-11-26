import type { World } from '@forgeax/engine-ecs';
import type { box3 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { type RenderResidencySelection, residencySelected } from '../gpu-driven/batch-residency';
import type { InstanceBoundsCacheInspection } from '../instances-derived-bounds';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { RenderResourceScope } from '../publication/resource-scope';
import { addressDrawRows, isOrdinarySceneDrawTable } from '../record/draw-row-pages';
import type { DrawRows, ValidatedRenderable } from '../record/frame-snapshot';
import { MeshDrawSlots } from '../record/mesh-draw-slots';
import { type NativeDrawRoster, NativeDrawRosterOwner } from '../record/native-draw-roster';
import type { CameraSnapshot } from '../render-contract';
import { cameraAdmitsLayers } from '../render-layers';
import type { RenderableSnapshot, RenderableTemporalSnapshot } from '../render-system-extract';
import {
  type FrameList,
  FrameListBase,
  FrameProjection,
  RetainedFrameProjection,
} from './frame-list';
import type { FrameSet } from './frame-set';
import { GenerationalWeakMap } from './generational-weak-map';
import { MaterialFrame } from './material-dispatch';
import { slotContent, slotDrawMaterials, slotDrawSnapshot } from './mesh-draw';
import type { MeshFrame } from './mesh-frame';
import type { SlotCameraVisibility } from './persistent-cull';
import { attachProbeRecord, type ProbeAttachMemo } from './probe-attach';
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
  GpuSceneMotion,
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneInspection,
  RenderSceneOperation,
  RenderSceneRecord,
  RenderSceneResyncReason,
  RenderSceneSlot,
  SceneRowGeometry,
} from './render-scene-types';
import type { RowContent } from './row-contents';
import {
  type SceneRowPreparation,
  SceneRows,
  type SceneRowWriteAccess,
  type WorldTransformSpan,
} from './scene-rows';
import { type SceneGeneratedSource, SceneSlotFrame } from './scene-slots';
import { SelectedSceneDrawRows } from './selected-draw-rows';
import type { SkinSceneFrame } from './skin-scene-inputs';

export type SurfaceColumnReader<T> = (
  entityKey: number,
  content: RowContent | undefined,
  materials: Pick<RenderableSnapshot, 'material' | 'materials'> | undefined,
) => T;

/** Captured native columns; this delegates to existing Mesh binding ownership, never a row cache. */
class SceneSurfaceRows {
  constructor(
    readonly source: SceneSlotFrame,
    readonly project: (record: RenderSceneSlot) => RenderableSnapshot,
    private readonly meshes: MeshFrame,
    private readonly sourceLodCount: number,
    private readonly materials?: MaterialFrame,
    private readonly unavailable?: FrameSet,
    private readonly residencySelection?: RenderResidencySelection,
    readonly fixedMaterialReads = MaterialFrame.fixedProgramRoot(materials) !== undefined,
  ) {
    Object.freeze(this);
  }

  /** A slot walk sees the same authored visibility as this public row sequence. */
  permitsSlotCull(selection: RenderResidencySelection | undefined): boolean {
    return (this.unavailable?.size ?? 0) === 0 && this.residencySelection === selection;
  }

  cullContent(content: RowContent): RowContent {
    return this.source.drawContent(content, this.meshes);
  }

  /** The Mesh owns these levels unless this exact projection uses the authored row. */
  visitLodCandidates(visit?: (row: RenderableSnapshot) => void, members?: FrameSet): number {
    if (this.permitsSlotCull(undefined)) {
      if (this.sourceLodCount === 0) return 0;
      if (visit === undefined && members === undefined) return this.sourceLodCount;
      if (visit === undefined && this.sourceLodCount === this.source.length)
        return members?.size ?? this.source.length;
    }
    let count = 0;
    const read = (content: RowContent, _entity: number, slot: number): undefined => {
      let levels = content.lods;
      if (
        content.terrain === undefined &&
        content.materialOverrides !== undefined &&
        !this.unavailable?.has(slot) &&
        (this.residencySelection === undefined ||
          residencySelected(this.residencySelection, content.residencyGroup))
      ) {
        const mesh = this.meshes.get(content.assetHandle);
        if (mesh !== undefined) levels = mesh.lods;
      }
      if ((levels?.length ?? 0) !== 0) {
        count++;
        if (visit !== undefined) {
          const record = this.source.slotAt(slot);
          if (record !== undefined) visit(this.project(record));
        }
      }
      return undefined;
    };
    this.source.findContent(read, members);
    return count;
  }

  /** A cull judges accepted material dependencies without constructing current or previous poses. */
  validateCullContent(content: RowContent): void {
    if (this.materials !== undefined && content.authorVisible !== false)
      hasDisplacementSource(this.cullContent(content), this.materials);
  }

  /** All ranks and physical slots in a synchronous surface walk share one material reader. */
  surfaceWalk(visit: SurfaceColumnReader<void>, members?: FrameSet) {
    const consume = (content: RowContent, entity: number, slot: number): true => {
      if (
        this.residencySelection !== undefined &&
        !residencySelected(this.residencySelection, content.residencyGroup)
      )
        visit(-1, undefined, undefined);
      else this.consume(content, entity, slot, visit);
      return true;
    };
    const readSlot = (slot: number | undefined): void => {
      if (slot === undefined || this.source.readContentSlot(slot, consume) !== true)
        visit(-1, undefined, undefined);
    };
    return {
      // Dispatch ranks and physical addresses coincide with this roster only for a full view.
      roster: members === undefined ? this.source : undefined,
      readSlot,
      readRank: (rank: number): void => {
        if (members !== undefined) readSlot(members.at(rank));
        else if (this.source.readContentAt(rank, consume) !== true) visit(-1, undefined, undefined);
      },
    };
  }

  /** Read the exact current displayed geometry and material binding without producing a pose. */
  findDrawContent<T>(
    requireMaterials: boolean,
    read: (entity: number, content: RowContent) => T | undefined,
    members?: FrameSet,
  ): T | undefined {
    const consume = (content: RowContent, entity: number, slot: number) => {
      if (
        (this.residencySelection !== undefined &&
          !residencySelected(this.residencySelection, content.residencyGroup)) ||
        this.unavailable?.has(slot) === true
      )
        return read(entity, content);
      if (!requireMaterials && this.materials === undefined) return read(entity, content);
      const draw = this.source.drawContent(content, this.meshes);
      if (this.materials !== undefined && draw.authorVisible !== false)
        hasDisplacementSource(draw, this.materials);
      return read(entity, draw);
    };
    return this.source.findContent(consume, members);
  }

  private consume<T>(
    content: RowContent,
    entityKey: number,
    slot: number,
    read: SurfaceColumnReader<T>,
  ): T {
    const pending = this.unavailable?.has(slot) === true;
    const materials = pending ? content : this.source.drawMaterials(content, this.meshes);
    // Keep accepted-material validation identical for rank and physical-slot reads.
    if (!pending && this.materials !== undefined && content.authorVisible !== false)
      hasDisplacementSource(materials, this.materials);
    return read(entityKey, content, materials);
  }
}

// Producer projection ownership only; no row, contributor, or result is cached here.
const surfaceProjectionOwners = new WeakMap<object, SceneSurfaceRows>();

/** Fixed frame rows with one-for-one generated draws. Unrelated rows keep their native address. */
export class GeneratedViewRows extends FrameProjection<RenderableSnapshot, RenderableSnapshot> {
  constructor(
    source: FrameList<RenderableSnapshot>,
    readonly draws: readonly RenderableSnapshot[],
    replacements: ReadonlyMap<number, RenderableSnapshot>,
  ) {
    super(source, (row, rank) => replacements.get(rank) ?? row);
  }
}

/** An authored view producer can replace members in place without visiting ordinary meshes. */
export function projectViewSources(
  rows: FrameList<RenderableSnapshot>,
  project: (source: RenderableSnapshot, rank: number) => RenderableSnapshot,
): FrameList<RenderableSnapshot> {
  const reader = surfaceProjectionOwners.get(rows);
  if (
    reader === undefined ||
    FrameProjection.rowReaderOf(rows, rows.at) !== reader ||
    FrameProjection.iterationReaderOf(rows) !== reader ||
    rows.map !== FrameListBase.prototype.map ||
    !SceneSlotFrame.hasNativeAt(reader.source) ||
    !SceneSlotFrame.hasNativeIteration(reader.source)
  )
    return rows.map(project);
  const members = reader.source.indexedSlots('viewSource');
  if (members === undefined) return rows.map(project);
  const replacements = new Map<number, RenderableSnapshot>();
  const draws: RenderableSnapshot[] = [];
  for (const slot of members.borrowKeys()) {
    const rank = reader.source.indexOfSlot(slot);
    if (rank === undefined) throw new Error('Missing captured view source slot');
    const row = rows.at(rank);
    if (row === undefined) throw new Error('Missing captured view source row');
    const next = project(row, rank);
    if (next !== row) replacements.set(rank, next);
    if (next.terrainSection !== undefined || next.generatedMesh !== undefined) draws.push(next);
  }
  return new GeneratedViewRows(rows, draws, replacements);
}

/** Custom/overridden indexed projections retain their exact ordinary at call. */
export function sceneSurfaceRowsOf(
  list: FrameList<unknown>,
  at: unknown,
): SceneSurfaceRows | SelectedSceneDrawRows | undefined {
  if (SelectedSceneDrawRows.indexed(list, at) && SceneSlotFrame.hasNativeAt(list.source))
    return list;
  const reader = FrameProjection.rowReaderOf(list, at);
  return reader instanceof SceneSurfaceRows &&
    surfaceProjectionOwners.get(list) === reader &&
    SceneSlotFrame.hasNativeAt(reader.source)
    ? reader
    : undefined;
}

/** Per-pass counts may use the captured skin membership only for this exact native address domain. */
export function sceneSkinSlotsOf(
  rows: FrameList<Pick<RenderableSnapshot, 'skinBinding' | 'material' | 'materials'>>,
  source: SceneSlotFrame,
): FrameSet | undefined {
  const owner = surfaceProjectionOwners.get(rows);
  if (
    owner === undefined ||
    owner.source.identities !== source.identities ||
    !owner.permitsSlotCull(undefined) ||
    FrameProjection.rowReaderOf(rows, rows.at) !== owner ||
    !SceneSlotFrame.hasNativeAt(owner.source)
  )
    return undefined;
  return owner.source.indexedSlots('skin');
}

export function sceneDrawContentOf(
  list: Iterable<Pick<RenderableSnapshot, 'entityKey'>>,
): SceneSurfaceRows | undefined {
  const owner = surfaceProjectionOwners.get(list);
  return owner !== undefined &&
    FrameProjection.iterationReaderOf(list) === owner &&
    SceneSlotFrame.hasNativeIteration(owner.source)
    ? owner
    : undefined;
}

interface AddressedMeshRows {
  readonly shadowRows?: DrawRows;
  readonly rows: DrawRows;
  readonly capacity: number;
}

/** One view's prepared submission: its rows revision and the slots it drew visible. */
export interface RenderSceneSubmissionCapture {
  readonly revision: number;
  /** Fixed admitted slots or borrowed generations. Absent when the whole roster was visible. */
  readonly visible: import('./render-scene-snapshots').SubmittedVisibility | undefined;
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
  private readonly rowWrites: SceneRowWriteAccess | undefined;
  private frame: SceneSlotFrame;
  private meshes: MeshFrame;
  private preparation: FrameSet;
  private readonly meshDrawSlots = new MeshDrawSlots();
  private readonly nativeDrawRoster = new NativeDrawRosterOwner();
  private meshDrawFrame:
    | {
        readonly primary: DrawRows;
        readonly shadow: DrawRows;
        readonly frame: SceneSlotFrame;
        readonly roster: NativeDrawRoster;
      }
    | undefined;
  /** The current physical draw publication of this view. Captured frames own their returned rows. */
  private addressedMeshDraws:
    | {
        readonly inputs: DrawRows;
        readonly shadow: DrawRows | undefined;
        readonly value: AddressedMeshRows;
        readonly frame: SceneSlotFrame;
        readonly revision: number;
      }
    | undefined;
  private temporalTracking = false;
  private history = SubmittedHistory.cut();
  private materialized:
    | {
        readonly residencySelection: RenderResidencySelection | undefined;
        readonly meshes: MeshFrame;
        readonly fixedMaterialReads: boolean;
        readonly value: FrameProjection<RenderSceneSlot, RenderableSnapshot>;
      }
    | undefined;
  private temporalMaterialized:
    | {
        readonly residencySelection: RenderResidencySelection | undefined;
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
  constructor(source?: RenderResourceScope | SceneRows, stageRows?: SceneRowWriteAccess) {
    if (source instanceof SceneRows) {
      this.rows = source;
      this.ownsRows = false;
      this.rowWrites = stageRows;
    } else {
      this.rows = new SceneRows(source);
      this.ownsRows = true;
      this.rowWrites = this.rows;
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
    this.meshDrawSlots.clear();
    this.nativeDrawRoster.clear();
    this.meshDrawFrame = undefined;
    this.addressedMeshDraws = undefined;
    this.pin();
  }
  setSource(source: RenderResourceScope | undefined): void {
    if (this.ownsRows) this.rows.setSource(source);
  }

  meshFrame(): MeshFrame {
    return this.meshes;
  }

  /** Read the shared rows' current Mesh frame after the owner adopted geometry. */
  observeMeshes(): void {
    this.meshes = this.rows.meshFrame();
  }

  /** Direct asset evidence changes one shared geometry row, without visiting its instances. */
  adoptMesh(handle: number, mesh: MeshAsset | undefined): boolean {
    const adopted = this.ownsRows
      ? this.rows.adoptMesh(handle, mesh)
      : this.rows.holdsMesh(handle) && mesh !== undefined;
    this.meshes = this.rows.meshFrame();
    return adopted;
  }

  get pipelinePreparationSlots(): FrameSet {
    return this.preparation;
  }

  beginMeshDrawFrame(sources?: Iterable<RenderableSnapshot>): void {
    this.addressedMeshDraws = undefined;
    if (sources !== undefined) this.meshDrawFrame = undefined;
    this.meshDrawSlots.beginFrame(
      sources === undefined ? undefined : this.captureMeshDrawRoster(sources),
    );
  }

  /** Native emitted rows retain their membership across unchanged submissions. */
  beginOwnedMeshDrawFrame(
    primary: DrawRows,
    shadow: DrawRows,
    nativeStart = 0,
    nativeEnd = primary.length,
  ): void {
    const previous = this.meshDrawFrame;
    if (
      previous?.frame === this.frame &&
      previous.primary === primary &&
      (previous.shadow === shadow || (previous.shadow.length === 0 && shadow.length === 0))
    ) {
      this.meshDrawSlots.beginFrame(previous.roster);
      return;
    }
    const roster = this.captureMeshDrawRoster(
      (function* () {
        for (let index = nativeStart; index < nativeEnd; index++)
          yield (primary.at(index) as ValidatedRenderable).source;
        if (!isOrdinarySceneDrawTable(shadow)) for (const row of shadow) yield row.source;
      })(),
    );
    this.meshDrawSlots.beginFrame(roster);
    this.meshDrawFrame = { frame: this.frame, primary, shadow, roster };
  }

  private captureMeshDrawRoster(sources: Iterable<RenderableSnapshot>): NativeDrawRoster {
    const scene = this;
    return this.nativeDrawRoster.capture(
      (function* () {
        // beginFrame consumes each pair before advancing this private iterator.
        let draw: { record: RenderSceneRecord; key: string } | undefined;
        for (const source of sources) {
          const key =
            source.nativeDraw?.key ??
            (source.terrainSection === undefined
              ? undefined
              : `section:${source.terrainSection.index}`);
          if (key === undefined) continue;
          const record = scene.lookup(source.entityKey);
          if (record === undefined) throw new Error('A draw must belong to the retained Scene');
          if (draw === undefined) draw = { record, key };
          else {
            draw.record = record;
            draw.key = key;
          }
          yield draw;
        }
      })(),
    );
  }

  readonly allocatedSourceAddress = (record: RenderSceneSlot): number | undefined =>
    this.meshDrawSlots.sourceAddress(record);

  /** Attach stable physical addresses without modifying the phase's immutable rows. */
  addressOwnedMeshDrawRows(inputs: DrawRows, shadowInputs?: DrawRows): AddressedMeshRows {
    const previous = this.addressedMeshDraws;
    const shadow =
      shadowInputs !== undefined && isOrdinarySceneDrawTable(shadowInputs)
        ? shadowInputs
        : undefined;
    if (
      previous?.inputs === inputs &&
      previous.shadow === shadow &&
      previous.frame === this.frame &&
      previous.revision === this.meshDrawSlots.revision
    )
      return previous.value;
    const before = previous?.revision === this.meshDrawSlots.revision ? previous : undefined;
    const primary = addressDrawRows(inputs, before?.inputs, before?.value.rows, this.addressDraw);
    const caster =
      shadow === undefined
        ? undefined
        : addressDrawRows(shadow, before?.shadow, before?.value.shadowRows, this.addressDraw);
    const value =
      caster === undefined
        ? primary
        : {
            rows: primary.rows,
            shadowRows: caster.rows,
            capacity: Math.max(primary.capacity, caster.capacity),
          };
    this.addressedMeshDraws = {
      inputs,
      shadow,
      value,
      frame: this.frame,
      revision: this.meshDrawSlots.revision,
    };
    return value;
  }

  private readonly addressDraw = (
    entry: ValidatedRenderable,
    old?: ValidatedRenderable,
    placed?: ValidatedRenderable,
  ): ValidatedRenderable => {
    const meshSlot = this.meshDrawSlot(entry.source, false, entry.sceneSlot);
    if (entry.meshSlot === meshSlot && entry.foldedMeshSlot === undefined) return entry;
    if (old === entry && placed?.meshSlot === meshSlot) return placed;
    if (entry.foldedMeshSlot === undefined) return { ...entry, meshSlot };
    const { foldedMeshSlot: _folded, ...ordinary } = entry;
    return { ...ordinary, meshSlot };
  };

  /** Source, terrain and folded draws share addresses across this view and its captures. */
  meshDrawSlot(source: RenderableSnapshot, folded = false, row?: RenderSceneSlot): number {
    const record = sceneRow(row, source) ?? this.lookup(source.entityKey);
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
  prepareRow(snapshot: RenderableSnapshot): SceneRowPreparation {
    if (this.rowWrites === undefined)
      throw new Error('Only the Scene row owner prepares source identities');
    const task = this.rowWrites.prepareRow(snapshot);
    const { entityKey, slot, generation } = task.row;
    let owner: RenderScene | undefined = this;
    let published = false;
    const api: SceneRowPreparation = Object.freeze({
      get row() {
        return task.row;
      },
      isCurrent: () => owner !== undefined && task.isCurrent(),
      publish: (publication?: SceneRowGeometry) => {
        const target = owner;
        if (target === undefined) throw new Error('Scene row preparation is closed');
        const delta = task.publish(publication);
        published = true;
        target.observe(delta, 1);
        owner = undefined;
        return delta;
      },
      release: () => {
        const row = owner !== undefined && published ? owner.rows.lookup(entityKey) : undefined;
        if (row?.slot === slot && row.generation === generation)
          throw new Error('A partially observed Scene row retains its cleanup responsibility');
        task.release();
        owner = undefined;
      },
    });
    return api;
  }

  /** Consume the disjoint rows from one local ECS presentation query. */
  applyPresentationSpans(
    spans: readonly import('@forgeax/engine-scene/internal').PresentationSpan[],
  ): RenderSceneApplyResult {
    if (!this.ownsRows) throw new Error('Local ECS presentation requires an owned Scene');
    const delta = this.rows.commitPresentationSpans(spans);
    let scans = 0;
    for (const span of spans) scans += span.entities.length;
    this.observe(delta, scans);
    return delta;
  }

  apply(
    operations: readonly RenderSceneOperation[],
    spans: readonly WorldTransformSpan[] = [],
    sourceColumnWorld?: World,
  ): RenderSceneApplyResult {
    if (this.rowWrites === undefined)
      throw new Error('A view over shared rows observes its owner’s deltas');
    let scans = operations.length;
    for (const span of spans) scans += span.entities.length;
    const delta =
      sourceColumnWorld !== undefined && operations.length === 0
        ? this.rowWrites.commitTransformSpans(spans, sourceColumnWorld)
        : this.rowWrites.apply(operations, spans);
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
    if (delta.removed > 0 || delta.recreated > 0) this.addressedMeshDraws = undefined;
    for (const record of delta.removedSlots) {
      history.record(record.slot, record);
      this.meshDrawSlots.release(record);
    }
    if (!history.isCut)
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
    this.observeCurrentRows();
    return sceneSnapshotDelta(this.frame);
  }

  /** Catch up after multiple writes without materializing a full publication. */
  observeCurrentRows(): void {
    const before = this.frame;
    this.pin();
    const frame = this.frame;
    const retire = (record: RenderSceneSlot) => {
      if (frame.slotAt(record.slot)?.generation !== record.generation) {
        this.addressedMeshDraws = undefined;
        this.meshDrawSlots.release(record);
      }
    };
    if (
      !frame.visitChangedVersions(before, (slot) => {
        const record = before.slotAt(slot);
        if (record !== undefined) retire(record);
      })
    )
      for (const record of before) retire(record);
    this.history = SubmittedHistory.cut();
    this.revision += 1;
    this.fullRebuilds += 1;
    this.invalidateSnapshots();
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

  /** The owner remapped the shared rows' World indices; the next observed delta re-pins them. */
  observeRemap(): void {
    this.invalidateSnapshots();
  }

  /** Reconcile the current identity set while retaining slots for survivors. */
  reset(snapshots: FrameList<RenderableSnapshot>, countAsRebuild = true): void {
    this.addressedMeshDraws = undefined;
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

  hasSource(kind: SceneGeneratedSource): boolean {
    return this.rows.hasSource(kind);
  }

  materialize(
    residencySelection?: RenderResidencySelection,
    bindings?: MaterialFrame,
  ): FrameList<RenderableSnapshot> {
    const fixedMaterialReads = MaterialFrame.fixedProgramRoot(bindings) !== undefined;
    const current = this.frame,
      meshes = this.meshes;
    if (
      this.materialized?.value.source !== current ||
      this.materialized.meshes !== meshes ||
      this.materialized.fixedMaterialReads !== fixedMaterialReads ||
      this.materialized.residencySelection !== residencySelection
    ) {
      const project = (record: RenderSceneSlot) =>
        residencySelection !== undefined &&
        !residencySelected(residencySelection, slotContent(record).residencyGroup)
          ? record.snapshot
          : slotDrawSnapshot(record, meshes);
      const reader = new SceneSurfaceRows(
        current,
        project,
        meshes,
        this.rows.lodCandidateCount,
        undefined,
        undefined,
        residencySelection,
        fixedMaterialReads,
      );
      this.materialized = {
        fixedMaterialReads,
        residencySelection,
        meshes,
        value: new RetainedFrameProjection(
          current,
          project,
          this.rows.rowFacts(current, meshes, project),
          reader,
        ),
      };
      surfaceProjectionOwners.set(this.materialized.value, reader);
    }
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

  /** The upload consumes each result before reading the next row. Capture one frame and scratch. */
  gpuMotionReader(resetHistory = false) {
    const frame = this.frame;
    const history = this.history;
    const meshes = this.meshes;
    const motion: GpuSceneMotion = {
      motionValid: false,
      reactive: false,
      previousInstances: undefined,
    };
    return (record: RenderSceneSlot): Readonly<GpuSceneMotion> | undefined => {
      const slot = frame.slotAt(record.slot);
      if (slot === undefined) return undefined;
      const submitted = resetHistory ? undefined : history.before(slot);
      return createTemporalSnapshot(
        slot,
        submitted,
        submitted !== undefined && history.admitted(submitted),
        hasDisplacementSource(slotDrawMaterials(slot, meshes)),
        motion,
      );
    };
  }

  /** Indexed draw consumption shares the temporal owner used by full view publications. */
  readonly drawSnapshotAt = (
    slot: number,
    counters?: FrameCacheTally,
    meshes = this.meshes,
  ): RenderableSnapshot | undefined => {
    const initial = this.frame.slotAt(slot);
    if (initial === undefined) return undefined;
    const source = slotDrawSnapshot(initial, meshes);
    return !this.temporalTracking
      ? source
      : temporalDrawSnapshot(
          source,
          counters,
          initial,
          this.history,
          undefined,
          this.temporalBySlot,
        );
  };

  drawFrame(
    materials: MaterialFrame,
    counters?: FrameCacheTally,
    meshes = this.meshes,
    view?: {
      readonly unavailable: Pick<FrameSet, 'has'>;
      readonly probeAt: (slot: number) => RenderableSnapshot['probeBlendRecord'];
      readonly probeMemo: ProbeAttachMemo['bySnapshot'];
      readonly mayHaveWaterSources: boolean;
    },
  ) {
    const current = this.frame;
    const history = this.history;
    const temporal = this.temporalTracking;
    const memo = this.temporalBySlot;
    // Mesh and temporal owners already memoize immutable row versions. A
    // frame-local slot map would register every consumed row again each frame.
    const project = (
      record: RenderSceneSlot,
      camera?: Pick<CameraSnapshot, 'cullMask'>,
      visibility?: SlotCameraVisibility,
    ) => {
      if (view?.unavailable.has(record.slot)) return undefined;
      if (camera !== undefined && visibility !== undefined) {
        const content = slotContent(record);
        if (
          (camera.cullMask !== undefined && !cameraAdmitsLayers(camera, content)) ||
          !visibility.admitsSlot(content, record)
        )
          return undefined;
      }
      const source = slotDrawSnapshot(record, meshes);
      const draw = temporal
        ? temporalDrawSnapshot(source, counters, record, history, materials, memo)
        : source;
      return view === undefined
        ? draw
        : attachProbeRecord(draw, view.probeAt(record.slot), view.probeMemo);
    };
    const at = (slot: number) => {
      const record = current.slotAt(slot);
      return record === undefined ? undefined : project(record);
    };
    return Object.assign(at, {
      locate: current.slotAt,
      project,
      projectCamera: project,
      mayHaveWaterSources: view?.mayHaveWaterSources ?? true,
    });
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
    residencySelection?: RenderResidencySelection,
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
      previous.unavailable === unavailable &&
      previous.residencySelection === residencySelection
    )
      return previous.value;
    const memo = this.temporalBySlot;
    // The unavailable roster is live; only a fixed frame without it retains rows.
    const project = (record: RenderSceneSlot): RenderableSnapshot => {
      if (
        residencySelection !== undefined &&
        !residencySelected(residencySelection, slotContent(record).residencyGroup)
      )
        return record.snapshot;
      // Pending source rows are retained for retry but have no accepted material.
      // Keep them hidden before consuming temporal facts from the accepted root.
      if (unavailable?.has(record.slot)) return { ...record.snapshot, authorVisible: false };
      return temporalDrawSnapshot(
        slotDrawSnapshot(record, meshes),
        counters,
        record,
        history,
        materials,
        memo,
      );
    };
    // The temporal row keeps its draw projection's LOD levels, so the Scene's
    // maintained facts hold; sparse rows yield the same temporal projection.
    const reader = new SceneSurfaceRows(
      current,
      project,
      meshes,
      this.rows.lodCandidateCount,
      materials,
      unavailable,
      residencySelection,
    );
    const value =
      unavailable === undefined
        ? new RetainedFrameProjection(
            current,
            project,
            this.rows.rowFacts(current, meshes, project),
            reader,
          )
        : new FrameProjection(current, project, reader);
    surfaceProjectionOwners.set(value, reader);
    this.temporalMaterialized = {
      residencySelection,
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
    visible: Iterable<Pick<RenderableSnapshot, 'entityKey'>>,
    roster?: SceneSlotFrame,
  ): RenderSceneSubmissionCapture {
    if (roster !== undefined || sceneDrawContentOf(visible)?.source === this.frame)
      return { revision: this.revision, visible: undefined };
    if (SelectedSceneDrawRows.native(visible)) {
      const slots = visible.submittedSlots(this.frame);
      if (slots !== undefined) return { revision: this.revision, visible: slots };
    }
    const slots = new Map<number, number>();
    for (const snapshot of visible) {
      const slot = this.lookup(snapshot.entityKey);
      if (slot !== undefined) slots.set(slot.slot, slot.generation);
    }
    return {
      revision: this.revision,
      visible: slots.size === this.frame.length ? undefined : slots,
    };
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

  readonly slot = (entityKey: number): RenderSceneSlot | undefined => {
    return this.lookup(entityKey);
  };

  /** Current slot of a projected snapshot: one identity-root descent. */
  slotOf(snapshot: RenderableSnapshot): RenderSceneSlot | undefined {
    return this.lookup(snapshot.entityKey);
  }
  has(entityKey: number): boolean {
    return this.lookup(entityKey) !== undefined;
  }
  snapshot(entityKey: number): RenderableSnapshot | undefined {
    return this.lookup(entityKey)?.snapshot;
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
  instanceBoundsStatistics(): InstanceBoundsCacheInspection {
    return this.rows.instanceBoundsStatistics();
  }

  get cullingBoundsBackingBytes(): number {
    return this.rows.cullingBoundsBackingBytes;
  }

  inspect(): RenderSceneInspection {
    return {
      records: this.frame.map(({ slot, generation, entityKey }) => ({
        slot,
        generation,
        entityKey,
      })),
      slotCapacity: this.frame.capacity,
      freeSlots: this.rows.freeSlotCount,
      cullingBoundsBackingBytes: this.cullingBoundsBackingBytes,
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

  private lookup(entityKey: number): RenderSceneSlot | undefined {
    return this.frame.lookup(entityKey);
  }

  private temporalSnapshot(
    slot: RenderSceneSlot,
    resetHistory = false,
    displacementSource = hasDisplacementSource(slotDrawMaterials(slot, this.meshes)),
  ): RenderableTemporalSnapshot {
    const submitted = resetHistory ? undefined : this.history.before(slot);
    return createTemporalSnapshot(
      slot,
      submitted,
      submitted !== undefined && this.history.admitted(submitted),
      displacementSource,
    );
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

  cullingWorldBounds(snapshot: RenderableSnapshot): RenderSceneBounds | undefined {
    const slot = this.lookup(snapshot.entityKey);
    return slot === undefined ? worldBounds(snapshot) : this.cullingWorldBoundsAt(slot);
  }
}

/** Project a complete retained scene through the same writer as frame deltas. */
/** The draw's own Scene row when it still names this source. */
export function sceneRow(
  row: RenderSceneSlot | undefined,
  source: RenderableSnapshot,
): RenderSceneSlot | undefined {
  return row !== undefined && row.entityKey === source.entityKey ? row : undefined;
}

export function sceneSnapshotDelta(slots: FrameList<RenderSceneSlot>): RenderSceneApplyResult {
  const journal = slots instanceof SceneSlotFrame ? slots.journal : undefined;
  return {
    ...(journal === undefined ? {} : { journal }),
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
