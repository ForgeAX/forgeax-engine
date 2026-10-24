import { expect, it } from 'vitest';
import type { RenderableSnapshot } from '../render-system-extract';
import { TreeFrame } from '../scene/frame-tree-list';
import { SceneSlots } from '../scene/scene-slots';

it('keeps entries permanently finished after an explicit return', () => {
  const entries = new TreeFrame<number>().with(10, 0, 0).with(20, 0, 1).entries();
  expect(entries.next()).toEqual({ value: [0, 10], done: false });
  entries.return?.();
  expect(entries.next()).toEqual({ value: undefined, done: true });
  expect(entries.next()).toEqual({ value: undefined, done: true });
});

it('closes a slot traversal on break while keeping independent walks', () => {
  const slots = new SceneSlots();
  for (let slot = 0; slot < 2; slot++)
    slots.set(slot, {
      slot,
      worldId: 0,
      entityKey: slot,
      generation: 0,
      snapshot: {} as RenderableSnapshot,
    });
  const frame = slots.capture();
  const iterator = frame[Symbol.iterator]();
  for (const value of iterator) {
    expect(value.slot).toBe(0);
    break;
  }
  expect(iterator.next()).toEqual({ value: undefined, done: true });
  expect([...frame].map((value) => value.slot)).toEqual([0, 1]);
});

it('keeps native array-iterator resume behavior for retained tree values', () => {
  const frame = new TreeFrame<number>().with(10, 0, 0).with(20, 0, 1);
  const iterator = frame[Symbol.iterator]();
  for (const value of iterator) {
    expect(value).toBe(10);
    break;
  }
  expect(iterator.next()).toEqual({ value: 20, done: false });
});
