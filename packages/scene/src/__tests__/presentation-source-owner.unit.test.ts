import {
  createWorldContext,
  type EntityHandle,
  FixedTime,
  FixedUpdate,
  type SystemDescriptor,
  World,
} from '@forgeax/engine-ecs';
import { expect, it, vi } from 'vitest';
import {
  ChildOf,
  readPresentationWorldMatrix,
  resetTransformInterpolation,
  scenePlugin,
  Transform,
  TransformInterpolation,
} from '../index';

it('captures a moving fixed pose once while preserving the final stop settlement', async () => {
  const world = new World();
  const ctx = await createWorldContext(world, [scenePlugin()]);
  const actor = world
    .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
    .unwrap();
  let moving = true;
  world
    .addSystem(FixedUpdate, {
      name: 'capture-copy-source',
      queries: [],
      fn: () => {
        if (moving)
          world.set(actor, Transform, { pos: [world.getResource(FixedTime).tick, 0, 0] }).unwrap();
      },
    })
    .unwrap();
  const internal = (
    world as unknown as Record<
      symbol,
      {
        getSchedules(): ReadonlyMap<
          unknown,
          { systems: Map<string, { descriptor: SystemDescriptor }> }
        >;
      }
    >
  )[Symbol.for('forgeax.ecs.worldInternal')];
  if (internal === undefined) throw new Error('Expected the World schedule owner');
  const capture = Array.from(internal.getSchedules().values())
    .map((schedule) => schedule.systems.get('captureTransformCurrent'))
    .find((record) => record !== undefined);
  if (capture === undefined) throw new Error('Expected the Scene capture owner');
  const descriptor = capture.descriptor;
  let copies = 0;
  try {
    for (let tick = 0; tick < 4; tick++) world.update(1 / 60).unwrap();
    capture.descriptor = {
      ...descriptor,
      fn: (...args) => {
        const set = vi.spyOn(Float32Array.prototype, 'set');
        try {
          return descriptor.fn(...args);
        } finally {
          copies += set.mock.calls.length;
          set.mockRestore();
        }
      },
    };
    world.update(1.5 / 60).unwrap();
    expect(readPresentationWorldMatrix(world, actor)?.[12]).toBeCloseTo(4.5);
    expect(copies).toBe(4);

    moving = false;
    const fixed = world.getResource(FixedTime);
    world.update(fixed.delta - fixed.overstep).unwrap();
    expect(readPresentationWorldMatrix(world, actor)?.[12]).toBeCloseTo(5);
    moving = true;
    world.update(1.5 / 60).unwrap();
    expect(readPresentationWorldMatrix(world, actor)?.[12]).toBeCloseTo(6);
    expect(copies).toBe(8);
  } finally {
    capture.descriptor = descriptor;
    await ctx.fiber.dispose();
  }
});

