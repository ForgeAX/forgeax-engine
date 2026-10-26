import { RhiError } from '@forgeax/engine-rhi';
import { type PassSelector, RenderQueue } from '@forgeax/engine-types';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchSources, MemberCandidates } from '../gpu-driven/batch-members';
import type { GpuDrivenBatch, GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import type { GpuDrawSelection } from '../gpu-driven/draw-selection';
import type { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import type {
  CameraAdmission,
  DispatchEntry,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../render-system-extract';
import { drawChangesSince } from '../scene/draw-evidence';
import type { FrameList } from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
import { TreeFrame } from '../scene/frame-tree-list';
import type { MaterialFrame } from '../scene/material-dispatch';
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
import { type ValidatedRenderable, worldEntityKey } from './frame-snapshot';
import { variantSetFromDefines } from './helpers';

function invalid(expected: string): never {
  throw new RhiError({
    code: 'rhi-descriptor-invalid',
    expected,
    hint: 'prepare direct geometry from the same Scene and material publication as GPU batches',
  });
}

export type DirectDrawScene = Pick<
  PersistentGpuDrivenState,
  'plan' | 'slotAt' | 'drawSnapshotAt' | 'unbatchedSlots'
> &
  Partial<Pick<PersistentGpuDrivenState, 'slots' | 'draws'>>;

/** Draw ordering of a sorted (transparent) consumer, read once per sync. */
export interface DirectDrawSort {
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
  readonly scene: DirectDrawScene;
  readonly selection: readonly unknown[];
  /** GPU ownership `select` reads; a replacement re-selects only its changed bindings. */
  readonly gpu?: GpuDrawSelection | undefined;
  readonly select: (binding: GpuDrivenBatchBinding) => MaterialSnapshot | undefined;
  readonly meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  readonly worlds: readonly RenderResourceScope[];
  readonly shadow: boolean;
  /** Accepted material versions the rows read; changed versions requeue their readers. */
  readonly materials: MaterialFrame | undefined;
  /** Validates unbatched and view-owned sources; reports each row's input index. */
  readonly prepareUnbatched: (
    sources: FrameList<RenderableSnapshot>,
  ) => readonly ValidatedRenderable[];
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
  readonly admission?: CameraAdmission | undefined;
  /** Camera-dependent row projection (CPU LOD); a changed `lodCamera` re-projects LOD rows. */
  readonly lod: (rows: readonly ValidatedRenderable[]) => readonly ValidatedRenderable[];
  /** Facts `lod` reads from the camera; changed tokens re-project LOD rows. */
  readonly lodCamera?: readonly unknown[] | undefined;
  /** Resident geometry versions unbatched validation reads; a change re-reads those rows. */
  readonly geometry?: readonly unknown[] | undefined;
  /** Present for Scene Pass consumers: rows project dispatch entries into Pass bins. */
  readonly entries?: { readonly selector: PassSelector | undefined } | undefined;
  readonly sort?: DirectDrawSort | undefined;
  /** First `renderableIndex` of this consumer's rows in a combined index space. */
  readonly offset?: number | undefined;
}

/** The ordered work of one sync; arrays are replaced whenever their content changes. */
export interface DirectDrawOutput {
  readonly rows: readonly ValidatedRenderable[];
  readonly dispatch: readonly DispatchEntry[];
  /** The row of each dispatch entry, index-aligned. */
  readonly entryRows: readonly ValidatedRenderable[];
}

/** Cumulative phase work; tests and benches read deltas. */
export interface DirectDrawPhaseWork {
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
type MutableEntry = { -readonly [K in keyof DispatchEntry]: DispatchEntry[K] };

interface Contribution {
  readonly binding: GpuDrivenBatchBinding;
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

interface Member {
  readonly key: number;
  /** Scene row address (the entity's GPU row); undefined for a view-owned draw. */
  readonly slot: number | undefined;
  /** Selected batches drawing this row, by batch id, in admission order. */
  readonly contributions: Map<number, Contribution>;
  unbatched: boolean;
  /** View-owned source of a member without a Scene row. */
  view: RenderableSnapshot | undefined;
  /** Scene row version the current row was built from. */
  version: number;
  /** Scene row read by the latest rebuild. */
  record: RenderSceneSlot | undefined;
  row: MutableRow | undefined;
  /** The row after camera-dependent projection. */
  drawn: MutableRow | undefined;
  materials: readonly MaterialResource[];
  meshKey: number | undefined;
  lod: boolean;
  items: readonly DrawItem[];
  /** The projected row, material frame and Pass selector the current items were placed from. */
  placed: MutableRow | undefined;
  placedMaterials: MaterialFrame | undefined;
  placedSelector: PassSelector | undefined;
  emitted: number;
}

interface DrawItem extends BinnedItem {
  readonly owner: Member;
  readonly bin: number;
  readonly entry: MutableEntry | undefined;
  /** Sorted phase id, or -1 when the entry keeps its bin position. */
  sortId: number;
}

const TAIL = 2 ** 40;
const UNBATCHED_BIN = -1;
const VIEW_BIN = -2;
const ROW_ENTRIES = 64;
const BULK_QUEUE = 256;
const MAX_SORT_WORLD = 2 ** 15;
const EMPTY_SLOTS: ReadonlySet<number> = new FrameSet();
const meshKeyOf = (worldId: number, handle: number) => worldId * 4294967296 + handle;

function sortedEntry(entry: DispatchEntry, all: boolean): boolean {
  return all || entry.queue === RenderQueue.Transparent || entry.renderState?.blend !== undefined;
}

function sameTokens(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function sameIndices(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): boolean {
  return left === right || (left !== undefined && right !== undefined && sameTokens(left, right));
}

/** Whether `place` reads the same entries and bins from both rows. */
function samePlacedFacts(before: MutableRow, after: MutableRow): boolean {
  const a = before.source;
  const b = after.source;
  return (
    before.mesh === after.mesh &&
    sameIndices(before.submeshIndices, after.submeshIndices) &&
    a.material === b.material &&
    sameTokens(a.materials, b.materials) &&
    a.worldId === b.worldId &&
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
    before.worldId === after.worldId &&
    before.assetHandle === after.assetHandle &&
    (before.lods?.length ?? 0) > 0 === (after.lods?.length ?? 0) > 0
  );
}

/** Equal arithmetic terms remain a distance tie under motion on a shared axis. */
function equalDistanceTerms(left: Float32Array, right: Float32Array, eye: Float64Array): boolean {
  for (let axis = 0; axis < 3; axis++) {
    const a = (left[12 + axis] ?? 0) - (eye[axis] ?? 0);
    const b = (right[12 + axis] ?? 0) - (eye[axis] ?? 0);
    if (a * a !== b * b) return false;
  }
  return true;
}

/**
 * One view's retained direct (CPU-recorded) draws for one consumer: a binned
 * phase whose members are Scene rows addressed by their entity's GPU row,
 * plus the view-owned draws that have no Scene row. A sync consumes the batch
 * plan's diff, the unbatched set's diff, the Scene's draw evidence, changed
 * materials, flipped camera admission and the selection; only entered, left
 * and changed members are rebuilt and requeued (dequeue before enqueue).
 * Scene Pass consumers bin dispatch entries by (queue, Pass); a sorted
 * consumer feeds its {@link SortedPhase} the same member diffs. An unchanged
 * sync returns the previous output arrays.
 */
export class DirectDrawPhase {
  private readonly bins = new BinnedPhase<DrawItem>();
  private readonly members = new Map<number, Member>();
  private readonly selected = new Map<number, SelectedBatch>();
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
  private readonly materialReaders = new Map<MaterialResource, Set<Member>>();
  private readonly meshReaders = new Map<number, Set<Member>>();
  private readonly lodMembers = new Set<Member>();
  /** Members whose admitted source failed validation; retried every sync. */
  private readonly pending = new Set<Member>();
  private batches: FrameList<GpuDrivenBatch> | undefined;
  private unbatched: ReadonlySet<number> | undefined;
  private draws: PersistentGpuDrivenState['draws'];
  private selection: readonly unknown[] = [];
  private materials: MaterialFrame | undefined;
  private visibility: ((source: RenderableSnapshot) => boolean) | undefined;
  private admission: CameraAdmission | undefined;
  private viewDraws: FrameList<RenderableSnapshot> | undefined;
  private lodCamera: readonly unknown[] = [];
  private geometry: readonly unknown[] = [];
  private sort = new SortedPhase('layered');
  private sortItems: (DrawItem | undefined)[] = [];
  private sortInputs: DirectDrawSort | undefined;
  private sortBins = -1;
  /** Every retained distance value is evaluated at this same eye. */
  private readonly sortEye = new Float64Array([Number.NaN, Number.NaN, Number.NaN]);
  /** Per-axis camera displacement interval preserving the retained order. */
  private readonly sortRange = new Float64Array(6);
  private rangeChanged = -1;
  /** Sorted entries the phase cannot address take the engine sort. */
  private unaddressable = 0;
  private emittedRevision = -1;
  private emittedSort = -1;
  private emittedOffset = 0;
  private epoch = 0;
  private output: DirectDrawOutput = { rows: [], dispatch: [], entryRows: [] };
  readonly work: DirectDrawPhaseWork = {
    rebuilt: 0,
    batches: 0,
    cold: 0,
    emitted: 0,
    retained: 0,
    evaluated: 0,
    orderConstraints: 0,
  };

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

  sync(input: DirectDrawInput): DirectDrawOutput {
    const dirty = new Set<Member>(this.pending);
    const previousSort = this.sortInputs;
    this.sortInputs = input.sort;
    if (previousSort === undefined) this.adoptSortEye();
    const lodCamera = input.lodCamera ?? [];
    const lodMoved = !sameTokens(lodCamera, this.lodCamera);
    this.lodCamera = lodCamera;
    this.syncBatches(input, dirty);
    this.syncUnbatched(input.scene.unbatchedSlots ?? EMPTY_SLOTS, dirty);
    this.syncEvidence(input, dirty);
    this.syncGeometry(input.geometry ?? [], dirty);
    this.syncAdmission(input, dirty);
    this.syncViewDraws(input, dirty);
    this.rebuild(input, dirty);
    this.touchMorphed(input, dirty);
    if (lodMoved) this.reprojectLod(input, dirty);
    this.syncSort(previousSort);
    return this.emit(input.offset ?? 0);
  }

  // ── Batches ───────────────────────────────────────────────────────────

  private syncBatches(input: DirectDrawInput, dirty: Set<Member>): void {
    const batches = input.scene.plan.batches;
    const previous = this.batches;
    // Asset scopes are part of every batch's answer; resident tables diff per binding.
    const selection = [...input.selection, ...input.worlds];
    const sameSelection = sameTokens(this.selection, selection);
    this.selection = selection;
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

  /** A replaced resident table re-selects only bindings whose geometry changed. */
  private syncMeshes(input: DirectDrawInput, dirty: Set<Member>): void {
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
    dirty: Set<Member>,
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
    dirty: Set<Member>,
  ): void {
    const before = this.selected.get(batchId);
    const after = batch === undefined ? undefined : this.selectBatch(batch, input);
    if (before === after) return;
    this.work.batches += 1;
    if (before?.derived === true) this.derivedBatches -= 1;
    if (after?.derived === true) this.derivedBatches += 1;
    if (after === undefined) this.selected.delete(batchId);
    else this.selected.set(batchId, after);
    if (
      before !== undefined &&
      after !== undefined &&
      before.batch.binding === after.batch.binding &&
      MemberCandidates.is(before.batch.candidates) &&
      MemberCandidates.is(after.batch.candidates)
    ) {
      const binding = after.batch.binding as GpuDrivenBatchBinding;
      after.batch.candidates.changesSince(before.batch.candidates, (slot, _left, right) => {
        const member = this.member(slot);
        if (right === undefined) member.contributions.delete(batchId);
        else member.contributions.set(batchId, contribution(binding, right));
        dirty.add(member);
      });
      // Material versions reach their readers through the MaterialFrame diff;
      // other geometry or scope answers re-read every member of the batch.
      if (before.mesh !== after.mesh || before.world !== after.world)
        for (const member of after.batch.members ?? []) {
          const owner = this.members.get(member.primitiveIndex);
          if (owner !== undefined) dirty.add(owner);
        }
      return;
    }
    if (before !== undefined)
      for (const member of before.batch.members ?? []) {
        const owner = this.members.get(member.primitiveIndex);
        if (owner === undefined) continue;
        owner.contributions.delete(batchId);
        dirty.add(owner);
      }
    if (after !== undefined) {
      const binding = after.batch.binding as GpuDrivenBatchBinding;
      const members = after.batch.members ?? invalid('native source members for a direct batch');
      for (const member of members) {
        const owner = this.member(member.primitiveIndex);
        owner.contributions.set(batchId, contribution(binding, member));
        dirty.add(owner);
      }
    }
  }

  private selectBatch(batch: GpuDrivenBatch, input: DirectDrawInput): SelectedBatch | undefined {
    const binding = batch.binding ?? invalid('a native geometry binding for every Scene batch');
    const material = input.select(binding);
    if (material === undefined) return undefined;
    const base = input.meshes.get(binding) ?? invalid('resident geometry for a direct batch');
    const mesh = input.prepareGeometry?.(base, material) ?? base;
    const derived = mesh !== base;
    const world = input.worlds[binding.worldId] ?? invalid('the asset scope of a direct batch');
    const previous = this.selected.get(batch.batchId);
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

  private syncUnbatched(unbatched: ReadonlySet<number>, dirty: Set<Member>): void {
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

  private syncEvidence(input: DirectDrawInput, dirty: Set<Member>): void {
    const materials = input.materials;
    const previousMaterials = this.materials;
    this.materials = materials;
    if (previousMaterials !== materials) {
      if (materials !== undefined && previousMaterials !== undefined)
        materials.changesSince(previousMaterials, (before, after) => {
          // Binding counts change with membership; rows read only versions and Passes.
          if (before?.snapshot === after?.snapshot && before?.passes === after?.passes) return;
          const resource = (after ?? before)?.resource;
          if (resource === undefined) return;
          for (const member of this.materialReaders.get(resource) ?? []) dirty.add(member);
          for (const batchId of this.byMaterial.get(resource) ?? [])
            this.judge(batchId, this.known.get(batchId), input, dirty);
        });
      else {
        for (const member of this.members.values()) dirty.add(member);
        for (const [batchId, batch] of this.known) this.judge(batchId, batch, input, dirty);
      }
    }
    const previous = this.draws;
    const draws = input.scene.draws;
    this.draws = draws;
    if (previous === draws) return;
    const slots = draws?.slots;
    const linked = drawChangesSince(previous, draws, {
      slot: (slot) => {
        const member = this.members.get(slot);
        if (member === undefined) return;
        // Page diffs report every lane of a changed page; an unchanged row keeps its version.
        if (slots !== undefined && slots.versionAt(slot) === member.version) return;
        dirty.add(member);
      },
      row: (slot) => {
        const member = this.members.get(slot);
        if (member !== undefined) dirty.add(member);
      },
      mesh: (worldId, handle) => {
        for (const member of this.meshReaders.get(meshKeyOf(worldId, handle)) ?? [])
          dirty.add(member);
      },
    });
    if (!linked) {
      this.work.cold += 1;
      for (const member of this.members.values()) dirty.add(member);
    }
  }

  /** Changed residency re-reads rows that validation prepared outside a batch. */
  private syncGeometry(geometry: readonly unknown[], dirty: Set<Member>): void {
    if (sameTokens(this.geometry, geometry)) return;
    this.geometry = geometry;
    for (const member of this.members.values())
      if (member.contributions.size === 0) dirty.add(member);
  }

  private syncAdmission(input: DirectDrawInput, dirty: Set<Member>): void {
    const visible = input.visible;
    const admission = input.admission;
    const previousVisible = this.visibility;
    const previous = this.admission;
    this.visibility = visible;
    this.admission = admission;
    if (visible === undefined && previousVisible === undefined) return;
    if (
      visible !== undefined &&
      previousVisible !== undefined &&
      admission !== undefined &&
      previous !== undefined
    ) {
      if (admission === previous) return;
      const flip = (slot: number) => {
        const member = this.members.get(slot);
        if (member !== undefined) dirty.add(member);
      };
      admission.hidden.changesSince(previous.hidden, flip);
      admission.residual.changesSince(previous.residual, flip);
      // Rows outside the residual set are judged by the camera itself.
      if (admission.frusta !== previous.frusta)
        for (const member of this.members.values())
          if (member.slot === undefined || !admission.residual.has(member.slot)) dirty.add(member);
      return;
    }
    // Without fixed evidence, admission is re-read for every candidate.
    for (const member of this.members.values()) dirty.add(member);
  }

  private syncViewDraws(input: DirectDrawInput, dirty: Set<Member>): void {
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
        key,
        slot,
        contributions: new Map(),
        unbatched: false,
        view: undefined,
        version: -1,
        record: undefined,
        row: undefined,
        drawn: undefined,
        materials: [],
        meshKey: undefined,
        lod: false,
        items: [],
        placed: undefined,
        placedMaterials: undefined,
        placedSelector: undefined,
        emitted: -1,
      };
      this.members.set(key, member);
    }
    return member;
  }

  private retire(member: Member): void {
    this.leaveSort(member);
    this.bins.dequeue(member.key);
    this.unread(member);
    this.pending.delete(member);
    this.morphed.delete(member);
    this.members.delete(member.key);
  }

  private rebuild(input: DirectDrawInput, dirty: Set<Member>): void {
    if (dirty.size === 0) return;
    // The output also contains rows without a matching pass-bin placement.
    // Their source changes must publish even when bin membership stays empty.
    this.emittedRevision = -1;
    const sources: RenderableSnapshot[] = [];
    const owners: Member[] = [];
    const built: Member[] = [];
    const live: Member[] = [];
    for (const member of dirty) {
      if (this.members.get(member.key) !== member) continue;
      if (member.view === undefined && member.contributions.size === 0 && !member.unbatched) {
        this.retire(member);
        continue;
      }
      this.work.rebuilt += 1;
      const previous = member.row;
      this.pending.delete(member);
      this.morphed.delete(member);
      member.row = undefined;
      live.push(member);
      const source = this.candidate(member, input);
      this.reread(member, previous?.source, source);
      if (source === undefined) continue;
      if (member.contributions.size > 0) {
        member.row = this.batchedRow(member, source, input);
        if (member.row !== undefined) built.push(member);
        continue;
      }
      if (input.admits !== undefined && !sourceMaterials(source).some(input.admits)) continue;
      sources.push(source);
      owners.push(member);
    }
    if (sources.length > 0) {
      const prepared = new Set<Member>();
      for (const row of input.prepareUnbatched(sources)) {
        const member = owners[row.renderableIndex];
        if (member === undefined) invalid('an input index for each prepared row');
        prepared.add(member);
        const indices = admittedSubmeshes(row, input.admits);
        if (indices === null) continue;
        const sceneSlot = member.record;
        member.row = {
          ...row,
          ...(sceneSlot === undefined ? {} : { sceneSlot }),
          ...(indices === row.submeshIndices || indices === undefined
            ? {}
            : { submeshIndices: indices }),
        };
        built.push(member);
      }
      // An admitted source without a row awaits its resources.
      for (const member of owners) if (!prepared.has(member)) this.pending.add(member);
    }
    this.project(input, built);
    this.requeue(input, live);
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
  private requeue(input: DirectDrawInput, live: readonly Member[]): void {
    const queued: (readonly [number, readonly BinPlacement<DrawItem>[]])[] = [];
    for (const member of live) {
      if (this.keepsPlacement(member, input)) {
        // Same bins and entries; only the row (transform, temporal record) moved.
        this.leaveSort(member);
        this.work.retained += 1;
        continue;
      }
      queued.push([member.key, this.place(member, input)]);
    }
    // Bulk changes (cold start, selection flips) sort each touched bin once.
    if (queued.length > BULK_QUEUE) this.bins.queueMany(queued);
    else for (const [key, placements] of queued) this.bins.queue(key, placements);
    for (const member of live) this.enterSort(member);
  }

  /** Camera-dependent projection of rebuilt rows. */
  private project(input: DirectDrawInput, built: readonly Member[]): void {
    if (built.length === 0) return;
    const drawn = input.lod(built.map((member) => member.row as MutableRow));
    for (let index = 0; index < built.length; index++) {
      const member = built[index] as Member;
      member.drawn = (drawn[index] ?? member.row) as MutableRow;
    }
  }

  /** Keep retained morph streams alive; a re-created stream replaces the row's mesh. */
  private touchMorphed(input: DirectDrawInput, rebuilt: ReadonlySet<Member>): void {
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
  private reprojectLod(input: DirectDrawInput, rebuilt: ReadonlySet<Member>): void {
    const members = [...this.lodMembers].filter(
      (member) => member.row !== undefined && !rebuilt.has(member),
    );
    if (members.length === 0) return;
    const drawn = input.lod(members.map((member) => member.row as MutableRow));
    for (let index = 0; index < members.length; index++) {
      const member = members[index] as Member;
      const next = (drawn[index] ?? member.row) as MutableRow;
      if (next === member.drawn) continue;
      // A level changes geometry only; entries and bins keep their identity.
      member.drawn = next;
      this.emittedRevision = -1;
    }
  }

  /** The member's current source, or undefined when it draws nothing in this consumer. */
  private candidate(member: Member, input: DirectDrawInput): RenderableSnapshot | undefined {
    const visible = input.visible;
    if (member.slot === undefined) {
      const source = member.view;
      if (
        source === undefined ||
        visible?.(source) === false ||
        source.authorVisible === false ||
        (input.shadow && source.shadowCaster === false)
      )
        return undefined;
      return source;
    }
    const scene = input.scene;
    const record = scene.slotAt(member.slot);
    member.record = record;
    member.version = record?.version ?? 0;
    for (const contribution of member.contributions.values())
      if (
        record === undefined ||
        record.generation !== contribution.generation ||
        record.entityKey !== contribution.entityKey
      )
        invalid('a live generation for each direct batch member');
    if (record === undefined) {
      if (member.unbatched) invalid('a live unbatched Scene slot');
      return undefined;
    }
    const snapshotAt = scene.drawSnapshotAt ?? invalid('the Scene-owned direct draw projection');
    const source = snapshotAt(member.slot);
    if (source === undefined || visible?.(source) === false) return undefined;
    if (source.authorVisible === false || (input.shadow && source.shadowCaster === false))
      return undefined;
    // Native view owners have already projected these roots into actual draw geometry.
    if (
      member.contributions.size === 0 &&
      (source.terrain !== undefined ||
        source.glyph !== undefined ||
        source.tilemap !== undefined ||
        source.instances?.instanceCount === 0)
    )
      return undefined;
    return source;
  }

  private batchedRow(
    member: Member,
    source: RenderableSnapshot,
    input: DirectDrawInput,
  ): MutableRow | undefined {
    const indices: number[] = [];
    let selected: SelectedBatch | undefined;
    for (const [batchId, contribution] of member.contributions) {
      if (contribution.instanceCount === 0) continue;
      const batch = this.selected.get(batchId) ?? invalid('a selected batch for each contribution');
      const binding = contribution.binding;
      if (source.worldId !== binding.worldId || source.assetHandle !== binding.assetHandle)
        invalid('matching source and resident mesh identities');
      if (batch.mesh.submeshes[binding.drawItemIndex] === undefined)
        invalid('the source submesh addressed by the direct batch');
      if (selected !== undefined && selected.mesh !== batch.mesh)
        invalid('one resident geometry per source slot');
      selected = batch;
      indices.push(binding.drawItemIndex);
    }
    if (selected === undefined) return undefined;
    // A shared morph batch drawn directly deforms each member's own stream.
    const mesh =
      source.morph === undefined
        ? selected.mesh
        : (input.prepareGeometry?.(selected.base, selected.material, source) ?? selected.mesh);
    if (mesh !== selected.mesh) this.morphed.set(member, selected);
    const sceneSlot = member.record;
    return {
      source,
      ...(sceneSlot === undefined ? {} : { sceneSlot }),
      world: selected.world,
      mesh,
      renderableIndex: 0,
      meshSlot: 0,
      submeshIndices: indices,
      renderState: undefined,
      stencilReference: undefined,
    };
  }

  /** Reverse indices of the materials and Mesh a member's source reads. */
  private read(member: Member, source: RenderableSnapshot): void {
    member.materials = [...new Set([source.material, ...source.materials])];
    for (const material of member.materials) {
      let readers = this.materialReaders.get(material);
      if (readers === undefined) {
        readers = new Set();
        this.materialReaders.set(material, readers);
      }
      readers.add(member);
    }
    if (source.assetHandle !== undefined) {
      const key = meshKeyOf(source.worldId, source.assetHandle);
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
      member.placedMaterials === materials &&
      member.placedSelector === entries.selector &&
      samePlacedFacts(before, after)
    );
  }

  /** A rows-only consumer's single item stays in the bin `place` would choose. */
  private keepsRowBin(member: Member): boolean {
    const first = member.contributions.keys().next();
    const key =
      first.done !== true ? first.value : member.slot === undefined ? VIEW_BIN : UNBATCHED_BIN;
    const item = member.items[0] as DrawItem;
    return member.items.length === 1 && item.entry === undefined && item.bin === key;
  }

  /** The member's current placements; queueing them dequeues its previous ones first. */
  private place(member: Member, input: DirectDrawInput): readonly BinPlacement<DrawItem>[] {
    this.leaveSort(member);
    const row = member.row === undefined ? undefined : member.drawn;
    member.placed = row;
    member.placedMaterials = input.materials;
    member.placedSelector = input.entries?.selector;
    if (row === undefined) {
      member.drawn = undefined;
      member.items = [];
      return [];
    }
    const placements: BinPlacement<DrawItem>[] = [];
    const items: DrawItem[] = [];
    const entries = input.entries;
    const materials = input.materials;
    if (entries === undefined || materials === undefined) {
      // Rows-only consumers keep batch order, then unbatched and view-owned rows.
      const first = member.contributions.keys().next();
      const key =
        first.done !== true ? first.value : member.slot === undefined ? VIEW_BIN : UNBATCHED_BIN;
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
      const identity = worldEntityKey(source.worldId, source.entityKey);
      const drawMaterials = [...(row.submeshIndices ?? row.mesh.submeshes.keys())].map((index) => {
        const submesh = row.mesh.submeshes[index];
        if (submesh === undefined) throw new Error('Direct draw has no selected submesh');
        return source.materials[submesh.materialSlot] ?? source.material;
      });
      materials.drawEntries(
        { source, renderableIndex: 0, materials: drawMaterials },
        (entry, pass) => {
          if (entries.selector !== undefined && !matchPass(entry.tags, entries.selector)) return;
          const item: DrawItem = {
            rank: identity,
            member: member.key,
            owner: member,
            bin: pass,
            entry: entry as MutableEntry,
            sortId: -1,
          };
          items.push(item);
          placements.push({ key: pass, major: entry.queue, minor: pass, item });
        },
      );
    }
    member.items = items;
    return placements;
  }

  // ── Sorted entries ────────────────────────────────────────────────────

  private enterSort(member: Member): void {
    const inputs = this.sortInputs;
    if (inputs === undefined) return;
    let ordinal = 0;
    for (const item of member.items) {
      const entry = item.entry;
      if (entry === undefined || !sortedEntry(entry, inputs.all)) continue;
      const key = this.sortKey((member.drawn as MutableRow).source, ordinal++);
      if (key === undefined) {
        this.unaddressable += 1;
        item.sortId = -2;
        continue;
      }
      const id = this.sort.enter(
        key,
        entry.layer,
        this.sortValue(member, inputs),
        entry.materialHandle,
        this.bins.ordinalOf(item.bin),
      );
      item.sortId = id;
      this.sortItems[id] = item;
    }
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
    if (source.worldId >= MAX_SORT_WORLD || ordinal >= ROW_ENTRIES) return undefined;
    let key = worldEntityKey(source.worldId, source.entityKey) * ROW_ENTRIES + ordinal;
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
    if (inputs.mode === TRANSPARENT_SORT_MODE_DISTANCE) {
      if (inputs.camera === undefined) return 0;
      const world = source.transform.world;
      const dx = (world[12] ?? 0) - (this.sortEye[0] ?? 0);
      const dy = (world[13] ?? 0) - (this.sortEye[1] ?? 0);
      const dz = (world[14] ?? 0) - (this.sortEye[2] ?? 0);
      return -(dx * dx + dy * dy + dz * dz);
    }
    return transparentSortValue(
      source.transform.world,
      pivot,
      inputs.mode,
      inputs.yzAlpha,
      inputs.camera,
    );
  }

  /** Adopt this sync's sort inputs: a changed formula re-evaluates every sorted value. */
  private syncSort(previous: DirectDrawSort | undefined): void {
    const inputs = this.sortInputs;
    if (inputs === undefined) {
      if (previous !== undefined) this.resetSort();
      return;
    }
    this.sort.setOrder(inputs.mode === TRANSPARENT_SORT_MODE_DISTANCE ? 'distance' : 'layered');
    if (previous === undefined || previous.all !== inputs.all) {
      // Which entries sort changed: enter every member again.
      this.resetSort();
      for (const member of this.members.values()) this.enterSort(member);
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
      const left = this.sortItems[before]?.owner.drawn?.source.transform.world;
      const right = this.sortItems[after]?.owner.drawn?.source.transform.world;
      if (left === undefined || right === undefined) {
        this.sortRange.fill(0);
        return;
      }
      const a = this.sort.valueOf(before);
      const b = this.sort.valueOf(after);
      // Stay clear of cancellation around a distance tie. A tied pair can
      // remain unbounded only when every squared coordinate term is equal.
      const margin = Math.max(0, b - a - Number.EPSILON * 8 * (Math.abs(a) + Math.abs(b) + 1));
      const equalTerms = margin === 0 && equalDistanceTerms(left, right, this.sortEye);
      for (let axis = 0; axis < 3; axis++) {
        const slope = 2 * ((right[12 + axis] ?? 0) - (left[12 + axis] ?? 0));
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

  private resetSort(): void {
    for (const member of this.members.values()) for (const item of member.items) item.sortId = -1;
    this.sort = new SortedPhase(this.sort.order);
    this.sortItems = [];
    this.sortBins = -1;
    this.rangeChanged = -1;
    this.unaddressable = 0;
    this.emittedSort = -1;
  }

  // ── Output ────────────────────────────────────────────────────────────

  private emit(offset: number): DirectDrawOutput {
    const revision = this.bins.revision;
    const sort = this.sort.revision;
    if (
      revision === this.emittedRevision &&
      sort === this.emittedSort &&
      offset === this.emittedOffset &&
      this.unaddressable === 0 &&
      this.sort.ordered
    )
      return this.output;
    this.emittedRevision = revision;
    this.emittedSort = sort;
    this.emittedOffset = offset;
    this.work.emitted += 1;
    const epoch = ++this.epoch;
    const items: DrawItem[] = [];
    const rows: MutableRow[] = [];
    for (const bin of this.bins.orderedBins())
      for (const item of bin.items) {
        if (item.entry !== undefined) {
          items.push(item);
          continue;
        }
        const owner = item.owner;
        if (owner.emitted === epoch) continue;
        owner.emitted = epoch;
        rows.push(owner.drawn as MutableRow);
      }
    this.order(items);
    const dispatch: DispatchEntry[] = [];
    const entryRows: ValidatedRenderable[] = [];
    for (const item of items) {
      const owner = item.owner;
      const entry = item.entry as MutableEntry;
      const row = owner.drawn as MutableRow;
      dispatch.push(entry);
      entryRows.push(row);
      // The last entry of a row owns its overlay (render state, stencil, variant).
      row.renderState = entry.renderState;
      row.stencilReference = entry.stencilReference;
      row.variantSet = variantSetFromDefines(entry.defines);
      if (entry.tags.LightMode !== 'ShadowCaster' && owner.emitted !== epoch) {
        owner.emitted = epoch;
        rows.push(row);
      }
    }
    // Rows without a view entry follow in member order.
    for (const member of this.members.values())
      if (member.drawn !== undefined && member.emitted !== epoch) {
        member.emitted = epoch;
        rows.push(member.drawn);
      }
    for (let index = 0; index < rows.length; index++)
      (rows[index] as MutableRow).renderableIndex = offset + index;
    for (let index = 0; index < dispatch.length; index++)
      (dispatch[index] as MutableEntry).renderableIndex = (
        entryRows[index] as ValidatedRenderable
      ).renderableIndex;
    this.output = { rows, dispatch, entryRows };
    return this.output;
  }

  /** Sorted entries take the positions of sorted entries in bin order, in phase order. */
  private order(items: DrawItem[]): void {
    const inputs = this.sortInputs;
    if (inputs === undefined) return;
    if (inputs.mode === TRANSPARENT_SORT_MODE_DISTANCE && inputs.camera === undefined) return;
    const positions: number[] = [];
    for (let index = 0; index < items.length; index++)
      if (sortedEntry((items[index] as DrawItem).entry as DispatchEntry, inputs.all))
        positions.push(index);
    if (positions.length <= 1) return;
    const sorted =
      this.unaddressable > 0 || !this.sort.ordered
        ? this.freshOrder(items, positions, inputs)
        : this.phaseOrder();
    for (let index = 0; index < positions.length; index++)
      items[positions[index] as number] = sorted[index] as DrawItem;
  }

  private phaseOrder(): DrawItem[] {
    const sorted: DrawItem[] = [];
    this.sort.forEachId((id) => sorted.push(this.sortItems[id] as DrawItem));
    return sorted;
  }

  /** The engine's stable sort, for values without a consistent order or unaddressable rows. */
  private freshOrder(
    items: readonly DrawItem[],
    positions: readonly number[],
    inputs: DirectDrawSort,
  ): DrawItem[] {
    const keyed = positions.map((position) => {
      const item = items[position] as DrawItem;
      return { item, position, value: this.sortValue(item.owner, inputs) };
    });
    const layered = inputs.mode !== TRANSPARENT_SORT_MODE_DISTANCE;
    keyed.sort((a, b) => {
      const x = a.item.entry as DispatchEntry;
      const y = b.item.entry as DispatchEntry;
      if (layered && x.layer !== y.layer) return x.layer - y.layer;
      if (a.value < b.value) return -1;
      if (a.value > b.value) return 1;
      if (layered && x.materialHandle !== y.materialHandle)
        return x.materialHandle - y.materialHandle;
      return a.position - b.position;
    });
    return keyed.map(({ item }) => item);
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

function contribution(
  binding: GpuDrivenBatchBinding,
  member: {
    readonly generation: number;
    readonly entityKey: number;
    readonly instanceCount: number;
  },
): Contribution {
  return {
    binding,
    generation: member.generation,
    entityKey: member.entityKey,
    instanceCount: member.instanceCount,
  };
}

function sourceMaterials(source: RenderableSnapshot): readonly MaterialResource[] {
  return source.materials.length === 0 ? [source.material] : source.materials;
}

/** Submeshes whose material the consumer admits (undefined: all); null when none remains. */
function admittedSubmeshes(
  row: ValidatedRenderable,
  admits: ((material: MaterialResource) => boolean) | undefined,
): readonly number[] | undefined | null {
  if (admits === undefined) return row.submeshIndices;
  const indices = [...(row.submeshIndices ?? row.mesh.submeshes.keys())].filter((index) => {
    const submesh = row.mesh.submeshes[index];
    return (
      submesh !== undefined &&
      admits(row.source.materials[submesh.materialSlot] ?? row.source.material)
    );
  });
  return indices.length === 0 ? null : indices;
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

/** Retained direct phases of one view, by consumer. */
const phasesByView = new WeakMap<object, WeakMap<object, DirectDrawPhase>>();

export function directDrawPhase(view: object, consumer: object): DirectDrawPhase {
  let phases = phasesByView.get(view);
  if (phases === undefined) {
    phases = new WeakMap();
    phasesByView.set(view, phases);
  }
  let phase = phases.get(consumer);
  if (phase === undefined) {
    phase = new DirectDrawPhase();
    phases.set(consumer, phase);
  }
  return phase;
}
