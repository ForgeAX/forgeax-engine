import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { readArrayRangesChangedSince, readMutationEpoch } from '../projection';
import { World } from '../world';

const Rows = defineComponent('SetArrayRangeRows', {
  values: { type: 'array<f32>' },
  fixed: { type: 'array<f32, 4>' },
  label: { type: 'f32' },
});

function spawnRows(world: World, count: number) {
  return world
    .spawn({
      component: Rows,
      data: { values: new Float32Array(count).map((_, index) => index), fixed: [0, 1, 2, 3] },
    })
    .unwrap();
}

describe('World.setArrayRange', () => {
  it('writes the window in place and keeps the array length', () => {
    const world = new World();
    const entity = spawnRows(world, 8);
    world.setArrayRange(entity, Rows, 'values', 2, [20, 30]).unwrap();
    expect(Array.from(world.get(entity, Rows).unwrap().values)).toEqual([0, 1, 20, 30, 4, 5, 6, 7]);
    world.setArrayRange(entity, Rows, 'fixed', 3, [9]).unwrap();
    expect(Array.from(world.get(entity, Rows).unwrap().fixed)).toEqual([0, 1, 2, 9]);
  });

  it('rejects windows outside the array and non-array fields without mutation', () => {
    const world = new World();
    const entity = spawnRows(world, 4);
    const before = readMutationEpoch(world);
    const outside = world.setArrayRange(entity, Rows, 'values', 3, [1, 2]);
    expect(outside.ok).toBe(false);
    if (!outside.ok && outside.error.code === 'array-range-out-of-bounds') {
      expect(outside.error.detail).toMatchObject({ offset: 3, length: 2, size: 4 });
    }
    const negative = world.setArrayRange(entity, Rows, 'values', -1, [1]);
    expect(!negative.ok && negative.error.code).toBe('array-range-out-of-bounds');
    const scalar = world.setArrayRange(entity, Rows, 'label', 0, [1]);
    expect(!scalar.ok && scalar.error.code === 'array-range-out-of-bounds').toBe(true);
    if (!scalar.ok && scalar.error.code === 'array-range-out-of-bounds') {
      expect(scalar.error.detail.size).toBe(-1);
    }
    expect(readMutationEpoch(world)).toBe(before);
    expect(Array.from(world.get(entity, Rows).unwrap().values)).toEqual([0, 1, 2, 3]);
  });

  it('reports merged changed ranges after an epoch', () => {
    const world = new World();
    const entity = spawnRows(world, 64);
    const since = readMutationEpoch(world);
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', since)).toEqual([]);
    world.setArrayRange(entity, Rows, 'values', 16, [1, 1, 1, 1]).unwrap();
    const middle = readMutationEpoch(world);
    world.setArrayRange(entity, Rows, 'values', 20, [2, 2]).unwrap();
    world.setArrayRange(entity, Rows, 'values', 40, [3]).unwrap();
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', since)).toEqual([
      { start: 16, end: 22 },
      { start: 40, end: 41 },
    ]);
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', middle)).toEqual([
      { start: 20, end: 22 },
      { start: 40, end: 41 },
    ]);
  });

  it('answers whole after any other write and restarts on the next range write', () => {
    const world = new World();
    const entity = spawnRows(world, 16);
    const initial = readMutationEpoch(world);
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', initial - 1)).toBe('whole');
    world.setArrayRange(entity, Rows, 'values', 0, [5]).unwrap();
    world.set(entity, Rows, { values: new Float32Array(16) }).unwrap();
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', initial)).toBe('whole');
    const afterSet = readMutationEpoch(world);
    world.setArrayRange(entity, Rows, 'values', 4, [5]).unwrap();
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', initial)).toBe('whole');
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', afterSet)).toEqual([
      { start: 4, end: 5 },
    ]);
  });

  it('bounds its history and falls back to whole for evicted epochs', () => {
    const world = new World();
    const entity = spawnRows(world, 8);
    const since = readMutationEpoch(world);
    for (let index = 0; index < 2048; index += 1) {
      world.setArrayRange(entity, Rows, 'values', index % 8, [index]).unwrap();
    }
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', since)).toBe('whole');
    const recent = readMutationEpoch(world);
    world.setArrayRange(entity, Rows, 'values', 3, [1]).unwrap();
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', recent)).toEqual([
      { start: 3, end: 4 },
    ]);
  });

  it('forgets the history of despawned entities', () => {
    const world = new World();
    const entity = spawnRows(world, 8);
    const since = readMutationEpoch(world);
    world.setArrayRange(entity, Rows, 'values', 0, [1]).unwrap();
    world.despawn(entity).unwrap();
    expect(readArrayRangesChangedSince(world, entity, Rows, 'values', since)).toBe('whole');
    const stale = world.setArrayRange(entity, Rows, 'values', 0, [1]);
    expect(!stale.ok && stale.error.code).toBe('stale-entity');
  });
});
