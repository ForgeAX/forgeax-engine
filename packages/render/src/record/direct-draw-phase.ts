import { mat4 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import { type PassSelector, RenderQueue } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchSources, MemberCandidates } from '../gpu-driven/batch-members';
import type {
  GpuDrivenBatch,
  GpuDrivenBatchBinding,
  LodHeightCamera,
} from '../gpu-driven/batch-topology';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import { cameraAdmitsLayers } from '../render-layers';
import type {
  CameraAdmission,
  DispatchEntry,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { CapturedSceneTransform } from '../scene/captured-transform';
import { drawChangesSince } from '../scene/draw-evidence';
import type { FrameList } from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
import { TreeFrame } from '../scene/frame-tree-list';
import { type MaterialFrame, usesAcceptedSpriteGeometry } from '../scene/material-dispatch';
import { SceneDrawSlot } from '../scene/mesh-draw';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { type BinnedItem, BinnedPhase, type BinPlacement } from '../systems/binned-phase';
import { matchPass } from '../systems/pass-selector';
import { SortedPhase } from '../systems/sorted-phase';
import { transparentSortValue } from '../systems/transparent-dispatch';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
} from '../systems/transparent-sort-config';
import {
  type ViewDrawOrderKey,
  ViewDrawOrderReader,
  type ViewDrawOrderSelection,
} from '../systems/view-draw-order';
import { selectCpuLodRow } from './cpu-lod';
import { issueDrawRows } from './draw-row-pages';
import type { DrawRows, ValidatedRenderable } from './frame-snapshot';
import { variantSetFromDefines } from './helpers';
import {
  MaterialBindingIndex,
  type MaterialRelationFrame,
  MaterialRelations,
} from './material-binding-index';
import {
  type MaterialPasses,
  type MaterialPassLookup,
  MemberMaterialPasses,
  materialPassLookup,
} from './material-pass-groups';
import type { ScenePassPreparationMemo } from './scene-pass-work';

function invalid(expected: string): never {
  throw new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'prepare direct geometry from the same Scene and material publication as GPU batches',
  });
}

export type DirectDrawScene = Pick<
  PersistentGpuDrivenState,
  'plan' | 'slotAt' | 'drawSnapshotAt' | 'unbatchedSlots' | 'skin' | 'allocatedSourceAddress'
> &
  Partial<Pick<PersistentGpuDrivenState, 'slots' | 'draws'>>;

/** Draw ordering of a sorted (transparent) consumer, read once per sync. */
export interface DirectDrawSort {
  readonly sourceOrder?: ViewDrawOrderSelection | undefined;
  readonly mode: number;
  readonly yzAlpha: number;
  readonly camera: CameraSnapshot | undefined;
  /** Sort every entry, not only queue-selected or blended work. */
  readonly all: boolean;
}

/**
 * One sync's inputs. Equal `selection` tokens prove unchanged `select`
 * answers for every binding whose material version did not change; changed
 * versions re-select only the batches drawing them.
 */
export interface DirectDrawInput {
  /** The recording owner admitted persistent row-material preparation. */
  readonly retainMaterialBindings?: boolean | undefined;
  readonly scene: DirectDrawScene;
  readonly selection: readonly unknown[];
  /** GPU ownership `select` reads; a replacement re-selects only its changed bindings. */
  readonly gpu?: GpuDrawSelection | undefined;
  readonly select: (binding: GpuDrivenBatchBinding) => MaterialSnapshot | undefined;
  readonly meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly sourceScope: RenderResourceScope;
  readonly shadow: boolean;
  /** Accepted material versions the rows read; changed versions requeue their readers. */
  readonly materials: MaterialFrame | undefined;
  /** Validates unbatched and view-owned sources; reports each row's input index. */
  readonly prepareUnbatched: (sources: FrameList<RenderableSnapshot>) => DrawRows;
  /** Material admission of unbatched and view-owned submeshes. */
  readonly admits?: ((material: MaterialResource) => boolean) | undefined;
  readonly viewDraws: FrameList<RenderableSnapshot>;
  /** Material-derived geometry; with a source, that morphed member's own stream. */
  readonly prepareGeometry?:
    | ((
        mesh: MeshGpuHandles,
        material: MaterialSnapshot,
        source?: RenderableSnapshot,
      ) => MeshGpuHandles)
    | undefined;
  /** Camera admission; its fixed evidence names every row whose answer may differ. */
  readonly visible?: ((source: RenderableSnapshot) => boolean) | undefined;
  /** Camera geometry mask; absent for shadow consumers. */
  readonly cullMask?: number;
  readonly admission?: CameraAdmission | undefined;
  /** Camera-dependent row projection (CPU LOD); a changed `lodCamera` re-projects LOD rows. */
  readonly lod?: LodHeightCamera | ((rows: readonly ValidatedRenderable[]) => DrawRows) | undefined;
  /** Facts `lod` reads from the camera; changed tokens re-project LOD rows. */
  readonly lodCamera?: readonly unknown[] | undefined;
  /** Resident geometry versions unbatched validation reads; a change re-reads those rows. */
  readonly geometry?: readonly unknown[] | undefined;
  /** Present for Scene Pass consumers: rows project dispatch entries into Pass bins. */
  readonly entries?:
    | { readonly selector: PassSelector | undefined; readonly temporal?: boolean }
    | undefined;
  readonly sort?: DirectDrawSort | undefined;
}

export interface NativeMeshRowSpan {
  /** Half-open range containing all keyed mesh draws and terrain sections. Empty for ordinary geometry. */
  readonly nativeStart: number;
  readonly nativeEnd: number;
}

/** The sealed row addresses and material dispatch order of one pass. */
export interface DirectDrawOutput extends NativeMeshRowSpan {
  /** Leading rows placed by distinct view dispatch owners, before undispatched rows. */
  readonly dispatchedPrefix?: number | undefined;
  readonly rows: DrawRows;
  readonly dispatch: readonly DispatchEntry[];
  readonly materialPasses?: MaterialPassLookup | undefined;
  /** Persistent entity-to-material facts, independent of pose and recording state. */
  readonly materialRows?: MaterialRelationFrame | undefined;
}

/** Cumulative phase work; tests and benches read deltas. */
export interface DirectDrawPhaseWork {
  /** Copies needed to install a different pass address or material overlay. */
  readdressed: number;
  /** Candidate rows rebuilt from their sources. */
  rebuilt: number;
  /** Batches whose selection or membership was re-judged. */
  batches: number;
  /** Syncs that could not link their evidence and re-read every candidate. */
  cold: number;
  /** Syncs that rebuilt the ordered output. */
  emitted: number;
  /** Rebuilt rows whose bin placements were proven unchanged and kept. */
  retained: number;
  /** Sort values evaluated. */
  evaluated: number;
  /** Adjacent distance-order constraints read to qualify a camera interval. */
  orderConstraints: number;
}

type MutableRow = { -readonly [K in keyof ValidatedRenderable]: ValidatedRenderable[K] };

interface Contribution {
  readonly port: DirectBatchPort;
  readonly generation: number;
  readonly entityKey: number;
  readonly instanceCount: number;
}

interface SelectedBatch {
  readonly batch: GpuDrivenBatch;
  readonly material: MaterialSnapshot;
  /** Material-derived geometry; differs from the resident mesh for derived shapes. */
  readonly mesh: MeshGpuHandles;
  /** Resident geometry a morphed member deforms. */
  readonly base: MeshGpuHandles;
  readonly derived: boolean;
  readonly world: RenderResourceScope;
}

/** One selected physical binding for all its members. A pose never changes its source submesh. */
class DirectBatchPort {
  readonly indices: readonly number[];
  section: MeshGpuHandles['submeshes'][number] | undefined;
  constructor(
    readonly id: number,
    readonly binding: GpuDrivenBatchBinding,
    public current: SelectedBatch,
  ) {
    this.indices =
      binding.drawItemIndex === 0 ? FIRST_SUBMESH : Object.freeze([binding.drawItemIndex]);
    this.section = current.mesh.submeshes[binding.drawItemIndex];
  }

  bind(current: SelectedBatch): void {
    if (this.current.mesh !== current.mesh)
      this.section = current.mesh.submeshes[this.binding.drawItemIndex];
    this.current = current;
  }
}

interface DrawSections {
  readonly port: DirectBatchPort;
  readonly indices: readonly number[];
  readonly assetHandle: RenderableSnapshot['assetHandle'];
  readonly entityKey: number | undefined;
  readonly generation: number | undefined;
}

/** Only multi-section members own a roster. Published rows borrow its immutable indices.
 * Edits to membership or resident geometry retire that selection before the next draw. */
class AdditionalDrawBatches extends Map<number, Contribution> {
  sections: DrawSections | undefined;
}

interface Member {
  /** The change queue can outlive a slot replacement during the same sync. */
  live: boolean;
  changeAddress: number;
  moveAddress: number;
  sortVisit: number;
  readonly key: number;
  /** Scene row address (the entity's GPU row); undefined for a view-owned draw. */
  readonly slot: number | undefined;
  /** The first selected batch in admission order; most geometry has just one. */
  firstBatch: Contribution | undefined;
  additionalBatches: AdditionalDrawBatches | undefined;
  unbatched: boolean;
  /** Current layer and visibility decision, including for rows awaiting geometry. */
  admitted: boolean;
  /** View-owned source of a member without a Scene row. */
  view: RenderableSnapshot | undefined;
  /** This queue visit has received only Scene slot evidence. */
  slotOnly: boolean;
  /** Scene row version the current row was built from. */
  version: number;
  /** Scene row read by the latest rebuild. */
  record: RenderSceneSlot | undefined;
  row: MutableRow | undefined;
  /** The row after camera-dependent projection. */
  drawn: ValidatedRenderable | undefined;
  /** Addressed publication, retained until projection, overlay or compact address changes. */
  published: ValidatedRenderable | undefined;
  /** A native batched row may start at the last issued address and pass state. */
  preaddressed: boolean;
  overlay: DispatchEntry | undefined;
  materials: readonly MaterialResource[];
  meshKey: number | undefined;
  lod: boolean;
  items: readonly DrawItem[];
  materialPasses: MemberMaterialPasses | undefined;
  /** The latest projected row with the geometry and bindings used by the placed items. */
  placed: ValidatedRenderable | undefined;
  placedMaterialEpoch: number;
  placedSelector: PassSelector | undefined;
  /** Compact index in the most recently emitted roster, before the pass offset. */
  outputIndex: number;
  emitted: number;
}

interface DrawItem extends BinnedItem {
  readonly owner: Member;
  readonly bin: number;
  readonly entry: DispatchEntry | undefined;
  publishedEntry?: DispatchEntry;
  /** Sorted phase id, or -1 when the entry keeps its bin position. */
  sortId: number;
}

/** The active change list uses each phase member's own address. Repeated
 * contributions from transforms, materials, residency and visibility enqueue
 * the member once. Retirement and same-slot replacement have distinct identities. */
class ChangedDrawMembers {
  private readonly rows: (Member | undefined)[] = [];
  size = 0;

