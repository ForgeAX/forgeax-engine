import { expect, it } from 'vitest';
import { EntityMaterialLists } from '../material-lists';

it('shares one interned list between entities with equal materials', () => {
  const lists = new EntityMaterialLists();
  lists.set(1, [3, 4]);
  lists.set(2, [3, 4]);
  lists.set(5, [4]);
  expect(lists.get(1)).toBe(lists.get(2));
  expect(lists.get(1)).toEqual([3, 4]);
  expect(lists.get(5)).toEqual([4]);
  expect(lists.get(9)).toEqual([]);
});

it('releases a list with its last entity and reuses its slot', () => {
  const lists = new EntityMaterialLists();
  lists.set(1, [3]);
  lists.set(2, [3]);
  const shared = lists.get(1);
  lists.delete(1);
  expect(lists.get(2)).toBe(shared);
  lists.set(2, [7]);
  expect(lists.get(2)).toEqual([7]);
  lists.set(3, [3]);
  expect(lists.get(3)).toEqual([3]);
  expect(lists.get(3)).not.toBe(shared);
  lists.delete(2);
  lists.delete(2);
  expect(lists.get(2)).toEqual([]);
  expect(lists.get(3)).toEqual([3]);
});

it('copies caller arrays instead of aliasing them', () => {
  const lists = new EntityMaterialLists();
  const ids = [1, 2];
  lists.set(1, ids);
  ids[0] = 9;
  expect(lists.get(1)).toEqual([1, 2]);
});
