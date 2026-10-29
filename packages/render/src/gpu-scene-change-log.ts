import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneSlot,
} from './scene/render-scene-types';

export type GpuSceneSlotBounds = (slot: RenderSceneSlot) => RenderSceneBounds | undefined;

/**
 * Old/new world boxes (six floats each) of the rows an instance-only update
 * moved, read after `GpuSceneSlotBounds` answered the slot's new union. Any
 * `undefined` falls back to the slot's old and new union boxes.
 */
export type GpuSceneSlotRowBoxes = (slot: RenderSceneSlot) => Float32Array | undefined;

/** Changed world bounds since a revision, or `'unbounded'` when a change has no proven box. */
export type GpuSceneChangedBounds = Float32Array | 'unbounded';

interface ChangeEntry {
  readonly revision: number;
  /** Old and new boxes, six floats each; `boxSlots[i]` owns box `i`. */
  readonly boxes: Float32Array;
  readonly boxSlots: Int32Array;
  /** Changed slots without a conservative box. */
  readonly unboundedSlots: Int32Array;
  /** A resync or reset: no slot-level evidence survives. */
  readonly whole: boolean;
  /** Slots created, changed or removed, including vacated cached shadows. */
  readonly changedSlots: Int32Array;
}

const HISTORY = 16;

function writeBox(box: Float32Array, bounds: RenderSceneBounds): void {
  box[0] = bounds.min[0] as number;
  box[1] = bounds.min[1] as number;
  box[2] = bounds.min[2] as number;
  box[3] = bounds.max[0] as number;
  box[4] = bounds.max[1] as number;
  box[5] = bounds.max[2] as number;
}
const EMPTY = new Float32Array(0);
const EMPTY_SLOTS = new Int32Array(0);

const BOXED = 1;
const UNBOUNDED = 2;

/**
 * Each dense scene slot's current conservative box (six floats) or its
 * unbounded mark, as slot-indexed columns instead of a per-slot array.
 */
class SlotBoxes {
  private state = new Uint8Array(0);
  private values = new Float32Array(0);

  hasBox(slot: number): boolean {
    return this.state[slot] === BOXED;
  }

  unbounded(slot: number): boolean {
    return this.state[slot] === UNBOUNDED;
  }

  pushBox(slot: number, out: number[]): void {
    for (let i = 0; i < 6; i += 1) out.push(this.values[slot * 6 + i] as number);
  }

  write(slot: number, bounds: RenderSceneBounds): void {
    this.ensure(slot);
    this.state[slot] = BOXED;
    writeBox(this.values.subarray(slot * 6, slot * 6 + 6), bounds);
  }

  markUnbounded(slot: number): void {
    this.ensure(slot);
    this.state[slot] = UNBOUNDED;
  }

  delete(slot: number): void {
    if (slot < this.state.length) this.state[slot] = 0;
  }

  clear(): void {
    this.state.fill(0);
  }

  private ensure(slot: number): void {
    if (slot < this.state.length) return;
    let capacity = Math.max(64, this.state.length);
    while (capacity <= slot) capacity *= 2;
    const state = new Uint8Array(capacity);
    state.set(this.state);
    const values = new Float32Array(capacity * 6);
    values.set(this.values);
    this.state = state;
    this.values = values;
  }
}

/**
 * Old and new world boxes of every slot a scene revision changed. A consumer
 * that retained content at revision R re-renders only when a box changed after
 * R intersects its view; any change without a conservative box, a resync, or a
 * revision older than the retained history reports `'unbounded'`.
 */
export class GpuSceneChangeLog {
  private readonly slots = new SlotBoxes();
  private readonly entries: ChangeEntry[] = [];
  private readonly scratchBoxes: number[] = [];
  private readonly scratchBoxSlots: number[] = [];
  private readonly scratchUnbounded: number[] = [];
  private readonly scratchChanged: number[] = [];
  private readonly scratchSeen = new Set<number>();
  private cached:
    | {
        readonly since: number;
        readonly ignored: ReadonlySet<number> | undefined;
        readonly observed: { has(slot: number): boolean } | undefined;
        readonly value: GpuSceneChangedBounds;
      }
    | undefined;