  constructor(private readonly address: 'changeAddress' | 'moveAddress') {}

  has(member: Member): boolean {
    const index = member[this.address];
    return index >= 0 && this.rows[index] === member;
  }

  add(member: Member): void {
    if (this.address === 'changeAddress') member.slotOnly = false;
    if (!this.has(member)) this.append(member);
  }

  addSlot(member: Member): void {
    if (this.has(member)) return;
    member.slotOnly = true;
    this.append(member);
  }

  private append(member: Member): void {
    member[this.address] = this.size;
    this.rows[this.size++] = member;
  }

  remove(member: Member): void {
    const index = member[this.address];
    if (index < 0 || this.rows[index] !== member) return;
    const last = --this.size;
    if (index !== last) {
      const moved = this.rows[last] as Member;
      this.rows[index] = moved;
      moved[this.address] = index;
    }
    this.rows[last] = undefined;
    member[this.address] = -1;
  }

  forEach(visit: (member: Member) => void): void {
    for (let index = 0; index < this.size; index++) visit(this.rows[index] as Member);
  }

  release(residents: number): void {
    const working = Math.min(this.size, residents);
    if (this.rows.length > Math.max(128, working * 4)) this.rows.length = working;
    this.rows.fill(undefined, 0, this.size);
    this.size = 0;
  }
}

type MemberChanges = ChangedDrawMembers | Set<Member>;

const FIRST_SUBMESH = Object.freeze([0]);
const TAIL = 2 ** 40;
const UNBATCHED_BIN = -1;
const VIEW_BIN = -2;
const ROW_ENTRIES = 64;
const BULK_QUEUE = 256;
const EMPTY_SLOTS: ReadonlySet<number> = new FrameSet();
const meshKeyOf = (handle: number) => handle;

function sortedEntry(entry: DispatchEntry, all: boolean): boolean {
  return all || entry.queue === RenderQueue.Transparent || entry.renderState?.blend !== undefined;
}

