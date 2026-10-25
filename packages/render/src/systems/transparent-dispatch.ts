import { RenderQueue } from '@forgeax/engine-types';
import type { FrameCacheCounters } from '../inspection-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import type { DispatchEntry, DispatchList, MaterialSnapshot } from '../render-system-extract';
import { SortedPhase, type SortedPhaseWork } from './sorted-phase';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from './transparent-sort-config';

export interface TransparentSortSource {
  readonly transform: { readonly world: Float32Array };
  readonly material?: MaterialSnapshot;
  /** World of the entry's entity (`DispatchEntry.entityIndex`); absent reads as 0. */
  readonly worldId?: number;
}

/** Indexed by `DispatchEntry.renderableIndex`; read once per sorted slot and frame. */
export interface TransparentSortRows {
  at(index: number): TransparentSortSource | undefined;
}

export interface TransparentSortOptions {
  /** Sort every entry, not only queue-selected or blended work. */
  readonly sortAll?: boolean;
  /**
   * Poses and material snapshots are immutable owned values, so an unchanged
   * reference is an unchanged sort input and its value is not recomputed.
   */
  readonly immutableSources?: boolean;
}

/**
 * Per-slot sort value. DISTANCE returns negated squared camera distance
 * (back-to-front); layer modes return the configured layer-local value.
 */
export function transparentSortValue(
  w: Float32Array | undefined,
  material: MaterialSnapshot | undefined,
  mode: number,
  yzAlpha: number,
  camera: CameraSnapshot | undefined,
): number {
  if (mode === TRANSPARENT_SORT_MODE_DISTANCE) {
    if (w === undefined || camera === undefined) return 0;
    const camPos = camera.position;
    const dx = (w[12] ?? 0) - (camPos[0] ?? 0);
    const dy = (w[13] ?? 0) - (camPos[1] ?? 0);
    const dz = (w[14] ?? 0) - (camPos[2] ?? 0);
    return -(dx * dx + dy * dy + dz * dz);
  }
  const posY = w?.[13] ?? 0;
  const posZ = w?.[14] ?? 0;
  if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) return posZ;
  const pivotAndSize = material?.paramSnapshot?.pivotAndSize as readonly number[] | undefined;
  const pivotY = pivotAndSize?.[1] ?? 0.5;
  const wy4 = w?.[4] ?? 0;
  const wy5 = w?.[5] ?? 1;
  const wy6 = w?.[6] ?? 0;
  const sizeY = Math.sqrt(wy4 * wy4 + wy5 * wy5 + wy6 * wy6);
  const footY = posY - pivotY * sizeY;
  if (mode === TRANSPARENT_SORT_MODE_LAYER_Y) return -footY;
  if (mode === TRANSPARENT_SORT_MODE_LAYER_YZ) return footY + yzAlpha * posZ;
  return posZ;
}

/** Entries of one row share its key; at most this many per row keep a retained identity. */
const ROW_ENTRIES = 64;
/** Row keys above this World index cannot carry an entry ordinal exactly. */
const MAX_IDENTITY_WORLD = 2 ** 15;
/** Fresh ties are spaced so later insertions between neighbours rarely exhaust a gap. */
const TIE_STEP = 1024;

/** Adapter and phase work, cumulative; read deltas. */
export interface TransparentSortWork extends SortedPhaseWork {
  /** Sorted slots visited in this frame's dispatch. */
  visited: number;
  /** Sort values evaluated (unchanged immutable sources are not). */
  evaluated: number;
}

function growInt32(array: Int32Array<ArrayBuffer>, length: number): Int32Array<ArrayBuffer> {
  if (array.length >= length) return array;
  const next = new Int32Array(Math.max(length, array.length * 2));
  next.set(array);
  return next;
}

function growFloat64(array: Float64Array<ArrayBuffer>, length: number): Float64Array<ArrayBuffer> {
  if (array.length >= length) return array;
  return new Float64Array(Math.max(length, array.length * 2));
}

