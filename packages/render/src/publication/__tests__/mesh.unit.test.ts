import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import { copyPublishedMesh, ownReceivedPublishedMesh, samePublishedMesh } from '../mesh';

const mesh = createBoxGeometry(1, 1, 1).unwrap();
const same = (left: unknown, right: unknown) => {
  const a = { ...mesh, extra: left },
    b = { ...mesh, extra: right };
  return samePublishedMesh(a, b);
};

it('compares exactly the byte range of every view, including unaligned and trailing bytes', () => {
  for (let offset = 0; offset < 8; offset++) {
    for (let length = 0; length < 17; length++) {
      const left = new Uint8Array(new ArrayBuffer(offset + length + 8), offset, length);
      for (let index = 0; index < length; index++) left[index] = index * 13;
      const right = new Uint8Array(new ArrayBuffer(offset + length + 8), offset, length);
      right.set(left);
      const a = new DataView(left.buffer, offset, length);
      const b = new DataView(right.buffer, offset, length);
      expect(same(left, right)).toBe(true);
      expect(same(a, b)).toBe(true);
      new Uint8Array(right.buffer)[offset + length] = 255;
      expect(same(left, right)).toBe(true);
      expect(same(a, b)).toBe(true);
      for (let index = 0; index < length; index++) {
        right[index] = (right[index] ?? 0) ^ 1;
        expect(same(left, right)).toBe(false);
        expect(same(a, b)).toBe(false);
        right[index] = (right[index] ?? 0) ^ 1;
      }
    }
  }
});

it('preserves raw-buffer, view-type, signed-zero and NaN payload distinctions', () => {
  for (let length = 0; length < 17; length++) {
    const left = new ArrayBuffer(length),
      right = left.slice(0);
    expect(same(left, right)).toBe(true);
    for (let index = 0; index < length; index++) {
      new Uint8Array(right)[index] = 1;
      expect(same(left, right)).toBe(false);
      new Uint8Array(right)[index] = 0;
    }
  }
  expect(same(new Float32Array([0]), new Float32Array([-0]))).toBe(false);
  expect(same(new Float32Array([0]), new Uint32Array([0]))).toBe(false);
  const left = new Uint32Array([0x7fc00001]),
    right = new Uint32Array([0x7fc00002]);
  expect(same(new Float32Array(left.buffer), new Float32Array(right.buffer))).toBe(false);
});

it('detects source shared-buffer writes without changing the owned prepared bytes', () => {
  const shared = new Uint8Array(new SharedArrayBuffer(17));
  const source = { ...mesh, extra: shared };
  const owned = copyPublishedMesh(source);
  expect(samePublishedMesh(owned, source)).toBe(true);
  shared[16] = 1;
  expect(samePublishedMesh(owned, source)).toBe(false);
  shared[16] = 0;
  expect(samePublishedMesh(owned, source)).toBe(true);
});

it('preserves exact own-field and scalar distinctions throughout plain mesh arrays', () => {
  const first = { values: [0, NaN, { flags: [true, null, undefined] }] };
  expect(same(first, structuredClone(first))).toBe(true);
  expect(same(first, { values: [-0, NaN, { flags: [true, null, undefined] }] })).toBe(false);
  expect(same({ value: undefined }, {})).toBe(false);
  expect(same({ value: 1 }, Object.create({ value: 1 }))).toBe(false);
  expect(same([undefined], new Array(1))).toBe(false);
  // Preserve the existing enumerable-POD comparison of trailing empty slots.
  expect(same([], new Array(3))).toBe(true);
  const array = Object.assign([1, 2, 3], { metadata: { owner: 'mesh' } });
  expect(same(array, Object.assign([1, 2, 3], { metadata: { owner: 'mesh' } }))).toBe(true);
  expect(same(array, Object.assign([1, 2, 3], { metadata: { owner: 'other' } }))).toBe(false);
  expect(same(array, [1, 2, 3])).toBe(false);
});

it('compares all bytes of large aligned and unaligned mesh views including word tails', () => {
  for (const shared of [false, true]) {
    for (let offset = 0; offset < 8; offset++) {
      for (let length = 32; length < 71; length++) {
        const leftBuffer = shared
          ? new SharedArrayBuffer(offset + length + 8)
          : new ArrayBuffer(offset + length + 8);
        const rightBuffer = new ArrayBuffer(offset + length + 8);
        const left = new Uint8Array(leftBuffer, offset, length);
        const right = new Uint8Array(rightBuffer, offset, length);
        for (let index = 0; index < length; index++) left[index] = index * 13;
        right.set(left);
        const a = new DataView(leftBuffer, offset, length);
        const b = new DataView(rightBuffer, offset, length);
        expect(same(a, b)).toBe(true);
        new Uint8Array(rightBuffer)[offset + length] = 255;
        expect(same(a, b)).toBe(true);
        for (let index = 0; index < length; index++) {
          right[index] = (right[index] ?? 0) ^ 1;
          expect(same(a, b)).toBe(false);
          right[index] = (right[index] ?? 0) ^ 1;
        }
      }
    }
  }
});

it('adopts only independent received POD while preserving shared/accessor/exotic copying', () => {
  const received = structuredClone(mesh);
  expect(ownReceivedPublishedMesh(received)).toBe(received);
  expect(ownReceivedPublishedMesh(received).vertices.buffer).toBe(received.vertices.buffer);
  for (const extra of [
    new Float32Array(new SharedArrayBuffer(32)),
    { nested: new Uint8Array(new SharedArrayBuffer(3)) },
    new Map([['entry', 1]]),
    Object.create(null),
    Object.assign([1, 2], { metadata: 'must retain original copy semantics' }),
  ]) {
    const input = { ...received, extra };
    const copied = ownReceivedPublishedMesh(input);
    expect(copied).not.toBe(input);
    expect(samePublishedMesh(copied, copyPublishedMesh(input))).toBe(true);
    expect(copied.vertices.buffer).not.toBe(input.vertices.buffer);
  }
  const shared = new Float32Array(new SharedArrayBuffer(received.vertices.byteLength));
  shared.set(received.vertices);
  const source = { ...received, vertices: shared };
  const protectedMesh = ownReceivedPublishedMesh(source);
  const first = protectedMesh.vertices[0];
  shared[0] = 1234;
  expect(protectedMesh.vertices[0]).toBe(first);
  const getter = Object.defineProperty({ ...received }, 'extra', {
    enumerable: true,
    get: () => 42,
  });
  expect(Object.getOwnPropertyDescriptor(ownReceivedPublishedMesh(getter), 'extra')).toHaveProperty(
    'value',
    42,
  );
});