  record(
    revision: number,
    delta: RenderSceneApplyResult,
    boundsOf?: GpuSceneSlotBounds,
    rowBoxesOf?: GpuSceneSlotRowBoxes,
  ): void {
    this.cached = undefined;
    const whole = delta.resynced > 0;
    if (delta.resynced > 0) this.slots.clear();
    // Scratch lists are copied into the retained entry below.
    const boxes = this.scratchBoxes;
    const boxSlots = this.scratchBoxSlots;
    const unboundedSlots = this.scratchUnbounded;
    const changedSlots = this.scratchChanged;
    boxes.length = 0;
    boxSlots.length = 0;
    unboundedSlots.length = 0;
    changedSlots.length = 0;
    const pushOld = (slot: number): void => {
      if (!this.slots.hasBox(slot)) {
        if (this.slots.unbounded(slot)) unboundedSlots.push(slot);
        return;
      }
      this.slots.pushBox(slot, boxes);
      boxSlots.push(slot);
    };
    for (const record of delta.removedSlots) {
      changedSlots.push(record.slot);
      pushOld(record.slot);
      this.slots.delete(record.slot);
    }
    // Only an instance-only update may report row boxes; the bounds cache
    // answers them only while the root transform and mesh are unchanged.
    let rowUpdateSlots: Set<number> | undefined;
    if (rowBoxesOf !== undefined && delta.instanceUpdatedSlots.length > 0) {
      rowUpdateSlots = new Set();
      for (const record of delta.instanceUpdatedSlots) rowUpdateSlots.add(record.slot);
    }
    const seen = this.scratchSeen;
    seen.clear();
    for (const records of [
      delta.createdSlots,
      delta.recreatedSlots,
      delta.updatedSlots,
      delta.contentUpdatedSlots,
      delta.instanceUpdatedSlots,
    ]) {
      for (const record of records) {
        if (seen.has(record.slot)) continue;
        seen.add(record.slot);
        changedSlots.push(record.slot);
        const snapshot = record.snapshot;
        if (
          rowBoxesOf !== undefined &&
          this.slots.hasBox(record.slot) &&
          rowUpdateSlots?.has(record.slot) === true &&
          snapshot.skinBinding === undefined
        ) {
          const bounds = boundsOf?.(record);
          const rows = bounds === undefined ? undefined : rowBoxesOf(record);
          if (bounds !== undefined && rows !== undefined) {
            for (let box = 0; box + 6 <= rows.length; box += 6) {
              for (let i = 0; i < 6; i += 1) boxes.push(rows[box + i] as number);
              boxSlots.push(record.slot);
            }
            this.slots.write(record.slot, bounds);
            continue;
          }
        }
        pushOld(record.slot);
        // Skinned and sprite casters deform beyond their bind-pose box.
        const bounds =
          snapshot.skinBinding !== undefined || snapshot.spriteInstances !== undefined
            ? undefined
            : boundsOf?.(record);
        if (bounds === undefined) {
          if (snapshot.instances?.instanceCount === 0) {
            this.slots.delete(record.slot);
          } else {
            this.slots.markUnbounded(record.slot);
            unboundedSlots.push(record.slot);
          }
          continue;
        }
        // The retained box is private to this log; its old values were copied above.
        this.slots.write(record.slot, bounds);
        this.slots.pushBox(record.slot, boxes);
        boxSlots.push(record.slot);
      }
    }
    this.push({
      revision,
      boxes: new Float32Array(boxes),
      boxSlots: new Int32Array(boxSlots),
      unboundedSlots: new Int32Array(unboundedSlots),
      whole,
      changedSlots: new Int32Array(changedSlots),
    });
  }

  /** Buffer contents changed without replacing the scene's conservative boxes. */
  recordContent(revision: number, slots: ReadonlySet<number>): void {
    this.cached = undefined;
    const boxes: number[] = [];
    const boxSlots: number[] = [];
    const unboundedSlots: number[] = [];
    for (const slot of slots) {
      if (!this.slots.hasBox(slot)) {
        unboundedSlots.push(slot);
        continue;
      }
      this.slots.pushBox(slot, boxes);
      boxSlots.push(slot);
    }
    this.push({
      revision,
      boxes: new Float32Array(boxes),
      boxSlots: new Int32Array(boxSlots),
      unboundedSlots: new Int32Array(unboundedSlots),
      whole: false,
      changedSlots: new Int32Array([...slots]),
    });
  }

  /** Invalidate every retained view, e.g. after a table rebuild. */
  reset(revision: number): void {
    this.cached = undefined;
    this.slots.clear();
    this.push({
      revision,
      boxes: EMPTY,
      boxSlots: EMPTY_SLOTS,
      unboundedSlots: EMPTY_SLOTS,
      whole: true,
      changedSlots: EMPTY_SLOTS,
    });
  }

