import { createWorldContext, FixedUpdate, World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import {
  ChildOf,
  GlobalTransform,
  propagateTransforms,
  readPresentationWorldMatrix,
  scenePlugin,
  Transform,
  TransformInterpolation,
} from '../index';

it('propagates shear through flat roots, children, edits and reparenting', () => {
  const world = new World();
  const parent = world
    .spawn({ component: Transform, data: { pos: [1, 0, 0], shear: [2, 0, 0] } })
    .unwrap();
  const child = world
    .spawn(
      { component: Transform, data: { pos: [0, 3, 0] } },
      { component: ChildOf, data: { parent } },
    )
    .unwrap();
  propagateTransforms(world).unwrap();
  expect([...world.get(child, GlobalTransform).unwrap().world.slice(12, 15)]).toEqual([7, 3, 0]);
  world.set(parent, Transform, { shear: [-1, 0, 0] }).unwrap();
  propagateTransforms(world).unwrap();
  expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(-2);
  world.removeComponent(child, ChildOf).unwrap();
  propagateTransforms(world).unwrap();
  expect(world.get(child, GlobalTransform).unwrap().world[12]).toBe(0);
  expect(world.get(parent, GlobalTransform).unwrap().world[4]).toBe(-1);
});

it('samples shear with the fixed pose without changing the simulation matrix', async () => {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin()]);
  try {
    const entity = world
      .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
      .unwrap();
    world
      .addSystem(FixedUpdate, {
        name: 'author-shear',
        queries: [],
        fn: () => {
          world.set(entity, Transform, { shear: [2, 0, 0] }).unwrap();
        },
      })
      .unwrap();
    world.update(1.5 / 60).unwrap();
    expect(world.get(entity, GlobalTransform).unwrap().world[4]).toBe(2);
    expect(readPresentationWorldMatrix(world, entity)?.[4]).toBeCloseTo(1);
  } finally {
    await context.fiber.dispose();
  }
});