/**
 * Transparent draw ordering backed by one retained {@link SortedPhase}.
 *
 * Queue-selected or blended slots are ordered by (layer, value,
 * materialHandle) for layer modes and by value for DISTANCE, with ties kept in
 * dispatch order; opaque slots are never touched. Each slot is keyed by its
 * row identity and entry ordinal, so a frame feeds the phase only its diffs:
 * entered and left slots, changed values or ordering facts, and every value
 * after a camera move in DISTANCE mode. Dispatch-order ties are retained per
 * slot and verified monotone during the scan; newcomers take a tie between
 * their surviving neighbours, and only a reordered survivor reassigns every
 * tie (a near-sorted repair). The order is therefore byte-identical to a
 * fresh stable sort. NaN values have no consistent order and take the engine
 * sort for that frame. When the source dispatch and the order are both
 * unchanged the previous result array is returned, keeping identity-keyed
 * record caches on their reuse path.
 */
export class TransparentSortCache {
  private phase = new SortedPhase('layered');
  private poses: (Float32Array | undefined)[] = [];
  private pivots: (MaterialSnapshot | undefined)[] = [];
  /** This frame's slot facts, read once from each source; overwritten next frame. */
  private readonly slotPoses: (Float32Array | undefined)[] = [];
  private readonly slotPivots: (MaterialSnapshot | undefined)[] = [];
  private seen = new Int32Array(0);
  private epoch = 0;
  private slotPositions = new Int32Array(0);
  private slotIds = new Int32Array(0);
  private slotKeys = new Float64Array(0);
  private slotValues = new Float64Array(0);
  private slotTies = new Float64Array(0);
  private changedSlots = new Int32Array(0);
  private prevKeys = new Float64Array(0);
  private prevIds = new Int32Array(0);
  private prevCount = 0;
  /** Slot index of each id in the previous frame. */
  private prevPosition = new Int32Array(0);
  private mode = -1;
  private yzAlpha = Number.NaN;
  private readonly eye = new Float64Array([Number.NaN, Number.NaN, Number.NaN]);
  private source: DispatchList | undefined;
  private value: DispatchEntry[] | undefined;
  private survivors = 0;
  private changed = 0;
  private violation = false;
  private hits = 0;
  private misses = 0;
  private visited = 0;
  private evaluated = 0;

  inspect(): FrameCacheCounters {
    return { hits: this.hits, misses: this.misses };
  }

  work(): TransparentSortWork {
    return { ...this.phase.work, visited: this.visited, evaluated: this.evaluated };
  }

  sort(
    dispatch: DispatchList,
    world: RenderResourceScope,
    cameras: readonly CameraSnapshot[],
    renderables: TransparentSortRows,
    options: TransparentSortOptions = {},
  ): DispatchList {
    const cfg = world.transparentSort;
    const mode = cfg.mode;
    // Native arrays index directly; a retained FrameList is read once.
    const entries: readonly DispatchEntry[] = Array.isArray(dispatch)
      ? (dispatch as readonly DispatchEntry[])
      : dispatch.slice();
    const n = this.select(entries, options.sortAll === true);
    if (n <= 1) return dispatch;
    const camera = cameras[0];
    if (mode === TRANSPARENT_SORT_MODE_DISTANCE && camera === undefined) return dispatch;
    const valuesDirty = this.configure(mode, cfg.yzAlpha, camera);
    const scanned = this.scan(
      entries,
      n,
      renderables,
      camera,
      valuesDirty,
      options.immutableSources === true,
    );
    if (scanned >= 0) return this.fallback(entries, n, renderables, scanned, camera);
    const membershipChanged = this.applyDiffs(entries, n);
    const orderChanged = this.phase.commit();
    if (!this.phase.ordered) {
      this.misses += 1;
      this.source = undefined;
      this.value = undefined;
      return freshOrder(entries, this.slotPositions, n, this.slotValues, mode);
    }
    // An unchanged dispatch list holds the same entries at the same positions.
    if (!orderChanged && !membershipChanged && this.source === dispatch && this.value) {
      this.hits += 1;
      return this.value;
    }
    if (orderChanged) this.misses += 1;
    else this.hits += 1;
    const value = this.emit(entries, n);
    this.source = dispatch;
    this.value = value;
    return value;
  }

  /** Dispatch positions of the sorted slots; returns their count. */
  private select(dispatch: readonly DispatchEntry[], sortAll: boolean): number {
    this.slotPositions = growInt32(this.slotPositions, dispatch.length);
    const slotPositions = this.slotPositions;
    let n = 0;
    for (let i = 0; i < dispatch.length; i++) {
      const entry = dispatch[i];
      if (
        sortAll ||
        entry?.queue === RenderQueue.Transparent ||
        entry?.renderState?.blend !== undefined
      )
        slotPositions[n++] = i;
    }
    return n;
  }

