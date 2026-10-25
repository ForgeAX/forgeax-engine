import { describe, expect, it } from 'vitest';
import { GpuSceneChangeLog } from '../gpu-scene-change-log';
import type {
  RenderSceneApplyResult,
  RenderSceneBounds,
  RenderSceneSlot,
} from '../scene/render-scene-types';

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

const union: RenderSceneBounds = { min: [0, 0, 0], max: [512, 2, 512] };
const moved: RenderSceneBounds = { min: [0, 0, 0], max: [600, 2, 512] };
const rowBoxes = new Float32Array([10, 0, 10, 12, 2, 12, 598, 0, 10, 600, 2, 12]);

describe('GpuSceneChangeLog row boxes', () => {
  it('keeps material-only changes independent of object membership and reports removed slots', () => {
    const log = new GpuSceneChangeLog();
    log.record(1, delta({ createdSlots: [slot] }));
    log.record(2, delta({}));
    expect(log.changedSlotsSince(1, 2)).toEqual([]);
    expect(log.changedSince(1, 2)).toEqual(new Float32Array());
    log.record(3, delta({ removedSlots: [slot] }));
    expect(log.changedSlotsSince(2, 3)).toEqual([slot.slot]);
    expect(log.changedSince(2, 3)).toBe('unbounded');
  });

  it('retains mesh-content evidence for independent views and skips unrelated slots', () => {
    const log = new GpuSceneChangeLog();
    log.record(1, delta({ createdSlots: [slot] }), () => union);
    log.recordContent(2, new Set([slot.slot]));
    const expected = new Float32Array([0, 0, 0, 512, 2, 512]);
    expect(log.changedSince(1, 2)).toEqual(expected);
    expect(log.changedSince(1, 2, new Set([slot.slot]))).toEqual(new Float32Array());
    expect(log.changedSince(1, 2)).toEqual(expected);
    expect(log.changedSlotsSince(1, 2)).toEqual([slot.slot]);
    log.recordContent(3, new Set([99]));
    expect(log.changedSince(2, 3)).toBe('unbounded');
    expect(log.changedSince(2, 3, new Set([99]))).toEqual(new Float32Array());
  });

  it('records the moved rows of an instance-only update instead of the union', () => {
    const log = new GpuSceneChangeLog();
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
    const log = new GpuSceneChangeLog();
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

describe('GpuSceneChangeLog rebuild seeding', () => {
  const cube = { ...slot, snapshot: {} } as unknown as RenderSceneSlot;
  const before: RenderSceneBounds = { min: [0, 0, 0], max: [1, 1, 1] };
  const after: RenderSceneBounds = { min: [0, 0.2, 0], max: [1, 1.2, 1] };

  it('proves the first change after a bounded rebuild', () => {
    const log = new GpuSceneChangeLog();
    log.record(1, delta({ createdSlots: [cube], resynced: 1 }), () => before);
    log.record(2, delta({ updatedSlots: [cube] }), () => after);
    expect(log.slotBoundsSince(1, 2, [3])).toEqual(
      new Float32Array([0, 0, 0, 1, 1, 1, 0, 0.2, 0, 1, 1.2, 1, 0, 0.2, 0, 1, 1.2, 1]),
    );
    expect(log.changedSince(1, 2)).not.toBe('unbounded');
  });

  it('keeps the first change after an unbounded rebuild unproven', () => {
    const log = new GpuSceneChangeLog();
    log.record(1, delta({ createdSlots: [cube], resynced: 1 }));
    log.record(2, delta({ updatedSlots: [cube] }), () => after);
    expect(log.slotBoundsSince(1, 2, [3])).toBe('unbounded');
  });

  it('forgets boxes of slots a resync dropped', () => {
    const log = new GpuSceneChangeLog();
    log.record(1, delta({ createdSlots: [cube] }), () => before);
    log.record(2, delta({ resynced: 1 }), () => before);
    log.record(3, delta({ createdSlots: [cube] }), () => after);
    expect(log.changedSince(2, 3)).toEqual(new Float32Array([0, 0.2, 0, 1, 1.2, 1]));
  });
});

describe('GpuSceneChangeLog changedBoundsMiss', () => {
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
    const log = new GpuSceneChangeLog();
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
});
