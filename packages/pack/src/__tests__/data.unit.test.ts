import { expect, it, vi } from 'vitest';
import { copyPackData, copyPackOutputData, decodePackData, encodePackData } from '../data.js';

it.each([
  [],
  [new Uint8Array([1, 2])],
  new Uint8Array([1, 2]),
])('rejects roots that cannot retain their identity through snapshot transport', (root) => {
  expect(() => encodePackData(root)).toThrow('expected a plain snapshot object');
  expect(() => decodePackData(root)).toThrow('expected a plain snapshot object');
});

it('rejects reserved binary metadata before it can overwrite author data', () => {
  const source = { binary: { author: 'metadata' }, data: new Uint8Array([1, 2]) };
  expect(() => encodePackData(source)).toThrow('snapshot root reserves the binary field');
  expect(source.binary).toEqual({ author: 'metadata' });
});

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
  const wire = encodePackData(copy);
  const restored = decodePackData(JSON.parse(JSON.stringify(wire))) as typeof source;
  expect(restored).toEqual(copy);
  expect(restored.floats.buffer).toBe(restored.nested[0].buffer);
  expect(restored.floats.byteOffset).toBe(8);
  expect(Object.is(restored.floats[1], -0)).toBe(true);
  expect([...new Uint8Array(restored.floats.buffer, 0, 8)]).toEqual(new Array(8).fill(0));
  expect(restored.tag).toEqual(source.tag);
});

it('rebases shared ranges only when all uses belong to outputs with their own encoding', () => {
  const storage = new ArrayBuffer(1024);
  new Uint8Array(storage).fill(99);
  const values = new Float32Array(storage, 512, 3);
  values.set([1.25, -0, -2]);
  const alias = new Uint16Array(storage, 516, 4);
  const separate = new Uint16Array(storage, 528, 2);
  separate.set([1, 2]);
  const mesh = { kind: 'mesh', values, alias, separate, repeated: [values] };
  const shouldCompact = (output: unknown) =>
    typeof output === 'object' && output !== null && 'kind' in output && output.kind === 'mesh';
  const compact = copyPackOutputData({ mesh }, shouldCompact).mesh;
  expect(compact.values.buffer.byteLength).toBe(20);
  expect(compact.values.byteOffset).toBe(0);
  expect(compact.alias.byteOffset).toBe(4);
  expect(compact.separate.byteOffset).toBe(16);
  expect(compact.alias.buffer).toBe(compact.values.buffer);
  expect(compact.separate.buffer).toBe(compact.values.buffer);
  expect(compact.repeated[0]).toBe(compact.values);
  expect(new Uint8Array(compact.values.buffer).slice(12, 16)).toEqual(new Uint8Array(4));
  expect(compact.values).toEqual(values);
  expect(compact.alias).toEqual(alias);
  expect(compact.separate).toEqual(separate);
  values[0] = 700;
  expect(compact.values[0]).toBe(1.25);

  const mixed = copyPackOutputData({ mesh, data: { views: [values] } }, shouldCompact);
  expect(mixed.mesh.values.buffer.byteLength).toBe(storage.byteLength);
  expect(mixed.mesh.values.byteOffset).toBe(values.byteOffset);
  expect(mixed.data.views[0]).toBe(mixed.mesh.values);
  expect(mixed.mesh.alias.buffer).toBe(mixed.mesh.values.buffer);
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
  const wire = encodePackData({ data: new Float32Array([1, 2]), metadata: {} });
  corrupt(wire as unknown as MutableWire);
  expect(() => decodePackData(wire)).toThrow();
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});
