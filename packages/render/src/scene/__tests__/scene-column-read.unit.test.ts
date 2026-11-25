import { expect, it, vi } from 'vitest';
import { snapshot } from '../../__tests__/gpu-driven-production-fixture';
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
