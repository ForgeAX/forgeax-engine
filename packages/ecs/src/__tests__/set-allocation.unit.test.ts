import { describe, expect, it, vi } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

describe('partial component writes', () => {
  it('does not materialize an existing row to validate independent patch fields', () => {
    const Pose = defineComponent('PatchPose', { pos: 'array<f32, 3>', value: 'f32' });
    const world = new World();
    const entity = world.spawn({ component: Pose, data: { pos: [1, 2, 3] } }).unwrap();
    const read = vi.spyOn(
      world as unknown as { readRow: (...args: unknown[]) => unknown },
      'readRow',
    );
    world.set(entity, Pose, { value: 4 }).unwrap();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(Array.from(world.get(entity, Pose).unwrap().pos)).toEqual([1, 2, 3]);
  });

  it('preserves fixed-array encoding, overlap, and zero padding', () => {
    const Data = defineComponent('FixedWrite', { values: 'array<f32, 4>' });
    const world = new World();
    const entity = world.spawn({ component: Data, data: { values: [1, 2, 3, 4] } }).unwrap();
    const values = world.get(entity, Data).unwrap().values;
    world.set(entity, Data, { values: values.subarray(1) }).unwrap();
    expect(Array.from(world.get(entity, Data).unwrap().values)).toEqual([2, 3, 4, 0]);
    world.set(entity, Data, { values: [5, 6] }).unwrap();
    expect(Array.from(world.get(entity, Data).unwrap().values)).toEqual([5, 6, 0, 0]);
  });
});