function sameTokens(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function sameIndices(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  return left === right || (left !== undefined && right !== undefined && sameTokens(left, right));
}

/** Whether `place` reads the same entries and bins from both rows. */
function samePlacedFacts(before: ValidatedRenderable, after: ValidatedRenderable): boolean {
  const a = before.source;
  const b = after.source;
  return (
    before.mesh === after.mesh &&
    sameIndices(before.submeshIndices, after.submeshIndices) &&
    a.material === b.material &&
    sameTokens(a.materials, b.materials) &&
    a.entityKey === b.entityKey &&
    (a.layer ?? 0) === (b.layer ?? 0) &&
    (a.shadowCaster === false) === (b.shadowCaster === false)
  );
}

/** Whether `read` would index the same materials, Mesh and LOD membership. */
function sameReads(before: RenderableSnapshot, after: RenderableSnapshot): boolean {
  return (
    before.material === after.material &&
    sameTokens(before.materials, after.materials) &&
    before.assetHandle === after.assetHandle &&
    (before.lods?.length ?? 0) > 0 === (after.lods?.length ?? 0) > 0
  );
}

/** Equal arithmetic terms remain a distance tie under motion on a shared axis. */
function equalDistanceTerms(
  left: Float32Array,
  leftOffset: number,
  right: Float32Array,
  rightOffset: number,
  eye: Float64Array,
): boolean {
  for (let axis = 0; axis < 3; axis++) {
    const a = (left[leftOffset + 12 + axis] ?? 0) - (eye[axis] ?? 0);
    const b = (right[rightOffset + 12 + axis] ?? 0) - (eye[axis] ?? 0);
    if (a * a !== b * b) return false;
  }
  return true;
}

function sourceAddress(
  scene: DirectDrawScene,
  record: RenderSceneSlot | undefined,
  source: RenderableSnapshot,
  fallback: number,
): number {
  return record !== undefined &&
    source.nativeDraw === undefined &&
    source.terrainSection === undefined
    ? (scene.allocatedSourceAddress?.(record) ?? fallback)
    : fallback;
}

function keyedDraw(row: ValidatedRenderable | undefined): boolean {
  return row?.source.nativeDraw !== undefined || row?.source.terrainSection !== undefined;
}

/** A fixed residual already owns admission for its slots; the camera tests the remaining rows. */
type AdmissionReads = 'changes' | 'all' | NonNullable<CameraAdmission['residual']>;

function sourceVisible(input: DirectDrawInput, source: RenderableSnapshot): boolean {
  return (
    (input.cullMask === undefined || cameraAdmitsLayers(input, source)) &&
    input.visible?.(source) !== false
  );
}

/**
 * One view's retained direct (CPU-recorded) draws for one consumer: a binned
 * phase whose members are Scene rows addressed by their entity's GPU row,
 * plus the view-owned draws that have no Scene row. A {@link queue} consumes the batch
 * plan's diff, the unbatched set's diff, the Scene's draw evidence, changed
 * materials, flipped camera admission and the selection; only entered, left
 * and changed members are rebuilt and requeued (dequeue before enqueue).
 * Scene Pass consumers bin dispatch entries by (queue, Pass); a sorted
 * consumer feeds its {@link SortedPhase} the same member diffs. {@link emit}
 * publishes the queued rows and material dispatch.
 */
export class DirectDrawPhase {
  private readonly bins = new BinnedPhase<DrawItem>();
  private readonly members = new Map<number, Member>();
  private availableChanges: ChangedDrawMembers | undefined = new ChangedDrawMembers(
    'changeAddress',
  );
  private readonly selected = new Map<number, DirectBatchPort>();
  /** Every plan batch by id, and the batches drawing each material. */
  private readonly known = new Map<number, GpuDrivenBatch>();
  private readonly byMaterial = new Map<MaterialResource, Set<number>>();
  private readonly byBinding = new Map<GpuDrivenBatchBinding, Set<number>>();
  private gpu: GpuDrawSelection | undefined;
  private residents: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles> | undefined;
  private derivedBatches = 0;
  /**
   * Members of a shared morph batch drawing their own deformed stream, with the
   * batch they deform. Morph outputs retire unless resolved, so every sync
   * re-resolves them.
   */
  private readonly morphed = new Map<Member, SelectedBatch>();
  /** Borrowed material publications cannot prove stable Pass identity across replacement. */
  private materialEpoch = 0;
  private readonly materialReaders = new Map<MaterialResource, Set<Member>>();
  private readonly meshReaders = new Map<number, Set<Member>>();
  private readonly lodMembers = new Set<Member>();
  /** Members whose admitted source failed validation; retried every sync. */
  private readonly pending = new Set<Member>();
  private batches: FrameList<GpuDrivenBatch> | undefined;
  private unbatched: ReadonlySet<number> | undefined;
  private draws: PersistentGpuDrivenState['draws'];
  private readonly selection: unknown[] = [];
  private materials: MaterialFrame | undefined;
  private temporalMaterialPasses = false;
  private materialPassGroupsEnabled = false;
  private visibility: ((source: RenderableSnapshot) => boolean) | undefined;
  private admission: CameraAdmission | undefined;
  private cullMask: number | undefined;
  private viewDraws: FrameList<RenderableSnapshot> | undefined;
  private lodCamera: readonly unknown[] = [];
  private lodMode: 'native' | 'external' | 'none' | undefined;
  private geometry: readonly unknown[] = [];
  private sort = new SortedPhase('layered');
  private readonly sourceOrderReader = new ViewDrawOrderReader();
  private sortItems: (DrawItem | undefined)[] = [];
  private sortInputs: DirectDrawSort | undefined;
  private sortVisit = 0;
  private completedSourceOrder: ViewDrawOrderSelection | undefined;
  /** Which entries belong to the currently populated sorted phase. */
  private sortAll: boolean | undefined;
  // Number columns only. The sorting workspace never retains a draw or a material.
  private readonly sortedPositions: number[] = [];
  private readonly sortPermutation: number[] = [];
  private readonly sortValues: number[] = [];
  private sortBins = -1;
  /** Every retained distance value is evaluated at this same eye. */
  private readonly lodWorld = mat4.create();
  private readonly sortEye = new Float64Array([Number.NaN, Number.NaN, Number.NaN]);
  /** Per-axis camera displacement interval preserving the retained order. */
  private readonly sortRange = new Float64Array(6);
  private rangeChanged = -1;
  /** Sorted entries the phase cannot address take the engine sort. */
  private unaddressable = 0;
  /** Geometry publications whose placed work still occupies its emitted address. */
  private readonly movedRows = new ChangedDrawMembers('moveAddress');
  private emittedRevision = -1;
  private emittedSort = -1;
  private emittedOffset = 0;
  private epoch = 0;
  private output: DirectDrawOutput = { rows: [], dispatch: [], nativeStart: 0, nativeEnd: 0 };
  private readonly materialRows = new MaterialRelations();
  private retainBindings = false;
  readonly work: DirectDrawPhaseWork = {
    readdressed: 0,
    rebuilt: 0,
    batches: 0,
    cold: 0,
    emitted: 0,
    retained: 0,
    evaluated: 0,
    orderConstraints: 0,
  };

  /** Only changed accepted values read by this phase can change its value projections. */
  materialValuesChanged(before: MaterialFrame, after: MaterialFrame): boolean {
    if (before === after) return false;
    let changed = false;
    after.changesSince(before, (left, right) => {
      if (left?.snapshot === right?.snapshot) return;
      const resource = (right ?? left)?.resource;
      if (resource !== undefined && this.materialReaders.has(resource)) changed = true;
    });
    return changed;
  }

  /** Whether a selected batch draws material-derived instead of resident geometry. */
  get derivesGeometry(): boolean {
    return this.derivedBatches > 0 || this.morphed.size > 0;
  }

  get binWork(): BinnedPhase<DrawItem>['work'] {
    return this.bins.work;
  }

  get sortWork(): SortedPhase['work'] {
    return this.sort.work;
  }

  /**
   * Queue step: consume this frame's member diffs into the bins and the
   * sorted order. It writes no output; {@link emit} reads the queued state.
   */
  queue(input: DirectDrawInput): void {
    const retain =
      input.retainMaterialBindings === true &&
      input.materials !== undefined &&
      !input.materials.hasBorrowedValues;
    if (retain !== this.retainBindings) {
      this.retainBindings = retain;
      this.emittedRevision = -1;
    }
    this.syncMaterialPassMode(input);
    const changes = this.availableChanges;
    this.availableChanges = undefined;
    // An integration callback can enter the same phase. Its private Set
    // leaves the outer walk's member addresses intact.
    const dirty = changes ?? new Set<Member>();
    try {
      for (const member of this.pending) dirty.add(member);
      const previousSort = this.sortInputs;
      this.sortVisit++;
      this.sortInputs = input.sort;
      if (input.sort?.sourceOrder !== this.completedSourceOrder) this.sort.invalidate();
      if (previousSort === undefined) this.adoptSortEye();
      const lodCamera = input.lodCamera ?? [];
      const mode =
        input.lod === undefined ? 'none' : typeof input.lod === 'function' ? 'external' : 'native';
      const lodMoved = mode !== this.lodMode || !sameTokens(lodCamera, this.lodCamera);
      this.syncBatches(input, dirty);
      this.syncUnbatched(input.scene.unbatchedSlots ?? EMPTY_SLOTS, dirty);
      this.syncEvidence(input, dirty);
      this.syncGeometry(input.geometry ?? [], dirty);
      const admission = this.syncAdmission(input, dirty);
      this.syncViewDraws(input, dirty);
      this.rebuild(input, dirty, input.scene.draws === undefined ? 'all' : admission);
      this.touchMorphed(input, dirty);
      if (lodMoved) this.reprojectLod(input, dirty);
      this.syncSort(previousSort);
      this.lodCamera = lodCamera;
      this.lodMode = mode;
    } catch (cause) {
      this.lodMode = undefined;
      this.completedSourceOrder = undefined;
      // A failed camera read can leave unvisited rows outside the residual.
      this.admission = undefined;
      // Input cursors may already have advanced. Retry the actual live
      // members even when the next frame carries no additional edits.
      dirty.forEach((member) => {
        if (member.live) this.pending.add(member);
      });
      this.emittedRevision = -1;
      throw cause;
    } finally {
      if (changes !== undefined) {
        changes.release(this.members.size);
        this.availableChanges = changes;
      }
    }
  }

  /** Rows-only and borrowed consumers allocate no owned material-group state. */
  private syncMaterialPassMode(input: DirectDrawInput): void {
    const enabled = input.entries !== undefined && input.materials?.hasBorrowedValues === false;
    const temporal = input.entries?.temporal === true;
    if (enabled !== this.materialPassGroupsEnabled || temporal !== this.temporalMaterialPasses)
      this.emittedRevision = -1;
    this.materialPassGroupsEnabled = enabled;
    this.temporalMaterialPasses = temporal;
  }

  // ── Batches ───────────────────────────────────────────────────────────

  private syncBatches(input: DirectDrawInput, dirty: MemberChanges): void {
    const batches = input.scene.plan.batches;
    const previous = this.batches;
    // Asset scopes are part of every batch's answer; resident tables diff per binding.
    const sameSelection = this.observeSelection(input);
    this.batches = batches;
    const gpu = input.gpu;
    const previousGpu = this.gpu;
    this.gpu = gpu;
    const gpuLinked = gpu === previousGpu || (gpu !== undefined && previousGpu !== undefined);
    if (previous === batches && sameSelection && gpuLinked) {
      this.syncGpu(previousGpu, gpu, input, dirty);
      this.syncMeshes(input, dirty);
      return;
    }
    if (sameSelection && gpuLinked && previous !== undefined && linkedBatches(previous, batches)) {
      // A batch can move between positions: retire only ids absent after the diff.
      const gone = new Set<number>();
      const next = new Map<number, GpuDrivenBatch>();
      batchChanges(previous, batches, (before, after) => {
        if (before !== undefined) gone.add(before.batchId);
        if (after !== undefined) next.set(after.batchId, after);
      });
      for (const batchId of gone)
        if (!next.has(batchId)) {
          this.know(batchId, undefined);
          this.judge(batchId, undefined, input, dirty);
        }
      for (const [batchId, batch] of next) {
        this.know(batchId, batch);
        this.judge(batchId, batch, input, dirty);
      }
      // Ownership and residency answers re-judge batches of the current plan only.
      this.syncGpu(previousGpu, gpu, input, dirty);
      this.syncMeshes(input, dirty);
      return;
    }
    if (previous !== batches) this.work.cold += 1;
    this.residents = input.meshes;
    // A changed selection re-judges every batch; members move only for changed answers.
    const live = new Set<number>();
    for (const batch of batches) {
      live.add(batch.batchId);
      this.know(batch.batchId, batch);
      this.judge(batch.batchId, batch, input, dirty);
    }
    for (const batchId of [...this.known.keys()])
      if (!live.has(batchId)) {
        this.know(batchId, undefined);
        this.judge(batchId, undefined, input, dirty);
      }
  }

  /** Keep one private token snapshot, observing each borrowed iterator once. */
  private observeSelection(input: DirectDrawInput): boolean {
    const tokens = this.selection;
    const previousLength = tokens.length;
    let same = true;
    let index = 0;
    try {
      for (const token of input.selection) {
        if (tokens[index] !== token) same = false;
        tokens[index++] = token;
      }
      if (tokens[index] !== input.sourceScope) same = false;
      tokens[index++] = input.sourceScope;
    } catch (cause) {
      // A throwing iterator must not let a partial snapshot prove reuse.
      tokens.length = 0;
      this.batches = undefined;
      throw cause;
    }
    if (previousLength !== index) same = false;
    tokens.length = index;
    return same;
  }

  /** A replaced resident table re-selects only bindings whose geometry changed. */
  private syncMeshes(input: DirectDrawInput, dirty: MemberChanges): void {
    const previous = this.residents;
    const meshes = input.meshes;
    this.residents = meshes;
    if (previous === meshes) return;
    for (const [binding, ids] of this.byBinding)
      if (previous === undefined || previous.get(binding) !== meshes.get(binding))
        for (const batchId of ids) this.judge(batchId, this.known.get(batchId), input, dirty);
  }

  /** Changed GPU ownership re-selects the batches of its changed bindings. */
  private syncGpu(
    previous: GpuDrawSelection | undefined,
    gpu: GpuDrawSelection | undefined,
    input: DirectDrawInput,
    dirty: MemberChanges,
  ): void {
    if (previous === gpu || previous === undefined || gpu === undefined) return;
    for (const binding of gpu.changedBindingsSince(previous))
      for (const batchId of this.byBinding.get(binding) ?? [])
        this.judge(batchId, this.known.get(batchId), input, dirty);
  }

  private know(batchId: number, batch: GpuDrivenBatch | undefined): void {
    const before = this.known.get(batchId)?.binding;
    const after = batch?.binding;
    if (batch === undefined) this.known.delete(batchId);
    else this.known.set(batchId, batch);
    if (before === after) return;
    if (before !== undefined) {
      unindex(this.byBinding, before, batchId);
      unindex(this.byMaterial, before.material, batchId);
    }
    if (after !== undefined) {
      index(this.byBinding, after, batchId);
      index(this.byMaterial, after.material, batchId);
    }
  }

  /** Replace one batch's contributions, visiting only differing members while it stays selected. */
  private judge(
    batchId: number,
    batch: GpuDrivenBatch | undefined,
    input: DirectDrawInput,
    dirty: MemberChanges,
  ): void {
    const before = this.selected.get(batchId)?.current;
    const after = batch === undefined ? undefined : this.selectBatch(batch, input);
    if (before === after) return;
    this.work.batches += 1;
    if (before?.derived === true) this.derivedBatches -= 1;
    if (after?.derived === true) this.derivedBatches += 1;
    const port = this.publishBatch(batchId, after);
    if (before !== undefined && port !== undefined && this.updateLinkedMembers(before, port, dirty))
      return;
    if (before !== undefined)
      for (const member of before.batch.members ?? []) {
        const owner = this.members.get(member.primitiveIndex);
        if (owner === undefined) continue;
        removeContribution(owner, batchId);
        dirty.add(owner);
      }
    if (port !== undefined) {
      const members =
        port.current.batch.members ?? invalid('native source members for a direct batch');
      for (const member of members) {
        const owner = this.member(member.primitiveIndex);
        setContribution(owner, contribution(port, member));
        dirty.add(owner);
      }
    }
  }

  /** Native candidate pages name changed members directly. A resident mesh or scope
   * replacement additionally changes every member that reads that physical binding. */
  private updateLinkedMembers(
    before: SelectedBatch,
    port: DirectBatchPort,
    dirty: MemberChanges,
  ): boolean {
    const current = port.current;
    const left = before.batch.candidates;
    const right = current.batch.candidates;
    if (
      before.batch.binding !== port.binding ||
      !MemberCandidates.is(left) ||
      !MemberCandidates.is(right)
    )
      return false;
    right.changesSince(left, (slot, _left, right) => {
      const member = this.member(slot);
      if (right === undefined) removeContribution(member, port.id);
      else setContribution(member, contribution(port, right));
      dirty.add(member);
    });
    // Material versions reach their readers through the MaterialFrame diff;
    // other geometry or scope answers re-read every member of the batch.
    if (before.mesh !== current.mesh || before.world !== current.world)
      for (const member of current.batch.members ?? []) {
        const owner = this.members.get(member.primitiveIndex);
        if (owner === undefined) continue;
        if (before.mesh !== current.mesh && owner.additionalBatches !== undefined)
          owner.additionalBatches.sections = undefined;
        dirty.add(owner);
      }
    return true;
  }

  private publishBatch(
    batchId: number,
    current: SelectedBatch | undefined,
  ): DirectBatchPort | undefined {
    if (current === undefined) {
      this.selected.delete(batchId);
      return undefined;
    }
    const binding = current.batch.binding as GpuDrivenBatchBinding;
    const before = this.selected.get(batchId);
    if (before?.binding === binding) {
      before.bind(current);
      return before;
    }
    const port = new DirectBatchPort(batchId, binding, current);
    this.selected.set(batchId, port);
    return port;
  }

  private selectBatch(batch: GpuDrivenBatch, input: DirectDrawInput): SelectedBatch | undefined {
    const binding = batch.binding ?? invalid('a native geometry binding for every Scene batch');
    const material = input.select(binding);
    if (material === undefined) return undefined;
    const base = input.meshes.get(binding) ?? invalid('resident geometry for a direct batch');
    const mesh = input.prepareGeometry?.(base, material) ?? base;
    const derived = mesh !== base;
    const world = input.sourceScope ?? invalid('the asset scope of a direct batch');
    const previous = this.selected.get(batch.batchId)?.current;
    // Equal facts keep the retained selection, so judge() sees no change.
    return previous !== undefined &&
      previous.batch === batch &&
      previous.material === material &&
      previous.mesh === mesh &&
      previous.base === base &&
      previous.world === world
      ? previous
      : { batch, material, mesh, base, derived, world };
  }

  // ── Unbatched rows, Scene evidence, camera admission, view draws ──────

  private syncUnbatched(unbatched: ReadonlySet<number>, dirty: MemberChanges): void {
    const previous = this.unbatched;
    this.unbatched = unbatched;
    if (previous === unbatched) return;
    const flip = (slot: number) => {
      const present = unbatched.has(slot);
      const member = present ? this.member(slot) : this.members.get(slot);
      if (member === undefined || member.unbatched === present) return;
      member.unbatched = present;
      dirty.add(member);
    };
    if (previous !== undefined && FrameSet.isFixed(previous) && FrameSet.isFixed(unbatched))
      unbatched.changesSince(previous, flip);
    else {
      for (const slot of previous ?? []) if (!unbatched.has(slot)) flip(slot);
      for (const slot of unbatched) flip(slot);
    }
  }

  private syncEvidence(input: DirectDrawInput, dirty: MemberChanges): void {
    const materials = input.materials;
    const previousMaterials = this.materials;
    this.materials = materials;
    if (previousMaterials !== materials) {
      if (previousMaterials?.hasBorrowedValues || materials?.hasBorrowedValues)
        this.materialEpoch++;
      if (materials !== undefined && previousMaterials !== undefined)
        materials.changesSince(previousMaterials, (before, after) => {
          // Binding counts change with membership; rows read only versions and Passes.
          if (before?.snapshot === after?.snapshot && before?.passes === after?.passes) return;
          const resource = (after ?? before)?.resource;
          if (resource === undefined) return;
          // Selection and derived geometry are judged once per binding below.
          // A fixed parameter-only version does not change a batched row's
          // Pass placement or source. Unbatched admission and per-source morph
          // preparation still read the payload and keep their ordinary rebuild.
          const samePasses =
            !materials.hasBorrowedValues &&
            !previousMaterials.hasBorrowedValues &&
            before?.passes === after?.passes;
          const spriteChanged =
            this.retainBindings &&
            samePasses &&
            before !== undefined &&
            after !== undefined &&
            before.snapshot.passes !== after.snapshot.passes &&
            usesAcceptedSpriteGeometry(before) !== usesAcceptedSpriteGeometry(after);
          for (const member of this.materialReaders.get(resource) ?? []) {
            if (!samePasses) member.placed = undefined;
            if (
              !samePasses ||
              spriteChanged ||
              member.firstBatch === undefined ||
              member.row?.source.morph !== undefined
            )
              dirty.add(member);
          }
          for (const batchId of this.byMaterial.get(resource) ?? [])
            this.judge(batchId, this.known.get(batchId), input, dirty);
        });
      else {
        this.materialEpoch++;
        for (const member of this.members.values()) dirty.add(member);
        for (const [batchId, batch] of this.known) this.judge(batchId, batch, input, dirty);
      }
    }
    const previous = this.draws;
    const draws = input.scene.draws;
    this.draws = draws;
    if (previous === draws) return;
    const linked = drawChangesSince(previous, draws, {
      slot: (slot, version) => {
        const member = this.members.get(slot);
        if (member === undefined || version === member.version) return;
        if (dirty instanceof ChangedDrawMembers) dirty.addSlot(member);
        else dirty.add(member);
      },
      row: (slot) => {
        const member = this.members.get(slot);
        if (member !== undefined) dirty.add(member);
      },
      mesh: (handle) => {
        for (const member of this.meshReaders.get(meshKeyOf(handle)) ?? []) dirty.add(member);
      },
    });
    if (!linked) {
      this.work.cold += 1;
      for (const member of this.members.values()) dirty.add(member);
    }
  }

  /** Changed residency re-reads rows that validation prepared outside a batch. */
  private syncGeometry(geometry: readonly unknown[], dirty: MemberChanges): void {
    if (sameTokens(this.geometry, geometry)) return;
    this.geometry = geometry;
    for (const member of this.members.values())
      if (member.firstBatch === undefined) dirty.add(member);
  }

  /** True when every current source needs a layer/predicate sample. */
  private syncAdmission(input: DirectDrawInput, dirty: MemberChanges): AdmissionReads {
    const maskChanged = input.cullMask !== this.cullMask;
    this.cullMask = input.cullMask;
    const visible = input.visible;
    const admission = input.admission;
    const previousVisible = this.visibility;
    const previous = this.admission;
    this.visibility = visible;
    this.admission = admission;
    if (maskChanged) return 'all';
    if (visible === undefined && previousVisible === undefined) return 'changes';
    if (
      visible !== undefined &&
      previousVisible !== undefined &&
      admission !== undefined &&
      previous !== undefined
    ) {
      if (admission === previous) return 'changes';
      const flip = (slot: number) => {
        const member = this.members.get(slot);
        if (member !== undefined) dirty.add(member);
      };
      if ('sceneOwner' in admission || 'sceneOwner' in previous) {
        if (
          !('sceneOwner' in admission && 'sceneOwner' in previous) ||
          admission.sceneOwner !== previous.sceneOwner ||
          admission.residency !== previous.residency ||
          input.viewDraws.length !== 0
        )
          return 'all';
        admission.hidden.changesSince(previous.hidden, flip);
        return 'changes';
      }
      admission.hidden.changesSince(previous.hidden, flip);
      admission.residual.changesSince(previous.residual, flip);
      // A new frustum requires a visibility read outside the fixed residual.
      // Only a changed answer or independent Scene evidence requires new draw work.
      return admission.frusta !== previous.frusta ? admission.residual : 'changes';
    }
    // Without fixed evidence, admission is re-read for every candidate.
    return 'all';
  }

  private syncViewDraws(input: DirectDrawInput, dirty: MemberChanges): void {
    const viewDraws = input.viewDraws;
    if (this.viewDraws === viewDraws) return;
    this.viewDraws = viewDraws;
    for (let index = 0; ; index++) {
      const key = TAIL + index;
      const source = viewDraws.at(index);
      const member = this.members.get(key);
      if (source === undefined) {
        if (member === undefined) break;
        this.retire(member);
        continue;
      }
      if (member?.view === source) continue;
      const owner = member ?? this.member(key);
      owner.view = source;
      dirty.add(owner);
    }
  }

  // ── Members ───────────────────────────────────────────────────────────

  /** The member of a Scene slot, or of a view-owned draw key beyond every slot. */
  private member(key: number): Member {
    const slot = key < TAIL ? key : undefined;
    let member = this.members.get(key);
    if (member === undefined) {
      member = {
        live: true,
        changeAddress: -1,
        moveAddress: -1,
        sortVisit: -1,
        key,
        slot,
        firstBatch: undefined,
        additionalBatches: undefined,
        unbatched: false,
        admitted: false,
        view: undefined,
        slotOnly: false,
        version: -1,
        record: undefined,
        row: undefined,
        drawn: undefined,
        published: undefined,
        preaddressed: false,
        overlay: undefined,
        materials: [],
        meshKey: undefined,
        lod: false,
        items: [],
        materialPasses: undefined,
        placed: undefined,
        placedMaterialEpoch: -1,
        placedSelector: undefined,
        outputIndex: -1,
        emitted: -1,
      };
      this.members.set(key, member);
    }
    return member;
  }

  private retire(member: Member): void {
    // Rows without a matching Pass still belong to the emitted roster.
    // Dequeueing their empty bin cannot invalidate that retained output.
    this.emittedRevision = -1;
    this.leaveSort(member);
    this.bins.dequeue(member.key);
    this.unread(member);
    this.pending.delete(member);
    this.morphed.delete(member);
    this.members.delete(member.key);
    member.live = false;
    this.movedRows.remove(member);
  }

  private rebuild(input: DirectDrawInput, dirty: MemberChanges, sample: AdmissionReads): void {
    if (sample === 'changes' && dirty.size === 0) return;
    let unbatched: { sources: RenderableSnapshot[]; owners: Member[] } | undefined;
    // An external projector receives its complete ordered batch. Native LOD
    // is row-local and is applied during the subsequent placement walk.
    const externalRows = typeof input.lod === 'function' ? ([] as Member[]) : undefined;
    // The addressed change queue already contains the projection work in order.
    // A borrowed all-row walk discovers its subset while reading the external source.
    const sampled = sample === 'all' ? ([] as Member[]) : undefined;
    const candidates = sample === 'changes' ? dirty : this.members;
    candidates.forEach((member) => {
      if (!member.live) return;
      const changed = sample === 'changes' || dirty.has(member);
      if (
        !changed &&
        typeof sample === 'object' &&
        member.slot !== undefined &&
        sample.has(member.slot)
      )
        return;
      if (member.view === undefined && member.firstBatch === undefined && !member.unbatched) {
        this.retire(member);
        return;
      }
      const tracked = input.scene.draws !== undefined;
      // Fixed draw evidence names every changed projection. A selected batch's
      // row already owns the exact source passed to the admission predicate.
      const retained =
        sample === 'all' && !changed && tracked && member.firstBatch !== undefined
          ? member.row
          : undefined;
      const current =
        retained !== undefined
          ? retained.source
          : member.slot === undefined
            ? member.view
            : (input.scene.drawSnapshotAt ?? invalid('the Scene-owned direct draw projection'))(
                member.slot,
              );
      const admitted = current !== undefined && sourceVisible(input, current);
      if (!changed) {
        // Borrowed producers can replace a projection independently of its Scene slot.
        const sourceChanged =
          !tracked &&
          member.slot !== undefined &&
          ((admitted && current !== member.row?.source) ||
            input.scene.slotAt(member.slot) !== member.record);
        if (admitted === member.admitted && !sourceChanged) return;
        dirty.add(member);
      }
      const sameAdmission = member.admitted === admitted;
      member.admitted = admitted;
      const previous = member.row;
      const before = member.record;
      const source = this.candidate(member, input, admitted ? current : undefined);
      const after = member.record;
      sampled?.push(member);
      // A native slot carries one shared content object across successive poses.
      // Any independent residency, batch, material or view edit takes the full join.
      if (
        dirty instanceof ChangedDrawMembers &&
        member.slotOnly &&
        changed &&
        sameAdmission &&
        member.firstBatch !== undefined &&
        after instanceof SceneDrawSlot &&
        after.retainsContentOf(before)
      ) {
        if (source === undefined && previous === undefined) return;
        if (
          source !== undefined &&
          previous !== undefined &&
          previous.world !== undefined &&
          previous.submeshIndices !== undefined &&
          previous.source.morph === undefined &&
          source.morph === undefined &&
          sameReads(previous.source, source)
        ) {
          member.row = this.issueBatchedRow(
            member,
            input,
            source,
            previous.world,
            previous.mesh,
            previous.submeshIndices,
          );
          if (externalRows !== undefined) externalRows.push(member);
          return;
        }
      }
      this.work.rebuilt += 1;
      this.pending.delete(member);
      this.morphed.delete(member);
      member.row = undefined;
      member.preaddressed = false;
      if (member.firstBatch !== undefined) {
        member.row = this.batchedRow(member, source, input);
        this.reread(member, previous?.source, source);
        if (member.row !== undefined) externalRows?.push(member);
        return;
      }
      this.reread(member, previous?.source, source);
      if (source === undefined) return;
      if (
        input.admits !== undefined &&
        !(source.materials.length === 0
          ? input.admits(source.material)
          : source.materials.some(input.admits))
      )
        return;
      unbatched ??= { sources: [], owners: [] };
      unbatched.sources.push(source);
      unbatched.owners.push(member);
    });
    if (unbatched !== undefined) {
      const { sources, owners } = unbatched;
      const prepared = new Set<Member>();
      for (const row of input.prepareUnbatched(sources)) {
        const member = owners[row.renderableIndex];
        if (member === undefined) invalid('an input index for each prepared row');
        prepared.add(member);
        const indices = admittedSubmeshes(row, input.admits);
        if (indices === null) continue;
        const sceneSlot = member.record;
        const projected: MutableRow = {
          ...row,
          meshSlot: sourceAddress(input.scene, sceneSlot, row.source, row.meshSlot),
        };
        if (sceneSlot !== undefined) projected.sceneSlot = sceneSlot;
        if (indices !== undefined && indices !== row.submeshIndices)
          projected.submeshIndices = indices;
        member.row = projected;
        externalRows?.push(member);
      }
      // An admitted source without a row awaits its resources.
      for (const member of owners) if (!prepared.has(member)) this.pending.add(member);
    }
    if (externalRows !== undefined) this.project(input, externalRows);
    this.requeue(input, sampled ?? dirty);
  }

  /** Reverse indices of the new source; a moved row reading the same materials and Mesh keeps them. */
  private reread(
    member: Member,
    previous: RenderableSnapshot | undefined,
    source: RenderableSnapshot | undefined,
  ): void {
    if (source !== undefined && previous !== undefined && sameReads(previous, source)) return;
    this.unread(member);
    if (source !== undefined) this.read(member, source);
  }

  /** Place live members again, keeping the placements of rows that only moved. */
  private requeue(
    input: DirectDrawInput,
    live: { forEach(visit: (member: Member) => void): void },
  ): void {
    let queued: (readonly [number, readonly BinPlacement<DrawItem>[]])[] | undefined;
    const lod = input.lod;
    live.forEach((member) => {
      if (!member.live) return;
      // An absent draw retiring another absent draw has no bin or roster edit.
      if (
        member.row === undefined &&
        member.drawn === undefined &&
        member.placed === undefined &&
        member.items.length === 0
      )
        return;
      if (typeof lod !== 'function' && member.row !== undefined) {
        member.drawn =
          lod === undefined
            ? member.row
            : selectCpuLodRow(member.row, lod, undefined, this.lodWorld);
        member.published = undefined;
      }
      if (this.keepsPlacement(member, input)) {
        // Same bins and entries; only the row (transform, temporal record) moved.
        if (
          this.emittedRevision >= 0 &&
          input.materials?.hasBorrowedValues === false &&
          keyedDraw(member.placed) === keyedDraw(member.drawn)
        )
          this.movedRows.add(member);
        else this.emittedRevision = -1;
        member.placed = member.drawn;
        this.work.retained += 1;
        return;
      }
      // Rows without bin placement can still enter or leave the output roster.
      this.emittedRevision = -1;
      queued ??= [];
      queued.push([member.key, this.place(member, input)]);
    });
    // Bulk changes (cold start, selection flips) sort each touched bin once.
    if (queued !== undefined) {
      if (queued.length > BULK_QUEUE) this.bins.queueMany(queued);
      else for (const [key, placements] of queued) this.bins.queue(key, placements);
    }
    // Retained placements keep their sort membership. Only a new placement can
    // introduce a sorted entry into a phase that owns no sort keys.
    if (
      this.sortInputs !== undefined &&
      this.sortAll === this.sortInputs.all &&
      (queued !== undefined || this.sort.length !== 0 || this.unaddressable !== 0)
    )
      live.forEach((member) => {
        if (member.live) this.syncMemberSort(member);
      });
  }

  /** Camera-dependent projection of rebuilt rows. */
  private project(input: DirectDrawInput, built: readonly Member[], cameraMoved = false): void {
    if (built.length === 0) return;
    const lod = input.lod;
    const borrowed =
      typeof lod === 'function' ? lod(built.map((member) => this.lodInputRow(member))) : undefined;
    for (let index = 0; index < built.length; index++) {
      const member = built[index] as Member;
      const row = member.row as ValidatedRenderable;
      const next =
        typeof lod === 'function'
          ? (borrowed?.at(index) ?? row)
          : lod === undefined
            ? row
            : selectCpuLodRow(row, lod, undefined, this.lodWorld);
      if (cameraMoved && next === member.drawn) continue;
      member.drawn = next;
      member.sortVisit = -1;
      if (cameraMoved) this.emittedRevision = -1;
      member.published = undefined;
    }
  }

  /** Keep retained morph streams alive; a re-created stream replaces the row's mesh. */
  private touchMorphed(input: DirectDrawInput, rebuilt: Pick<MemberChanges, 'has'>): void {
    const replaced: Member[] = [];
    for (const [member, selected] of this.morphed) {
      const row = member.row;
      if (row === undefined || rebuilt.has(member)) continue;
      const mesh =
        input.prepareGeometry?.(selected.base, selected.material, row.source) ?? selected.mesh;
      if (mesh === row.mesh) continue;
      member.row = { ...row, mesh };
      replaced.push(member);
    }
    if (replaced.length === 0) return;
    this.project(input, replaced);
    this.emittedRevision = -1;
  }

  /** The camera moved: re-project LOD rows that this sync did not rebuild. */
  private reprojectLod(input: DirectDrawInput, rebuilt: Pick<MemberChanges, 'has'>): void {
    const lod = input.lod;
    if (typeof lod === 'function') {
      const members = [...this.lodMembers].filter(
        (member) => member.row !== undefined && !rebuilt.has(member),
      );
      this.project(input, members, true);
      return;
    }
    for (const member of this.lodMembers) {
      const row = member.row;
      if (row === undefined || rebuilt.has(member)) continue;
      const before = member.drawn;
      const next =
        lod === undefined
          ? row
          : selectCpuLodRow(
              row,
              lod,
              this.lodMode === 'native' ? before : undefined,
              this.lodWorld,
            );
      if (next === before) continue;
      member.drawn = next;
      member.sortVisit = -1;
      member.published = undefined;
      // Native LOD changes only physical index ranges. Its existing pass placement,
      // material and transparent-sort position belong to the same source.
      if (
        this.lodMode === 'native' &&
        this.emittedRevision >= 0 &&
        member.placed === before &&
        member.outputIndex >= 0 &&
        input.materials?.hasBorrowedValues === false
      ) {
        member.placed = next;
        this.movedRows.add(member);
      } else this.emittedRevision = -1;
    }
  }

  /** An external row projection sees the original mesh input, independent of a prior dispatch. */
  private lodInputRow(member: Member): ValidatedRenderable {
    const row = member.row as ValidatedRenderable;
    if (!member.preaddressed) return row;
    const { variantSet: _variant, ...fields } = row;
    member.preaddressed = false;
    member.row = {
      ...fields,
      renderableIndex: 0,
      renderState: undefined,
      stencilReference: undefined,
    };
    return member.row;
  }

  /** The member's current source, or undefined when it draws nothing in this consumer. */
  private candidate(
    member: Member,
    input: DirectDrawInput,
    source: RenderableSnapshot | undefined,
  ): RenderableSnapshot | undefined {
    if (member.slot !== undefined) {
      const record = input.scene.slotAt(member.slot);
      member.record = record;
      member.version = record?.version ?? 0;
      if (record === undefined) {
        if (member.firstBatch !== undefined)
          invalid('a live generation for each direct batch member');
        if (member.unbatched) invalid('a live unbatched Scene slot');
        return undefined;
      }
      // Native view owners have already projected these roots into actual draw geometry.
      if (
        source !== undefined &&
        member.firstBatch === undefined &&
        (source.terrain !== undefined ||
          source.glyph !== undefined ||
          source.tilemap !== undefined ||
          (source.waterMeshSource !== undefined &&
            source.assetHandle === undefined &&
            source.generatedMesh === undefined &&
            source.terrainSection === undefined &&
            source.nativeDraw === undefined) ||
          source.instances?.instanceCount === 0)
      )
        return undefined;
    }
    return source?.authorVisible === false || (input.shadow && source?.shadowCaster === false)
      ? undefined
      : source;
  }

  private batchedRow(
    member: Member,
    source: RenderableSnapshot | undefined,
    input: DirectDrawInput,
  ): MutableRow | undefined {
    const sceneSlot = member.record;
    const first = member.firstBatch as Contribution;
    const additional = member.additionalBatches;
    let port = first.port;
    let indices = port.indices;
    if (additional === undefined) {
      if (!activeContribution(first, sceneSlot, source)) return undefined;
    } else {
      const sections = drawSections(first, additional, sceneSlot, source);
      if (sections === undefined) return undefined;
      port = sections.port;
      indices = sections.indices;
    }
    if (source === undefined) return undefined;
    const selected = port.current;
    // A shared morph batch drawn directly deforms each member's own stream.
    const mesh =
      source.morph === undefined
        ? selected.mesh
        : (input.prepareGeometry?.(selected.base, selected.material, source) ?? selected.mesh);
    if (mesh !== selected.mesh) this.morphed.set(member, selected);
    return this.issueBatchedRow(member, input, source, selected.world, mesh, indices);
  }

  private issueBatchedRow(
    member: Member,
    input: DirectDrawInput,
    source: RenderableSnapshot,
    world: RenderResourceScope,
    mesh: MeshGpuHandles,
    indices: readonly number[],
  ): MutableRow {
    const sceneSlot = member.record;
    // A moved member has a new detached source but often the same pass address.
    // Issue can use this one new row directly. A re-sort or changed overlay still
    // produces the current address without mutating previously submitted rows.
    const previous = typeof input.lod === 'function' ? undefined : member.published;
    member.preaddressed = previous !== undefined;
    const row: MutableRow = {
      source,
      world,
      mesh,
      renderableIndex: previous?.renderableIndex ?? 0,
      meshSlot: sourceAddress(input.scene, sceneSlot, source, 0),
      submeshIndices: indices,
      renderState: previous?.renderState,
      stencilReference: previous?.stencilReference,
    };
    if (sceneSlot !== undefined) row.sceneSlot = sceneSlot;
    if (previous?.variantSet !== undefined) row.variantSet = previous.variantSet;
    return row;
  }

  /** Reverse indices of the materials and Mesh a member's source reads. */
  private read(member: Member, source: RenderableSnapshot): void {
    const authored = source.materials;
    if (authored.length === 0 || (authored.length === 1 && authored[0] === source.material))
      member.materials = [source.material];
    else member.materials = [...new Set([source.material, ...authored])];
    for (const material of member.materials) {
      let readers = this.materialReaders.get(material);
      if (readers === undefined) {
        readers = new Set();
        this.materialReaders.set(material, readers);
      }
      readers.add(member);
    }
    if (source.assetHandle !== undefined) {
      const key = meshKeyOf(source.assetHandle);
      member.meshKey = key;
      let readers = this.meshReaders.get(key);
      if (readers === undefined) {
        readers = new Set();
        this.meshReaders.set(key, readers);
      }
      readers.add(member);
    }
    member.lod = (source.lods?.length ?? 0) > 0;
    if (member.lod) this.lodMembers.add(member);
  }

  private unread(member: Member): void {
    for (const material of member.materials) {
      const readers = this.materialReaders.get(material);
      readers?.delete(member);
      if (readers?.size === 0) this.materialReaders.delete(material);
    }
    member.materials = [];
    if (member.meshKey !== undefined) {
      const readers = this.meshReaders.get(member.meshKey);
      readers?.delete(member);
      if (readers?.size === 0) this.meshReaders.delete(member.meshKey);
      member.meshKey = undefined;
    }
    this.lodMembers.delete(member);
    member.lod = false;
  }

  /**
   * Whether `place` would rebuild the member's current items: the rebuilt row
   * keeps every fact `place` reads from the row it was placed with (bins,
   * Pass entries, entity rank), against the same material frame and selector.
   */
  private keepsPlacement(member: Member, input: DirectDrawInput): boolean {
    const before = member.placed;
    const after = member.row === undefined ? undefined : member.drawn;
    if (before === undefined || after === undefined || member.items.length === 0) return false;
    const entries = input.entries;
    const materials = input.materials;
    if (entries === undefined || materials === undefined) return this.keepsRowBin(member);
    return (
      member.placedMaterialEpoch === this.materialEpoch &&
      member.placedSelector === entries.selector &&
      samePlacedFacts(before, after)
    );
  }

  /** A rows-only consumer's single item stays in the bin `place` would choose. */
  private keepsRowBin(member: Member): boolean {
    const key =
      member.firstBatch?.port.id ?? (member.slot === undefined ? VIEW_BIN : UNBATCHED_BIN);
    const item = member.items[0] as DrawItem;
    return member.items.length === 1 && item.entry === undefined && item.bin === key;
  }

  /** The member's current placements; queueing them dequeues its previous ones first. */
  private place(member: Member, input: DirectDrawInput): readonly BinPlacement<DrawItem>[] {
    this.leaveSort(member);
    // Placement replaces this member's entries, including an empty result.
    // Release its previous groups even when no later draw asks for them.
    member.materialPasses = undefined;
    const row = member.row === undefined ? undefined : member.drawn;
    member.placed = row;
    member.placedMaterialEpoch = this.materialEpoch;
    member.placedSelector = input.entries?.selector;
    if (row === undefined) {
      member.drawn = undefined;
      member.published = undefined;
      member.overlay = undefined;
      member.items = [];
      return [];
    }
    const placements: BinPlacement<DrawItem>[] = [];
    const items: DrawItem[] = [];
    const entries = input.entries;
    const materials = input.materials;
    if (entries === undefined || materials === undefined) {
      // Rows-only consumers keep batch order, then unbatched and view-owned rows.
      const key =
        member.firstBatch?.port.id ?? (member.slot === undefined ? VIEW_BIN : UNBATCHED_BIN);
      const item: DrawItem = {
        rank: member.key,
        member: member.key,
        owner: member,
        bin: key,
        entry: undefined,
        sortId: -1,
      };
      items.push(item);
      placements.push({ key, major: key < 0 ? -key : 0, minor: key, item });
    } else {
      const source = row.source;
      const identity = source.entityKey;
      materials.drawEntries(source, 0, row, (entry, pass) => {
        if (entries.selector !== undefined && !matchPass(entry.tags, entries.selector)) return;
        const item: DrawItem = {
          rank: identity,
          member: member.key,
          owner: member,
          bin: pass,
          entry,
          sortId: -1,
        };
        items.push(item);
        placements.push({ key: pass, major: entry.queue, minor: pass, item });
      });
    }
    member.items = items;
    return placements;
  }

  // ── Sorted entries ────────────────────────────────────────────────────

  private syncMemberSort(member: Member): void {
    const inputs = this.sortInputs;
    if (inputs === undefined) return;
    const visit = this.sortVisit;
    let ordinal = 0;
    let value: number | undefined;
    let group: number | undefined;
    let priority = 0,
      depth = 0,
      tie = 0;
    const sourceOrder = inputs.sourceOrder;
    for (const item of member.items) {
      const entry = item.entry;
      if (entry === undefined || !sortedEntry(entry, inputs.all)) continue;
      const entryOrdinal = ordinal++;
      if (item.sortId === -2) continue;
      if (entryOrdinal === 0 && sourceOrder !== undefined) {
        const key = this.readMemberOrder(member, sourceOrder);
        // A second draw can reenter this reader. Only the scalar keys belong to this member.
        if (key !== undefined) {
          group = key[0];
          priority = key[1];
          depth = key[2];
          tie = key[3];
        }
      }
      if (group !== undefined) {
        this.writeSortedItem(item, entryOrdinal, group, priority, depth, tie);
        continue;
      }
      value ??= this.sortValue(member, inputs);
      const bin = this.bins.ordinalOf(item.bin);
      if (sourceOrder === undefined)
        this.writeSortedItem(item, entryOrdinal, entry.layer, value, entry.materialHandle, bin);
      else
        this.writeSortedItem(item, entryOrdinal, Number.NEGATIVE_INFINITY, entry.layer, value, bin);
    }
    member.sortVisit = visit;
  }

  private writeSortedItem(
    item: DrawItem,
    ordinal: number,
    group: number,
    priority: number,
    depth: number,
    tie: number,
  ): void {
    if (item.sortId >= 0) {
      this.sort.update(item.sortId, group, priority, depth, tie);
      return;
    }
    const key = this.sortKey((item.owner.drawn as MutableRow).source, ordinal);
    if (key === undefined) {
      this.unaddressable += 1;
      item.sortId = -2;
      return;
    }
    const id = this.sort.enter(key, group, priority, depth, tie);
    item.sortId = id;
    this.sortItems[id] = item;
  }

  private leaveSort(member: Member): void {
    for (const item of member.items) {
      if (item.sortId === -2) this.unaddressable -= 1;
      else if (item.sortId >= 0) {
        this.sort.leave(item.sortId);
        this.sortItems[item.sortId] = undefined;
      }
      item.sortId = -1;
    }
  }

  private sortKey(source: RenderableSnapshot, ordinal: number): number | undefined {
    if (ordinal >= ROW_ENTRIES) return undefined;
    let key = source.entityKey * ROW_ENTRIES + ordinal;
    // View-owned draws can share an entity: each takes its own free key.
    while (this.sort.idOf(key) >= 0) key += 1;
    return key;
  }

  private sortValue(member: Member, inputs: DirectDrawSort): number {
    this.work.evaluated += 1;
    const source = (member.drawn as MutableRow).source;
    const pivot =
      inputs.mode === TRANSPARENT_SORT_MODE_LAYER_Y ||
      inputs.mode === TRANSPARENT_SORT_MODE_LAYER_YZ
        ? this.materials?.get(source.material)?.snapshot
        : undefined;
    const pose = CapturedSceneTransform.storage(source.transform);
    if (inputs.mode === TRANSPARENT_SORT_MODE_DISTANCE) {
      if (inputs.camera === undefined) return 0;
      const world = CapturedSceneTransform.column(pose);
      const offset = CapturedSceneTransform.offset(pose);
      const dx = (world[offset + 12] ?? 0) - (this.sortEye[0] ?? 0);
      const dy = (world[offset + 13] ?? 0) - (this.sortEye[1] ?? 0);
      const dz = (world[offset + 14] ?? 0) - (this.sortEye[2] ?? 0);
      return -(dx * dx + dy * dy + dz * dz);
    }
    return transparentSortValue(pose, pivot, inputs.mode, inputs.yzAlpha, inputs.camera);
  }

  private readMemberOrder(
    member: Member,
    order: ViewDrawOrderSelection,
  ): ViewDrawOrderKey | undefined {
    const source = (member.drawn as ValidatedRenderable).source;
    const pose = CapturedSceneTransform.storage(source.transform);
    return this.sourceOrderReader.read(
      order,
      source.entityKey,
      CapturedSceneTransform.column(pose),
      CapturedSceneTransform.offset(pose),
    );
  }

  /** Opaque work retains its precedence in a combined pass. */
  private sourceSortKey(item: DrawItem, inputs: DirectDrawSort): ViewDrawOrderKey {
    const entry = item.entry as DispatchEntry;
    const key =
      inputs.sourceOrder === undefined
        ? undefined
        : this.readMemberOrder(item.owner, inputs.sourceOrder);
    if (key !== undefined) return key;
    const value = this.sortValue(item.owner, inputs);
    const fallback = this.sourceOrderReader.key;
    fallback[0] = Number.NEGATIVE_INFINITY;
    fallback[1] = entry.layer;
    fallback[2] = value;
    fallback[3] = this.bins.ordinalOf(item.bin);
    return fallback;
  }

  /** Adopt this sync's sort inputs: a changed formula re-evaluates every sorted value. */
  private syncSort(previous: DirectDrawSort | undefined): void {
    const inputs = this.sortInputs;
    if (inputs?.sourceOrder === undefined) this.completedSourceOrder = undefined;
    if (inputs === undefined) {
      if (previous !== undefined) this.resetSort();
      return;
    }
    this.sort.setOrder(
      !inputs.sourceOrder && inputs.mode === TRANSPARENT_SORT_MODE_DISTANCE
        ? 'distance'
        : 'layered',
    );
    const sourceModeChanged = Boolean(previous?.sourceOrder) !== Boolean(inputs.sourceOrder);
    if (this.sortAll !== inputs.all || sourceModeChanged) {
      this.resetSort(inputs.all);
      this.sort.invalidate();
      for (const member of this.members.values()) this.syncMemberSort(member);
    }
    if (inputs.sourceOrder !== undefined) {
      this.publishViewOrder(inputs.sourceOrder);
      return;
    }
    this.syncSortTies();
    this.sort.commit();
    const eye = inputs.camera?.position;
    const moved =
      inputs.mode === TRANSPARENT_SORT_MODE_DISTANCE &&
      (eye === undefined
        ? this.sortEye.some(Number.isFinite)
        : eye[0] !== this.sortEye[0] || eye[1] !== this.sortEye[1] || eye[2] !== this.sortEye[2]);
    const formula =
      previous !== undefined &&
      (previous.mode !== inputs.mode || !Object.is(previous.yzAlpha, inputs.yzAlpha));
    if (formula || (moved && !this.retainsDistanceOrder())) {
      this.adoptSortEye();
      this.sort.invalidate();
      for (const item of this.sortItems)
        if (item !== undefined)
          this.sort.update(
            item.sortId,
            this.sort.layerOf(item.sortId),
            this.sortValue(item.owner, inputs),
            this.sort.materialOf(item.sortId),
            this.sort.tieOf(item.sortId),
          );
      this.sort.commit();
      this.rangeChanged = -1;
    }
  }

  private publishViewOrder(source: ViewDrawOrderSelection): void {
    if (source !== this.completedSourceOrder) {
      for (const item of this.sortItems) {
        if (item !== undefined && item.owner.sortVisit !== this.sortVisit)
          this.syncMemberSort(item.owner);
      }
    }
    this.sort.commit();
    this.completedSourceOrder = source;
  }

  private syncSortTies(): void {
    // Ties keep dispatch order among equal facts: the bin ordinal of (queue, Pass).
    if (this.sortBins !== this.bins.binRevision) {
      this.sortBins = this.bins.binRevision;
      for (const item of this.sortItems)
        if (item !== undefined) {
          const tie = this.bins.ordinalOf(item.bin);
          if (this.sort.tieOf(item.sortId) !== tie)
            this.sort.update(
              item.sortId,
              this.sort.layerOf(item.sortId),
              this.sort.valueOf(item.sortId),
              this.sort.materialOf(item.sortId),
              tie,
            );
        }
    }
  }

  private adoptSortEye(): void {
    const eye = this.sortInputs?.camera?.position;
    for (let axis = 0; axis < 3; axis++) this.sortEye[axis] = eye?.[axis] ?? Number.NaN;
    this.rangeChanged = -1;
  }

  /**
   * Distance differences are affine in the camera position. Adjacent pairs
   * therefore define a safe interval along each axis in which their order
   * cannot change. Retain the values at one common eye, including new/edited
   * rows, until the camera leaves that interval. General 3D moves still repair
   * the sorted phase; no scene or geometry is omitted.
   */
  private retainsDistanceOrder(): boolean {
    const eye = this.sortInputs?.camera?.position;
    if (eye === undefined || this.unaddressable > 0 || !this.sort.ordered) return false;
    let moving = -1;
    for (let axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(eye[axis]) || !Number.isFinite(this.sortEye[axis])) return false;
      if (eye[axis] !== this.sortEye[axis]) {
        if (moving >= 0) return false;
        moving = axis;
      }
    }
    if (moving < 0) return true;
    if (this.rangeChanged !== this.sort.work.changed) this.qualifyDistanceRange();
    const displacement = (eye[moving] ?? 0) - (this.sortEye[moving] ?? 0);
    return (
      displacement > (this.sortRange[moving] ?? 0) &&
      displacement < (this.sortRange[3 + moving] ?? 0)
    );
  }

  private qualifyDistanceRange(): void {
    this.rangeChanged = this.sort.work.changed;
    this.sortRange.fill(Number.NEGATIVE_INFINITY, 0, 3);
    this.sortRange.fill(Number.POSITIVE_INFINITY, 3);
    for (let position = 1; position < this.sort.length; position++) {
      this.work.orderConstraints += 1;
      const before = this.sort.at(position - 1);
      const after = this.sort.at(position);
      const leftTransform = this.sortItems[before]?.owner.drawn?.source.transform;
      const rightTransform = this.sortItems[after]?.owner.drawn?.source.transform;
      if (leftTransform === undefined || rightTransform === undefined) {
        this.sortRange.fill(0);
        return;
      }
      const leftPose = CapturedSceneTransform.storage(leftTransform);
      const rightPose = CapturedSceneTransform.storage(rightTransform);
      const left = CapturedSceneTransform.column(leftPose),
        leftOffset = CapturedSceneTransform.offset(leftPose);
      const right = CapturedSceneTransform.column(rightPose),
        rightOffset = CapturedSceneTransform.offset(rightPose);
      const a = this.sort.valueOf(before);
      const b = this.sort.valueOf(after);
      // Stay clear of cancellation around a distance tie. A tied pair can
      // remain unbounded only when every squared coordinate term is equal.
      const margin = Math.max(0, b - a - Number.EPSILON * 8 * (Math.abs(a) + Math.abs(b) + 1));
      const equalTerms =
        margin === 0 && equalDistanceTerms(left, leftOffset, right, rightOffset, this.sortEye);
      for (let axis = 0; axis < 3; axis++) {
        const slope =
          2 * ((right[rightOffset + 12 + axis] ?? 0) - (left[leftOffset + 12 + axis] ?? 0));
        if (
          !Number.isFinite(margin) ||
          !Number.isFinite(slope) ||
          (slope === 0 && margin === 0 && !equalTerms)
        ) {
          this.sortRange[axis] = 0;
          this.sortRange[3 + axis] = 0;
        } else if (slope > 0) {
          this.sortRange[axis] = Math.max(this.sortRange[axis] ?? 0, -margin / slope);
        } else if (slope < 0) {
          this.sortRange[3 + axis] = Math.min(this.sortRange[3 + axis] ?? 0, -margin / slope);
        }
      }
    }
  }

  private resetSort(all?: boolean): void {
    this.sortAll = all;
    for (const member of this.members.values()) for (const item of member.items) item.sortId = -1;
    this.sort = new SortedPhase(this.sort.order);
    this.sortItems = [];
    this.sortBins = -1;
    this.rangeChanged = -1;
    this.unaddressable = 0;
    this.emittedSort = -1;
  }

  // ── Output ────────────────────────────────────────────────────────────

  /**
   * Emit step: the queued bins and order as ordered rows and dispatch, with
   * `offset` the first `renderableIndex` of this consumer's rows in a combined
   * index space. Moved rows replace their addressed pages in the published order.
   */
  emit(offset = 0): DirectDrawOutput {
    const revision = this.bins.revision;
    const sort = this.sort.revision;
    if (
      revision === this.emittedRevision &&
      sort === this.emittedSort &&
      (offset === this.emittedOffset || this.materials?.hasBorrowedValues === false) &&
      this.unaddressable === 0 &&
      this.sort.ordered
    ) {
      if (offset !== this.emittedOffset) return this.relocate(offset);
      if (this.movedRows.size > 0) {
        const previous = this.output.rows;
        if (this.retainBindings) this.materialRows.begin(this.materials as MaterialFrame);
        const rows = issueDrawRows(previous.length, previous, (write) => {
          this.movedRows.forEach((member) => {
            const index = member.outputIndex;
            const row = this.publishRow(member, offset + index);
            write(index, row);
            if (this.retainBindings) this.materialRows.move(index, row);
          });
        });
        this.output = {
          ...this.output,
          rows,
          materialRows: this.retainBindings ? this.materialRows.finish(rows.length) : undefined,
        };
        this.movedRows.release(this.members.size);
        this.work.emitted++;
      }
      return this.output;
    }
    // A failed full placement may have written candidate compact addresses.
    // Force the next emission to rebuild those addresses before publishing them.
    this.emittedRevision = -1;
    this.work.emitted += 1;
    const epoch = ++this.epoch;
    const items: DrawItem[] = [];
    const rows: Member[] = [];
    for (const bin of this.bins.orderedBins())
      for (const item of bin.items) {
        if (item.entry !== undefined) {
          items.push(item);
          continue;
        }
        const owner = item.owner;
        if (owner.emitted === epoch) continue;
        owner.emitted = epoch;
        owner.overlay = undefined;
        rows.push(owner);
      }
    this.order(items);
    this.output = this.emitOrdered(items, rows, epoch, offset);
    this.movedRows.release(this.members.size);
    this.emittedRevision = revision;
    this.emittedSort = sort;
    this.emittedOffset = offset;
    return this.output;
  }

  /** A preceding pass changed width. The admitted membership, local indices
   * and order still belong to this phase, including concurrent pose writes. */
  private relocate(offset: number): DirectDrawOutput {
    const previous = this.output;
    const delta = offset - this.emittedOffset;
    const rows = issueDrawRows(previous.rows.length, undefined, (write) => {
      for (const member of this.members.values()) {
        if (member.emitted !== this.epoch) continue;
        write(member.outputIndex, this.publishRow(member, offset + member.outputIndex));
      }
    });
    let materialRows = previous.materialRows;
    if (this.retainBindings && this.movedRows.size > 0) {
      this.materialRows.begin(this.materials as MaterialFrame);
      this.movedRows.forEach((member) => {
        this.materialRows.move(member.outputIndex, member.published as ValidatedRenderable);
      });
      materialRows = this.materialRows.finish(rows.length);
    }
    const dispatch = previous.dispatch.map((entry) => ({
      ...entry,
      renderableIndex: entry.renderableIndex + delta,
    }));
    this.output = {
      ...previous,
      rows,
      dispatch,
      materialRows,
      materialPasses: previous.materialPasses?.atOffset(offset),
    };
    this.emittedOffset = offset;
    this.movedRows.release(this.members.size);
    this.work.emitted++;
    return this.output;
  }

  /** Publish ordered items and their rows, retaining only an equal fixed dispatch key. */
  private emitOrdered(
    items: readonly DrawItem[],
    members: Member[],
    epoch: number,
    offset: number,
  ): DirectDrawOutput {
    const previousDispatch = this.output.dispatch;
    let nextDispatch: DispatchEntry[] | undefined;
    // Borrowed tables keep ordinary replacement; fixed entries can retain the
    // already consumed dispatch array when its actual order and indices agree.
    if (this.materials === undefined || this.materials.hasBorrowedValues) nextDispatch = [];
    const startsWithDispatch = members.length === 0;
    for (const item of items) {
      const owner = item.owner;
      const entry = item.entry as DispatchEntry;
      // The last entry of a row owns its overlay (render state, stencil, variant).
      owner.overlay = entry;
      if (entry.tags.LightMode !== 'ShadowCaster' && owner.emitted !== epoch) {
        owner.emitted = epoch;
        members.push(owner);
      }
    }
    const dispatchedPrefix = startsWithDispatch ? members.length : undefined;
    // Rows without a view entry follow in member order.
    for (const member of this.members.values())
      if (member.drawn !== undefined && member.emitted !== epoch) {
        member.emitted = epoch;
        if (member.items.length === 0) member.overlay = undefined;
        members.push(member);
      }
    const ownedMaterials = this.retainBindings;
    if (ownedMaterials) this.materialRows.begin(this.materials as MaterialFrame);
    else this.materialRows.clear();
    let nativeStart = 0;
    let nativeEnd = 0;
    const rows = issueDrawRows(members.length, undefined, (write) => {
      for (let index = 0; index < members.length; index++) {
        const member = members[index] as Member;
        member.outputIndex = index;
        const row = this.publishRow(member, offset + index);
        write(index, row);
        if (keyedDraw(row)) {
          if (nativeEnd === 0) nativeStart = index;
          nativeEnd = index + 1;
        }
        if (ownedMaterials) this.materialRows.write(index, row);
      }
    });
    const materialRows = ownedMaterials ? this.materialRows.finish(rows.length) : undefined;
    for (let index = 0; index < items.length; index++) {
      const item = items[index] as DrawItem;
      const entry = (item.publishedEntry ?? item.entry) as DispatchEntry;
      const row = item.owner.published as ValidatedRenderable;
      const renderableIndex = row.renderableIndex;
      // A captured pass or pending submission still owns its original compact address.
      const published =
        entry.renderableIndex === renderableIndex ? entry : { ...entry, renderableIndex };
      item.publishedEntry = published;
      if (nextDispatch === undefined && previousDispatch[index] !== published)
        nextDispatch = previousDispatch.slice(0, index);
      nextDispatch?.push(published);
    }
    if (nextDispatch === undefined && items.length !== previousDispatch.length)
      nextDispatch = previousDispatch.slice(0, items.length);
    const dispatch = nextDispatch ?? previousDispatch;
    const materialPasses = this.projectMaterialPasses(items, dispatch, epoch, offset);
    return {
      rows,
      dispatch,
      materialPasses,
      materialRows,
      dispatchedPrefix,
      nativeStart,
      nativeEnd,
    };
  }

  /** Never mutate a borrowed LOD row or a publication sealed by a downstream owner. */
  private publishRow(member: Member, renderableIndex: number): ValidatedRenderable {
    const projected = member.drawn as ValidatedRenderable;
    const row = member.published ?? projected;
    const overlay = member.overlay;
    const base = member.preaddressed ? undefined : projected;
    const renderState = overlay === undefined ? base?.renderState : overlay.renderState;
    const stencilReference =
      overlay === undefined ? base?.stencilReference : overlay.stencilReference;
    const variantSet =
      overlay === undefined ? base?.variantSet : variantSetFromDefines(overlay.defines);
    if (
      row.renderableIndex === renderableIndex &&
      row.renderState === renderState &&
      row.stencilReference === stencilReference &&
      row.variantSet === variantSet
    ) {
      member.published = row;
    } else {
      this.work.readdressed++;
      member.published = { ...row, renderableIndex, renderState, stencilReference, variantSet };
    }
    return member.published;
  }

  private appendMaterialPass(owner: Member, entry: DispatchEntry, epoch: number): void {
    owner.materialPasses ??= new MemberMaterialPasses();
    owner.materialPasses.append(entry, epoch);
  }

  /** Equal emitted dispatch already proves every row/material Pass grouping. */
  private projectMaterialPasses(
    items: readonly DrawItem[],
    dispatch: readonly DispatchEntry[],
    epoch: number,
    offset: number,
  ): MaterialPassLookup | undefined {
    if (!this.materialPassGroupsEnabled || items.length === 0) return undefined;
    const previous = this.output.materialPasses;
    if (dispatch === this.output.dispatch && previous?.temporal === this.temporalMaterialPasses)
      return previous;
    for (const item of items)
      this.appendMaterialPass(item.owner, item.entry as DispatchEntry, epoch);
    const groups: (MaterialPasses | undefined)[] = [];
    let size = 0;
    for (const item of items) {
      const index = (item.owner.published as ValidatedRenderable).renderableIndex - offset;
      if (groups[index] !== undefined) continue;
      const group = item.owner.materialPasses?.finish(epoch, this.temporalMaterialPasses);
      if (group === undefined) invalid('the emitted member material groups');
      groups[index] = group;
      size += 1;
    }
    return materialPassLookup(groups, offset, size, this.temporalMaterialPasses);
  }

  /** Sorted entries take the positions of sorted entries in bin order, in phase order. */
  private order(items: DrawItem[]): void {
    const inputs = this.sortInputs;
    if (inputs === undefined) return;
    if (
      !inputs.sourceOrder &&
      inputs.mode === TRANSPARENT_SORT_MODE_DISTANCE &&
      inputs.camera === undefined
    )
      return;
    const positions = this.sortedPositions;
    positions.length = 0;
    for (let index = 0; index < items.length; index++)
      if (sortedEntry((items[index] as DrawItem).entry as DispatchEntry, inputs.all))
        positions.push(index);
    if (positions.length <= 1) return;
    if (this.unaddressable > 0 || !this.sort.ordered) {
      this.freshOrder(items, positions, inputs);
    } else {
      let next = 0;
      this.sort.forEachId((id) => {
        items[positions[next++] as number] = this.sortItems[id] as DrawItem;
      });
    }
  }

  /** The engine's stable sort, for values without a consistent order or unaddressable rows. */
  private freshOrder(
    items: DrawItem[],
    positions: readonly number[],
    inputs: DirectDrawSort,
  ): void {
    const order = this.sortPermutation;
    const values = this.sortValues;
    const sourceOrder = inputs.sourceOrder !== undefined;
    order.length = positions.length;
    values.length = sourceOrder ? positions.length * 4 : positions.length;
    for (let index = 0; index < positions.length; index++) {
      order[index] = index;
      const item = items[positions[index] as number] as DrawItem;
      if (sourceOrder) {
        const key = this.sourceSortKey(item, inputs);
        for (let lane = 0; lane < 4; lane++) values[index * 4 + lane] = key[lane] as number;
      } else values[index] = this.sortValue(item.owner, inputs);
    }
    const layered = inputs.mode !== TRANSPARENT_SORT_MODE_DISTANCE;
    order.sort((a, b) => {
      if (sourceOrder) {
        for (let lane = 0; lane < 4; lane++) {
          const difference = (values[a * 4 + lane] as number) - (values[b * 4 + lane] as number);
          if (difference) return difference;
        }
        return a - b;
      }
      const x = (items[positions[a] as number] as DrawItem).entry as DispatchEntry;
      const y = (items[positions[b] as number] as DrawItem).entry as DispatchEntry;
      if (layered && x.layer !== y.layer) return x.layer - y.layer;
      const left = values[a] as number;
      const right = values[b] as number;
      if (left < right) return -1;
      if (left > right) return 1;
      if (layered && x.materialHandle !== y.materialHandle)
        return x.materialHandle - y.materialHandle;
      return a - b;
    });
    // Apply destination -> source cycles to the selected positions, preserving intervening opaque draws.
    for (let first = 0; first < order.length; first++) {
      if (order[first] === first) continue;
      const held = items[positions[first] as number] as DrawItem;
      let dest = first;
      let source = order[dest] as number;
      while (source !== first) {
        items[positions[dest] as number] = items[positions[source] as number] as DrawItem;
        order[dest] = dest;
        dest = source;
        source = order[dest] as number;
      }
      items[positions[dest] as number] = held;
      order[dest] = dest;
    }
  }
}

