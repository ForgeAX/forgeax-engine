import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, GlobalTransform, Transform } from '../index';
import { registerPropagateTransforms } from '../systems/propagate-transforms';

describe('Scene owned propagation memory', () => {
  it('preserves hierarchy output and retires marker buffers with the registration', () => {
    const world = new World();
    const parent = world.spawn({ component: Transform, data: { pos: [3, 0, 0] } }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [2, 0, 0] } },
        { component: ChildOf, data: { parent } },
      )
      .unwrap();
    const before = world.memoryStats().buffers.liveSlots;
    const unregister = registerPropagateTransforms(world);
    world.update(1 / 60).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(5);
    expect(world.memoryStats().buffers.liveSlots).toBeGreaterThan(before);
    const warm = world.memoryStats().buffers.backingAllocations;
    world.set(parent, Transform, { pos: [4, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(6);
    expect(world.memoryStats().buffers.backingAllocations).toBe(warm);
    unregister();
    unregister();
    expect(world.memoryStats().buffers.liveSlots).toBe(before);
    world.trimMemory().unwrap();
    const again = registerPropagateTransforms(world);
    world.update(1 / 60).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(6);
    again();
  });
});
