import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, GlobalTransform, scenePlugin, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { createIKSolver, createSkeletonRetargeter } from '../index';

async function rig(length = 1) {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  const root = world.spawn({ component: Transform, data: {} }).unwrap();
  const mid = world
    .spawn(
      { component: Transform, data: { pos: [length, 0, 0] } },
      { component: ChildOf, data: { parent: root } },
    )
    .unwrap();
  const end = world
    .spawn(
      { component: Transform, data: { pos: [length, 0, 0] } },
      { component: ChildOf, data: { parent: mid } },
    )
    .unwrap();
  return { world, joints: [root, mid, end] as const };
}

describe('skeletal solvers write the actual Scene pose', () => {
  it('reaches a goal, preserves bone lengths, and bounds unreachable work', async () => {
    const { world, joints } = await rig();
    const solver = createIKSolver(world, { joints }).unwrap();
    const solved = solver.solve([1, 1, 0], { pole: [0, 1, 0] }).unwrap();
    expect(solved.error).toBeLessThan(1e-4);
    world.update(0).unwrap();
    const end = world.get(joints[2], GlobalTransform).unwrap().world;
    expect(end[12]).toBeCloseTo(1, 4);
    expect(end[13]).toBeCloseTo(1, 4);
    expect([...world.get(joints[1], Transform).unwrap().pos]).toEqual([1, 0, 0]);
    expect(solver.solve([10, 0, 0]).unwrap().error).toBeCloseTo(8, 3);
  });

  it('retargets a current pose onto different bone lengths and reference axes', async () => {
    const { world, joints: source } = await rig();
    const target = [world.spawn({ component: Transform, data: { pos: [5, 0, 0] } }).unwrap()];
    target.push(
      world
        .spawn(
          { component: Transform, data: { pos: [0, 2, 0] } },
          { component: ChildOf, data: { parent: target[0] as EntityHandle } },
        )
        .unwrap(),
    );
    target.push(
      world
        .spawn(
          { component: Transform, data: { pos: [0, 2, 0] } },
          { component: ChildOf, data: { parent: target[1] as EntityHandle } },
        )
        .unwrap(),
    );
    const retarget = createSkeletonRetargeter(world, {
      pairs: source.map((joint, i) => ({ source: joint, target: target[i] as EntityHandle })),
    }).unwrap();
    world.set(source[0], Transform, { quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }).unwrap();
    retarget.retarget().unwrap();
    world.update(0).unwrap();
    const pose = world.get(target[2] as EntityHandle, GlobalTransform).unwrap().world;
    expect(pose[12]).toBeCloseTo(1, 4);
    expect(pose[13]).toBeCloseTo(0, 4);
    expect([...world.get(target[1] as EntityHandle, Transform).unwrap().pos]).toEqual([0, 2, 0]);
  });

  it('uses current ancestor transforms, handles opposite goals, and has a zero-weight identity', async () => {
    const { world, joints } = await rig();
    const parent = world
      .spawn({
        component: Transform,
        data: { pos: [3, 1, 0], quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 2, 2] },
      })
      .unwrap();
    world.addComponent(joints[0], { component: ChildOf, data: { parent } }).unwrap();
    const solver = createIKSolver(world, { joints }).unwrap();
    expect(solver.solve([3, -3, 0]).unwrap().error).toBeLessThan(1e-4);
    const before = [...world.get(joints[0], Transform).unwrap().quat];
    solver.solve([8, 8, 0], { weight: 0 }).unwrap();
    expect([...world.get(joints[0], Transform).unwrap().quat]).toEqual(before);
    world.set(parent, Transform, { pos: [4, 2, 0] }).unwrap();
    solver.solve([4, -2, 0]).unwrap();
    world.update(0).unwrap();
    const tip = world.get(joints[2], GlobalTransform).unwrap().world;
    expect(tip[12]).toBeCloseTo(4, 4);
    expect(tip[13]).toBeCloseTo(-2, 4);
  });

  it('solves a longer CCD chain and escapes a collinear shortening singularity', async () => {
    const { world, joints } = await rig();
    const extra = world
      .spawn(
        { component: Transform, data: { pos: [1, 0, 0] } },
        { component: ChildOf, data: { parent: joints[2] } },
      )
      .unwrap();
    const solver = createIKSolver(world, {
      joints: [...joints, extra],
      maxIterations: 128,
    }).unwrap();
    expect(solver.solve([1.5, 0, 0]).unwrap().error).toBeLessThan(1e-4);
    for (const joint of [...joints.slice(1), extra])
      expect(world.get(joint, Transform).unwrap().pos[0]).toBe(1);
  });

  it('enforces finite options, topology, stale entities and unsupported scale before writes', async () => {
    const { world, joints } = await rig();
    const solver = createIKSolver(world, { joints }).unwrap();
    expect(createIKSolver(world, { joints, maxIterations: 0 }).ok).toBe(false);
    expect(createIKSolver(world, { joints: [joints[0], joints[2]] }).ok).toBe(false);
    expect(solver.solve([Number.NaN, 1, 0]).ok).toBe(false);
    expect(solver.solve([1, 1, 0], { weight: 2 }).ok).toBe(false);
    world.set(joints[1], Transform, { scale: [1, 2, 1] }).unwrap();
    expect(solver.solve([1, 1, 0]).ok).toBe(false);
    world.set(joints[1], Transform, { scale: [1, 1, 1] }).unwrap();
    world.removeComponent(joints[1], ChildOf).unwrap();
    expect(solver.solve([1, 1, 0]).ok).toBe(false);
  });

  it('preserves a nonidentity target rest pose and transfers scaled root motion exactly once', async () => {
    const { world, joints: source } = await rig();
    const target = [
      world
        .spawn({
          component: Transform,
          data: { pos: [5, 0, 0], quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
        })
        .unwrap(),
    ];
    target.push(
      world
        .spawn(
          { component: Transform, data: { pos: [2, 0, 0] } },
          { component: ChildOf, data: { parent: target[0] as EntityHandle } },
        )
        .unwrap(),
    );
    target.push(
      world
        .spawn(
          { component: Transform, data: { pos: [2, 0, 0] } },
          { component: ChildOf, data: { parent: target[1] as EntityHandle } },
        )
        .unwrap(),
    );
    const retarget = createSkeletonRetargeter(world, {
      pairs: source.map((joint, i) => ({ source: joint, target: target[i] as EntityHandle })),
      rootTranslationScale: 2,
    }).unwrap();
    retarget.retarget().unwrap();
    expect(world.get(target[0] as EntityHandle, Transform).unwrap().quat[2]).toBeCloseTo(
      Math.SQRT1_2,
    );
    world.set(source[0], Transform, { pos: [1, 0, 0] }).unwrap();
    retarget.retarget().unwrap();
    retarget.retarget().unwrap();
    expect(world.get(target[0] as EntityHandle, Transform).unwrap().pos[0]).toBe(7);
    expect(world.get(target[1] as EntityHandle, Transform).unwrap().pos[0]).toBe(2);
    expect(
      createSkeletonRetargeter(world, { pairs: [{ source: source[0], target: source[0] }] }).ok,
    ).toBe(false);
    expect(
      createSkeletonRetargeter(world, { pairs: [], rootTranslationScale: Number.NaN }).ok,
    ).toBe(false);
  });
  it('rejects source/target overlap through unmapped hierarchy intermediates', async () => {
    const { world, joints } = await rig();
    const leaf = world
      .spawn(
        { component: Transform, data: { pos: [1, 0, 0] } },
        { component: ChildOf, data: { parent: joints[2] } },
      )
      .unwrap();
    // The mapped sets are disjoint, but both compiled poses contain the middle nodes.
    const result = createSkeletonRetargeter(world, {
      pairs: [
        { source: joints[0], target: joints[1] },
        { source: leaf, target: joints[2] },
      ],
    });
    expect(result.ok).toBe(false);
  });
});

it('publishes solver range writes through ordinary changed queries, and omits identical output', async () => {
  const { world, joints } = await rig();
  const changed = world.query({ read: [Transform], changed: [Transform] }).unwrap();
  [...changed.spans().unwrap()];
  const solver = createIKSolver(world, { joints }).unwrap();
  solver.solve([1, 1, 0], { pole: [0, 1, 0] }).unwrap();
  const entities = [...changed.spans().unwrap()].flatMap((span) => [...span.entities]);
  expect(entities).toContain(joints[0]);
  expect(entities).toContain(joints[1]);
  solver.solve([1, 1, 0], { pole: [0, 1, 0] }).unwrap();
  expect([...changed.spans().unwrap()]).toHaveLength(0);
});
