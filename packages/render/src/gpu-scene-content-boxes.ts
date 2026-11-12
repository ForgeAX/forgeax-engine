import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneSlot,
} from './scene/render-scene-types';
import {
  CONTENT_BOX,
  CONTENT_CHANGED,
  CONTENT_UNBOUNDED,
  CONTENT_WHOLE,
  type RowChangeLog,
} from './scene/row-change-log';

export type GpuSceneSlotBounds = (slot: RenderSceneSlot) => RenderSceneBounds | undefined;

/**
 * Old/new world boxes (six floats each) of the rows an instance-only update
 * moved, read after `GpuSceneSlotBounds` answered the slot's new union. Any
 * `undefined` falls back to the slot's old and new union boxes.
 */
export type GpuSceneSlotRowBoxes = (slot: RenderSceneSlot) => Float32Array | undefined;

/** Changed world bounds since a cursor, or `'unbounded'` when a change has no proven box. */
export type GpuSceneChangedBounds = Float32Array | 'unbounded';

/**
 * A GPU Scene content consumer's position in the scene's one row journal
 * ({@link RowChangeLog}). Equal cursors (by identity) observed the same
 * content; a cursor of another journal cannot be answered.
 */
export interface SceneContentCursor {
  readonly journal: RowChangeLog;
  readonly position: number;
}

type Membership = { has(slot: number): boolean };

const EMPTY = new Float32Array(0);
const BOXED = 1;
const UNBOUNDED = 2;
const box = new Float32Array(6);

function writeBox(out: Float32Array, at: number, bounds: RenderSceneBounds): void {
  out[at] = bounds.min[0] as number;
  out[at + 1] = bounds.min[1] as number;
  out[at + 2] = bounds.min[2] as number;
  out[at + 3] = bounds.max[0] as number;
  out[at + 4] = bounds.max[1] as number;
  out[at + 5] = bounds.max[2] as number;
}

/** A slot whose change has no proven box, or a box that touches the filtered caller. */
function counts(
  slot: number,
  ignored: ReadonlySet<number> | undefined,
  observed: Membership | undefined,
): boolean {
  return ignored?.has(slot) !== true && (observed === undefined || observed.has(slot));
}

/** Push `boxes[offset..offset+6)` onto `out`. */
function pushBox(out: number[], boxes: Float32Array, offset: number): void {
  for (let i = 0; i < 6; i += 1) out.push(boxes[offset + i] as number);
}

/**
 * The GPU Scene's conservative content evidence. Each dense scene slot's
 * current box (six floats) or unbounded mark lives in slot-indexed columns;
 * every synced change appends its slot and the old and new boxes to the
 * scene's one row journal as content entries. A consumer that retained
 * content at a cursor re-renders only when a box logged after it intersects
 * its view; any change without a conservative box, a resync, or a cursor the
 * journal no longer holds reports `'unbounded'`.
 */
export class GpuSceneContentBoxes {
  private state = new Uint8Array(0);
  private values = new Float32Array(0);
  private readonly seen = new Set<number>();
  private cached:
    | {
        readonly since: SceneContentCursor;
        readonly current: SceneContentCursor;
        readonly ignored: ReadonlySet<number> | undefined;
        readonly observed: Membership | undefined;
        readonly value: GpuSceneChangedBounds;
      }
    | undefined;