function index<K>(map: Map<K, Set<number>>, key: K, id: number): void {
  let ids = map.get(key);
  if (ids === undefined) {
    ids = new Set();
    map.set(key, ids);
  }
  ids.add(id);
}

function unindex<K>(map: Map<K, Set<number>>, key: K, id: number): void {
  const ids = map.get(key);
  ids?.delete(id);
  if (ids?.size === 0) map.delete(key);
}

function activeContribution(
  member: Contribution,
  slot: RenderSceneSlot | undefined,
  source: RenderableSnapshot | undefined,
): boolean {
  if (
    slot !== undefined &&
    (slot.generation !== member.generation || slot.entityKey !== member.entityKey)
  )
    invalid('a live generation for each direct batch member');
  if (source === undefined || member.instanceCount === 0) return false;
  const { binding, section } = member.port;
  if (source.assetHandle !== binding.assetHandle)
    invalid('matching source and resident mesh identities');
  if (section === undefined) invalid('the source submesh addressed by the direct batch');
  return true;
}

function drawSections(
  first: Contribution,
  additional: AdditionalDrawBatches,
  slot: RenderSceneSlot | undefined,
  source: RenderableSnapshot | undefined,
): DrawSections | undefined {
  const held = additional.sections;
  if (
    held !== undefined &&
    source !== undefined &&
    held.assetHandle === source.assetHandle &&
    held.generation === slot?.generation &&
    held.entityKey === slot?.entityKey
  )
    return held;
  let selected: DirectBatchPort | undefined;
  let indices: number[] | undefined;
  const rest = additional.values();
  for (
    let member: Contribution | undefined = first;
    member !== undefined;
    member = rest.next().value
  ) {
    if (!activeContribution(member, slot, source)) continue;
    const port = member.port;
    if (selected !== undefined) {
      if (port.current.mesh !== selected.current.mesh)
        invalid('one resident geometry per source slot');
      indices ??= [selected.binding.drawItemIndex];
      indices.push(port.binding.drawItemIndex);
    }
    selected = port;
  }
  if (selected === undefined) return undefined;
  additional.sections = {
    port: selected,
    indices: indices === undefined ? selected.indices : Object.freeze(indices),
    assetHandle: selected.binding.assetHandle,
    entityKey: slot?.entityKey,
    generation: slot?.generation,
  };
  return additional.sections;
}

