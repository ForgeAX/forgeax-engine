import { assert, expect, test } from 'vitest';
import type { RenderableSnapshot } from '../render-system-extract';
import { setSceneRow } from '../scene/__tests__/scene-row-writes';
import type { RenderSceneSlot } from '../scene/render-scene-types';
import { SceneSlots } from '../scene/scene-slots';

function record(slot: number, generation = 0): RenderSceneSlot {
  return {
    slot,
    generation,
    version: 0,
    worldId: 0,
    entityKey: slot + generation * 100000,
    snapshot: { entityKey: slot, worldId: 0 } as RenderableSnapshot,
  };
}

test('coalesces known writes per page and preserves captured roots through deletion/reuse', () => {
  const slots = new SceneSlots();
  for (let slot = 0; slot < 1000; slot++) setSceneRow(slots, slot, record(slot));
  const before = slots.capture();
  expect(slots.capture()).toBe(before);
  expect(before.length).toBe(1000);
  expect(slots.inspect()).toMatchObject({ newPages: 16, copiedPages: 0 });
  for (let slot = 128; slot < 192; slot++) setSceneRow(slots, slot, record(slot, 1));
  const changed = slots.capture();
  expect(slots.inspect()).toMatchObject({ newPages: 16, copiedPages: 1 });
  expect(changed.pageAt(0)).toBe(before.pageAt(0));
  expect(changed.pageAt(2)).not.toBe(before.pageAt(2));
  expect(changed.slotAt(130)?.generation).toBe(1);
  expect(before.slotAt(130)?.generation).toBe(0);
  setSceneRow(slots, 130, undefined);
  const removed = slots.capture();
  expect(removed.slotAt(130)).toBeUndefined();
  expect(removed.slotAt(131)).toBe(changed.slotAt(131));
  expect(removed.indexOfSlot(131)).toBe(130);
  setSceneRow(slots, 130, record(130, 2));
  const reused = slots.capture();
  expect(reused.slotAt(130)?.generation).toBe(2);
  expect(before.slotAt(130)?.generation).toBe(0);
  expect(changed.slotAt(130)?.generation).toBe(1);
  expect(removed.slotAt(130)).toBeUndefined();
  expect(reused.at(-1)?.slot).toBe(999);
  expect(reused.at(Number.NaN)?.slot).toBe(0);
  expect(reused.slice(2.8, 5.9).map((row) => row.slot)).toEqual([2, 3, 4]);
});

test('randomized fragmented roots agree with current membership and retain old input', () => {
  const slots = new SceneSlots(),
    model = new Map<number, RenderSceneSlot>();
  let seed = 0x5ab1e;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const saved: { frame: ReturnType<SceneSlots['capture']>; rows: RenderSceneSlot[] }[] = [];
  for (let iteration = 0; iteration < 2000; iteration++) {
    const key = random() % 10000;
    const value = setSceneRow(slots, key, random() % 4 === 0 ? undefined : record(key, iteration));
    if (value === undefined) model.delete(key);
    else model.set(key, value);
    expect(slots.get(key)).toBe(value);
    if (iteration % 17 !== 0) continue;
    const frame = slots.capture(),
      rows = [...model.values()].sort((a, b) => a.slot - b.slot);
    expect([...frame]).toEqual(rows);
    expect(frame.length).toBe(rows.length);
    expect(slots.size).toBe(rows.length);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      assert(row);
      expect(frame.at(index)).toBe(row);
      expect(frame.indexOfSlot(row.slot)).toBe(index);
    }
    if (iteration % 85 === 0) saved.push({ frame, rows });
  }
  for (const { frame, rows } of saved) expect([...frame]).toEqual(rows);
  for (const key of model.keys()) setSceneRow(slots, key, undefined);
  const empty = slots.capture();
  expect(empty.length).toBe(0);
  expect(empty.root).toBeUndefined();
  expect(slots.size).toBe(0);
  expect(slots.capacity).toBeGreaterThan(0);
});
