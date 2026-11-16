import { describe, expect, it } from 'vitest';
import { defineComponent, fieldTypeToMetaKey } from '../component';
import { createColumn, growColumn } from '../storage/column';
import { World } from '../world';
import { worldRead } from '../world-read';
import { elementByteSize } from '../world-storage-primitives';

const cases = [
  ['f32', 4, 1 / 3, Math.fround(1 / 3)],
  ['f64', 8, 1 / 3, 1 / 3],
  ['i32', 4, 0xffffffff, -1],
  ['u32', 4, -1, 0xffffffff],
  ['i16', 2, 0xffff, -1],
  ['u16', 2, -1, 0xffff],
  ['i8', 1, 0xff, -1],
  ['u8', 1, -1, 0xff],
  ['bool', 1, 257, 1],
  ['enum', 4, -1, 0xffffffff],
] as const;

describe('scalar storage', () => {
  it.each(cases)('%s preserves conversion across column growth', (type, width, input, expected) => {
    expect(elementByteSize(type)).toBe(width);
    for (const shared of [false, true]) {
      const column = createColumn(type, 2, 1, shared);
      column.view[1] = input;
      const grown = growColumn(column, 4);
      expect(Array.from(grown.view)).toEqual([0, expected, 0, 0]);
      expect(grown.view[0]).toBe(0);
      expect(grown.view[3]).toBe(0);
    }
  });

  it.each(
    cases,
  )('%s round-trips fixed and variable World arrays', (type, _width, input, expected) => {
    const component = defineComponent(`StorageArray_${type}`, {
      fixed: { type: `array<${type}, 3>` },
      values: { type: `array<${type}>` },
    });
    const world = new World();
    const entity = world
      .spawn({ component, data: { fixed: [input], values: [input, input] } })
      .unwrap();
    expect(Array.from(world.get(entity, component).unwrap().fixed)).toEqual([expected, 0, 0]);
    expect(Array.from(world.get(entity, component).unwrap().values)).toEqual([expected, expected]);
    world.set(entity, component, { fixed: [0, input], values: [0, input, input] }).unwrap();
    expect(Array.from(world.get(entity, component).unwrap().fixed)).toEqual([0, expected, 0]);
    expect(Array.from(world.get(entity, component).unwrap().values)).toEqual([
      0,
      expected,
      expected,
    ]);
    world.despawn(entity).unwrap();
  });

  it('does not resolve Object prototype names as storage types', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(fieldTypeToMetaKey(name)).toBeNull();
    }
  });
});

it('resolves current scalar storage after growth, migration, swap-remove and identity reuse', () => {
  const Values = defineComponent('ScalarStorageLifecycle', {
    values: 'array<f32>',
    words: 'array<u32>',
    fixed: 'array<f64, 4>',
  });
  const Extra = defineComponent('ScalarStorageLifecycleExtra', { x: 'f32' });
  const world = new World();
  const first = world.spawn({ component: Values, data: { values: [1] } }).unwrap();
  const entity = world
    .spawn({ component: Values, data: { values: [2, 3], words: [0xffffffff], fixed: [-0, 1 / 3] } })
    .unwrap();
  const others = Array.from({ length: 256 }, () =>
    world.spawn({ component: Values, data: {} }).unwrap(),
  );
  const read = world[worldRead];
  world.despawn(first).unwrap();
  expect(read.getArrayElement(entity, Values, 'values', 1)).toBe(3);
  world.addComponent(entity, { component: Extra, data: { x: 1 } }).unwrap();
  expect(read.getArrayElement(entity, Values, 'fixed', 0)).toBe(-0);
  expect(read.getArrayElement(entity, Values, 'fixed', 1)).toBe(1 / 3);
  world
    .set(entity, Values, { values: Array.from({ length: 96 }, (_, index) => index + 10) })
    .unwrap();
  expect(read.getArrayElement(entity, Values, 'values', 95)).toBe(105);
  world.set(entity, Values, { values: [7, 8] }).unwrap();
  world.removeComponent(entity, Extra).unwrap();
  world.setArrayRange(entity, Values, 'values', 1, [19]).unwrap();
  expect(read.getArrayElement(entity, Values, 'values', 1)).toBe(19);
  expect(read.getArrayElement(entity, Values, 'values', 2)).toBeUndefined();
  expect(read.getArrayElement(entity, Values, 'words', 0)).toBe(0xffffffff);
  world.despawn(entity).unwrap();
  const replacement = world.spawn({ component: Values, data: { values: [31] } }).unwrap();
  expect(read.getArrayElement(entity, Values, 'values', 0)).toBeUndefined();
  expect(read.getArrayElement(replacement, Values, 'values', 0)).toBe(31);
  for (const other of others) world.despawn(other).unwrap();
  world.despawn(replacement).unwrap();
  world.trimMemory().unwrap();
});
