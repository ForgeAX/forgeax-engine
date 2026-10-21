import { expect, test } from 'vitest';
import { ChangeIndex } from '../storage/change-index';

test('coalesces writes, prunes clean paths and bounds structural reuse by slot', () => {
  const index = new ChangeIndex();
  for (let key = 0; key < 4096; key++) index.set(key, key + 1);
  const keys: number[] = [];
  index.set(2000, 5000);
  expect(index.get(2000)).toBe(5000);
  index.visitSince(4096, 5000, (key) => keys.push(key));
  expect(keys).toEqual([2000]);
  expect(index.checkedEntries).toBeLessThan(400);
  for (let epoch = 5001; epoch <= 10000; epoch++) index.set(2000, epoch);
  expect(index.size).toBe(4096);
  keys.length = 0;
  index.visitSince(5000, 10000, (key) => keys.push(key));
  expect(keys).toEqual([2000]);
  index.visitSince(10000, 10000, () => {
    throw new Error('clean index produced work');
  });
  expect(index.checkedEntries).toBe(1);
});

test('removes live component entries and releases empty paths across the entire slot width', () => {
  const index = new ChangeIndex();
  const keys = [0, 15, 16, 255, 65536, 0xffffff];
  for (let i = 0; i < keys.length; i++) index.set(keys[i] as number, i + 1);
  for (let i = 0; i < keys.length; i++) expect(index.get(keys[i] as number)).toBe(i + 1);
  for (const key of keys) {
    index.delete(key);
    index.delete(key);
    expect(index.get(key)).toBe(0);
  }
  expect(index.size).toBe(0);
  index.visitSince(-1, 100, () => {
    throw new Error('retired leaf survived');
  });
  expect(index.checkedEntries).toBe(0);
  index.set(0xffffff, 101);
  const found: number[] = [];
  index.visitSince(100, 101, (key) => found.push(key));
  expect(found).toEqual([0xffffff]);
});

test('known-page reads reuse only their current owner leaf, including absent pages and mutations', () => {
  const index = new ChangeIndex();
  const other = new ChangeIndex();
  const keys = [0, 31, 32, 63, 64, 4095, 4096, 0xffffff];
  for (const key of keys) {
    expect(index.get(key)).toBe(0);
    index.set(key, key + 1);
    expect(index.get(key)).toBe(key + 1);
  }
  for (const key of [...keys, ...keys.slice().reverse()]) {
    expect(index.get(key)).toBe(key + 1);
    expect(other.get(key)).toBe(0);
  }
  expect(index.get(0)).toBe(1);
  const root = Object.getOwnPropertyDescriptor(index, 'root');
  if (root === undefined) throw new Error('missing index owner root');
  Object.defineProperty(index, 'root', {
    configurable: true,
    get() {
      throw new Error('repeated same-page lookup descended the tree');
    },
  });
  try {
    expect(index.get(31)).toBe(32);
    expect(index.get(32)).toBe(33);
    expect(index.get(1)).toBe(0);
  } finally {
    Object.defineProperty(index, 'root', root);
  }
  for (const key of keys) {
    index.set(key, key + 100);
    expect(index.get(key)).toBe(key + 100);
    index.delete(key);
    expect(index.get(key)).toBe(0);
    index.set(key, key + 200);
    expect(index.get(key)).toBe(key + 200);
    index.delete(key);
  }
  expect(index.size).toBe(0);
  expect(index.get(0xffffff)).toBe(0);
  index.set(1, 7);
  expect(index.get(1)).toBe(7);
  expect(index.get(128)).toBe(0);
  expect(index.get(129)).toBe(0);
  index.set(129, 8);
  expect(index.get(129)).toBe(8);
});

test.each([
  'set',
  'delete',
] as const)('invalidates the borrowed read page before a failing %s', (operation) => {
  const index = new ChangeIndex();
  index.set(0, 1);
  expect(index.get(0)).toBe(1);
  const root = Object.getOwnPropertyDescriptor(index, 'root');
  if (root === undefined) throw new Error('missing index owner root');
  Object.defineProperty(index, 'root', {
    configurable: true,
    get() {
      throw new Error('injected index mutation failure');
    },
  });
  try {
    expect(() => (operation === 'set' ? index.set(0, 2) : index.delete(0))).toThrow('injected');
    expect(() => index.get(0)).toThrow('injected');
  } finally {
    Object.defineProperty(index, 'root', root);
  }
  expect(index.get(0)).toBe(1);
});
