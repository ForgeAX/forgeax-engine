import { expect, it } from 'vitest';
import { normaliseForPack } from '../pack-value';

it('projects supported clamped equirect bytes into the same numeric JSON array', () => {
  const bytes = new Uint8ClampedArray([1, 2, 3, 255]).subarray(1, 4);
  const source = { kind: 'equirect', data: bytes, metadata: { value: 1 } };
  const expected = JSON.stringify(source, (_key, value) =>
    ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
  );
  const projected = normaliseForPack(source);
  expect(JSON.stringify(projected)).toBe(expected);
  expect(source.data).toBe(bytes);
  expect(projected).not.toBe(source);
});

it('preserves every own metadata key without changing the output prototype', () => {
  const source = Object.fromEntries([
    ['__proto__', { marker: 1 }],
    ['constructor', 7],
  ]);
  const projected = normaliseForPack(source);
  expect(JSON.stringify(projected)).toBe(JSON.stringify(source));
  expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
  expect(Object.hasOwn(projected as object, '__proto__')).toBe(true);
});