function setContribution(member: Member, value: Contribution): void {
  if (member.additionalBatches !== undefined) member.additionalBatches.sections = undefined;
  if (member.firstBatch === undefined || member.firstBatch.port.id === value.port.id) {
    member.firstBatch = value;
    return;
  }
  member.additionalBatches ??= new AdditionalDrawBatches();
  member.additionalBatches.set(value.port.id, value);
}

function removeContribution(member: Member, batchId: number): void {
  const additional = member.additionalBatches;
  if (additional !== undefined) additional.sections = undefined;
  if (member.firstBatch?.port.id === batchId) {
    // Preserve insertion order when the first of several submeshes leaves.
    member.firstBatch = additional?.values().next().value;
    if (member.firstBatch !== undefined) additional?.delete(member.firstBatch.port.id);
  } else additional?.delete(batchId);
  if (additional?.size === 0) member.additionalBatches = undefined;
}

function contribution(
  port: DirectBatchPort,
  member: {
    readonly generation: number;
    readonly entityKey: number;
    readonly instanceCount: number;
  },
): Contribution {
  return {
    port,
    generation: member.generation,
    entityKey: member.entityKey,
    instanceCount: member.instanceCount,
  };
}

/** Submeshes whose material the consumer admits (undefined: all); null when none remains. */
function admittedSubmeshes(
  row: ValidatedRenderable,
  admits: ((material: MaterialResource) => boolean) | undefined,
): readonly number[] | undefined | null {
  if (admits === undefined) return row.submeshIndices;
  const source = row.source;
  const selected = row.submeshIndices;
  const count = selected?.length ?? row.mesh.submeshes.length;
  let first = -1;
  let accepted: number[] | undefined;
  for (let local = 0; local < count; local++) {
    const index = selected === undefined ? local : (selected[local] as number);
    const submesh = row.mesh.submeshes[index];
    if (submesh === undefined || !admits(source.materials[submesh.materialSlot] ?? source.material))
      continue;
    if (first < 0) first = index;
    else {
      accepted ??= [first];
      accepted.push(index);
    }
  }
  if (first < 0) return null;
  return accepted ?? (first === 0 ? FIRST_SUBMESH : [first]);
}

