import { expect, it, vi } from 'vitest';
import { sameValue } from '../same-value';

it('compares nested descriptor records by own keys without key arrays', () => {
  const make = () => ({
    programs: [{ key: 'a', layout: { group: 1, entries: [1, 2] }, bytes: new Uint8Array([1, 2]) }],
    label: 'x',
  });
  const keys = vi.spyOn(Object, 'keys');
  try {
    expect(sameValue(make(), make())).toBe(true);
    expect(keys).not.toHaveBeenCalled();
  } finally {
    keys.mockRestore();
  }
  expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  expect(sameValue({ a: 1 }, { b: 1 })).toBe(false);
  expect(sameValue({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
  // Inherited enumerable keys are not own descriptor facts.
  const inherited = Object.create({ extra: 1 }) as Record<string, unknown>;
  inherited.a = 1;
  expect(sameValue(inherited, { a: 1 })).toBe(true);
  expect(sameValue({ a: 1 }, inherited)).toBe(true);
});

it('compares typed views by bytes, Maps by entries and skips top-level ignored keys', () => {
  expect(sameValue(new Float32Array([1, Number.NaN]), new Float32Array([1, Number.NaN]))).toBe(
    true,
  );
  expect(sameValue(new Float32Array([0]), new Float32Array([-0]))).toBe(false);
  expect(sameValue(new Float32Array([1]), [1])).toBe(false);
  expect(sameValue(new Map([['a', { b: 1 }]]), new Map([['a', { b: 1 }]]))).toBe(true);
  expect(sameValue(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false);
  expect(sameValue(new Map(), {})).toBe(false);
  const ignore = new Set(['layer']);
  expect(sameValue({ layer: 1, x: 2 }, { layer: 3, x: 2 }, ignore)).toBe(true);
  expect(sameValue({ layer: 1 }, {}, ignore)).toBe(true);
  expect(sameValue({ nested: { layer: 1 } }, { nested: { layer: 3 } }, ignore)).toBe(false);
});
