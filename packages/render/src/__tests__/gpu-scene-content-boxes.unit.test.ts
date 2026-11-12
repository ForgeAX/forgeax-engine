import { describe, expect, it } from 'vitest';
import {
  GpuSceneContentBoxes,
  type GpuSceneSlotBounds,
  type GpuSceneSlotRowBoxes,
  type SceneContentCursor,
} from '../gpu-scene-content-boxes';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneSlot,
} from '../scene/render-scene-types';
import { CONTENT_BOX, CONTENT_CHANGED, RowChangeLog } from '../scene/row-change-log';

const slot = {
  worldId: 0,
  entityKey: 1,
  slot: 3,
  generation: 1,
  snapshot: { instances: { instanceCount: 1024 } },
} as unknown as RenderSceneSlot;

function delta(overrides: Partial<RenderSceneApplyResult>): RenderSceneApplyResult {
  return {
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
    ...overrides,
  };
}

/**
 * The content boxes over one row journal, addressed by sync count: cursor `n`
 * is the journal position after the `n`-th recorded sync (0 before any).
 */
class Journal {
  readonly log = new RowChangeLog();
  readonly boxes = new GpuSceneContentBoxes();
  private readonly cursors: SceneContentCursor[] = [{ journal: this.log, position: 0 }];

  record(
    at: number,
    change: RenderSceneApplyResult,
    boundsOf?: GpuSceneSlotBounds,
    rowBoxesOf?: GpuSceneSlotRowBoxes,
  ): void {
    expect(at).toBe(this.cursors.length);
    this.boxes.record(this.log, change, boundsOf, rowBoxesOf);
    this.cursors.push({ journal: this.log, position: this.log.position });
  }

  /** Buffer contents changed in place: each slot keeps its current box, or becomes unbounded. */
  recordContent(at: number, slots: ReadonlySet<number>): void {
    const current = this.at(this.cursors.length - 1);
    const updated = [...slots].map(
      (slot) => ({ slot, snapshot: {} }) as unknown as RenderSceneSlot,
    );
    this.record(at, delta({ contentUpdatedSlots: updated }), (record) => {
      const held = this.boxes.slotBoundsSince(current, current, [record.slot]);
      if (held === 'unbounded' || held.length < 6) return undefined;
      return {
        min: [held[0], held[1], held[2]],
        max: [held[3], held[4], held[5]],
      } as RenderSceneBounds;
    });
  }

  at(index: number): SceneContentCursor {
    return this.cursors[index] as SceneContentCursor;
  }

  changedSince(
    since: number,
    current: number,
    ignored?: ReadonlySet<number>,
    observed?: { has(slot: number): boolean },
  ) {
    return this.boxes.changedSince(this.at(since), this.at(current), ignored, observed);
  }

  changedBoundsMiss(
    since: number,
    current: number,
    misses: (boxes: Float32Array, offset: number) => boolean,
    ignored?: ReadonlySet<number>,
    observed?: { has(slot: number): boolean },
  ) {
    return this.boxes.changedBoundsMiss(
      this.at(since),
      this.at(current),
      misses,
      ignored,
      observed,
    );
  }

  changedSlotsSince(since: number, current: number) {
    return this.boxes.changedSlotsSince(this.at(since), this.at(current));
  }

  slotBoundsSince(since: number, current: number, slots: Iterable<number>) {
    return this.boxes.slotBoundsSince(this.at(since), this.at(current), slots);
  }
}

const union: RenderSceneBounds = { min: [0, 0, 0], max: [512, 2, 512] };
const moved: RenderSceneBounds = { min: [0, 0, 0], max: [600, 2, 512] };
const rowBoxes = new Float32Array([10, 0, 10, 12, 2, 12, 598, 0, 10, 600, 2, 12]);

