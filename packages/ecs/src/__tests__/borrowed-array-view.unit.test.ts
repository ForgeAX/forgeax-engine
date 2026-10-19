import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const Pose = defineComponent('BorrowedPose', { value: 'array<f32, 3>' });
const Tag = defineComponent('BorrowedPoseTag', {});

describe('internal borrowed inline array views', () => {
  it('reuses the byte window while public reads keep independent wrappers', () => {
    const world = new World();
    const entity = world.spawn({ component: Pose, data: { value: [1, 2, 3] } }).unwrap();
    const read = () => world[worldInternal].getArrayView(entity, Pose, 'value');
    const initial = read();
    expect(read()).toBe(initial);
    world.set(entity, Pose, { value: [4, 5, 6] }).unwrap();
    expect(Array.from(read() ?? [])).toEqual([4, 5, 6]);
    expect(world.get(entity, Pose).unwrap().value).not.toBe(world.get(entity, Pose).unwrap().value);
  });

  it('resolves new storage after growth, migration and swap removal', () => {
    const world = new World();
    const first = world.spawn({ component: Pose, data: { value: [1, 2, 3] } }).unwrap();
    const initial = world[worldInternal].getArrayView(first, Pose, 'value');
    for (let i = 0; i < 600; i++)
      world.spawn({ component: Pose, data: { value: [i, i + 1, i + 2] } }).unwrap();
    const last = world.spawn({ component: Pose, data: { value: [7, 8, 9] } }).unwrap();
    expect(world[worldInternal].getArrayView(first, Pose, 'value') === initial).toBe(false);
    expect(Array.from(world[worldInternal].getArrayView(first, Pose, 'value') ?? [])).toEqual([
      1, 2, 3,
    ]);
    world[worldInternal].getArrayView(last, Pose, 'value');
    world.addComponent(first, { component: Tag, data: {} }).unwrap();
    expect(Array.from(world[worldInternal].getArrayView(first, Pose, 'value') ?? [])).toEqual([
      1, 2, 3,
    ]);
    expect(Array.from(world[worldInternal].getArrayView(last, Pose, 'value') ?? [])).toEqual([
      7, 8, 9,
    ]);
    world.despawn(first).unwrap();
    expect(world[worldInternal].getArrayView(first, Pose, 'value')).toBeUndefined();
    const replacement = world.spawn({ component: Pose, data: { value: [10, 11, 12] } }).unwrap();
    expect(Array.from(world[worldInternal].getArrayView(replacement, Pose, 'value') ?? [])).toEqual(
      [10, 11, 12],
    );
  });

  it('still reads variable arrays from their current pool slot and length', () => {
    const Dynamic = defineComponent('BorrowedDynamic', { value: 'array<u32>' });
    const world = new World();
    const entity = world.spawn({ component: Dynamic, data: { value: [1, 2] } }).unwrap();
    world[worldInternal].getArrayView(entity, Dynamic, 'value');
    world.set(entity, Dynamic, { value: [3, 4, 5, 6] }).unwrap();
    expect(Array.from(world[worldInternal].getArrayView(entity, Dynamic, 'value') ?? [])).toEqual([
      3, 4, 5, 6,
    ]);
  });
});
