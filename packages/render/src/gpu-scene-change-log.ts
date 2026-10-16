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
  /** Slots created or changed, i.e. every slot whose shadow must be re-rendered. */
  readonly changedSlots: Int32Array;
}

const HISTORY = 16;
const EMPTY = new Float32Array(0);
const EMPTY_SLOTS = new Int32Array(0);

/**
 * Old and new world boxes of every slot a scene revision changed. A consumer
 * that retained content at revision R re-renders only when a box changed after
 * R intersects its view; any change without a conservative box, a resync, or a
 * revision older than the retained history reports `'unbounded'`.
 */
export class GpuSceneChangeLog {
  private readonly boundsBySlot = new Map<number, Float32Array>();
  private readonly unboundedSlots = new Set<number>();
  private readonly entries: ChangeEntry[] = [];
  private cached:
    | {
        readonly since: number;
        readonly ignored: ReadonlySet<number> | undefined;
        readonly observed: ReadonlyMap<number, unknown> | undefined;
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
    const whole = boundsOf === undefined || delta.resynced > 0;
    if (delta.resynced > 0) {
      this.boundsBySlot.clear();
      this.unboundedSlots.clear();
    }
    const boxes: number[] = [];
    const boxSlots: number[] = [];
    const unboundedSlots: number[] = [];
    const changedSlots: number[] = [];
    const pushOld = (slot: number): void => {
      const previous = this.boundsBySlot.get(slot);
      if (previous === undefined) {
        if (this.unboundedSlots.has(slot)) unboundedSlots.push(slot);
        return;
      }
      for (let i = 0; i < 6; i += 1) boxes.push(previous[i] as number);
      boxSlots.push(slot);
    };
    for (const record of delta.removedSlots) {
      pushOld(record.slot);
      this.boundsBySlot.delete(record.slot);
      this.unboundedSlots.delete(record.slot);
    }
    // Only an instance-only update may report row boxes; the bounds cache
    // answers them only while the root transform and mesh are unchanged.
    const rowUpdateSlots = new Set(delta.instanceUpdatedSlots.map((record) => record.slot));
    const seen = new Set<number>();
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
        const retained = this.boundsBySlot.get(record.slot);
        if (
          rowBoxesOf !== undefined &&
          retained !== undefined &&
          rowUpdateSlots.has(record.slot) &&
          snapshot.skin === undefined
        ) {
          const bounds = boundsOf?.(record);
          const rows = bounds === undefined ? undefined : rowBoxesOf(record);
          if (bounds !== undefined && rows !== undefined) {
            for (let box = 0; box + 6 <= rows.length; box += 6) {
              for (let i = 0; i < 6; i += 1) boxes.push(rows[box + i] as number);
              boxSlots.push(record.slot);
            }
            retained.set([...bounds.min, ...bounds.max]);
            continue;
          }
        }
        pushOld(record.slot);
        // Skinned and sprite casters deform beyond their bind-pose box.
        const bounds =
          snapshot.skin !== undefined || snapshot.spriteInstances !== undefined
            ? undefined
            : boundsOf?.(record);
        if (bounds === undefined) {
          this.boundsBySlot.delete(record.slot);
          if (snapshot.instances?.instanceCount === 0) {
            this.unboundedSlots.delete(record.slot);
          } else {
            this.unboundedSlots.add(record.slot);
            unboundedSlots.push(record.slot);
          }
          continue;
        }
        this.unboundedSlots.delete(record.slot);
        const box = new Float32Array([
          bounds.min[0],
          bounds.min[1],
          bounds.min[2],
          bounds.max[0],
          bounds.max[1],
          bounds.max[2],
        ]);
        this.boundsBySlot.set(record.slot, box);
        for (let i = 0; i < 6; i += 1) boxes.push(box[i] as number);
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
      const box = this.boundsBySlot.get(slot);
      if (box === undefined) {
        unboundedSlots.push(slot);
        continue;
      }
      for (const value of box) boxes.push(value);
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
    this.boundsBySlot.clear();
    this.unboundedSlots.clear();
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
   * slots absent from the retained owner's `observed` map. The map's values
   * are unused; consumers can pass their existing membership without copying it.
   */
  changedSince(
    since: number,
    current: number,
    ignored?: ReadonlySet<number>,
    observed?: ReadonlyMap<number, unknown>,
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
   * Slots created or changed after `since`, or `undefined` when the retained
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
      if (this.unboundedSlots.has(slot)) return 'unbounded';
      const box = this.boundsBySlot.get(slot);
      if (box !== undefined) {
        for (let i = 0; i < 6; i += 1) merged.push(box[i] as number);
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
