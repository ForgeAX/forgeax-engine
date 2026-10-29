import { expect, test } from 'vitest';
import {
  type Roster,
  RosterCursor,
  rosterGet,
  rosterPut,
  rosterRemove,
  rosterValues,
} from '../slot-roster';

function entries(root: Roster | undefined): [number, number][] {
  const cursor = new RosterCursor(root);
  const result: [number, number][] = [];
  while (cursor.next()) result.push([cursor.key, cursor.value]);
  return result;
}

test('randomized edits agree with a sorted model and keep earlier roots intact', () => {
  let seed = 11;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let root: Roster | undefined;
  const model = new Map<number, number>();
  const saved: [Roster | undefined, [number, number][]][] = [];
  for (let step = 0; step < 6000; step++) {
    const key = Math.floor(random() * 3000) * 4294967296 * (random() < 0.5 ? 1 : 0) + (step % 997);
    if (random() < 0.3) {
      root = rosterRemove(root, key);
      model.delete(key);
    } else {
      const value = Math.floor(random() * 1e6);
      root = rosterPut(root, key, value);
      model.set(key, value);
    }
    if (step % 500 === 0) {
      const expected = [...model].sort((a, b) => a[0] - b[0]);
      saved.push([root, expected]);
    }
  }
  const expected = [...model].sort((a, b) => a[0] - b[0]);
  expect(root?.count ?? 0).toBe(model.size);
  expect(entries(root)).toEqual(expected);
  for (const [key, value] of model) expect(rosterGet(root, key)).toBe(value);
  expect([...rosterValues(root, 10, 300)]).toEqual(expected.slice(10, 300).map(([, v]) => v));
  for (const [old, contents] of saved) expect(entries(old)).toEqual(contents);
});

test('unchanged edits keep the root and the last removal empties it', () => {
  const one = rosterPut(undefined, 5, 1);
  expect(rosterPut(one, 5, 1)).toBe(one);
  expect(rosterRemove(one, 6)).toBe(one);
  expect(rosterRemove(one, 5)).toBeUndefined();
  let root: Roster | undefined;
  for (let key = 0; key < 1000; key++) root = rosterPut(root, key, key * 2);
  // 1000 entries live in pages, not one node per entry.
  let pages = 0;
  const visit = (node: Roster | undefined) => {
    if (node === undefined) return;
    pages++;
    visit(node.left);
    visit(node.right);
  };
  visit(root);
  expect(pages).toBeLessThan(20);
});
