import { expect, it, vi } from 'vitest';
import type { RenderableSnapshot } from '../../render-system-extract';
import { CONTENT_CHANGED, type RowChange } from '../row-change-log';
import { type SceneSlotFrame, SceneSlots } from '../scene-slots';
import { setSceneRow } from './scene-row-writes';

const row = (entityKey: number, generation = 1) => ({
  generation,
  entityKey,
  snapshot: { entityKey } as RenderableSnapshot,
});

function populated(count: number): SceneSlots {
  const slots = new SceneSlots();
  for (let slot = 0; slot < count; slot++) setSceneRow(slots, slot, row(slot));
  return slots;
}

function changes(after: SceneSlotFrame, before: SceneSlotFrame): string[] | undefined {
  const logged: string[] = [];
  const visit = (slot: number, kind: RowChange, generation: number) =>
    logged.push(`${kind}:${slot}:${generation}`);
  return after.changesSince(before, visit) ? logged : undefined;
}

it('derives entered and left rows in O(changes), independent of scene size', () => {
  for (const count of [1000, 100000]) {
    const slots = populated(count);
    const before = slots.capture();
    setSceneRow(slots, count, row(count));
    setSceneRow(slots, 17, undefined);
    expect(changes(slots.capture(), before)).toEqual([`enter:${count}:1`, 'leave:17:1']);
  }
});

it('logs an identity replacement at one slot as a leave then an enter', () => {
  const slots = populated(4);
  const before = slots.capture();
  setSceneRow(slots, 2, row(99, 5));
  slots.writePose(1, new Float32Array(16));
  expect(changes(slots.capture(), before)).toEqual(['leave:2:1', 'enter:2:5', 'update:1:1']);
});

it('gives each consumer its own cursor over the one shared log', () => {
  const slots = populated(64);
  const first = slots.capture();
  setSceneRow(slots, 3, undefined);
  const second = slots.capture();
  setSceneRow(slots, 5, row(5, 2));
  const third = slots.capture();
  // A consumer that last read `first` sees both changes; one at `second` only the later.
  expect(changes(third, first)).toEqual(['leave:3:1', 'update:5:2']);
  expect(changes(third, second)).toEqual(['update:5:2']);
  expect(changes(third, third)).toEqual([]);
  // Writes after a capture belong to the next frame.
  setSceneRow(slots, 6, undefined);
  expect(changes(third, second)).toEqual(['update:5:2']);
});

it('declines cursors it cannot answer: other owners, a clear, or lapsed history', () => {
  const slots = populated(8);
  const before = slots.capture();
  expect(changes(populated(8).capture(), before)).toBeUndefined();
  // A frame cannot be diffed backwards.
  setSceneRow(slots, 0, undefined);
  expect(changes(before, slots.capture())).toBeUndefined();
  const kept = slots.capture();
  slots.clear();
  expect(changes(slots.capture(), kept)).toBeUndefined();
  // The ring retains about two full-scene rewrites, then the oldest cursor lapses.
  const churn = populated(8);
  const old = churn.capture();
  for (let round = 0; round < 2048; round++) churn.writePose(round % 8, new Float32Array(16));
  expect(changes(churn.capture(), old)).toBeUndefined();
  const recent = churn.capture();
  churn.writePose(0, new Float32Array(16));
  expect(changes(churn.capture(), recent)).toEqual(['update:0:1']);
});

it('walks occupied lanes across both words with independent captured row lifetimes', () => {
  const slots = new SceneSlots();
  const indices = [1, 31, 32, 63, 65, 127, 4_000_032, 4_000_063];
  for (const index of indices) setSceneRow(slots, index, row(index));
  const frame = slots.capture();
  const a = frame[Symbol.iterator]();
  const b = frame[Symbol.iterator]();
  const result = a.next();
  const first = result.value;
  expect(first.slot).toBe(1);
  setSceneRow(slots, 1, undefined);
  setSceneRow(slots, 64, row(64));
  expect(a.next()).toBe(result);
  expect(result.value.slot).toBe(31);
  expect(first.slot).toBe(1);
  expect([...b].map((value) => value.slot)).toEqual(indices);
  expect(a.return?.().done).toBe(true);
  expect(a.next().done).toBe(true);
  expect([...slots.capture()].map((value) => value.slot)).toEqual([
    31, 32, 63, 64, 65, 127, 4_000_032, 4_000_063,
  ]);
});