  /** Adopt this frame's formula inputs; true when every value must be re-evaluated. */
  private configure(mode: number, yzAlpha: number, camera: CameraSnapshot | undefined): boolean {
    this.phase.setOrder(mode === TRANSPARENT_SORT_MODE_DISTANCE ? 'distance' : 'layered');
    let dirty = mode !== this.mode || !Object.is(yzAlpha, this.yzAlpha);
    this.mode = mode;
    this.yzAlpha = yzAlpha;
    if (mode === TRANSPARENT_SORT_MODE_DISTANCE && camera !== undefined) {
      const eye = this.eye;
      const position = camera.position;
      for (let axis = 0; axis < 3; axis++) {
        const coordinate = position[axis] ?? 0;
        if (!Object.is(eye[axis], coordinate)) {
          eye[axis] = coordinate;
          dirty = true;
        }
      }
    }
    if (dirty) this.phase.invalidate();
    return dirty;
  }

  /**
   * Read each slot once: resolve its retained item, evaluate a changed value
   * and record the diff. Returns -1, or the count of slots read when the
   * retained identity cannot address this frame (one fresh sort follows).
   */
  private scan(
    dispatch: readonly DispatchEntry[],
    n: number,
    renderables: TransparentSortRows,
    camera: CameraSnapshot | undefined,
    valuesDirty: boolean,
    immutable: boolean,
  ): number {
    const phase = this.phase;
    const mode = this.mode;
    const yzAlpha = this.yzAlpha;
    const readsPivot =
      mode === TRANSPARENT_SORT_MODE_LAYER_Y || mode === TRANSPARENT_SORT_MODE_LAYER_YZ;
    this.slotIds = growInt32(this.slotIds, n);
    this.slotKeys = growFloat64(this.slotKeys, n);
    this.slotValues = growFloat64(this.slotValues, n);
    this.slotTies = growFloat64(this.slotTies, n);
    this.changedSlots = growInt32(this.changedSlots, n);
    const { slotPositions, slotIds, slotKeys, slotValues, changedSlots, slotPoses, slotPivots } =
      this;
    const { prevKeys, prevIds, prevPosition, poses, pivots, seen } = this;
    const prevCount = this.prevCount;
    const epoch = ++this.epoch;
    let survivors = 0;
    let changed = 0;
    let lastTie = Number.NEGATIVE_INFINITY;
    let violation = false;
    let previousRow = Number.NaN;
    let ordinal = 0;
    // Expected offset of this slot in the previous frame's slot list: a
    // matching key there resolves its id without a key lookup.
    let delta = 0;
    let newcomers: Set<number> | undefined;
    this.visited += n;
    for (let k = 0; k < n; k++) {
      const entry = dispatch[slotPositions[k] as number] as DispatchEntry;
      const source = renderables.at(entry.renderableIndex);
      // Identity only selects which retained item a slot reuses; the order is
      // derived from this frame's facts and scan order alone.
      const worldId = source?.worldId ?? 0;
      const entityKey = entry.entityIndex;
      const row =
        worldId < MAX_IDENTITY_WORLD && entityKey >= 0 && entityKey < 4294967296
          ? worldId * 4294967296 + entityKey
          : -1 - entry.renderableIndex;
      ordinal = row === previousRow ? ordinal + 1 : 0;
      previousRow = row;
      const pose = source?.transform.world;
      const pivot = readsPivot ? source?.material : undefined;
      slotPoses[k] = pose;
      slotPivots[k] = pivot;
      if (ordinal >= ROW_ENTRIES) return k + 1;
      const key = row * ROW_ENTRIES + (row < 0 ? -ordinal : ordinal);
      slotKeys[k] = key;
      const guess = k + delta;
      let id: number;
      if (guess >= 0 && guess < prevCount && prevKeys[guess] === key) id = prevIds[guess] as number;
      else {
        id = phase.idOf(key);
        if (id >= 0) delta = (prevPosition[id] as number) - k;
      }
      slotIds[k] = id;
      if (id < 0) {
        newcomers ??= new Set();
        if (newcomers.has(key)) return k + 1;
        newcomers.add(key);
        changedSlots[changed++] = k;
        slotValues[k] = transparentSortValue(pose, pivot, mode, yzAlpha, camera);
        this.evaluated += 1;
        continue;
      }
      if (seen[id] === epoch) return k + 1;
      seen[id] = epoch;
      survivors += 1;
      const tie = phase.tieOf(id);
      if (tie <= lastTie) violation = true;
      lastTie = tie;
      let value: number;
      if (!valuesDirty && immutable && poses[id] === pose && pivots[id] === pivot) {
        value = phase.valueOf(id);
      } else {
        value = transparentSortValue(pose, pivot, mode, yzAlpha, camera);
        this.evaluated += 1;
        poses[id] = pose;
        pivots[id] = pivot;
      }
      slotValues[k] = value;
      if (
        !Object.is(value, phase.valueOf(id)) ||
        entry.layer !== phase.layerOf(id) ||
        entry.materialHandle !== phase.materialOf(id)
      )
        changedSlots[changed++] = k;
    }
    this.survivors = survivors;
    this.changed = changed;
    this.violation = violation;
    return -1;
  }

