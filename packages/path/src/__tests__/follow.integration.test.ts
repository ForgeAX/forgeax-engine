import { createWorldContext, FixedUpdate, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { RigidBody } from '@forgeax/engine-physics';
import { ChildOf, GlobalTransform, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { DesiredPathPose, Path, PathFollower, PathMotion, pathPlugin } from '../index';
import { definition } from './fixture';

async function setup() {
  const world = new World({ time: { fixedDeltaSeconds: 1 / 60 } });
  const context = await createWorldContext(world, [pathPlugin()]);
  const path = world.spawn({ component: Path, data: definition() }).unwrap();
  const follower = world.spawn({ component: PathFollower, data: { path, speed: 6 } }).unwrap();
  return { world, context, path, follower };
}
describe('native World path following', () => {
  it('advances before fixed propagation, supports independent state, pause, reverse and no dt', async () => {
    const { world, context, path, follower } = await setup();
    const other = world
      .spawn({ component: PathFollower, data: { path, distance: 5, speed: -6 } })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(follower, GlobalTransform).unwrap().world[14]).toBeCloseTo(0.1);
    expect(world.get(other, GlobalTransform).unwrap().world[14]).toBeCloseTo(4.9);
    world.set(follower, PathFollower, { paused: true }).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(follower, PathFollower).unwrap().distance).toBeCloseTo(0.1);
    world.update(0).unwrap();
    expect(world.get(other, PathFollower).unwrap().distance).toBeCloseTo(4.8);
    await context.fiber.dispose();
  });
  it('uses current hierarchy transforms and rebuilds world length after scale and controls change', async () => {
    const { world, context, path, follower } = await setup();
    const parent = world
      .spawn({ component: Transform, data: { pos: [3, 2, 1], scale: [2, 2, 2] } })
      .unwrap();
    world.addComponent(follower, { component: ChildOf, data: { parent } }).unwrap();
    world.set(path, Transform, { scale: [1, 2, 3], pos: [5, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    const pose = world.get(follower, GlobalTransform).unwrap().world;
    expect(pose[12]).toBeCloseTo(5);
    expect(pose[14]).toBeCloseTo(0.1);
    world.set(path, Path, { points: Float32Array.from([0, 0, 0, 10, 0, 0]) }).unwrap();
    world.set(parent, Transform, { pos: [20, 1, 4] }).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(follower, PathFollower).unwrap().distance).toBeCloseTo(0.2);
    expect(world.get(follower, GlobalTransform).unwrap().world[12]).toBeCloseTo(5.2);
    await context.fiber.dispose();
  });
  it('retains distance and wraps/clamps atomically when a path is replaced', async () => {
    const { world, context, path, follower } = await setup();
    world.set(follower, PathFollower, { distance: 9, speed: 0 }).unwrap();
    world.set(path, Path, definition([0, 0, 0, 0, 0, 2])).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(follower, PathFollower).unwrap().distance).toBe(2);
    world.set(follower, PathFollower, { distance: 9, loop: true }).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(follower, PathFollower).unwrap().distance).toBe(1);
    await context.fiber.dispose();
  });
  it('publishes desired motion without Transform writes and prevents competing physics authority', async () => {
    const { world, context, follower } = await setup();
    world.addComponent(follower, { component: DesiredPathPose, data: {} }).unwrap();
    world.addComponent(follower, { component: RigidBody, data: {} }).unwrap();
    world.set(follower, PathFollower, { motion: PathMotion.desired }).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(follower, Transform).unwrap().pos[2]).toBe(0);
    expect(world.get(follower, DesiredPathPose).unwrap().position[2]).toBeCloseTo(0.1);
    world.set(follower, PathFollower, { motion: PathMotion.scene }).unwrap();
    expect(world.update(1 / 60).ok).toBe(false);
    await context.fiber.dispose();
  });
  it('fails closed on a deleted path and releases its native contributions on detach/rebuild', async () => {
    const { world, context, path, follower } = await setup();
    world.addComponent(follower, { component: DesiredPathPose, data: {} }).unwrap();
    world.set(follower, PathFollower, { motion: PathMotion.desired }).unwrap();
    world.update(1 / 60).unwrap();
    world.despawn(path).unwrap();
    expect(world.update(1 / 60).ok).toBe(false);
    expect(world.get(follower, DesiredPathPose).unwrap().valid).toBe(false);
    await context.fiber.dispose();
    expect(world.inspect().systems.some((system) => system.name === 'path/follow')).toBe(false);
    const replacement = await setup();
    replacement.world.update(1 / 60).unwrap();
    expect(replacement.world.get(replacement.follower, PathFollower).unwrap().distance).toBeCloseTo(
      0.1,
    );
    await replacement.context.fiber.dispose();
  });
  it('reads moving path transforms from the same fixed tick', async () => {
    const { world, context, path, follower } = await setup();
    world
      .addSystem(FixedUpdate, {
        name: 'move-path',
        before: ['path/follow'],
        queries: [],
        fn() {
          world.set(path, Transform, { pos: [2, 0, 0] }).unwrap();
        },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(follower, GlobalTransform).unwrap().world[12]).toBe(2);
    await context.fiber.dispose();
  });
  it('converts a rotated scaled path through a nonuniform parent when orientation is disabled', async () => {
    const { world, context, path, follower } = await setup();
    const rotation = quat.create();
    quat.fromAxisAngle(rotation, [0, 1, 0], Math.PI / 2);
    const parent = world
      .spawn({ component: Transform, data: { pos: [20, 3, -4], scale: [2, 3, 4], quat: rotation } })
      .unwrap();
    world.addComponent(follower, { component: ChildOf, data: { parent } }).unwrap();
    world.set(follower, PathFollower, { followTangent: false }).unwrap();
    world.set(path, Transform, { pos: [2, 1, 3], scale: [1, 2, 3], quat: rotation }).unwrap();
    world.update(1 / 60).unwrap();
    const pose = world.get(follower, GlobalTransform).unwrap().world;
    expect(pose[12]).toBeCloseTo(2.1, 5);
    expect(pose[13]).toBeCloseTo(1, 5);
    expect(pose[14]).toBeCloseTo(3, 5);
    world.set(follower, PathFollower, { followTangent: true }).unwrap();
    const rejected = world.update(1 / 60);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).toContain('path-parent-frame-unsupported');
    await context.fiber.dispose();
  });
  it('converts small invertible parents without the general inverse identity fallback', async () => {
    const { world, context, follower } = await setup();
    const parent = world
      .spawn({ component: Transform, data: { scale: [0.0001, 0.0001, 0.0001] } })
      .unwrap();
    world.addComponent(follower, { component: ChildOf, data: { parent } }).unwrap();
    world.set(follower, PathFollower, { followTangent: false }).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(follower, GlobalTransform).unwrap().world[14]).toBeCloseTo(0.1, 5);
    world.despawn(follower).unwrap();
    world.despawn(parent).unwrap();
    await context.fiber.dispose();
  });
  it('rejects unrepresentable parent-local positions before writing Transform', async () => {
    const { world, context, follower } = await setup();
    const parent = world
      .spawn({ component: Transform, data: { scale: [1e-40, 1e-40, 1e-40] } })
      .unwrap();
    world.addComponent(follower, { component: ChildOf, data: { parent } }).unwrap();
    world.set(follower, PathFollower, { followTangent: false }).unwrap();
    const rejected = world.update(1 / 60);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).toContain('path-invalid-input');
    expect(Array.from(world.get(follower, Transform).unwrap().pos)).toEqual([0, 0, 0]);
    await context.fiber.dispose();
  });
  it('separates carrier translation from relative along-track speed and removes deleted followers', async () => {
    const { world, context, path, follower } = await setup();
    world.update(1 / 60).unwrap();
    const before = world.get(follower, GlobalTransform).unwrap().world[14] as number;
    world.set(path, Transform, { pos: [0, 0, 5 / 60] }).unwrap();
    world.update(1 / 60).unwrap();
    expect(world.get(follower, PathFollower).unwrap().distance).toBeCloseTo(0.2);
    expect(
      ((world.get(follower, GlobalTransform).unwrap().world[14] as number) - before) * 60,
    ).toBeCloseTo(11, 4);
    world.despawn(follower).unwrap();
    world.despawn(path).unwrap();
    world.update(1 / 60).unwrap();
    await context.fiber.dispose();
    expect(world.components.resolve('Path')).toBeUndefined();
  });
});
