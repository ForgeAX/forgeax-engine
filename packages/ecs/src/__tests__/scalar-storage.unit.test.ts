import { describe, expect, it } from 'vitest';
import { defineComponent, fieldTypeToMetaKey, TYPE_METADATA } from '../component';
import { createColumn, growColumn } from '../storage/column';
import { World } from '../world';
import { worldRead } from '../world-read';
import {
  elementByteSize,
  readArrayElementAt,
  reinterpretSlotBytes,
  writeArrayElementAt,
} from '../world-storage-primitives';

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
  ['ref', 4, -1, 0xffffffff],
] as const;

describe('scalar storage', () => {
  it.each(
    cases,
  )('%s preserves conversion across column growth and byte subviews', (type, width, input, expected) => {
    expect(elementByteSize(type)).toBe(width);
    for (const shared of [false, true]) {
      const column = createColumn(type, 2, 1, shared);
      column.view[1] = input;
      const grown = growColumn(column, 4);
      expect(Array.from(grown.view)).toEqual([0, expected, 0, 0]);
      const bytes = new Uint8Array(grown.buffer, width, width * 2);
      writeArrayElementAt(bytes, 1, type, input);
      expect(readArrayElementAt(bytes, 1, type)).toBe(expected);
      expect(readArrayElementAt(bytes, 2, type)).toBe(0);
      expect(Array.from(reinterpretSlotBytes(bytes, type, 2))).toEqual([expected, expected]);
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

  it.each([
    'entity',
    'shared<Payload>',
  ] as const)('reinterprets %s handles as unsigned words', (type) => {
    const words = new Uint32Array([7, 0xffffffff, 9]);
    const bytes = new Uint8Array(words.buffer, 4, 4);
    expect(Array.from(reinterpretSlotBytes(bytes, type, 1))).toEqual([0xffffffff]);
    expect(readArrayElementAt(bytes, 0, type)).toBe(0xffffffff);
  });

  it('does not resolve Object prototype names as storage types', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(fieldTypeToMetaKey(name)).toBeNull();
    }
  });
});

it.each(
  cases,
)('%s scalar reads/writes preserve exact native edge conversions and partial tails', (type, width) => {
  const Ctor = TYPE_METADATA[type]?.viewCtor;
  if (Ctor === undefined) throw new Error('Expected admitted scalar constructor');
  for (const shared of [false, true]) {
    const makeBuffer = () =>
      shared ? new SharedArrayBuffer(width * 4 + 1) : new ArrayBuffer(width * 4 + 1);
    const actual = new Uint8Array(makeBuffer(), width, width * 2 + 1);
    const reference = new Uint8Array(makeBuffer(), width, width * 2 + 1);
    const native = new Ctor(
      reference.buffer,
      reference.byteOffset,
      Math.floor(reference.byteLength / width),
    );
    for (const index of [-1, -0, 0, 1, 1.5, 2, Number.NaN, Infinity]) {
      for (const value of [
        0,
        -0,
        Number.NaN,
        Infinity,
        -Infinity,
        -1,
        Number.MAX_SAFE_INTEGER,
        1 / 3,
      ]) {
        native[index] = value;
        writeArrayElementAt(actual, index, type, value);
        expect(Array.from(new Uint8Array(actual.buffer))).toEqual(
          Array.from(new Uint8Array(reference.buffer)),
        );
        expect(readArrayElementAt(actual, index, type)).toBe(native[index] ?? 0);
      }
    }
  }
});

it('preserves empty, detached and misaligned scalar access failures', () => {
  const empty = new Uint8Array(0);
  expect(readArrayElementAt(empty, 0, 'f32')).toBe(0);
  expect(() => writeArrayElementAt(empty, 0, 'f32', 1)).not.toThrow();
  const misaligned = new Uint8Array(new ArrayBuffer(16), 1, 8);
  expect(() => readArrayElementAt(misaligned, 0, 'f32')).toThrow(RangeError);
  expect(() => writeArrayElementAt(misaligned, 0, 'f32', 1)).toThrow(RangeError);
  const detached = new Uint8Array(8);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  expect(() => readArrayElementAt(detached, 0, 'f32')).toThrow(TypeError);
  expect(() => writeArrayElementAt(detached, 0, 'f32', 1)).toThrow(TypeError);
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
