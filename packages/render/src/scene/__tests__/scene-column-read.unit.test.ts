import { expect, it, vi } from 'vitest';
import { snapshot } from '../../__tests__/gpu-driven-production-fixture';
import { FrameSet } from '../frame-set';
import { SceneSlotPage, SceneSlots } from '../scene-slots';
import { setSceneRow } from './scene-row-writes';

it('reads sparse physical columns without row views and preserves held frames across slot reuse', () => {
  const slots = new SceneSlots();
  setSceneRow(slots, 3, { entityKey: 11, generation: 1, snapshot: snapshot(11, 1) });
  setSceneRow(slots, 130, { entityKey: 22, generation: 1, snapshot: snapshot(22, 1) });
  const before = slots.capture();
  const read = (_content: unknown, entity: number, slot: number) => [entity, slot];
  const view = vi.spyOn(SceneSlotPage.prototype, 'read');
  try {
    expect(before.readContentSlot(3, read)).toEqual(before.readContentAt(0, read));
    expect(before.readContentSlot(130, read)).toEqual(before.readContentAt(1, read));
    const consume = vi.fn(read);
    for (const slot of [-1, 1.5, NaN, Infinity, 64])
      expect(before.readContentSlot(slot, consume)).toBeUndefined();
    expect(consume).not.toHaveBeenCalled();
    expect(view).not.toHaveBeenCalled();
    slots.remove(130);
    setSceneRow(slots, 3, { entityKey: 44, generation: 2, snapshot: snapshot(44, 1) });
    const after = slots.capture();
    view.mockClear();
    expect(before.readContentSlot(3, read)).toEqual([11, 3]);
    expect(before.readContentSlot(130, read)).toEqual([22, 130]);
    expect(after.readContentSlot(3, read)).toEqual([44, 3]);
    expect(after.readContentSlot(130, read)).toBeUndefined();
    expect(view).not.toHaveBeenCalled();
  } finally {
    view.mockRestore();
  }
});

it('intersects captured columns with view words in order and stops at the first result', () => {
  const slots = new SceneSlots();
  const keys = [1, 31, 32, 63, 64, 1023, 1024, 1031];
  for (const slot of keys)
    setSceneRow(slots, slot, { entityKey: slot, generation: 1, snapshot: snapshot(slot, 1) });
  const before = slots.capture();
  const view = FrameSet.from([0, 2, 31, 32, 63, 64, 130, 1023, 1024, 1031]);
  slots.remove(32);
  setSceneRow(slots, 63, { entityKey: 2001, generation: 2, snapshot: snapshot(2001, 1) });
  const seen: number[] = [];
  expect(
    before.findContent((_row, entity) => {
      seen.push(entity);
      return entity === 1023 ? false : undefined;
    }, view),
  ).toBe(false);
  expect(seen).toEqual([31, 32, 63, 64, 1023]);
  seen.length = 0;
  slots.capture().findContent((_row, entity) => {
    seen.push(entity);
  }, view);
  expect(seen).toEqual([31, 2001, 64, 1023, 1024, 1031]);
});

it('filters display facts in the captured view rank domain across holes and high bits', () => {
  const slots = new SceneSlots();
  const keys = [0, 3, 31, 32, 37, 59, 63, 64, 65, 1023, 1024, 1055];
  for (const slot of keys)
    setSceneRow(slots, slot, { entityKey: slot, generation: 1, snapshot: snapshot(slot, 1) });
  const held = slots.capture();
  const subset = FrameSet.from([1, 31, 37, 59, 63, 64, 1023, 1055]);
  const sparse = FrameSet.from([31, 64, 1055]);
  const dense = FrameSet.from([...keys, 888, 999]);
  for (const view of [undefined, subset]) {
    for (const indexed of [undefined, sparse, dense]) {
      const expected = Array.from(view ?? keys).flatMap((slot, rank) =>
        keys.includes(slot) && indexed?.has(slot) !== false && rank % 3 !== 1 ? [slot] : [],
      );
      const selected = held.selectContent((_row, rank) => rank % 3 !== 1, view, indexed);
      expect([...selected]).toEqual(expected);
    }
  }
});

it('keeps per-slot rank observation when a custom source remaps display rows', () => {
  const slots = new SceneSlots();
  for (const slot of [1, 2, 3])
    setSceneRow(slots, slot, { entityKey: slot, generation: 1, snapshot: snapshot(slot, 1) });
  const held = slots.capture();
  const rank = vi
    .spyOn(held, 'indexOfSlot')
    .mockImplementation((slot) => (slot === 2 ? undefined : 3 - slot));
  const result = held.selectContent(
    (_row, index) => index === 0,
    undefined,
    FrameSet.from([1, 2, 3]),
  );
  expect([...result]).toEqual([3]);
  expect(rank.mock.calls).toEqual([[1], [2], [3]]);
});
