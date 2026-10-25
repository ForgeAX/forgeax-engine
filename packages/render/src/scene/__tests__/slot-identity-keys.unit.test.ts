import { expect, it } from 'vitest';
import {
  patchSuppressedPrimitiveWords,
  suppressedPrimitiveWords,
  suppressionPatchOf,
} from '../../gpu-driven/production-raster-prepare';
import { worldEntityKey } from '../../record/frame-snapshot';
import type { RenderableSnapshot } from '../../render-system-extract';
import type { RenderSceneSlot } from '../render-scene-types';
import { type SceneSlotFrame, SceneSlots, SlotIdentityKeys } from '../scene-slots';
import { setSceneRow } from './scene-row-writes';

function row(worldId: number, entityKey: number, generation = 1) {
  return {
    generation,
    worldId,
    entityKey,
    snapshot: { worldId, entityKey } as RenderableSnapshot,
  };
}

function roster(count: number): { slots: SceneSlots; frame: SceneSlotFrame } {
  const slots = new SceneSlots();
  for (let slot = 0; slot < count; slot++) setSceneRow(slots, slot, row(slot % 2, slot * 3));
  return { slots, frame: slots.capture() };
}

it('reads the active key set from a slot roster without visiting rows', () => {
  const keys = new SlotIdentityKeys(roster(1000).frame, [7, 4]);
  const expected = new Set(
    Array.from({ length: 1000 }, (_, slot) => worldEntityKey(slot % 2 === 0 ? 7 : 4, slot * 3)),
  );
  expect(keys.size).toBe(expected.size);
  expect(new Set(keys)).toEqual(expected);
  for (const key of expected) expect(keys.has(key)).toBe(true);
  expect(keys.has(worldEntityKey(7, 3))).toBe(false);
  expect(keys.has(worldEntityKey(0, 0))).toBe(false);
  // A World past the routed list keys as its own index.
  const single = new SceneSlots();
  setSceneRow(single, 0, row(5, 2));
  const beyond = new SlotIdentityKeys(single.capture(), [7]);
  expect([...beyond]).toEqual([worldEntityKey(5, 2)]);
  expect(beyond.has(worldEntityKey(5, 2))).toBe(true);
});

it('reports roster membership changes from the row-change log in O(changes)', () => {
  for (const count of [1000, 10000]) {
    const { slots, frame: before } = roster(count);
    const delta = (after: SceneSlotFrame) => {
      const visited: number[] = [];
      expect(
        new SlotIdentityKeys(after, [7, 4]).changesSince(
          new SlotIdentityKeys(before, [7, 4]),
          (slot) => visited.push(slot),
        ),
      ).toBe(true);
      return visited;
    };
    expect(delta(before)).toEqual([]);
    // Rewriting a row for the same identity keeps membership.
    setSceneRow(slots, 0, row(0, 0, 2));
    expect(delta(slots.capture())).toEqual([]);
    setSceneRow(slots, count, row(0, count * 3 + 1));
    setSceneRow(slots, 1, undefined);
    expect(delta(slots.capture())).toEqual([count, 1]);
  }
});

it('declines a delta across a World routing change', () => {
  const { frame } = roster(8);
  expect(
    new SlotIdentityKeys(frame, [7, 4]).changesSince(new SlotIdentityKeys(frame, [7, 5]), () => {}),
  ).toBe(false);
});

function sceneSlot(slot: number, generation = 1): RenderSceneSlot {
  return {
    slot,
    generation,
    version: 0,
    worldId: 0,
    entityKey: slot,
    snapshot: { worldId: 0, entityKey: slot } as RenderableSnapshot,
  };
}

it('patches view suppression from logged row and roster changes, at any scene size', () => {
  const evaluations: number[] = [];
  const changedWords: number[] = [];
  for (const count of [1000, 10000]) {
    const capacity = count + 64;
    const slots = new SceneSlots();
    for (let slot = 0; slot < count; slot++)
      if (slot !== 5) setSceneRow(slots, slot, sceneSlot(slot));
    // The roster can trail the scene frame: rows written after it are inactive.
    const activeBefore = new SlotIdentityKeys(slots.capture(), [0]);
    setSceneRow(slots, 5, sceneSlot(5));
    const before = slots.capture();
    const words = suppressedPrimitiveWords(before, [0], activeBefore, capacity);
    setSceneRow(slots, 3, sceneSlot(3, 2));
    setSceneRow(slots, 7, undefined);
    // Slot 5 re-enters the active roster; the new row leaves it.
    const activeAfter = new SlotIdentityKeys(slots.capture(), [0]);
    setSceneRow(slots, count, sceneSlot(count));
    const after = slots.capture();
    let reads = 0;
    const read = after.slotAt;
    Object.defineProperty(after, 'slotAt', {
      value: (slot: number) => {
        reads++;
        return read(slot);
      },
    });
    const patched = patchSuppressedPrimitiveWords(
      { slots: before, worldKeys: [0], activeEntityKeys: activeBefore, words },
      after,
      [0],
      activeAfter,
      capacity,
    );
    evaluations.push(reads);
    expect(patched).toEqual(suppressedPrimitiveWords(after, [0], activeAfter, capacity));
    expect(words[0]).toBe(1 << 5);
    expect(patched?.[0]).toBe(0);
    expect(patched?.[count >>> 5]).toBe(1 << (count & 31));
    // The patch names its base and every word that diverged from it, so a
    // view holding the base uploads only those words.
    const patch = suppressionPatchOf(patched as Uint32Array);
    expect(patch?.base).toBe(words);
    const diverged = [...(patched as Uint32Array).keys()].filter((i) => patched?.[i] !== words[i]);
    expect(new Set(patch?.words)).toEqual(new Set(diverged));
    changedWords.push(patch?.words.length ?? -1);
    expect(
      patchSuppressedPrimitiveWords(
        { slots: before, worldKeys: [0], activeEntityKeys: activeBefore, words },
        after,
        [0],
        activeAfter,
        capacity + 64,
      ),
    ).toBeUndefined();
  }
  // Row updates (slot 3) never re-evaluate a bit: only entered/left rows do.
  expect(evaluations).toEqual([4, 4]);
  expect(changedWords[0]).toBe(changedWords[1]);
});