  /** Dequeue left slots, then enqueue entered and changed ones; true when membership changed. */
  private applyDiffs(dispatch: readonly DispatchEntry[], n: number): boolean {
    const phase = this.phase;
    const { slotPositions, slotIds, slotKeys, slotValues, slotTies, changedSlots } = this;
    const epoch = this.epoch;
    const violation = this.violation || !this.assignNewcomerTies(n);
    if (violation) {
      for (let k = 0; k < n; k++) slotTies[k] = k * TIE_STEP;
      phase.invalidate();
    }
    const leaving = phase.length - this.survivors;
    // A large batch is cheaper as one near-sorted repair than as eager shifts.
    if (this.changed + leaving > (phase.length >>> 3) + 8) phase.invalidate();
    let membershipChanged = leaving > 0;
    // Members are exactly the previous frame's slots.
    if (leaving > 0) {
      const { prevIds, seen } = this;
      const prevCount = this.prevCount;
      for (let j = 0; j < prevCount; j++) {
        const id = prevIds[j] as number;
        if (seen[id] === epoch) continue;
        phase.leave(id);
        this.poses[id] = undefined;
        this.pivots[id] = undefined;
      }
    }
    const count = violation ? n : this.changed;
    for (let c = 0; c < count; c++) {
      const k = violation ? c : (changedSlots[c] as number);
      const entry = dispatch[slotPositions[k] as number] as DispatchEntry;
      let id = slotIds[k] as number;
      if (id >= 0) {
        phase.update(
          id,
          entry.layer,
          slotValues[k] as number,
          entry.materialHandle,
          violation ? (slotTies[k] as number) : phase.tieOf(id),
        );
        continue;
      }
      id = phase.enter(
        slotKeys[k] as number,
        entry.layer,
        slotValues[k] as number,
        entry.materialHandle,
        slotTies[k] as number,
      );
      slotIds[k] = id;
      if (id >= this.seen.length) {
        this.seen = growInt32(this.seen, id + 1);
        this.prevPosition = growInt32(this.prevPosition, this.seen.length);
      }
      this.seen[id] = epoch;
      this.poses[id] = this.slotPoses[k];
      this.pivots[id] = this.slotPivots[k];
      membershipChanged = true;
    }
    // This frame's slots become the next frame's lookup guesses.
    this.prevKeys = growFloat64(this.prevKeys, n);
    this.prevIds = growInt32(this.prevIds, n);
    this.prevKeys.set(slotKeys.subarray(0, n));
    this.prevIds.set(slotIds.subarray(0, n));
    this.prevCount = n;
    const prevPosition = this.prevPosition;
    for (let k = 0; k < n; k++) prevPosition[slotIds[k] as number] = k;
    return membershipChanged;
  }

  /** Slots in phase order at the dispatch's slot positions; other entries keep their place. */
  private emit(dispatch: readonly DispatchEntry[], n: number): DispatchEntry[] {
    const { phase, slotPositions } = this;
    const slotOf = this.prevPosition;
    const value = dispatch.slice();
    for (let position = 0; position < n; position++) {
      const slot = slotOf[phase.at(position)] as number;
      value[slotPositions[position] as number] = dispatch[
        slotPositions[slot] as number
      ] as DispatchEntry;
    }
    return value;
  }