describe('GpuSceneContentBoxes row boxes', () => {
  it('keeps material-only changes independent of object membership and reports removed slots', () => {
    const log = new Journal();
    log.record(1, delta({ createdSlots: [slot] }));
    log.record(2, delta({}));
    expect(log.changedSlotsSince(1, 2)).toEqual([]);
    expect(log.changedSince(1, 2)).toEqual(new Float32Array());
    log.record(3, delta({ removedSlots: [slot] }));
    expect(log.changedSlotsSince(2, 3)).toEqual([slot.slot]);
    expect(log.changedSince(2, 3)).toBe('unbounded');
  });

  it('retains mesh-content evidence for independent views and skips unrelated slots', () => {
    const log = new Journal();
    log.record(1, delta({ createdSlots: [slot] }), () => union);
    log.recordContent(2, new Set([slot.slot]));
    const expected = new Float32Array([0, 0, 0, 512, 2, 512, 0, 0, 0, 512, 2, 512]);
    expect(log.changedSince(1, 2)).toEqual(expected);
    expect(log.changedSince(1, 2, new Set([slot.slot]))).toEqual(new Float32Array());
    expect(log.changedSince(1, 2)).toEqual(expected);
    expect(log.changedSlotsSince(1, 2)).toEqual([slot.slot]);
    log.recordContent(3, new Set([99]));
    expect(log.changedSince(2, 3)).toBe('unbounded');
    expect(log.changedSince(2, 3, new Set([99]))).toEqual(new Float32Array());
  });

  it('records the moved rows of an instance-only update instead of the union', () => {
    const log = new Journal();
    log.record(1, delta({ createdSlots: [slot] }), () => union);
    log.record(
      2,
      delta({ updatedSlots: [slot], instanceUpdatedSlots: [slot] }),
      () => moved,
      () => rowBoxes,
    );
    expect(Array.from(log.changedSince(1, 2) as Float32Array)).toEqual(Array.from(rowBoxes));
    expect(log.changedSlotsSince(1, 2)).toEqual([3]);
    // The retained union follows the move, so a later whole-slot change
    // reports the new union as its old box.
    log.record(3, delta({ updatedSlots: [slot], contentUpdatedSlots: [slot] }), () => union);
    expect(Array.from(log.changedSince(2, 3) as Float32Array)).toEqual([
      0, 0, 0, 600, 2, 512, 0, 0, 0, 512, 2, 512,
    ]);
  });

  it('keeps union boxes for content updates and unanswered row boxes', () => {
    const log = new Journal();
    log.record(1, delta({ createdSlots: [slot] }), () => union);
    log.record(
      2,
      delta({ updatedSlots: [slot], contentUpdatedSlots: [slot] }),
      () => moved,
      () => rowBoxes,
    );
    expect(Array.from(log.changedSince(1, 2) as Float32Array)).toEqual([
      0, 0, 0, 512, 2, 512, 0, 0, 0, 600, 2, 512,
    ]);
    log.record(
      3,
      delta({ updatedSlots: [slot], instanceUpdatedSlots: [slot] }),
      () => union,
      () => undefined,
    );
    expect(Array.from(log.changedSince(2, 3) as Float32Array)).toEqual([
      0, 0, 0, 600, 2, 512, 0, 0, 0, 512, 2, 512,
    ]);
  });
});

describe('GpuSceneContentBoxes rebuild seeding', () => {
  const cube = { ...slot, snapshot: {} } as unknown as RenderSceneSlot;
  const before: RenderSceneBounds = { min: [0, 0, 0], max: [1, 1, 1] };
  const after: RenderSceneBounds = { min: [0, 0.2, 0], max: [1, 1.2, 1] };

  it('proves the first change after a bounded rebuild', () => {
    const log = new Journal();
    log.record(1, delta({ createdSlots: [cube], resynced: 1 }), () => before);
    log.record(2, delta({ updatedSlots: [cube] }), () => after);
    expect(log.slotBoundsSince(1, 2, [3])).toEqual(
      new Float32Array([0, 0, 0, 1, 1, 1, 0, 0.2, 0, 1, 1.2, 1, 0, 0.2, 0, 1, 1.2, 1]),
    );
    expect(log.changedSince(1, 2)).not.toBe('unbounded');
  });

  it('keeps the first change after an unbounded rebuild unproven', () => {
    const log = new Journal();
    log.record(1, delta({ createdSlots: [cube], resynced: 1 }));
    log.record(2, delta({ updatedSlots: [cube] }), () => after);
    expect(log.slotBoundsSince(1, 2, [3])).toBe('unbounded');
  });

  it('forgets boxes of slots a resync dropped', () => {
    const log = new Journal();
    log.record(1, delta({ createdSlots: [cube] }), () => before);
    log.record(2, delta({ resynced: 1 }), () => before);
    log.record(3, delta({ createdSlots: [cube] }), () => after);
    expect(log.changedSince(2, 3)).toEqual(new Float32Array([0, 0.2, 0, 1, 1.2, 1]));
  });
});

