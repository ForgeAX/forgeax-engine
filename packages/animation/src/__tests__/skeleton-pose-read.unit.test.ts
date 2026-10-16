import { Disabled, World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { SkeletonPose, SkeletonTransformReader } from '../skeleton-pose';
import { AnimationBindingError } from '../solver-errors';

describe('skeletal motion Transform reads', () => {
  it('reads live columns across value writes, row migration, and disabled fallback', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: {} }).unwrap();
    const joint = world
      .spawn(
        { component: Transform, data: { pos: [1, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const reader = new SkeletonTransformReader(world);
    const pose = new SkeletonPose(world, [joint], null, reader);
    reader.register(pose.entities);
    reader.refresh();
    const jointIndex = pose.indices.get(joint) as number;
    const position = (): number[] => Array.from(pose.positions[jointIndex] as Float32Array);

    world.setArrayRange(joint, Transform, 'pos', 0, [2, 3, 4]).unwrap();
    pose.read();
    expect(position()).toEqual([2, 3, 4]);

    world.addComponent(joint, { component: Name, data: { value: 'joint' } }).unwrap();
    expect(reader.isCurrent()).toBe(false);
    world.setArrayRange(joint, Transform, 'pos', 0, [5, 6, 7]).unwrap();
    pose.read();
    expect(position()).toEqual([5, 6, 7]);
    expect(reader.isCurrent()).toBe(true);

    world.addComponent(joint, { component: Disabled, data: {} }).unwrap();
    world.setArrayRange(joint, Transform, 'pos', 0, [8, 9, 10]).unwrap();
    pose.read();
    expect(position()).toEqual([8, 9, 10]);
  });

  it('still rejects a stale parent after the read view has been refreshed', () => {
    const world = new World();
    const root = world.spawn({ component: Transform, data: {} }).unwrap();
    const otherRoot = world.spawn({ component: Transform, data: {} }).unwrap();
    const joint = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: root } })
      .unwrap();
    const reader = new SkeletonTransformReader(world);
    const pose = new SkeletonPose(world, [joint], null, reader);
    reader.register(pose.entities);

    reader.refresh();
    world.set(joint, ChildOf, { parent: otherRoot }).unwrap();
    reader.refresh();
    expect(() => pose.read()).toThrow(AnimationBindingError);
  });

  it('samples fresh World values when a new pose joins a stale shared view', () => {
    const world = new World();
    const joint = world.spawn({ component: Transform, data: { pos: [1, 0, 0] } }).unwrap();
    const reader = new SkeletonTransformReader(world);
    const first = new SkeletonPose(world, [joint], null, reader);
    reader.register(first.entities);
    reader.refresh();

    world.addComponent(joint, { component: Name, data: { value: 'joint' } }).unwrap();
    world.setArrayRange(joint, Transform, 'pos', 0, [4, 5, 6]).unwrap();
    const second = new SkeletonPose(world, [joint], null, reader);
    expect(Array.from(second.positions[0] as Float32Array)).toEqual([4, 5, 6]);

    reader.register(second.entities);
    reader.refresh();
  });

  it('retains shared joint rows until the last pose unregisters', () => {
    const world = new World();
    const joint = world.spawn({ component: Transform, data: {} }).unwrap();
    const reader = new SkeletonTransformReader(world);
    const first = new SkeletonPose(world, [joint], null, reader);
    const second = new SkeletonPose(world, [joint], null, reader);
    reader.register(first.entities);
    reader.register(second.entities);
    reader.refresh();

    const position = first.positions[0] as (typeof first.positions)[number];
    const rotation = first.rotations[0] as (typeof first.rotations)[number];
    const scale = first.scales[0] as (typeof first.scales)[number];
    expect(reader.read(joint, position, rotation, scale)).toBe(true);
    reader.unregister(first.entities);
    expect(reader.read(joint, position, rotation, scale)).toBe(true);
    reader.unregister(second.entities);
    expect(reader.read(joint, position, rotation, scale)).toBe(false);
  });
});
