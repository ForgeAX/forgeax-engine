import { expect, it } from 'vitest';
import { createVfxStructuredInputBank, isVfxStructuredInputData } from '../structured-input';

it('keeps four author records isolated and preserves exact bits in detached historical versions', () => {
  const bank = createVfxStructuredInputBank({ recordStrideBytes: 273 * 16, capacity: 4 }).unwrap();
  const record = new Uint8Array(273 * 16);
  new DataView(record.buffer).setUint32(0, 0xffc01234, true);
  for (let i = 0; i < 4; i++) {
    record[4] = i + 1;
    bank.write(i, record).unwrap();
  }
  const first = bank.snapshot();
  expect(first?.byteLength).toBe(17472);
  expect(first === undefined ? 0 : new DataView(first.buffer).getUint32(0, true)).toBe(0xffc01234);
  expect([0, 1, 2, 3].map((i) => first?.[i * 273 * 16 + 4])).toEqual([1, 2, 3, 4]);
  record.fill(0);
  bank.clear(1).unwrap();
  expect(first?.[273 * 16 + 4]).toBe(2);
  expect(bank.snapshot()?.[273 * 16 + 4]).toBe(0);
  first?.fill(17);
  expect(bank.snapshot()?.[4]).toBe(1);
  const retained = bank.snapshot();
  bank.dispose();
  expect(bank.snapshot()).toBeUndefined();
  expect(retained?.[4]).toBe(1);
  expect(bank.write(0, record).ok).toBe(false);
  expect(bank.clear().ok).toBe(false);
});
it.each([
  { recordStrideBytes: 0, capacity: 4 },
  { recordStrideBytes: 17, capacity: 4 },
  { recordStrideBytes: 16, capacity: 0 },
  { recordStrideBytes: 65536, capacity: 2 },
])('rejects invalid bank extent %j', (options) =>
  expect(createVfxStructuredInputBank(options).ok).toBe(false));
it('rejects out-of-range writes without changing any record', () => {
  const bank = createVfxStructuredInputBank({ recordStrideBytes: 16, capacity: 4 }).unwrap();
  expect(bank.write(4, new Uint8Array(16)).ok).toBe(false);
  expect(bank.write(0, new Uint8Array(15)).ok).toBe(false);
  expect(bank.clear(-1).ok).toBe(false);
  expect(bank.snapshot()).toEqual(new Uint8Array(64));
});
it.each([0, 15, 17, 65552])('rejects malformed portable byte count %i', (size) =>
  expect(isVfxStructuredInputData(new Uint8Array(size))).toBe(false));