describe('GpuSceneContentBoxes changedBoundsMiss', () => {
  it('answers exactly what testing the merged changedSince boxes answers', () => {
    let seed = 0x9e3779b9;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const boxOf = (): RenderSceneBounds => {
      const x = random() * 100;
      const z = random() * 100;
      const size = 1 + random() * 8;
      return { min: [x, 0, z], max: [x + size, 2, z + size] };
    };
    const rowOf = (index: number): RenderSceneSlot =>
      ({
        worldId: 0,
        entityKey: index + 1,
        slot: index,
        generation: 1,
        snapshot: { instances: { instanceCount: 1 } },
      }) as unknown as RenderSceneSlot;
    const rows = Array.from({ length: 40 }, (_, index) => rowOf(index));
    const log = new Journal();
    let revision = 0;
    for (let step = 0; step < 24; step += 1) {
      revision += 1;
      const pick = rows.filter(() => random() < 0.2);
      if (step % 7 === 6) log.recordContent(revision, new Set(pick.map((row) => row.slot)));
      else
        log.record(revision, delta({ updatedSlots: pick }), () =>
          random() < 0.1 ? undefined : boxOf(),
        );
    }
    const viewBoxes = Array.from({ length: 6 }, boxOf).map((view) => ({
      min: [view.min[0] - 10, -1, view.min[2] - 10],
      max: [view.max[0] + 10, 3, view.max[2] + 10],
    }));
    let cases = 0;
    const outcomes = new Set<boolean>();
    for (const view of viewBoxes) {
      const missesAt = (boxes: Float32Array, offset: number): boolean =>
        (boxes[offset + 3] as number) < (view.min[0] as number) ||
        (boxes[offset] as number) > (view.max[0] as number) ||
        (boxes[offset + 5] as number) < (view.min[2] as number) ||
        (boxes[offset + 2] as number) > (view.max[2] as number);
      for (let since = revision - 18; since <= revision; since += 1) {
        for (let variant = 0; variant < 4; variant += 1) {
          const ignored =
            variant & 1 ? new Set(rows.filter(() => random() < 0.5).map((r) => r.slot)) : undefined;
          const observedSet =
            variant & 2 ? new Set(rows.filter(() => random() < 0.5).map((r) => r.slot)) : undefined;
          const merged = log.changedSince(since, revision, ignored, observedSet);
          let expected = merged !== 'unbounded';
          if (merged !== 'unbounded')
            for (let offset = 0; offset < merged.length; offset += 6)
              if (!missesAt(merged, offset)) expected = false;
          expect(log.changedBoundsMiss(since, revision, missesAt, ignored, observedSet)).toBe(
            expected,
          );
          outcomes.add(expected);
          cases += 1;
        }
      }
    }
    expect(cases).toBe(6 * 19 * 4);
    expect([...outcomes].sort()).toEqual([false, true]);
  });

  it('answers unbounded for a cursor of another journal and for a lapsed one', () => {
    const log = new Journal();
    log.record(1, delta({ createdSlots: [slot] }), () => union);
    const other: SceneContentCursor = { journal: new RowChangeLog(), position: 0 };
    expect(log.boxes.changedSince(other, log.at(1))).toBe('unbounded');
    expect(log.boxes.changedSlotsSince(other, log.at(1))).toBeUndefined();
    expect(log.boxes.changedBoundsMiss(other, log.at(1), () => true)).toBe(false);
    const lapsed: SceneContentCursor = { journal: log.log, position: -1 };
    expect(log.boxes.changedSince(lapsed, log.at(1))).toBe('unbounded');
  });
});

describe('RowChangeLog content entries', () => {
  it('keeps row and content entries invisible to each other', () => {
    const log = new RowChangeLog();
    log.append(3, 'enter', 7, 0);
    log.appendContent(5, CONTENT_BOX | CONTENT_CHANGED, [1, 2, 3, 4, 5, 6]);
    log.append(3, 'leave', 7, 0);
    const rows: unknown[] = [];
    expect(
      log.visit(0, log.position, (slot, kind, generation) => rows.push([slot, kind, generation])),
    ).toBe(true);
    expect(rows).toEqual([
      [3, 'enter', 7],
      [3, 'leave', 7],
    ]);
    const content: unknown[] = [];
    expect(
      log.visitContent(0, log.position, (slot, flags, boxes, offset) => {
        content.push([slot, flags, [...boxes.subarray(offset, offset + 6)]]);
        return true;
      }),
    ).toBe('done');
    expect(content).toEqual([[5, CONTENT_BOX | CONTENT_CHANGED, [1, 2, 3, 4, 5, 6]]]);
  });

  it('lapses a content cursor whose box the ring overwrote', () => {
    const log = new RowChangeLog();
    for (let i = 0; i < 4096; i++) log.appendContent(i, CONTENT_BOX, [i, i, i, i, i, i]);
    expect(log.visitContent(0, log.position, () => true)).toBe('lapsed');
    expect(log.visitContent(log.position - 8, log.position, () => true)).toBe('done');
  });
});
