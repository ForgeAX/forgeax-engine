import { expect, test } from 'vitest';
import { ChangeIndex } from '../storage/change-index';

function visit(index: ChangeIndex, since: number, upper: number): number[] {
  const keys: number[] = [];
  index.visitSince(since, upper, (key) => keys.push(key));
  return keys;
}

test('coalesces structural changes by slot and prunes clean paths', () => {
  const index = new ChangeIndex();
  for (let key = 0; key < 4096; key++) index.set(key, key + 1);
  index.set(2000, 5000);
  expect(visit(index, 4096, 5000)).toEqual([2000]);
  expect(index.checkedEntries).toBeLessThan(400);

  for (let epoch = 5001; epoch <= 10000; epoch++) index.set(2000, epoch);
  expect(visit(index, 5000, 9999)).toEqual([]);
  expect(visit(index, 5000, 10000)).toEqual([2000]);
  expect(visit(index, 10000, 10000)).toEqual([]);
  expect(index.checkedEntries).toBe(1);
});

test('visits the full slot width in slot order with an independent cut for each reader', () => {
  const index = new ChangeIndex();
  const slots = [0xffffff, 0, 65536, 64, 63, 4096, 4095];
  for (const [offset, slot] of slots.entries()) index.set(slot, offset + 1);

  expect(visit(index, 0, 7)).toEqual([0, 63, 64, 4095, 4096, 65536, 0xffffff]);
  index.set(0xffffff, 8);
  expect(visit(index, 3, 7)).toEqual([63, 64, 4095, 4096]);
  expect(visit(index, 7, 8)).toEqual([0xffffff]);
  expect(visit(index, 0, 8)).toEqual([0, 63, 64, 4095, 4096, 65536, 0xffffff]);
});