  /** Append one synced delta's content entries to `journal`. */
  record(
    journal: RowChangeLog,
    delta: RenderSceneApplyResult,
    boundsOf?: GpuSceneSlotBounds,
    rowBoxesOf?: GpuSceneSlotRowBoxes,
  ): void {
    this.cached = undefined;
    if (delta.resynced > 0) {
      this.state.fill(0);
      journal.appendContent(-1, CONTENT_WHOLE);
    }
    for (const record of delta.removedSlots) {
      const changed = this.appendOld(journal, record.slot, CONTENT_CHANGED);
      if (changed !== 0) journal.appendContent(record.slot, CONTENT_CHANGED);
      this.delete(record.slot);
    }
    // Only an instance-only update may report row boxes; the bounds cache
    // answers them only while the root transform and mesh are unchanged.
    let rowUpdateSlots: Set<number> | undefined;
    if (rowBoxesOf !== undefined && delta.instanceUpdatedSlots.length > 0) {
      rowUpdateSlots = new Set();
      for (const record of delta.instanceUpdatedSlots) rowUpdateSlots.add(record.slot);
    }
    const seen = this.seen;
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
        const rows =
          rowUpdateSlots?.has(record.slot) === true
            ? this.recordRowBoxes(journal, record, boundsOf, rowBoxesOf)
            : false;
        if (!rows) this.recordSlot(journal, record, boundsOf);
      }
    }
  }

  /** An instance-only update: the moved rows' old/new boxes replace the union pair. */
  private recordRowBoxes(
    journal: RowChangeLog,
    record: RenderSceneSlot,
    boundsOf: GpuSceneSlotBounds | undefined,
    rowBoxesOf: GpuSceneSlotRowBoxes | undefined,
  ): boolean {
    if (!this.hasBox(record.slot) || record.snapshot.skinBinding !== undefined) return false;
    const bounds = boundsOf?.(record);
    const rows = bounds === undefined ? undefined : rowBoxesOf?.(record);
    if (bounds === undefined || rows === undefined) return false;
    let changed = CONTENT_CHANGED;
    for (let at = 0; at + 6 <= rows.length; at += 6) {
      journal.appendContent(record.slot, CONTENT_BOX | changed, rows, at);
      changed = 0;
    }
    if (changed !== 0) journal.appendContent(record.slot, changed);
    this.write(record.slot, bounds);
    return true;
  }

  private recordSlot(
    journal: RowChangeLog,
    record: RenderSceneSlot,
    boundsOf: GpuSceneSlotBounds | undefined,
  ): void {
    const slot = record.slot;
    const snapshot = record.snapshot;
    let changed = this.appendOld(journal, slot, CONTENT_CHANGED);
    // Skinned and sprite casters deform beyond their bind-pose box.
    const bounds =
      snapshot.skinBinding !== undefined || snapshot.spriteInstances !== undefined
        ? undefined
        : boundsOf?.(record);
    if (bounds !== undefined) {
      this.write(slot, bounds);
      journal.appendContent(slot, CONTENT_BOX | changed, this.values, slot * 6);
      return;
    }
    if (snapshot.instances?.instanceCount === 0) {
      this.delete(slot);
    } else {
      this.markUnbounded(slot);
      journal.appendContent(slot, CONTENT_UNBOUNDED | changed);
      changed = 0;
    }
    if (changed !== 0) journal.appendContent(slot, changed);
  }

  /** Log the slot's retained box (or unbounded mark); returns the still-unlogged changed flag. */
  private appendOld(journal: RowChangeLog, slot: number, changed: number): number {
    if (this.hasBox(slot)) {
      journal.appendContent(slot, CONTENT_BOX | changed, this.values, slot * 6);
      return 0;
    }
    if (!this.unbounded(slot)) return changed;
    journal.appendContent(slot, CONTENT_UNBOUNDED | changed);
    return 0;
  }

  /**
   * Boxes changed after `since`, skipping `ignored` slots and, when supplied,
   * slots absent from the retained owner's `observed` membership. Consumers
   * pass their existing membership without copying it.
   */
  changedSince(
    since: SceneContentCursor,
    current: SceneContentCursor,
    ignored?: ReadonlySet<number>,
    observed?: Membership,
  ): GpuSceneChangedBounds {
    if (since === current) return EMPTY;
    const cached = this.cached;
    if (
      cached?.since === since &&
      cached.current === current &&
      cached.ignored === ignored &&
      cached.observed === observed
    )
      return cached.value;
    const merged: number[] = [];
    let unbounded = since.journal !== current.journal;
    if (!unbounded) {
      const visited = current.journal.visitContent(
        since.position,
        current.position,
        (slot, flags, boxes, offset) => {
          if ((flags & CONTENT_WHOLE) !== 0) return false;
          if (!counts(slot, ignored, observed)) return true;
          if ((flags & CONTENT_UNBOUNDED) !== 0) return false;
          if ((flags & CONTENT_BOX) !== 0) pushBox(merged, boxes, offset);
          return true;
        },
      );
      unbounded = visited !== 'done';
    }
    const value: GpuSceneChangedBounds = unbounded ? 'unbounded' : new Float32Array(merged);
    this.cached = { since, current, ignored, observed, value };
    return value;
  }

  /**
   * Whether every box {@link changedSince} would report misses the caller:
   * the same answer as testing its merged boxes, without merging them. Boxes
   * are filtered by `ignored`, judged by `misses` and only then by the
   * `observed` membership, so a box outside the caller costs no membership
   * lookup. A change without a proven box, a resync or a cursor the journal
   * no longer holds never misses.
   */
  changedBoundsMiss(
    since: SceneContentCursor,
    current: SceneContentCursor,
    misses: (boxes: Float32Array, offset: number) => boolean,
    ignored?: ReadonlySet<number>,
    observed?: Membership,
  ): boolean {
    if (since === current) return true;
    if (since.journal !== current.journal) return false;
    const visited = current.journal.visitContent(
      since.position,
      current.position,
      (slot, flags, boxes, offset) => {
        if ((flags & CONTENT_WHOLE) !== 0) return false;
        if ((flags & CONTENT_UNBOUNDED) !== 0) return !counts(slot, ignored, observed);
        if ((flags & CONTENT_BOX) === 0) return true;
        if (ignored?.has(slot) === true || misses(boxes, offset)) return true;
        return observed !== undefined && !observed.has(slot);
      },
    );
    return visited === 'done';
  }

  /**
   * Slots created, changed or removed after `since`, or `undefined` when the
   * journal cannot prove the set.
   */
  changedSlotsSince(
    since: SceneContentCursor,
    current: SceneContentCursor,
  ): readonly number[] | undefined {
    if (since === current) return [];
    if (since.journal !== current.journal) return undefined;
    const changed: number[] = [];
    const visited = current.journal.visitContent(
      since.position,
      current.position,
      (slot, flags) => {
        if ((flags & CONTENT_WHOLE) !== 0) return false;
        if ((flags & CONTENT_CHANGED) !== 0) changed.push(slot);
        return true;
      },
    );
    return visited === 'done' ? changed : undefined;
  }

  /**
   * Every world box `slots` occupied after `since`: the boxes logged by later
   * changes (whole-slot old/new boxes, or the moved rows' old/new boxes of an
   * instance-only update, whose unmoved rows stay inside the current box) plus
   * the current whole-slot box. A retained view whose content differs only
   * in these slots re-renders only when one of the boxes touches it. Returns
   * `'unbounded'` when a slot has no proven box or the journal cannot prove
   * the set.
   */
  slotBoundsSince(
    since: SceneContentCursor,
    current: SceneContentCursor,
    slots: Iterable<number>,
  ): GpuSceneChangedBounds {
    const wanted = new Set(slots);
    if (wanted.size === 0) return EMPTY;
    if (since.journal !== current.journal) return 'unbounded';
    const merged: number[] = [];
    const found = new Set<number>();
    const visited =
      since === current
        ? 'done'
        : current.journal.visitContent(
            since.position,
            current.position,
            (slot, flags, boxes, offset) => {
              if ((flags & CONTENT_WHOLE) !== 0) return false;
              if (!wanted.has(slot)) return true;
              if ((flags & CONTENT_UNBOUNDED) !== 0) return false;
              if ((flags & CONTENT_BOX) === 0) return true;
              found.add(slot);
              pushBox(merged, boxes, offset);
              return true;
            },
          );
    if (visited !== 'done') return 'unbounded';
    for (const slot of wanted) {
      if (this.unbounded(slot)) return 'unbounded';
      if (this.hasBox(slot)) {
        pushBox(merged, this.values, slot * 6);
      } else if (!found.has(slot)) {
        return 'unbounded';
      }
    }
    return new Float32Array(merged);
  }

  private hasBox(slot: number): boolean {
    return this.state[slot] === BOXED;
  }

  private unbounded(slot: number): boolean {
    return this.state[slot] === UNBOUNDED;
  }

  private write(slot: number, bounds: RenderSceneBounds): void {
    this.ensure(slot);
    this.state[slot] = BOXED;
    writeBox(box, 0, bounds);
    this.values.set(box, slot * 6);
  }

  private markUnbounded(slot: number): void {
    this.ensure(slot);
    this.state[slot] = UNBOUNDED;
  }

  private delete(slot: number): void {
    if (slot < this.state.length) this.state[slot] = 0;
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
