import { expect, it } from 'vitest';
import type { RenderableSnapshot } from '../../render-system-extract';
import type { RowChange } from '../row-change-log';
import { type SceneSlotFrame, SceneSlots } from '../scene-slots';
import { setSceneRow } from './scene-row-writes';

const row = (entityKey: number, generation = 1) => ({
  generation,
  worldId: 0,
  entityKey,
  snapshot: { worldId: 0, entityKey } as RenderableSnapshot,
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