  /**
   * Boxes changed after `since`, skipping `ignored` slots and, when supplied,
   * slots absent from the retained owner's `observed` membership. Consumers
   * pass their existing membership without copying it.
   */
  changedSince(
    since: number,
    current: number,
    ignored?: ReadonlySet<number>,
    observed?: { has(slot: number): boolean },
  ): GpuSceneChangedBounds {
    if (since === current) return EMPTY;
    if (
      this.cached?.since === since &&
      this.cached.ignored === ignored &&
      this.cached.observed === observed
    )
      return this.cached.value;
    const first = this.entriesAfter(since);
    let value: GpuSceneChangedBounds;
    if (first === undefined) {
      value = 'unbounded';
    } else {
      const merged: number[] = [];
      value = EMPTY;
      for (let index = first; index < this.entries.length; index += 1) {
        const entry = this.entries[index] as ChangeEntry;
        if (
          entry.whole ||
          entry.unboundedSlots.some(
            (slot) => ignored?.has(slot) !== true && (observed === undefined || observed.has(slot)),
          )
        ) {
          value = 'unbounded';
          break;
        }
        for (let box = 0; box < entry.boxSlots.length; box += 1) {
          const slot = entry.boxSlots[box] as number;
          if (ignored?.has(slot) === true || (observed !== undefined && !observed.has(slot)))
            continue;
          for (let i = 0; i < 6; i += 1) merged.push(entry.boxes[box * 6 + i] as number);
        }
      }
      if (value !== 'unbounded') value = new Float32Array(merged);
    }
    this.cached = { since, ignored, observed, value };
    return value;
  }

  /**
   * Whether every box {@link changedSince} would report misses the caller:
   * the same answer as testing its merged boxes, without merging them. Boxes
   * are filtered by `ignored`, judged by `misses` and only then by the
   * `observed` membership, so a box outside the caller costs no membership
   * lookup. A change without a proven box, a resync or a revision older than
   * the history never misses.
   */
  changedBoundsMiss(
    since: number,
    current: number,
    misses: (boxes: Float32Array, offset: number) => boolean,
    ignored?: ReadonlySet<number>,
    observed?: { has(slot: number): boolean },
  ): boolean {
    if (since === current) return true;
    const first = this.entriesAfter(since);
    if (first === undefined) return false;
    for (let index = first; index < this.entries.length; index += 1) {
      const entry = this.entries[index] as ChangeEntry;
      if (entry.whole) return false;
      const unbounded = entry.unboundedSlots;
      for (let at = 0; at < unbounded.length; at += 1) {
        const slot = unbounded[at] as number;
        if (ignored?.has(slot) !== true && (observed === undefined || observed.has(slot)))
          return false;
      }
      const boxSlots = entry.boxSlots;
      for (let box = 0; box < boxSlots.length; box += 1) {
        const slot = boxSlots[box] as number;
        if (ignored?.has(slot) === true || misses(entry.boxes, box * 6)) continue;
        if (observed === undefined || observed.has(slot)) return false;
      }
    }
    return true;
  }

  /**
   * Slots created, changed or removed after `since`, or `undefined` when the retained
   * history cannot prove the set.
   */
  changedSlotsSince(since: number, current: number): readonly number[] | undefined {
    if (since === current) return [];
    const first = this.entriesAfter(since);
    if (first === undefined) return undefined;
    const changed: number[] = [];
    for (let index = first; index < this.entries.length; index += 1) {
      const entry = this.entries[index] as ChangeEntry;
      if (entry.whole) return undefined;
      for (const slot of entry.changedSlots) changed.push(slot);
    }
    return changed;
  }

  /**
   * Every world box `slots` occupied after `since`: the boxes logged by later
   * changes (whole-slot old/new boxes, or the moved rows' old/new boxes of an
   * instance-only update, whose unmoved rows stay inside the current box) plus
   * the current whole-slot box. A retained view whose content differs only
   * in these slots re-renders only when one of the boxes touches it. Returns
   * `'unbounded'` when a slot has no proven box or the history cannot prove
   * the set.
   */
  slotBoundsSince(since: number, current: number, slots: Iterable<number>): GpuSceneChangedBounds {
    const wanted = new Set(slots);
    if (wanted.size === 0) return EMPTY;
    const first = since === current ? this.entries.length : this.entriesAfter(since);
    if (first === undefined) return 'unbounded';
    const merged: number[] = [];
    const found = new Set<number>();
    for (let index = first; index < this.entries.length; index += 1) {
      const entry = this.entries[index] as ChangeEntry;
      if (entry.whole || entry.unboundedSlots.some((slot) => wanted.has(slot))) {
        return 'unbounded';
      }
      for (let box = 0; box < entry.boxSlots.length; box += 1) {
        const slot = entry.boxSlots[box] as number;
        if (!wanted.has(slot)) continue;
        found.add(slot);
        for (let i = 0; i < 6; i += 1) merged.push(entry.boxes[box * 6 + i] as number);
      }
    }
    for (const slot of wanted) {
      if (this.slots.unbounded(slot)) return 'unbounded';
      if (this.slots.hasBox(slot)) {
        this.slots.pushBox(slot, merged);
      } else if (!found.has(slot)) {
        return 'unbounded';
      }
    }
    return new Float32Array(merged);
  }

  private entriesAfter(since: number): number | undefined {
    const first = this.entries.findIndex((entry) => entry.revision > since);
    if (first < 0 || (this.entries[first] as ChangeEntry).revision !== since + 1) return undefined;
    return first;
  }

  private push(entry: ChangeEntry): void {
    this.entries.push(entry);
    if (this.entries.length > HISTORY) this.entries.shift();
  }
}
