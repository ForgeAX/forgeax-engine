import { describe, expect, expectTypeOf, it } from 'vitest';
import * as mat4 from '../mat4';
import type { Mat4 } from '../types';

describe('mat4.view', () => {
  it('owns its brand and addresses disjoint matrices within a storage subview', () => {
    const backing = new Float32Array(64);
    const storage = backing.subarray(8, 40);
    const first = mat4.view(storage);
    const second = mat4.view(storage, 1);
    expectTypeOf(first).toEqualTypeOf<Mat4>();
    expect(first.buffer).toBe(storage.buffer);
    expect(first.byteOffset).toBe(storage.byteOffset);
    expect(second.byteOffset).toBe(storage.byteOffset + 64);
    expect(first.length).toBe(16);
    expect(second.length).toBe(16);
    first[12] = 3;
    second[12] = 7;
    expect(storage[12]).toBe(3);
    expect(storage[28]).toBe(7);
    expect(backing[7]).toBe(0);
    expect(backing[40]).toBe(0);
  });

  it('preserves raw signed-zero and NaN bytes through shared-buffer native cloning', () => {
    const storage = new Float32Array(32);
    const bytes = new Uint32Array(storage.buffer);
    bytes[0] = 0x80000000;
    bytes[16] = 0x7fc01234;
    const matrices = [mat4.view(storage), mat4.view(storage, 1)];
    const copied = structuredClone(matrices);
    expect(copied[0]?.buffer).toBe(copied[1]?.buffer);
    expect(copied[0]?.buffer).not.toBe(storage.buffer);
    expect(new Uint32Array(copied[0]?.buffer ?? new ArrayBuffer(0))[0]).toBe(0x80000000);
    expect(new Uint32Array(copied[1]?.buffer ?? new ArrayBuffer(0))[16]).toBe(0x7fc01234);
    expect(storage.byteLength).toBe(128);
  });

  it('degrades invalid windows to detached zero matrices', () => {
    const storage = new Float32Array(64).subarray(8, 25);
    for (const index of [
      -1,
      0.5,
      1,
      2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const value = mat4.view(storage, index);
      expect(value).toEqual(mat4.create());
      expect(value.buffer).not.toBe(storage.buffer);
    }
    expect(mat4.view(new Float32Array(15))).toEqual(mat4.create());
  });
});
