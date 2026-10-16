import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createIKSolver } from '../index';

it('constrains a local hinge throughout continuous goals and partial overlays', async () => {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  const root = world.spawn({ component: Transform, data: {} }).unwrap();
  const end = world
    .spawn(
      { component: Transform, data: { pos: [1, 0, 0] } },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  const solver = createIKSolver(world, {
    joints: [root, end],
    limits: [{ joint: root, min: [0, 0, -0.4], max: [0, 0, 0.4] }],
  }).unwrap();
  for (let i = 0; i < 100; i++) {
    const a = Math.sin(i / 10) * 1.2;
    world.set(root, Transform, { quat: [0, 0, 0, 1] }).unwrap();
    solver.solve([Math.cos(a), Math.sin(a), 0.2], { weight: ((i % 10) + 1) / 10 }).unwrap();
    const q = world.get(root, Transform).unwrap().quat;
    expect(Math.abs(q[0] as number)).toBeLessThan(1e-6);
    expect(Math.abs(q[1] as number)).toBeLessThan(1e-6);
    expect(Math.abs(2 * Math.atan2(q[2] as number, q[3] as number))).toBeLessThanOrEqual(0.400001);
  }
});

it('keeps a three-joint limb continuous as its pole circles the goal axis', async () => {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  const joints = [world.spawn({ component: Transform, data: {} }).unwrap()];
  for (let i = 1; i < 3; i++)
    joints.push(
      world
        .spawn(
          { component: Transform, data: { pos: [1, 0, 0] } },
          { component: ChildOf, data: { parent: joints[i - 1] as EntityHandle } },
        )
        .unwrap(),
    );
  const solver = createIKSolver(world, { joints, maxIterations: 128 }).unwrap();
  let previous: number[][] | undefined;
  for (let i = 0; i <= 120; i++) {
    const angle = (i / 120) * Math.PI * 2;
    const solved = solver
      .solve([1, 0, 0], { pole: [0, Math.cos(angle), Math.sin(angle)] })
      .unwrap();
    expect(solved.error).toBeLessThan(1e-4);
    const current = joints.map((joint) => [...world.get(joint, Transform).unwrap().quat]);
    if (previous)
      for (let joint = 0; joint < 3; joint++) {
        const a = current[joint] as number[];
        const b = previous[joint] as number[];
        const dot =
          Math.abs(a.reduce((sum, value, k) => sum + value * (b[k] as number), 0)) /
          (Math.hypot(...a) * Math.hypot(...b));
        expect(2 * Math.acos(Math.min(1, dot))).toBeLessThan(0.1);
      }
    previous = current;
  }
});

it('retains the previous elbow plane when a three-joint pole becomes collinear', async () => {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  const joints = [world.spawn({ component: Transform, data: {} }).unwrap()];
  for (let i = 1; i < 3; i++)
    joints.push(
      world
        .spawn(
          { component: Transform, data: { pos: [1, 0, 0] } },
          { component: ChildOf, data: { parent: joints[i - 1] as EntityHandle } },
        )
        .unwrap(),
    );
  const solver = createIKSolver(world, { joints }).unwrap();
  solver.solve([1, 0, 0], { pole: [0, -1, 0] }).unwrap();
  const before = joints.map((joint) => [...world.get(joint, Transform).unwrap().quat]);
  const result = solver.solve([1, 0, 0], { pole: [2, 0, 0] }).unwrap();
  expect(result.error).toBeLessThan(1e-4);
  for (let i = 0; i < joints.length; i++) {
    const after = world.get(joints[i] as EntityHandle, Transform).unwrap().quat;
    for (let j = 0; j < 4; j++) expect(after[j]).toBeCloseTo(before[i]?.[j] as number, 5);
  }
});

it('uses the reference local axes; rejects invalid limits and stale chains before any write', async () => {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  const root = world
    .spawn({
      component: Transform,
      data: {
        quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
      },
    })
    .unwrap();
  const end = world
    .spawn(
      { component: Transform, data: { pos: [1, 0, 0] } },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  const joints = [root, end];
  const limits = [{ joint: root, min: [0, 0, -0.2], max: [0, 0, 0.3] }];
  const solver = createIKSolver(world, { joints, limits }).unwrap();
  solver.solve([-1, 0, 0]).unwrap();
  const q = world.get(root, Transform).unwrap().quat;
  expect(2 * Math.atan2(q[2] as number, q[3] as number)).toBeCloseTo(Math.PI / 2 + 0.3, 5);
  for (const bad of [
    [{ joint: end, min: [0, 0, 0], max: [0, 0, 0] }],
    [...limits, ...limits],
    [{ joint: root, min: [0, 0, 1], max: [0, 0, -1] }],
    [{ joint: root, min: [0, 0, 0], max: [0, 2, 0] }],
  ])
    expect(createIKSolver(world, { joints, limits: bad }).ok).toBe(false);
  const before = [...q];
  world.despawn(end).unwrap();
  expect(solver.solve([0, 1, 0]).ok).toBe(false);
  expect([...world.get(root, Transform).unwrap().quat]).toEqual(before);
});

it('bounds long-chain and zero-length work and composes continuous pole solves with step caps', async () => {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  const joints = [world.spawn({ component: Transform, data: {} }).unwrap()];
  for (let i = 1; i < 256; i++)
    joints.push(
      world
        .spawn(
          { component: Transform, data: { pos: [0.01, 0, 0] } },
          { component: ChildOf, data: { parent: joints[i - 1] as EntityHandle } },
        )
        .unwrap(),
    );
  const solver = createIKSolver(world, { joints, maxIterations: 4, tolerance: 1e-3 }).unwrap();
  for (let i = 0; i < 4; i++) {
    const result = solver.solve([2.8, i * 0.1, 0]).unwrap();
    expect(result.iterations).toBeLessThanOrEqual(4);
    expect(Number.isFinite(result.error)).toBe(true);
    expect(result.error).toBeGreaterThanOrEqual(0.249);
  }
  const limb = joints.slice(0, 3);
  const smallStep = createIKSolver(world, {
    joints: limb,
    maxAngle: 0.1,
    maxIterations: 128,
  }).unwrap();
  for (let i = 0; i < 20; i++)
    expect(
      smallStep.solve([0.01, Math.sin(i / 10) * 0.01, 0], { pole: [0, 1, 0] }).unwrap().error,
    ).toBeLessThan(1e-4);
  world.set(limb[1] as EntityHandle, Transform, { pos: [0, 0, 0] }).unwrap();
  const before = [...world.get(limb[0] as EntityHandle, Transform).unwrap().quat];
  expect(smallStep.solve([0.01, 0.01, 0], { pole: [0, 1, 0] }).ok).toBe(false);
  expect([...world.get(limb[0] as EntityHandle, Transform).unwrap().quat]).toEqual(before);
});
