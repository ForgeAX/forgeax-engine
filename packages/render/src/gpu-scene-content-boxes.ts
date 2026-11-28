import { box3 } from '@forgeax/engine-math';
import { slotContent } from './scene/mesh-draw';
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
import type { RowContent } from './scene/row-contents';
import { PublishedPoseRows } from './scene/scene-slots';

/** The scene writes its six coordinates directly. Borrowed sources may supply an owned box. */
export type GpuSceneSlotBounds =
  | {
      writeCullingWorldBoundsAt(slot: RenderSceneSlot, out: box3.Box3): boolean;
      writeCullingPoseBounds?(
        slot: number,
        version: number,
        content: RowContent,
        column: Float32Array,
        offset: number,
        out: box3.Box3,
      ): boolean;
    }
  | ((slot: RenderSceneSlot) => RenderSceneBounds | undefined);

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
const PAGE_ROWS = 64;
const boxOffset = (slot: number) => (slot & (PAGE_ROWS - 1)) * 6;
interface BoundsPage {
  readonly state: Uint8Array;
  live: number;
  boxed: number;
  visit: number;
  low: number;
  high: number;
  values: Float32Array | undefined;
}

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
function pushBox(out: number[], boxes: Float32Array, offset: number, maxWords: number): boolean {
  if (out.length >= maxWords) return false;
  for (let i = 0; i < 6; i += 1) out.push(boxes[offset + i] as number);
  return true;
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
  private readonly pages = new Map<number, BoundsPage>();
  private visit = 0;
  private boundsScratch: box3.Box3 | undefined = box3.create();

  clear(): void {
    this.pages.clear();
    this.visit = 0;
  }

  /** Append one synced delta's content entries to `journal`. */
  record(
    journal: RowChangeLog,
    delta: RenderSceneApplyResult,
    boundsOf?: GpuSceneSlotBounds,
  ): void {
    if (delta.resynced > 0) {
      this.clear();
      journal.appendContent(-1, CONTENT_WHOLE);
    }
    for (const record of delta.removedSlots) {
      const changed = this.appendOld(
        journal,
        record.slot,
        CONTENT_CHANGED,
        this.pages.get(Math.floor(record.slot / PAGE_ROWS)),
      );
      if (changed !== 0) journal.appendContent(record.slot, CONTENT_CHANGED);
      this.setState(record.slot, 0);
    }
    // A nested writer gets its own output until the outer sync has copied its box.
    const scratch = this.boundsScratch;
    this.boundsScratch = undefined;
    try {
      this.recordRows(journal, delta, boundsOf, scratch ?? box3.create());
    } finally {
      this.boundsScratch = scratch;
    }
  }

  private recordRows(
    journal: RowChangeLog,
    delta: RenderSceneApplyResult,
    boundsOf: GpuSceneSlotBounds | undefined,
    scratch: box3.Box3,
  ): void {
    if (this.visit === Number.MAX_SAFE_INTEGER) {
      for (const page of this.pages.values()) page.visit = 0;
      this.visit = 0;
    }
    const visit = ++this.visit;
    let absent: Set<number> | undefined;
    const recordPose = (
      slot: number,
      content: RowContent,
      record: RenderSceneSlot | undefined,
      version: number,
      column?: Float32Array,
      offset = 0,
    ) => {
      const before = this.pages.get(Math.floor(slot / PAGE_ROWS));
      const high = (slot & 32) !== 0;
      const bit = 1 << (slot & 31);
      if (
        (before?.visit === visit && ((high ? before.high : before.low) & bit) !== 0) ||
        absent?.has(slot)
      )
        return;
      const page = this.recordSlot(
        journal,
        slot,
        content,
        boundsOf,
        scratch,
        before,
        record,
        version,
        column,
        offset,
      );
      if (page === undefined) {
        // A zero-instance row owns no bounds storage to carry the duplicate mark.
        absent ??= new Set();
        absent.add(slot);
        return;
      }
      if (page.visit !== visit) {
        page.visit = visit;
        page.low = page.high = 0;
      }
      if (high) page.high |= bit;
      else page.low |= bit;
    };
    const recordChange = (record: RenderSceneSlot) => {
      recordPose(record.slot, slotContent(record), record, record.version);
    };
    delta.createdSlots.forEach(recordChange);
    delta.recreatedSlots.forEach(recordChange);
    const updated = delta.updatedSlots;
    if (
      updated instanceof PublishedPoseRows &&
      (boundsOf === undefined ||
        (typeof boundsOf !== 'function' && boundsOf.writeCullingPoseBounds !== undefined))
    )
      updated.visitWrites(recordChange, (slot, version, content, column, offset) => {
        recordPose(slot, content, undefined, version, column, offset);
      });
    else updated.forEach(recordChange);
    delta.contentUpdatedSlots.forEach(recordChange);
    delta.instanceUpdatedSlots.forEach(recordChange);
  }

  private recordSlot(
    journal: RowChangeLog,
    slot: number,
    snapshot: RowContent,
    boundsOf: GpuSceneSlotBounds | undefined,
    scratch: box3.Box3,
    before: BoundsPage | undefined,
    record: RenderSceneSlot | undefined,
    version: number,
    column: Float32Array | undefined,
    offset: number,
  ): BoundsPage | undefined {
    const changed = this.appendOld(journal, slot, CONTENT_CHANGED, before);
    // Skinned and sprite casters deform beyond their bind-pose box.
    let borrowed: RenderSceneBounds | undefined;
    let written = false;
    if (snapshot.skinBinding === undefined && snapshot.spriteInstances === undefined) {
      if (record !== undefined) {
        if (typeof boundsOf === 'function') borrowed = boundsOf(record);
        else written = boundsOf?.writeCullingWorldBoundsAt(record, scratch) === true;
      } else if (column !== undefined && typeof boundsOf !== 'function')
        written =
          boundsOf?.writeCullingPoseBounds?.(slot, version, snapshot, column, offset, scratch) ===
          true;
    }
    if (written || borrowed !== undefined) {
      const page = this.setState(slot, BOXED) as BoundsPage;
      page.values ??= new Float32Array(PAGE_ROWS * 6);
      const offset = boxOffset(slot);
      if (borrowed === undefined) page.values.set(scratch, offset);
      else writeBox(page.values, offset, borrowed);
      journal.appendContent(slot, CONTENT_BOX | changed, page.values, offset);
      return page;
    }
    if (snapshot.instances?.instanceCount === 0) {
      this.setState(slot, 0);
      if (changed !== 0) journal.appendContent(slot, changed);
      return undefined;
    }
    const page = this.setState(slot, UNBOUNDED);
    journal.appendContent(slot, CONTENT_UNBOUNDED | changed);
    return page;
  }

  /** Log the slot's retained box (or unbounded mark); returns the still-unlogged changed flag. */
  private appendOld(
    journal: RowChangeLog,
    slot: number,
    changed: number,
    page: BoundsPage | undefined,
  ): number {
    const state = page?.state[slot & (PAGE_ROWS - 1)];
    if (state === BOXED) {
      journal.appendContent(slot, CONTENT_BOX | changed, page?.values, boxOffset(slot));
      return 0;
    }
    if (state !== UNBOUNDED) return changed;
    journal.appendContent(slot, CONTENT_UNBOUNDED | changed);
    return 0;
  }

  /**
   * Boxes changed after `since`, skipping `ignored` slots and, when supplied,
   * slots absent from the retained owner's `observed` membership. Consumers
   * pass their existing membership without copying it. A finite limit requests
   * complete bounds only when they fit the caller's rectangle budget.
   */
  changedSince(
    since: SceneContentCursor,
    current: SceneContentCursor,
    ignored?: ReadonlySet<number>,
    observed?: Membership,
    maxBoxes = Number.POSITIVE_INFINITY,
  ): GpuSceneChangedBounds {
    if (since === current) return EMPTY;
    const merged: number[] = [];
    const maxWords = maxBoxes * 6;
    let unbounded = since.journal !== current.journal;
    if (!unbounded) {
      const visited = current.journal.visitContent(
        since.position,
        current.position,
        (slot, flags, boxes, offset) => {
          if ((flags & CONTENT_WHOLE) !== 0) return false;
          if (!counts(slot, ignored, observed)) return true;
          if ((flags & CONTENT_UNBOUNDED) !== 0) return false;
          return (flags & CONTENT_BOX) === 0 || pushBox(merged, boxes, offset, maxWords);
        },
      );
      unbounded = visited !== 'done';
    }
    return unbounded ? 'unbounded' : merged.length === 0 ? EMPTY : new Float32Array(merged);
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
   * Whether a slot was created, changed or removed after `since`: the
   * emptiness of {@link changedSlotsSince} without collecting the slots.
   */
  hasChangedSlotsSince(since: SceneContentCursor, current: SceneContentCursor): boolean {
    if (since === current) return false;
    if (since.journal !== current.journal) return true;
    const visited = current.journal.visitContent(
      since.position,
      current.position,
      (_slot, flags) => (flags & (CONTENT_WHOLE | CONTENT_CHANGED)) === 0,
    );
    return visited !== 'done';
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
    maxBoxes = Number.POSITIVE_INFINITY,
  ): GpuSceneChangedBounds {
    const wanted = slots instanceof Set ? slots : new Set(slots);
    if (wanted.size === 0) return EMPTY;
    if (wanted.size > maxBoxes || since.journal !== current.journal) return 'unbounded';
    const maxWords = maxBoxes * 6;
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
              return pushBox(merged, boxes, offset, maxWords);
            },
          );
    if (visited !== 'done') return 'unbounded';
    for (const slot of wanted) {
      const page = this.pages.get(Math.floor(slot / PAGE_ROWS));
      const state = page?.state[slot & (PAGE_ROWS - 1)];
      if (state === UNBOUNDED) return 'unbounded';
      if (state === BOXED && page?.values !== undefined) {
        if (!pushBox(merged, page.values, boxOffset(slot), maxWords)) return 'unbounded';
      } else if (!found.has(slot)) {
        return 'unbounded';
      }
    }
    return new Float32Array(merged);
  }

  /** Allocate the six-float column only while this page has bounded casters. */
  private setState(slot: number, next: number): BoundsPage | undefined {
    const key = Math.floor(slot / PAGE_ROWS);
    const lane = slot & (PAGE_ROWS - 1);
    let page = this.pages.get(key);
    if (page === undefined) {
      if (next === 0) return undefined;
      page = {
        state: new Uint8Array(PAGE_ROWS),
        live: 0,
        boxed: 0,
        values: undefined,
        visit: 0,
        low: 0,
        high: 0,
      };
      this.pages.set(key, page);
    }
    const before = page.state[lane];
    if (before === next) return page;
    page.state[lane] = next;
    if (before === 0) page.live++;
    if (next === BOXED) page.boxed++;
    if (before === BOXED && --page.boxed === 0) page.values = undefined;
    if (next === 0 && --page.live === 0) this.pages.delete(key);
    return page;
  }
}