it('captures first movement after idle, settles stops and preserves source lifecycle discontinuities', async () => {
  const world = new World();
  const ctx = await createWorldContext(world, [scenePlugin()]);
  const actor = world
    .spawn(
      { component: Transform, data: { pos: [2, 0, 0] } },
      { component: TransformInterpolation, data: {} },
    )
    .unwrap();
  const other = world
    .spawn({ component: Transform, data: {} }, { component: TransformInterpolation, data: {} })
    .unwrap();
  const parent = world.spawn({ component: Transform, data: { pos: [100, 0, 0] } }).unwrap();
  let write: (() => void) | undefined;
  world
    .addSystem(FixedUpdate, { name: 'source-owner-write', queries: [], fn: () => write?.() })
    .unwrap();
  const x = (entity: EntityHandle) => {
    const value = readPresentationWorldMatrix(world, entity)?.[12];
    if (value === undefined) throw new Error('Expected a current presentation matrix');
    return value;
  };
  const halfTick = () => {
    const fixed = world.getResource(FixedTime);
    world.update(fixed.delta * 1.5 - fixed.overstep).unwrap();
  };
  const completeTick = () => {
    const fixed = world.getResource(FixedTime);
    world.update(fixed.delta - fixed.overstep).unwrap();
  };
  try {
    for (let tick = 0; tick < 60; tick++) world.update(1 / 60).unwrap();
    write = () => {
      world.set(actor, Transform, { pos: [4, 0, 0] }).unwrap();
    };
    halfTick();
    expect(x(actor)).toBeCloseTo(3, 5);
    write = undefined;
    completeTick();
    expect(x(actor)).toBeCloseTo(4, 5);
    for (let tick = 0; tick < 30; tick++) world.update(1 / 60).unwrap();

    // A new parent and a fixed writer in the same tick snap the final local
    // pose, rather than blending it through either the old or new parent.
    world.addComponent(actor, { component: ChildOf, data: { parent } }).unwrap();
    write = () => {
      world.set(actor, Transform, { pos: [6, 0, 0] }).unwrap();
    };
    halfTick();
    expect(x(actor)).toBeCloseTo(106, 5);
    write = undefined;
    completeTick();

    // Invalidating one history inside a fixed tick must not erase another
    // actor's ordinary interpolation from that same accepted tick.
    write = () => {
      world.set(actor, Transform, { pos: [20, 0, 0] }).unwrap();
      resetTransformInterpolation(world, actor);
      world.set(other, Transform, { pos: [9, 0, 0] }).unwrap();
    };
    halfTick();
    expect(x(actor)).toBeCloseTo(120, 5);
    expect(x(other)).toBeCloseTo(4.5, 5);
    write = undefined;
    world.removeComponent(actor, TransformInterpolation).unwrap();
    completeTick();
    expect(x(actor)).toBeCloseTo(120, 5);
    world.addComponent(actor, { component: TransformInterpolation, data: {} }).unwrap();
    write = () => {
      world.set(actor, Transform, { pos: [22, 0, 0] }).unwrap();
    };
    halfTick();
    expect(x(actor)).toBeCloseTo(121, 5);
    write = undefined;
    completeTick();

    const retired = world
      .spawn(
        { component: Transform, data: { pos: [7, 0, 0] } },
        { component: TransformInterpolation, data: {} },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    world.despawn(retired).unwrap();
    const replacement = world
      .spawn(
        { component: Transform, data: { pos: [31, 0, 0] } },
        { component: TransformInterpolation, data: {} },
      )
      .unwrap();
    expect(replacement).not.toBe(retired);
    halfTick();
    expect(x(replacement)).toBeCloseTo(31, 5);
    expect(x(actor)).toBeCloseTo(122, 5);
  } finally {
    await ctx.fiber.dispose();
  }
});

it('keeps interpolated motion continuous across a merged fixed catch-up', async () => {
  const world = new World({
    time: {
      fixedDeltaSeconds: 0.05,
      maxStepsPerUpdate: 2,
      maxDeltaSeconds: 3 * 0.05,
      fixedCatchUp: 'merged',
    },
  });
  const ctx = await createWorldContext(world, [scenePlugin()]);
  const body = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: TransformInterpolation, data: {} },
    )
    .unwrap();
  // Constant 10 units/s, integrated with whatever step FixedUpdate receives.
  world
    .addSystem(FixedUpdate, {
      name: 'constant-velocity',
      queries: [],
      fn: (world) => {
        const x = world.get(body, Transform).unwrap().pos[0] ?? 0;
        world
          .set(body, Transform, { pos: [x + 10 * world.getResource(FixedTime).delta, 0, 0] })
          .unwrap();
      },
    })
    .unwrap();
  let elapsed = 0;
  const frame = (seconds: number) => {
    world.update(seconds).unwrap();
    elapsed += seconds;
    // Presentation renders one base step behind simulation time.
    const x = readPresentationWorldMatrix(world, body)?.[12];
    expect(x).toBeCloseTo(10 * (elapsed - 0.05), 5);
  };
  try {
    for (let index = 0; index < 4; index++) frame(0.05);
    frame(0.11); // merged: one 0.1 s pass
    expect(world.getResource(FixedTime).stepDelta).toBeCloseTo(0.1, 9);
    frame(0.02); // no fixed pass, still inside the merged interval
    frame(0.03); // ordinary step
    frame(0.12); // merged again
    frame(0.05);
  } finally {
    await ctx.fiber.dispose();
  }
});
