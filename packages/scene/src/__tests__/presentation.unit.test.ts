import {
  createWorldContext,
  type EntityHandle,
  FixedTime,
  FixedUpdate,
  Time,
  Update,
  World,
} from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import {
  ChildOf,
  GlobalTransform,
  readPresentationWorldMatrix,
  registerPropagateTransforms,
  resetTransformInterpolation,
  scenePlugin,
  Transform,
  TransformInterpolation,
} from '../index';

function x(world: World, entity: EntityHandle): number {
  const matrix = readPresentationWorldMatrix(world, entity);
  if (matrix === undefined || matrix[12] === undefined)
    throw new Error('expected presentation translation');
  return matrix[12];
}

describe('fixed-step transform presentation', () => {
  it('samples every display frame while retaining the exact simulation pose', async () => {
    const world = new World();
    const ctx = await createWorldContext(world, [scenePlugin()]);
    const root = world
      .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
      .unwrap();
    const child = world
      .spawn(
        { component: Transform, data: { pos: [1, 0, 0] } },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    world
      .addSystem(FixedUpdate, {
        name: 'physics-like-writeback',
        after: ['propagateTransformsFixed'],
        queries: [],
        fn: () => {
          world
            .set(root, Transform, { pos: [world.getResource(FixedTime).tick / 10, 0, 0] })
            .unwrap();
        },
      })
      .unwrap();
    try {
      world.update(2 / 60).unwrap();
      let previous = x(world, root);
      for (let frame = 0; frame < 120; frame += 1) {
        world.update(1 / 120).unwrap();
        const rowReads = vi.spyOn(world, 'get');
        const rootPose = x(world, root);
        expect(rootPose - previous, `display frame ${frame}`).toBeCloseTo(0.05, 5);
        expect(x(world, child)).toBeCloseTo(rootPose + 1, 5);
        expect(rowReads).not.toHaveBeenCalled();
        rowReads.mockRestore();
        expect(world.get(root, Transform).unwrap().pos[0]).toBeCloseTo(
          world.getResource(FixedTime).tick / 10,
          5,
        );
        expect(world.get(root, GlobalTransform).unwrap().world[12]).toBeCloseTo(
          world.get(root, Transform).unwrap().pos[0] ?? Number.NaN,
          5,
        );
        previous = rootPose;
      }
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

it('captures the final two catch-up ticks and retires presentation changes on stop', async () => {
  const world = new World();
  const ctx = await createWorldContext(world, [scenePlugin()]);
  const entity = world
    .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
    .unwrap();
  let moving = true;
  world
    .addSystem(FixedUpdate, {
      name: 'move',
      queries: [],
      fn: () => {
        if (moving)
          world
            .set(entity, Transform, {
              pos: [(world.get(entity, Transform).unwrap().pos[0] ?? 0) + 1, 0, 0],
            })
            .unwrap();
      },
    })
    .unwrap();
  try {
    world.update(3 / 60).unwrap();
    expect(x(world, entity)).toBeCloseTo(2);
    world.update(1 / 120).unwrap();
    expect(x(world, entity)).toBeCloseTo(2.5);
    const changed = world.query({ read: [GlobalTransform], changed: [GlobalTransform] }).unwrap();
    Array.from(changed);
    moving = false;
    world.update(1 / 120).unwrap();
    expect(x(world, entity)).toBeCloseTo(3);
    expect(Array.from(changed, (row) => row.entity)).toContain(entity);
    world.update(1 / 120).unwrap();
    expect(x(world, entity)).toBeCloseTo(3);
    expect(Array.from(changed)).toHaveLength(0);
  } finally {
    await ctx.fiber.dispose();
  }
});

it('keeps required static interpolation tags without row snapshots or stale teleport poses', async () => {
  const world = new World();
  const ctx = await createWorldContext(world, [scenePlugin()]);
  const root = world
    .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
    .unwrap();
  const child = world
    .spawn(
      { component: Transform, data: { pos: [2, 0, 0] } },
      { component: TransformInterpolation, data: {} },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  try {
    world.update(2 / 60).unwrap();
    const reads = vi.spyOn(world, 'get');
    try {
      world.update(1 / 60).unwrap();
      expect(reads.mock.calls.filter(([, component]) => component === Transform)).toHaveLength(0);
    } finally {
      reads.mockRestore();
    }
    expect(world.hasComponent(root, TransformInterpolation)).toBe(true);
    expect(world.hasComponent(child, TransformInterpolation)).toBe(true);
    world.set(root, Transform, { pos: [8, 0, 0] }).unwrap();
    world.update(1 / 120).unwrap();
    expect(x(world, root)).toBeCloseTo(8);
    expect(x(world, child)).toBeCloseTo(10);
    world.removeComponent(root, TransformInterpolation).unwrap();
    world.update(1 / 60).unwrap();
    expect(x(world, root)).toBeCloseTo(8);
    expect(x(world, child)).toBeCloseTo(10);
  } finally {
    await ctx.fiber.dispose();
  }
});

it('keeps variable-rate child animation on the interpolated parent', async () => {
  const world = new World();
  const ctx = await createWorldContext(world, [scenePlugin()]);
  const root = world
    .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
    .unwrap();
  const child = world
    .spawn(
      { component: Transform, data: {} },
      { component: TransformInterpolation, data: {} },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  world
    .addSystem(FixedUpdate, {
      name: 'move',
      queries: [],
      fn: () =>
        world.set(root, Transform, { pos: [world.getResource(FixedTime).tick, 0, 0] }).unwrap(),
    })
    .unwrap();
  world
    .addSystem(Update, {
      name: 'animate',
      after: [FixedUpdate],
      before: ['propagateTransforms'],
      queries: [],
      fn: () =>
        world.set(child, Transform, { pos: [world.getResource(Time).elapsed, 0, 0] }).unwrap(),
    })
    .unwrap();
  try {
    world.update(2 / 60).unwrap();
    for (const dt of [1 / 240, 1 / 120, 3 / 60, 1 / 30, 1 / 60]) {
      world.update(dt).unwrap();
      expect(x(world, child)).toBeCloseTo(x(world, root) + world.getResource(Time).elapsed, 5);
    }
  } finally {
    await ctx.fiber.dispose();
  }
});

it('snaps teleports, reparenting and capped catch-up instead of blending unrelated poses', async () => {
  const world = new World();
  const ctx = await createWorldContext(world, [scenePlugin()]);
  const root = world
    .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
    .unwrap();
  const parent = world.spawn({ component: Transform, data: { pos: [10, 0, 0] } }).unwrap();
  world
    .addSystem(FixedUpdate, {
      name: 'move',
      queries: [],
      fn: () =>
        world
          .set(root, Transform, {
            pos: [(world.get(root, Transform).unwrap().pos[0] ?? 0) + 1, 0, 0],
          })
          .unwrap(),
    })
    .unwrap();
  try {
    world.update(2 / 60).unwrap();
    world.set(root, Transform, { pos: [30, 0, 0] }).unwrap();
    world.update(0).unwrap();
    expect(x(world, root)).toBeCloseTo(30);
    world.addComponent(root, { component: ChildOf, data: { parent } }).unwrap();
    world.update(0).unwrap();
    expect(x(world, root)).toBeCloseTo(40);
    world.update(0.1).unwrap();
    expect(world.getResource(FixedTime).droppedUpdates).toBe(1);
    expect(x(world, root)).toBeCloseTo(44);
    world.set(root, Transform, { pos: [80, 0, 0] }).unwrap();
    resetTransformInterpolation(world, root);
    expect(x(world, root)).toBeCloseTo(90);
    world.update(0).unwrap();
    expect(x(world, root)).toBeCloseTo(90);
  } finally {
    await ctx.fiber.dispose();
  }
});

it('shares one sampler lease and releases it with the propagation owner', () => {
  const world = new World();
  const entity = world
    .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
    .unwrap();
  const first = registerPropagateTransforms(world),
    second = registerPropagateTransforms(world);
  const systems = () =>
    world.inspect().systems.filter((system) => system.name.startsWith('captureTransform'));
  expect(systems()).toHaveLength(2);
  first();
  expect(systems()).toHaveLength(2);
  world.update(1 / 60).unwrap();
  second();
  expect(systems()).toHaveLength(0);
  expect(x(world, entity)).toBe(0);
});
