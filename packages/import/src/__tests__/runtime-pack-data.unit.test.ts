import { copyPackData } from '@forgeax/engine-pack/runtime';
import { expect, it, vi } from 'vitest';
import { decodeRuntimePackData, encodeRuntimePackData } from '../runtime-pack-data.js';

it('isolates one binary graph while preserving aliases and excluding unrelated backing bytes', () => {
  const storage = new ArrayBuffer(48);
  new Uint8Array(storage).fill(99);
  const floats = new Float32Array(storage, 8, 3);
  floats.set([1.25, -0, -2]);
  const shorts = new Uint16Array(storage, 12, 4);
  const source = { floats, nested: [shorts] as const, tag: { path: null, kind: 'Uint8Array' } };
  const copy = copyPackData(source) as typeof source;
  floats[0] = 77;
  expect(copy.floats[0]).toBe(1.25);
  expect(copy.floats.buffer).toBe(copy.nested[0].buffer);
  const wire = encodeRuntimePackData(copy);
  const restored = decodeRuntimePackData(JSON.parse(JSON.stringify(wire))) as typeof source;
  expect(restored).toEqual(copy);
  expect(restored.floats.buffer).toBe(restored.nested[0].buffer);
  expect(restored.floats.byteOffset).toBe(8);
  expect(Object.is(restored.floats[1], -0)).toBe(true);
  expect([...new Uint8Array(restored.floats.buffer, 0, 8)]).toEqual(new Array(8).fill(0));
  expect(restored.tag).toEqual(source.tag);
});

it('does not invoke TypedArray constructor or metadata getters and rejects shared/subclass input', () => {
  const value = new Float32Array([1, 2]);
  const getter = vi.fn(() => {
    throw new Error('executed caller code');
  });
  for (const property of ['constructor', 'buffer', 'byteOffset', 'byteLength', 'length'])
    Object.defineProperty(value, property, { get: getter });
  expect(copyPackData(value)).toEqual(new Float32Array([1, 2]));
  expect(getter).not.toHaveBeenCalled();
  expect(() => copyPackData(new Uint8Array(new SharedArrayBuffer(4)))).toThrow();
  class Subclass extends Float32Array {}
  expect(() => copyPackData(new Subclass(2))).toThrow();
});

type MutableWire = {
  binary: {
    byteOrder: string;
    buffers: string[];
    views: [{ offset: number; length: number; buffer: number; path: string[] }];
  };
};

it.each([
  (wire: MutableWire) => {
    wire.binary.views[0].offset = 1;
  },
  (wire: MutableWire) => {
    wire.binary.views[0].length = Number.MAX_SAFE_INTEGER;
  },
  (wire: MutableWire) => {
    wire.binary.views[0].buffer = -1;
  },
  (wire: MutableWire) => {
    wire.binary.views.push(wire.binary.views[0]);
  },
  (wire: MutableWire) => {
    wire.binary.views[0].path = ['__proto__', 'polluted'];
  },
  (wire: MutableWire) => {
    wire.binary.views[0].path = ['metadata'];
  },
  (wire: MutableWire) => {
    wire.binary.buffers.push('AAAA');
  },
  (wire: MutableWire) => {
    wire.binary.byteOrder = 'native';
  },
])('rejects malformed binary tables without mutating the input prototype', (corrupt) => {
  const wire = encodeRuntimePackData({ data: new Float32Array([1, 2]), metadata: {} });
  corrupt(wire as unknown as MutableWire);
  expect(() => decodeRuntimePackData(wire)).toThrow();
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});