it('publishes final row versions in first-write order to independent consumers', () => {
  const slots = populated(132);
  const first = slots.capture();
  setSceneRow(slots, 95, undefined);
  slots.writePose(31, new Float32Array(16));
  setSceneRow(slots, 95, row(210, 2));
  slots.writePose(64, new Float32Array(16));
  slots.writePose(31, new Float32Array(16));
  setSceneRow(slots, 32, undefined);
  const second = slots.capture();
  const expected = [95, 31, 64, 32].map((slot) => [slot, second.versionAt(slot)]);
  expect(expected[3]).toEqual([32, 0]);

  setSceneRow(slots, 95, undefined);
  const third = slots.capture();
  const replay = vi.spyOn(slots.journal, 'visit');
  const lookup = vi.spyOn(second, 'versionAt');
  const collect = (after: SceneSlotFrame, before: SceneSlotFrame) => {
    const values: number[][] = [];
    return after.visitChangedVersions(before, (slot, version) => values.push([slot, version]))
      ? values
      : undefined;
  };
  for (let consumer = 0; consumer < 4; consumer++) expect(collect(second, first)).toEqual(expected);
  expect(collect(third, second)).toEqual([[95, 0]]);
  expect(collect(second, second)).toEqual([]);
  expect(replay).not.toHaveBeenCalled();
  // Repeated writes resolve the exact final values from the captured frame.
  expect(lookup.mock.results.map((result) => result.value)).toEqual(
    Array.from({ length: 4 }, () => expected.map((value) => value[1])).flat(),
  );

  const gap = collect(third, first);
  expect(new Map(gap?.map(([slot, version]) => [slot, version]))).toEqual(
    new Map([95, 31, 64, 32].map((slot) => [slot, third.versionAt(slot)])),
  );
  expect(replay).toHaveBeenCalledOnce();
  expect(collect(second, third)).toBeUndefined();
  expect(collect(second, populated(132).capture())).toBeUndefined();
  slots.clear();
  expect(collect(slots.capture(), third)).toBeUndefined();
});

it('reads adjacent distinct writes from existing journal storage and declines overwritten cursors', () => {
  const slots = populated(128);
  const initial = slots.capture();
  const journal = slots.journal;
  const backing = journal.backingBytes;
  journal.appendContent(0, CONTENT_CHANGED);
  const pose = new Float32Array(16);
  pose[12] = 47;
  for (const slot of [67, 4, 31, 91]) slots.writePose(slot, pose);
  setSceneRow(slots, 17, undefined);
  const first = slots.capture();
  const expected = [67, 4, 31, 91, 17].map((slot) => [slot, first.versionAt(slot)]);
  const lookup = vi.spyOn(first, 'versionAt');
  const values: number[][] = [];
  expect(first.visitChangedVersions(initial, (slot, version) => values.push([slot, version]))).toBe(
    true,
  );
  expect(values).toEqual(expected);
  expect(lookup).not.toHaveBeenCalled();
  expect(Object.hasOwn(first, 'rowVersions')).toBe(false);
  for (let frame = 0; frame < 40; frame++) {
    pose[12] = frame;
    for (let slot = 18; slot < 128; slot++) slots.writePose(slot, pose);
    slots.capture();
  }
  expect(journal.backingBytes).toBe(backing);
  const stale = vi.fn();
  expect(first.visitChangedVersions(initial, stale)).toBe(false);
  expect(stale).not.toHaveBeenCalled();
  expect(first.slotAt(67)?.snapshot.transform.world[12]).toBe(47);
});

it.each([
  'wrap',
  'reset',
] as const)('finishes an in-progress publication read across journal %s', (mode) => {
  const slots = populated(8);
  const before = slots.capture();
  const pose = new Float32Array(16);
  for (const slot of [3, 1, 7, 4]) slots.writePose(slot, pose);
  const after = slots.capture();
  const seen: number[][] = [];
  expect(
    after.visitChangedVersions(before, (slot, version) => {
      seen.push([slot, version]);
      if (slot !== 3) return;
      if (mode === 'reset') {
        slots.clear();
        for (let next = 0; next < 8; next++) setSceneRow(slots, next, row(next));
        for (let step = 0; step < 1015; step++) slots.writePose(step % 8, pose);
      } else {
        for (let step = 0; step < 1028; step++) slots.writePose(step % 8, pose);
      }
      slots.capture();
    }),
  ).toBe(true);
  expect(seen).toEqual([3, 1, 7, 4].map((slot) => [slot, after.versionAt(slot)]));
});
