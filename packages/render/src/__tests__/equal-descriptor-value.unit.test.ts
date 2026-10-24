import { expect, it, vi } from 'vitest';
import { equalDescriptorValue } from '../features/prepared-gpu-work';

it('compares nested descriptor records by own keys without key arrays', () => {
  const make = () => ({
    programs: [{ key: 'a', layout: { group: 1, entries: [1, 2] }, bytes: new Uint8Array([1, 2]) }],
    label: 'x',
  });
  const keys = vi.spyOn(Object, 'keys');
  try {
    expect(equalDescriptorValue(make(), make())).toBe(true);
    expect(keys).not.toHaveBeenCalled();
  } finally {
    keys.mockRestore();
  }
  expect(equalDescriptorValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  expect(equalDescriptorValue({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  expect(equalDescriptorValue({ a: 1 }, { b: 1 })).toBe(false);
  expect(equalDescriptorValue({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
  // Inherited enumerable keys are not own descriptor facts.
  const inherited = Object.create({ extra: 1 }) as Record<string, unknown>;
  inherited.a = 1;
  expect(equalDescriptorValue(inherited, { a: 1 })).toBe(true);
  expect(equalDescriptorValue({ a: 1 }, inherited)).toBe(true);
});
