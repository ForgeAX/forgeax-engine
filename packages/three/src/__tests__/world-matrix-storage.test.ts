import { Matrix4 } from 'three/src/Three.Core.js';
import { expect, it, vi } from 'vitest';
import {
  enableThreeSourceTracking,
  multiplyWorldMatrix,
  ownedMatrixElements,
  ownedWorldMatrixElements,
  sourceCollectionStorage,
  watchCollection,
} from '../source-collections';
import { copyWorldMatrixElements, worldMatrixRow } from '../world-matrix-storage';

function fixture() {
  const off = enableThreeSourceTracking();
  const original = Array.from({ length: 16 }, (_, i) => i + 0.25);
  const elements = ownedWorldMatrixElements(original);
  off();
  const storage = sourceCollectionStorage(elements);
  const row = worldMatrixRow(storage);
  if (!row) throw new Error('Expected an owned world matrix');
  expect(row.dense).toBe(original);
  return { elements, storage, row, lanes: original };
}

it('publishes changed binary64 lanes through the original Three array', () => {
  const { elements, storage, lanes } = fixture();
  const observer = vi.fn();
  const stop = watchCollection(elements, observer);
  lanes[0] = -0;
  lanes[2] = Number.NaN;
  expect(Array.isArray(elements)).toBe(true);
  expect(Object.getPrototypeOf(elements)).toBe(Array.prototype);
  expect(elements.slice(0, 3)).toEqual([-0, 1.25, Number.NaN]);
  expect(Object.getOwnPropertyDescriptor(elements, '0')).toEqual({
    configurable: true,
    enumerable: true,
    writable: true,
    value: -0,
  });
  elements[3] = 1 + Number.EPSILON;
  expect(lanes[3]).toBe(1 + Number.EPSILON);
  expect(observer).toHaveBeenCalledTimes(1);
  storage[4] = 43;
  expect(elements[4]).toBe(43);
  expect(observer).toHaveBeenCalledTimes(1);
  const child = Object.create(elements);
  child[0] = 7;
  expect(lanes[0]).toBe(-0);
  expect(elements.slice(0, 5)).toEqual([-0, 1.25, Number.NaN, 1 + Number.EPSILON, 43]);
  stop?.();
});

it('preserves current values through accessors, shape changes and freezing', () => {
  const { elements, storage, row, lanes } = fixture();
  lanes[6] = 99;
  Object.defineProperty(elements, '4', {
    get() {
      return this[6];
    },
  });
  expect(row.dense).toBeUndefined();
  expect(elements[4]).toBe(99);
  expect(Reflect.get(elements, '4', { 6: 123 })).toBe(123);
  elements.length = 5;
  expect(storage[6]).toBeUndefined();
  const frozen = fixture();
  frozen.lanes[8] = -7;
  Object.freeze(frozen.elements);
  expect(frozen.elements[8]).toBe(-7);
  expect(Reflect.set(frozen.elements, '8', 123)).toBe(false);
});

it('matches stock mixed-sign projective multiplication in place, including non-finite lanes', () => {
  const parent = new Matrix4().fromArray(Array.from({ length: 16 }, (_, i) => (i - 7.25) / 13));
  const local = new Matrix4().fromArray(Array.from({ length: 16 }, (_, i) => (5.5 - i) / 11));
  for (const value of [0.375, -0, Number.POSITIVE_INFINITY, Number.NaN]) {
    parent.elements[15] = value;
    const expected = new Matrix4().multiplyMatrices(parent, local);
    const { row, lanes, elements } = fixture();
    for (let i = 0; i < 16; i++) lanes[i] = parent.elements[i] as number;
    multiplyWorldMatrix(elements, local.elements, row, row);
    expect(Array.from(lanes)).toEqual(expected.elements);
  }
});

it('composes affine world rows in place with reflection, shear and non-finite parents', () => {
  const parent = new Matrix4().set(-1, 2, 0, 2, 0, 3, 1, -5, 1, 0, -2, 1, 0, 0, 0, 1);
  const local = new Matrix4().set(2, 0, -1, 3, -1, 0, 1, 5, 1, 2, 1, -3, 0, 0, 0, 1);
  for (const translation of [0, -0, -3.5, Infinity, NaN]) {
    parent.elements[12] = translation;
    const expected = new Matrix4().multiplyMatrices(parent, local);
    const { row, lanes, elements } = fixture();
    for (let i = 0; i < 16; i++) lanes[i] = parent.elements[i] as number;
    multiplyWorldMatrix(elements, local.elements, row, row);
    expect(Array.from(lanes)).toEqual(expected.elements);
  }
});

it('reads the public local array and follows a destination replaced during scalar coercion', () => {
  const { row, elements, lanes } = fixture();
  new Matrix4().toArray(lanes);
  const stop = enableThreeSourceTracking();
  const local = ownedMatrixElements(new Matrix4().elements);
  stop();
  let receiver: unknown;
  let stored: unknown;
  Object.defineProperty(local, 0, {
    configurable: true,
    get() {
      receiver = this;
      return {
        valueOf() {
          Object.defineProperty(elements, 0, {
            configurable: true,
            get: () => stored,
            set(value) {
              stored = value;
            },
          });
          return 2;
        },
      };
    },
  });
  multiplyWorldMatrix(elements, local, row, row);
  expect(receiver).toBe(local);
  expect(row.dense).toBeUndefined();
  expect(stored).toBe(2);
  expect(elements.slice(1)).toEqual(new Matrix4().elements.slice(1));
});

it('reads the live array receiver when a destination setter edits later source lanes', () => {
  const source = fixture();
  const writer: number[] = [];
  let receiver: unknown;
  Object.defineProperty(writer, 0, {
    set() {
      Object.defineProperty(source.elements, 1, {
        get() {
          receiver = this;
          return 17;
        },
        configurable: true,
      });
    },
  });
  expect(copyWorldMatrixElements(writer, source.storage, source.elements)).toBe(true);
  expect(writer[1]).toBe(17);
  expect(receiver).toBe(source.elements);
  Object.defineProperty(source.elements, 1, {
    writable: true,
    value: 23,
    configurable: true,
    enumerable: true,
  });
  expect(source.row.readLane(1, source.elements)).toBe(23);
});
