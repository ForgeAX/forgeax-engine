import { describe, expect, it } from 'vitest';
import { defineComponent, fieldTypeToMetaKey } from '../component';
import { createColumn, growColumn } from '../storage/column';
import { World } from '../world';
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
