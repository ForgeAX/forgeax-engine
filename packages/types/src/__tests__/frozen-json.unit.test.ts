import { describe, expect, it } from 'vitest';
import { isDeepFrozenJson } from '../frozen-json.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('isDeepFrozenJson', () => {
  it('accepts deep-frozen plain JSON trees', () => {
    expect(isDeepFrozenJson(deepFreeze({ a: [1, 'x', true, null, { b: undefined }] }))).toBe(true);
    expect(isDeepFrozenJson(deepFreeze(Object.assign(Object.create(null), { a: 1 })))).toBe(true);
  });

  it('rejects mutable nodes anywhere in the tree', () => {
    expect(isDeepFrozenJson({ a: 1 })).toBe(false);
    expect(isDeepFrozenJson(Object.freeze({ a: { b: 1 } }))).toBe(false);
  });

  it('rejects accessors, hidden or symbol keys, foreign prototypes, functions and views', () => {
    const rejected: object[] = [
      Object.defineProperty({}, 'a', { get: () => 1, enumerable: true }),
      Object.defineProperty({}, 'a', { value: 1 }),
      { [Symbol('a')]: 1 },
      Object.create({ inherited: 1 }),
      { a: () => 1 },
      { a: 1n },
    ];
    for (const value of rejected) expect(isDeepFrozenJson(Object.freeze(value))).toBe(false);
    expect(isDeepFrozenJson(Object.freeze(new Uint8Array(0)))).toBe(false);
  });
});
