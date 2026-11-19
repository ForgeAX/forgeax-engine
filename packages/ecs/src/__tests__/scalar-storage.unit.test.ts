import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from '../component';
import { ArrayStore } from '../storage/array-store';
import { createColumn, growColumn } from '../storage/column';
import { World } from '../world';
import { worldRead } from '../world-read';
import { columnLayout } from './__fixtures__/column-layout';

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
    for (const shared of [false, true]) {
      const layout = columnLayout(type);
      const column = createColumn(layout, 2, shared);
      expect(column.layout).toBe(layout);
      expect(column.view.BYTES_PER_ELEMENT).toBe(width);
      expect(column.view.byteLength).toBe(2 * width);
      column.view[1] = input;
      const grown = growColumn(column, 4);
      expect(grown.layout).toBe(layout);
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
      expect(() => defineComponent(`RejectedScalar_${name}`, { value: name } as never)).toThrow();
      expect(() =>
        defineComponent(`RejectedArray_${name}`, { value: `array<${name}>` } as never),
      ).toThrow();
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

it('reclaims backing if its component typed view cannot be constructed', () => {
  const arrays = new ArrayStore();
  const location = new Uint32Array(3);
  const Native = Uint32Array;
  vi.stubGlobal(
    'Uint32Array',
    class extends Native {
      constructor() {
        super(0);
        throw new RangeError('controlled block view construction failure');
      }
    },
  );
  try {
    expect(arrays.alloc(location, 0, 16)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
  expect([...location]).toEqual([0, 0, 0]);
  expect(arrays.stats()).toMatchObject({ liveArrays: 0, blocks: 0, committedBytes: 0 });
  expect(arrays.alloc(location, 0, 16)).toBe(true);
  expect(arrays.u32(location[0] as number).byteLength).toBe(65536);
});

it.each([
  [16, 16],
  [17, 64],
  [65, 256],
  [257, 1024],
  [1025, 2048],
  [4097, 8192],
  [262145, 524288],
])('keeps component capacity policy for%s bytes ->%s', (bytes, capacity) => {
  const arrays = new ArrayStore();
  const location = new Uint32Array(3);
  expect(arrays.alloc(location, 0, bytes)).toBe(true);
  expect(arrays.capacity(location[0] as number)).toBe(capacity);
  expect(arrays.stats().liveArrays).toBe(1);
  arrays.release(location[0] as number, location[1] as number);
  arrays.trim();
  expect(arrays.stats()).toMatchObject({ liveArrays: 0, committedBytes: 0 });
});

it('keeps mixed slab codecs and replaces the codec of a reused dedicated cell', () => {
  const arrays = new ArrayStore();
  const location = new Uint32Array(3);
  expect(arrays.alloc(location, 0, 16)).toBe(true);
  const slab = location[0] as number;
  const floats = arrays.view(slab, Float32Array);
  const bytes = arrays.view(slab, Uint8Array);
  floats[0] = 3.5;
  expect(arrays.view(slab, Float32Array)).toBe(floats);
  expect(arrays.view(slab, Uint8Array)).toBe(bytes);
  expect(new Float32Array(bytes.buffer)[0]).toBe(3.5);

  expect(arrays.alloc(location, 0, 512)).toBe(true);
  const block = location[0] as number;
  arrays.view(block, Float64Array)[0] = 9.5;
  arrays.release(block, 0);
  expect(arrays.alloc(location, 0, 512)).toBe(true);
  expect(location[0]).toBe(block);
  const next = arrays.view(block, Int16Array);
  next[0] = -7;
  expect(arrays.view(block, Int16Array)[0]).toBe(-7);
  expect(arrays.view(block, Float64Array)).toBeInstanceOf(Float64Array);
});
