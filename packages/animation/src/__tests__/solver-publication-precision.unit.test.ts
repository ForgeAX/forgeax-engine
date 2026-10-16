import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createIKSolver, createSkeletonRetargeter } from '../index';

it('publishes a representable small locked rotation', async () => {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  const root = world.spawn({ component: Transform, data: {} }).unwrap();
  const tip = world
    .spawn(
      { component: Transform, data: { pos: [1, 0, 0] } },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  const goal = [1, 1e-7, 0];
  const solved = createIKSolver(world, {
    joints: [root, tip],
    tolerance: 1e-9,
    limits: [{ joint: root, min: [0, 0, 1e-7], max: [0, 0, 1e-7] }],
  })
    .unwrap()
    .solve(goal)
    .unwrap();
  const q = world.get(root, Transform).unwrap().quat;
  const x = 1 - 2 * ((q[1] as number) ** 2 + (q[2] as number) ** 2);
  const y = 2 * ((q[0] as number) * (q[1] as number) + (q[2] as number) * (q[3] as number));
  const z = 2 * ((q[0] as number) * (q[2] as number) - (q[1] as number) * (q[3] as number));
  const publishedError = Math.hypot(x - 1, y - 1e-7, z);
  expect(solved.reached).toBe(true);
  expect(publishedError).toBeLessThanOrEqual(1e-9);
  expect(Math.abs(publishedError - solved.error)).toBeLessThanOrEqual(1e-9);
});

it('publishes representable small retargeted root motion', async () => {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  const source = world.spawn({ component: Transform, data: {} }).unwrap();
  const target = world.spawn({ component: Transform, data: {} }).unwrap();
  const retargeter = createSkeletonRetargeter(world, {
    pairs: [{ source, target }],
    rootTranslationScale: 1,
  }).unwrap();
  world.set(source, Transform, { pos: [1e-8, 0, 0] }).unwrap();
  retargeter.retarget().unwrap();
  expect(world.get(target, Transform).unwrap().pos[0]).toBe(
    world.get(source, Transform).unwrap().pos[0],
  );
});
