import { describe, expect, it } from 'vitest';
import { equalByteMaps, equalBytes } from '../test/byte-equality.mjs';

describe('complete byte payload equality', () => {
  it('checks every byte, including both sides of a typical row boundary', () => {
    const actual = Uint8Array.from({ length: 257 }, (_, index) => index & 255);
    const expected = actual.slice();
    for (let index = 0; index < expected.length; index++) {
      const before = expected[index] ?? 0;
      expected[index] = before ^ 128;
      expect(equalBytes(actual, expected), `byte ${index}`).toBe(false);
      expected[index] = before;
      expect(equalBytes(actual, expected)).toBe(true);
    }
  });

  it('checks full large payloads and unequal extents', () => {
    const actual = new Uint8Array(65_537).fill(42);
    const expected = actual.slice();
    expect(equalBytes(actual, expected)).toBe(true);
    for (const offset of [0, 32_768, 65_536]) {
      expected[offset] = 43;
      expect(equalBytes(actual, expected)).toBe(false);
      expected[offset] = 42;
    }
    expect(equalBytes(actual, expected.subarray(1))).toBe(false);
    expect(equalBytes(actual.subarray(1), expected)).toBe(false);
  });

  it('compares the exact view rather than unrelated backing bytes', () => {
    const first = new Uint8Array([9, 1, 2, 3, 9]);
    const second = new Uint8Array([8, 8, 1, 2, 3, 8]);
    expect(equalBytes(first.subarray(1, 4), second.subarray(2, 5))).toBe(true);
    expect(equalBytes(first.subarray(0, 3), second.subarray(2, 5))).toBe(false);
    expect([...first]).toEqual([9, 1, 2, 3, 9]);
    expect([...second]).toEqual([8, 8, 1, 2, 3, 8]);
  });

  it('preserves empty and unavailable payload distinctions', () => {
    const empty = new Uint8Array();
    expect(equalBytes(empty, new Uint8Array())).toBe(true);
    expect(equalBytes(undefined, undefined)).toBe(true);
    expect(equalBytes(undefined, empty)).toBe(false);
    expect(equalBytes(empty, undefined)).toBe(false);
  });

  it('compares every snapshot key and payload regardless of insertion order', () => {
    const first = new Map([
      ['a', new Uint8Array([1, 2])],
      ['b', new Uint8Array([3, 4])],
    ]);
    const second = new Map([
      ['b', new Uint8Array([3, 4])],
      ['a', new Uint8Array([1, 2])],
    ]);
    expect(equalByteMaps(first, second)).toBe(true);
    second.set('b', new Uint8Array([3, 5]));
    expect(equalByteMaps(first, second)).toBe(false);
    expect(equalByteMaps(first, new Map([['a', new Uint8Array([1, 2])]]))).toBe(false);
    expect(
      equalByteMaps(new Map([['a', new Uint8Array()]]), new Map([['b', new Uint8Array()]])),
    ).toBe(false);
    expect(equalByteMaps(undefined, undefined)).toBe(true);
    expect(equalByteMaps(first, undefined)).toBe(false);
    expect(equalByteMaps(undefined, second)).toBe(false);
  });
});