function linkedBatches(
  before: FrameList<GpuDrivenBatch>,
  after: FrameList<GpuDrivenBatch>,
): boolean {
  return (
    (before instanceof TreeFrame && after instanceof TreeFrame) ||
    (BatchSources.isFixed(before) && BatchSources.isFixed(after))
  );
}

function batchChanges(
  before: FrameList<GpuDrivenBatch>,
  after: FrameList<GpuDrivenBatch>,
  visit: (before: GpuDrivenBatch | undefined, after: GpuDrivenBatch | undefined) => void,
): void {
  if (after instanceof TreeFrame) after.changesSince(before as TreeFrame<GpuDrivenBatch>, visit);
  else (after as BatchSources).changesSince(before as BatchSources, visit);
}

/**
 * One view's retained direct phases, by consumer (a Scene Pass request or a
 * shadow consumer). The view's recording state owns it and retires it with
 * the view; no phase outlives its view.
 */
export class ViewDrawPhases {
  readonly materialBindings = new MaterialBindingIndex();
  /** Combined output of this view's currently selected graph consumers. */
  scenePassWork: ScenePassPreparationMemo | undefined;
  private readonly phases = new WeakMap<object, DirectDrawPhase>();

  of(consumer: object): DirectDrawPhase {
    let phase = this.phases.get(consumer);
    if (phase === undefined) {
      phase = new DirectDrawPhase();
      this.phases.set(consumer, phase);
    }
    return phase;
  }
}
