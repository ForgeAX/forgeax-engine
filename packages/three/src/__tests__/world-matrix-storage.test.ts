import { Matrix4 } from 'three/src/Three.Core.js';
import { expect, it, vi } from 'vitest';
import {
  enableThreeSourceTracking,
  ownedWorldMatrixElements,
  sourceCollectionStorage,
  watchCollection,
} from '../source-collections';
import {
  copyWorldMatrixElements,
  multiplyWorldMatrix,
  worldMatrixRow,
} from '../world-matrix-storage';

function fixture() {
  const off = enableThreeSourceTracking();
  const elements = ownedWorldMatrixElements(Array.from({ length: 16 }, (_, i) => i + 0.25));
  off();
  const storage = sourceCollectionStorage(elements);
  const row = worldMatrixRow(storage);
  if (!row) throw new Error('Expected an owned world matrix');
  row.attach();
  if (!row.lanes) throw new Error('Expected dense numeric storage');
  return { elements, storage, row, lanes: row.lanes };
}

it('publishes changed binary64 lanes through the same Three array and every attachment', () => {
  const { elements, storage, row, lanes } = fixture();
  const observer = vi.fn();
  const stop = watchCollection(elements, observer);
  row.attach();
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
  row.release();
  expect(row.lanes).toBe(lanes);
  row.release();
  expect(row.lanes).toBeUndefined();
  expect(elements.slice(0, 5)).toEqual([-0, 1.25, Number.NaN, 1 + Number.EPSILON, 43]);
  stop?.();
});

it('materializes current values before accessors, shape changes and freezing', () => {
  const { elements, storage, row, lanes } = fixture();
  lanes[6] = 99;
  Object.defineProperty(elements, '4', {
    get() {
      return this[6];
    },
  });
  expect(row.lanes).toBeUndefined();
  expect(elements[4]).toBe(99);
  expect(Reflect.get(elements, '4', { 6: 123 })).toBe(123);
  elements.length = 5;
  expect(storage[6]).toBeUndefined();
  row.release();
  const frozen = fixture();
  frozen.lanes[8] = -7;
  Object.freeze(frozen.elements);
  expect(frozen.elements[8]).toBe(-7);
  expect(Reflect.set(frozen.elements, '8', 123)).toBe(false);
  frozen.row.release();
});

it('matches stock mixed-sign projective multiplication in place, including non-finite lanes', () => {
  const parent = new Matrix4().fromArray(Array.from({ length: 16 }, (_, i) => (i - 7.25) / 13));
  const local = new Matrix4().fromArray(Array.from({ length: 16 }, (_, i) => (5.5 - i) / 11));
  for (const value of [0.375, -0, Number.POSITIVE_INFINITY, Number.NaN]) {
    parent.elements[15] = value;
    const expected = new Matrix4().multiplyMatrices(parent, local);
    const lanes = new Float64Array(parent.elements);
    multiplyWorldMatrix(lanes, local.elements, lanes);
    expect(Array.from(lanes)).toEqual(expected.elements);
  }
});

it('composes affine world rows in place with reflection, shear and non-finite parents', () => {
  const parent = new Matrix4().set(-1, 2, 0, 2, 0, 3, 1, -5, 1, 0, -2, 1, 0, 0, 0, 1);
  const local = new Matrix4().set(2, 0, -1, 3, -1, 0, 1, 5, 1, 2, 1, -3, 0, 0, 0, 1);
  for (const translation of [0, -0, -3.5, Infinity, NaN]) {
    parent.elements[12] = translation;
    const expected = new Matrix4().multiplyMatrices(parent, local);
    const lanes = new Float64Array(parent.elements);
    multiplyWorldMatrix(lanes, local.elements, lanes);
    expect(Array.from(lanes)).toEqual(expected.elements);
  }
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
  source.row.release();
  Object.defineProperty(source.elements, 1, {
    writable: true,
    value: 23,
    configurable: true,
    enumerable: true,
  });
  source.row.attach();
  expect(source.row.readLane(1, source.elements)).toBe(23);
  source.row.release();
});
