import { expect, it, vi } from 'vitest';
import * as distanceFields from '../../../../geometry/src/distance-field';
import { prepareSdfCardsFixture } from './sdf-cards.commands';

it('shares SDF preparation without sharing mutable caller payloads', async () => {
  const build = vi.spyOn(distanceFields, 'buildMeshDistanceField');
  const [first, second] = await Promise.all([prepareSdfCardsFixture(), prepareSdfCardsFixture()]);
  // One cube, hollow and two-sided sheet field, independent of concurrent caller count.
  expect(build).toHaveBeenCalledTimes(3);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second.field.values).not.toBe(first.field.values);
  expect(second.layers.geometry.positions).not.toBe(first.layers.geometry.positions);
  first.field.values[0] = (first.field.values[0] ?? 0) + 1;
  first.layers.geometry.positions[0] = 999;
  expect(await prepareSdfCardsFixture()).toEqual(second);
  expect(build).toHaveBeenCalledTimes(3);
  build.mockRestore();
}, 120000);