  /**
   * Newcomer runs take ties strictly between their surviving neighbours.
   * False when a gap is exhausted; every tie is then reassigned.
   */
  private assignNewcomerTies(n: number): boolean {
    const { slotIds, slotTies, phase } = this;
    let runStart = 0;
    let before = Number.NEGATIVE_INFINITY;
    for (let k = 0; k <= n; k++) {
      const id = k < n ? (slotIds[k] as number) : -1;
      if (k < n && id < 0) continue;
      const after = k < n ? phase.tieOf(id) : Number.POSITIVE_INFINITY;
      const m = k - runStart;
      if (m > 0) {
        let previous = before;
        for (let j = 0; j < m; j++) {
          let tie: number;
          if (before === Number.NEGATIVE_INFINITY && after === Number.POSITIVE_INFINITY)
            tie = j * TIE_STEP;
          else if (before === Number.NEGATIVE_INFINITY) tie = after - (m - j) * TIE_STEP;
          else if (after === Number.POSITIVE_INFINITY) tie = before + (j + 1) * TIE_STEP;
          else tie = before + ((after - before) * (j + 1)) / (m + 1);
          if (!(tie > previous) || !(tie < after)) return false;
          slotTies[runStart + j] = tie;
          previous = tie;
        }
      }
      before = after;
      runStart = k + 1;
    }
    return true;
  }

  /** Rows the retained identity cannot address: one engine sort, then a fresh phase. */
  private fallback(
    dispatch: readonly DispatchEntry[],
    n: number,
    renderables: TransparentSortRows,
    read: number,
    camera: CameraSnapshot | undefined,
  ): DispatchList {
    const { mode, yzAlpha } = this;
    const readsPivot =
      mode === TRANSPARENT_SORT_MODE_LAYER_Y || mode === TRANSPARENT_SORT_MODE_LAYER_YZ;
    const values = this.slotValues;
    for (let k = 0; k < n; k++) {
      let pose = this.slotPoses[k];
      let pivot = this.slotPivots[k];
      // Slots after the abandoned scan position are read here for the first time.
      if (k >= read) {
        const source = renderables.at(
          (dispatch[this.slotPositions[k] as number] as DispatchEntry).renderableIndex,
        );
        pose = source?.transform.world;
        pivot = readsPivot ? source?.material : undefined;
      }
      values[k] = transparentSortValue(pose, pivot, mode, yzAlpha, camera);
      this.evaluated += 1;
    }
    this.reset();
    this.misses += 1;
    return freshOrder(dispatch, this.slotPositions, n, values, mode);
  }

  private reset(): void {
    this.phase = new SortedPhase(this.phase.order);
    this.poses = [];
    this.pivots = [];
    this.seen = new Int32Array(0);
    this.prevPosition = new Int32Array(0);
    this.prevCount = 0;
    this.source = undefined;
    this.value = undefined;
  }
}

/**
 * The engine's stable sort of the slots in dispatch order: the order a NaN
 * value or an unaddressable row receives, exactly as without a retained phase.
 */
function freshOrder(
  dispatch: readonly DispatchEntry[],
  slotPositions: Int32Array,
  n: number,
  values: Float64Array,
  mode: number,
): DispatchEntry[] {
  const keys = new Float64Array(dispatch.length);
  const slots: number[] = [];
  for (let k = 0; k < n; k++) {
    const slot = slotPositions[k] as number;
    slots.push(slot);
    keys[slot] = values[k] as number;
  }
  const compare = (a: number, b: number): number => {
    if (mode !== TRANSPARENT_SORT_MODE_DISTANCE) {
      const da = dispatch[a] as DispatchEntry;
      const db = dispatch[b] as DispatchEntry;
      if (da.layer !== db.layer) return da.layer - db.layer;
      const va = keys[a] as number;
      const vb = keys[b] as number;
      if (va < vb) return -1;
      if (va > vb) return 1;
      return da.materialHandle - db.materialHandle;
    }
    const va = keys[a] as number;
    const vb = keys[b] as number;
    if (va < vb) return -1;
    if (va > vb) return 1;
    return 0;
  };
  const order = slots.slice().sort(compare);
  const result = dispatch.slice();
  for (let k = 0; k < slots.length; k++) {
    result[slots[k] as number] = dispatch[order[k] as number] as DispatchEntry;
  }
  return result;
}
