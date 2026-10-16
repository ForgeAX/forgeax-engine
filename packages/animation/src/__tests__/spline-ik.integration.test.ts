import { createWorldContext, defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { quat, vec3 } from '@forgeax/engine-math';
import { Path, PathAxis, preparePath } from '@forgeax/engine-path';
import { startNativePlugin } from '@forgeax/engine-plugin';
import {
  ChildOf,
  GlobalTransform,
  Name,
  scenePlugin,
  Transform,
  worldInstantiateSceneFlat,
} from '@forgeax/engine-scene';
import type { AnimationTargetIdValue, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { AnimationTargetId, bindAnimationTargets } from '../animation-target';
import { animationPlugin } from '../plugin';
import { bindSkeletalMotion, skeletalMotionPlugin } from '../skeletal-motion';
import { createSplineIKSolver, SplineIK, splineIKPlugin } from '../spline-ik';

async function rig(count = 4, length = 1) {
  const world = new World();
  const context = await createWorldContext(world, [
    scenePlugin(),
    animationPlugin(undefined, { cadence: 'fixed' }),
  ]);
  const joints: EntityHandle[] = [];
  for (let i = 0; i < count; i++)
    joints.push(
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, i === 0 ? 0 : length] } },
          ...(i > 0
            ? [{ component: ChildOf, data: { parent: joints[i - 1] as EntityHandle } }]
            : []),
        )
        .unwrap(),
    );
  const path = (points: number[], closed = false) =>
    preparePath({
      points: new Float32Array(points),
      closed,
      parameterization: 1,
      subdivisions: 2048,
      up: new Float32Array([0, 1, 0]),
    }).unwrap();
  const positions = () =>
    joints.map((e) => Array.from(world.get(e, GlobalTransform).unwrap().world).slice(12, 15));
  return { world, context, joints, path, positions };
}

describe('Spline IK ordinary Scene pose', () => {
  it('rejects existing and late same-chain motion writers before bind, restore or zero-weight solve', async () => {
    const { world, context, joints, path } = await rig();
    const motion = (await startNativePlugin(context, skeletalMotionPlugin())).unwrap();
    try {
      const player = world
        .spawn(
          { component: Transform, data: {} },
          { component: Name, data: { value: 'motion-player' } },
          { component: AnimationPlayer, data: {} },
        )
        .unwrap();
      world
        .addComponent(joints[0] as EntityHandle, { component: ChildOf, data: { parent: player } })
        .unwrap();
      for (let i = 0; i < joints.length; i++)
        world
          .addComponent(joints[i] as EntityHandle, {
            component: Name,
            data: { value: `joint-${i}` },
          })
          .unwrap();
      bindAnimationTargets(world, player, joints).unwrap();
      const targets = joints.map(
        (joint) => world.get(joint, AnimationTargetId).unwrap().value as AnimationTargetIdValue,
      );
      const solver = createSplineIKSolver(world, { joints }).unwrap();
      solver.solve(path([0, 0, 0, 3, 0, 0])).unwrap();
      const binding = bindSkeletalMotion(world, player, {
        springs: [
          {
            targets,
            stiffness: 20,
            damping: 5,
            gravity: [0, 0, 0],
            radius: 0.03,
            maxAngle: Math.PI / 2,
          },
        ],
      }).unwrap();
      binding.setSpringWeight(0, 0).unwrap();
      // Public JavaScript consumers cannot empty the controlled chain to bypass admission.
      expect(Reflect.set(solver.joints, 'length', 0)).toBe(false);
      expect(solver.joints).toEqual(joints);
      const snapshot = () =>
        joints.map((joint) => {
          const t = world.get(joint, Transform).unwrap();
          return { pos: [...t.pos], quat: [...t.quat] };
        });
      const before = snapshot();
      for (const result of [
        createSplineIKSolver(world, { joints }),
        solver.restoreBase(),
        solver.solve(path([0, 0, 0, 0, 0, 5]), { weight: 0 }),
      ]) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'spline-ik-conflict', detail: { joint: joints[0] } },
        });
        expect(snapshot()).toEqual(before);
      }
      binding.dispose();
      expect(solver.restoreBase().ok).toBe(true);
      expect(solver.solve(path([0, 0, 0, 0, 0, 5])).ok).toBe(true);
    } finally {
      await motion.dispose();
      await context.fiber.dispose();
    }
  });

  it('keeps disjoint fixed-step motion and spline chains with one restore before the sampled base', async () => {
    const { world, context, joints } = await rig();
    const motion = (await startNativePlugin(context, skeletalMotionPlugin())).unwrap();
    try {
      const other: EntityHandle[] = [];
      for (let i = 0; i < 3; i++)
        other.push(
          world
            .spawn(
              { component: Transform, data: { pos: [0, 0, i ? 1 : 0] } },
              ...(i
                ? [{ component: ChildOf, data: { parent: other[i - 1] as EntityHandle } }]
                : []),
            )
            .unwrap(),
        );
      const player = world
        .spawn(
          { component: Transform, data: {} },
          { component: Name, data: { value: 'motion-player' } },
          { component: AnimationPlayer, data: {} },
        )
        .unwrap();
      world
        .addComponent(other[0] as EntityHandle, { component: ChildOf, data: { parent: player } })
        .unwrap();
      for (let i = 0; i < other.length; i++)
        world
          .addComponent(other[i] as EntityHandle, {
            component: Name,
            data: { value: `motion-${i}` },
          })
          .unwrap();
      bindAnimationTargets(world, player, other).unwrap();
      const targets = other.map(
        (joint) => world.get(joint, AnimationTargetId).unwrap().value as AnimationTargetIdValue,
      );
      const binding = bindSkeletalMotion(world, player, {
        springs: [
          {
            targets,
            stiffness: 0,
            damping: 5,
            gravity: [0, 0, 0],
            radius: 0.03,
            maxAngle: Math.PI / 2,
          },
        ],
      }).unwrap();
      const spline = (await startNativePlugin(context, splineIKPlugin())).unwrap();
      try {
        const curve = world
          .spawn(
            { component: Transform, data: {} },
            { component: Path, data: { points: [0, 0, 0, 3, 0, 0] } },
          )
          .unwrap();
        world
          .spawn({
            component: SplineIK,
            data: {
              root: joints[0] as EntityHandle,
              tip: joints.at(-1) as EntityHandle,
              path: curve,
            },
          })
          .unwrap();
        const initial = other.map((joint) => [...world.get(joint, Transform).unwrap().quat]);
        for (let i = 0; i < 60; i++) world.update(1 / 60).unwrap();
        expect(binding.fixedSteps).toBe(60);
        expect(binding.failure).toBeUndefined();
        expect(other.map((joint) => [...world.get(joint, Transform).unwrap().quat])).toEqual(
          initial,
        );
        expect([...world.get(joints[0] as EntityHandle, Transform).unwrap().quat]).not.toEqual([
          0, 0, 0, 1,
        ]);
        expect(createSplineIKSolver(world, { joints }).ok).toBe(true);
        const fixed = world.scheduleData().find((scope) => scope.name === 'FixedUpdate');
        expect(
          fixed?.systems.filter((system) => system.name === 'animation/restore-spline-base'),
        ).toHaveLength(1);
        expect(
          fixed?.systems.find((system) => system.name === 'animation/solve-spline-ik'),
        ).toMatchObject({
          after: ['advanceAnimationPlayer'],
          before: ['captureSkeletalMotionBase', 'propagateTransformsFixed'],
        });
        const presented = [...world.get(joints[0] as EntityHandle, Transform).unwrap().quat];
        world.set(curve, Path, { points: [0, 0, 0, 0, 0, 3] }).unwrap();
        world.update(0).unwrap();
        expect(binding.fixedSteps).toBe(60);
        expect([...world.get(joints[0] as EntityHandle, Transform).unwrap().quat]).toEqual(
          presented,
        );
        world.update(1 / 60).unwrap();
        expect(binding.fixedSteps).toBe(61);
        const result = world.get(joints[0] as EntityHandle, Transform).unwrap().quat;
        for (let i = 0; i < 4; i++) expect(result[i]).toBeCloseTo(i === 3 ? 1 : 0, 5);
      } finally {
        await spline.dispose();
      }
    } finally {
      await motion.dispose();
      await context.fiber.dispose();
    }
  });

  it('derives ordinary default App cadence without adding another playback or restore system', async () => {
    const world = new World();
    const context = await createWorldContext(world, [
      scenePlugin(),
      animationPlugin(),
      splineIKPlugin(),
    ]);
    try {
      const root = world.spawn({ component: Transform, data: {} }).unwrap();
      const tip = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 1] } },
          { component: ChildOf, data: { parent: root } },
        )
        .unwrap();
      const path = world
        .spawn(
          { component: Transform, data: {} },
          { component: Path, data: { points: [0, 0, 0, 1, 0, 0] } },
        )
        .unwrap();
      world.spawn({ component: SplineIK, data: { root, tip, path } }).unwrap();
      world.update(0).unwrap();
      expect([...world.get(root, Transform).unwrap().quat]).not.toEqual([0, 0, 0, 1]);
      const schedules = world.scheduleData();
      const update = schedules.find((scope) => scope.name === 'Update');
      expect(
        update?.systems.filter((system) => system.name === 'advanceAnimationPlayer'),
      ).toHaveLength(1);
      expect(
        update?.systems.filter((system) => system.name === 'animation/restore-spline-base'),
      ).toHaveLength(1);
      expect(
        schedules
          .filter((scope) => scope.name !== 'Update')
          .flatMap((scope) => scope.systems)
          .some((system) => system.name === 'animation/solve-spline-ik'),
      ).toBe(false);
    } finally {
      await context.fiber.dispose();
    }
  });

  it('keeps the complete current base after a middle segment fails validation', async () => {
    const { world, context, joints, path } = await rig();
    const solver = createSplineIKSolver(world, { joints }).unwrap();
    world.set(joints[0] as EntityHandle, Transform, { pos: [1, 2, 3] }).unwrap();
    world.set(joints[1] as EntityHandle, Transform, { pos: [0, 0, 0] }).unwrap();
    world
      .set(joints[3] as EntityHandle, Transform, {
        pos: [0.2, 0.3, 2],
        quat: quat.fromEuler(quat.create(), 0, 0.3, 0, 'XYZ'),
      })
      .unwrap();
    const snapshot = () =>
      joints.map((joint) => {
        const pose = world.get(joint, Transform).unwrap();
        return { position: Array.from(pose.pos), rotation: Array.from(pose.quat) };
      });
    const current = snapshot();
    expect(solver.solve(path([0, 0, 0, 0, 0, 8])).ok).toBe(false);
    expect(snapshot()).toEqual(current);
    solver.restoreBase().unwrap();
    expect(snapshot()).toEqual(current);
    await context.fiber.dispose();
  });

  it('retires the previous live binding when an explicit root reference becomes invalid', async () => {
    const { world, context, joints } = await rig();
    const failures: string[] = [];
    const fiber = (
      await startNativePlugin(
        context,
        splineIKPlugin({ onError: (_, failure) => failures.push(failure.code) }),
      )
    ).unwrap();
    const curve = world
      .spawn(
        { component: Transform, data: {} },
        { component: Path, data: { points: [0, 0, 0, 3, 0, 0] } },
      )
      .unwrap();
    const controller = world
      .spawn({
        component: SplineIK,
        data: { root: joints[0] as EntityHandle, tip: joints.at(-1) as EntityHandle, path: curve },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(Array.from(world.get(joints[0] as EntityHandle, Transform).unwrap().quat)).not.toEqual([
      0, 0, 0, 1,
    ]);
    world.set(controller, SplineIK, { root: null }).unwrap();
    world.update(1 / 60).unwrap();
    expect(failures).toEqual(['spline-ik-invalid']);
    expect(Array.from(world.get(joints[0] as EntityHandle, Transform).unwrap().quat)).toEqual([
      0, 0, 0, 1,
    ]);
    await fiber.dispose();
    await context.fiber.dispose();
  });

  it('reports the invalid authored Path field and keeps the sampled base pose', async () => {
    const { world, context, joints } = await rig();
    const errors: { code: string; reason: string }[] = [];
    const fiber = (
      await startNativePlugin(
        context,
        splineIKPlugin({
          onError: (_, failure) =>
            errors.push({ code: failure.code, reason: failure.detail.reason }),
        }),
      )
    ).unwrap();
    const curve = world
      .spawn(
        { component: Transform, data: {} },
        { component: Path, data: { points: new Float32Array([0, 0, 0]) } },
      )
      .unwrap();
    world
      .spawn({
        component: SplineIK,
        data: { root: joints[0] as EntityHandle, tip: joints.at(-1) as EntityHandle, path: curve },
      })
      .unwrap();
    const before = joints.map((joint) => Array.from(world.get(joint, Transform).unwrap().pos));
    world.update(1 / 60).unwrap();
    expect(errors).toEqual([
      { code: 'spline-ik-invalid', reason: expect.stringContaining('points') },
    ]);
    expect(joints.map((joint) => Array.from(world.get(joint, Transform).unwrap().pos))).toEqual(
      before,
    );
    await fiber.dispose();
    await context.fiber.dispose();
  });

  it('places a preserved chain on a straight curve and extends short open ends', async () => {
    const { world, context, joints, path, positions } = await rig();
    const solver = createSplineIKSolver(world, { joints }).unwrap();
    expect(solver.solve(path([0, 0, 0, 0, 0, 2])).unwrap().extended).toBe(true);
    world.update(1 / 60).unwrap();
    positions().forEach((point, i) => {
      expect(point[0]).toBeCloseTo(0, 6);
      expect(point[1]).toBeCloseTo(0, 6);
      expect(point[2]).toBeCloseTo(i, 6);
    });
    solver.restoreBase().unwrap();
    solver.solve(path([0, 0, 0, 0, 0, 8]), { lengthMode: 'fit' }).unwrap();
    world.update(1 / 60).unwrap();
    expect(positions()[3]?.[2]).toBeCloseTo(8, 5);
    await context.fiber.dispose();
  });

  it('preserves lengths around bends with weight 0/0.5/1 and current parent scale', async () => {
    const { world, context, joints, path, positions } = await rig(16, 0.2);
    const parent = world
      .spawn({ component: Transform, data: { pos: [2, 3, 0], scale: [2, 2, 2] } })
      .unwrap();
    world
      .addComponent(joints[0] as EntityHandle, { component: ChildOf, data: { parent } })
      .unwrap();
    const curve = path([0, 0, 0, 1, 0, 2, -1, 1, 4, 0, 0, 8]);
    const solver = createSplineIKSolver(world, { joints }).unwrap();
    for (const weight of [0, 0.5, 1]) {
      solver.restoreBase().unwrap();
      solver.solve(curve, { weight, origin: [2, 3, 0] }).unwrap();
      world.update(1 / 60).unwrap();
      const actual = positions();
      for (let i = 1; i < joints.length; i++)
        expect(
          Math.hypot(
            ...(actual[i] as number[]).map(
              (v, a) => v - ((actual[i - 1] as number[])[a] as number),
            ),
          ),
        ).toBeCloseTo(0.4, 4);
    }
    world.set(parent, Transform, { scale: [1, 2, 1] }).unwrap();
    const before = joints.map((j) => Array.from(world.get(j, Transform).unwrap().quat));
    expect(solver.solve(curve).ok).toBe(false);
    expect(joints.map((j) => Array.from(world.get(j, Transform).unwrap().quat))).toEqual(before);
    await context.fiber.dispose();
  });

  it('maps authored axes to analytic tangents, supports reverse and twist', async () => {
    const { world, context, joints, path } = await rig();
    const solver = createSplineIKSolver(world, {
      joints,
      forwardAxis: PathAxis.positiveX,
    }).unwrap();
    solver
      .solve(path([0, 0, 0, 0, 0, 10]), {
        direction: -1,
        twistStart: Math.PI / 2,
        twistEnd: Math.PI / 2,
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const q = quat.create();
    q.set(world.get(joints[0] as EntityHandle, Transform).unwrap().quat);
    const axis = vec3.create();
    quat.transformVec3(axis, q, [1, 0, 0]);
    expect(Array.from(axis)).toEqual([0, 0, -1]);
    expect(world.get(joints[0] as EntityHandle, GlobalTransform).unwrap().world[14]).toBeCloseTo(
      10,
    );
    await context.fiber.dispose();
  });

  it('rejects impossible closed lengths, seam twist and stale topology without writes', async () => {
    const { world, context, joints, path } = await rig(4, 10);
    const solver = createSplineIKSolver(world, { joints }).unwrap();
    const closed = path([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], true);
    const snapshot = () =>
      joints.map((j) => ({
        p: Array.from(world.get(j, Transform).unwrap().pos),
        q: Array.from(world.get(j, Transform).unwrap().quat),
      }));
    const before = snapshot();
    expect(solver.solve(closed).ok).toBe(false);
    expect(solver.solve(closed, { twistEnd: 1 }).ok).toBe(false);
    expect(snapshot()).toEqual(before);
    world.removeComponent(joints[2] as EntityHandle, ChildOf).unwrap();
    expect(solver.solve(path([0, 0, 0, 0, 0, 100])).ok).toBe(false);
    expect(snapshot()).toEqual(before);
    await context.fiber.dispose();
  });

  it('clamps an open fit offset and closes transported orientation over a full turn', async () => {
    const { world, context, joints, path, positions } = await rig(16, 0.2);
    const solver = createSplineIKSolver(world, { joints }).unwrap();
    solver.solve(path([0, 0, 0, 0, 0, 8]), { offset: 100, lengthMode: 'fit' }).unwrap();
    world.update(1 / 60).unwrap();
    for (const point of positions()) expect(point[2]).toBeCloseTo(8, 5);
    // Restore the nonsingular base before the next solve.
    solver.restoreBase().unwrap();
    const closed = path([0, 0, 0, 1, 0, 1, 0, 1, 2, -1, 0, 1], true);
    solver
      .solve(closed, { lengthMode: 'fit', offset: closed.length * 0.37, twistEnd: Math.PI * 2 })
      .unwrap();
    world.update(1 / 60).unwrap();
    const first = world.get(joints[0] as EntityHandle, GlobalTransform).unwrap().world;
    const last = world.get(joints[15] as EntityHandle, GlobalTransform).unwrap().world;
    for (let i = 0; i < 16; i++) expect(first[i]).toBeCloseTo(last[i] as number, 4);
    await context.fiber.dispose();
  });

  it('checks curve ancestry for every binding that shares a cached Path', async () => {
    const { world, context, joints } = await rig(4, 0.5);
    const failures: string[] = [];
    const plugin = await startNativePlugin(
      context,
      splineIKPlugin({ onError: (_e, f) => failures.push(f.code) }),
    );
    plugin.unwrap();
    const other = [world.spawn({ component: Transform, data: {} }).unwrap()];
    other.push(
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 1] } },
          { component: ChildOf, data: { parent: other[0] as EntityHandle } },
        )
        .unwrap(),
    );
    const curve = world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent: other[1] as EntityHandle } },
        { component: Path, data: { points: [0, 0, 0, 0, 0, 4] } },
      )
      .unwrap();
    world
      .spawn({
        component: SplineIK,
        data: { root: joints[0] as EntityHandle, tip: joints[3] as EntityHandle, path: curve },
      })
      .unwrap();
    world
      .spawn({
        component: SplineIK,
        data: { root: other[0] as EntityHandle, tip: other[1] as EntityHandle, path: curve },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(failures).toEqual(['spline-ik-conflict']);
    expect(Array.from(world.get(other[1] as EntityHandle, Transform).unwrap().pos)).toEqual([
      0, 0, 1,
    ]);
    await context.fiber.dispose();
  });

  it('loads instance-local chain references through ordinary JSON and restores base each frame', async () => {
    const source: SceneAsset = {
      kind: 'scene',
      entities: {
        curve: {
          components: { Transform: {}, Path: { points: [0, 0, 0, 1, 0, 1, 1, 1, 2, 0, 1, 3] } },
        },
        a: { components: { Transform: {} } },
        b: { components: { Transform: { pos: [0, 0, 1] }, ChildOf: { parent: 'a' } } },
        c: { components: { Transform: { pos: [0, 0, 1] }, ChildOf: { parent: 'b' } } },
        control: { components: { SplineIK: { path: 'curve', root: 'a', tip: 'c', weight: 0.5 } } },
      },
    };
    const world = new World();
    const failures: string[] = [];
    const instanceLease = world.components
      .register(
        defineComponent('SceneInstance', {
          source: 'shared<SceneAsset>',
          mapping: 'array<entity>',
          state: 'unique<SceneInstanceState>',
        }),
      )
      .unwrap();
    const context = await createWorldContext(world, [
      scenePlugin(),
      animationPlugin(undefined, { cadence: 'fixed' }),
      splineIKPlugin({ onError: (_e, f) => failures.push(f.code) }),
    ]);
    const handle = world.allocSharedRef(
      'SceneAsset',
      JSON.parse(JSON.stringify(source)) as SceneAsset,
    );
    worldInstantiateSceneFlat(world, handle).unwrap();
    worldInstantiateSceneFlat(world, handle).unwrap();
    const controllers = Array.from(world.query({ read: [SplineIK] }).unwrap(), (r) => r.entity);
    const config = world.get(controllers[0] as EntityHandle, SplineIK).unwrap();
    if (config.root === null || config.path === null) throw new Error('Missing explicit binding');
    expect(config.root).not.toBe(world.get(controllers[1] as EntityHandle, SplineIK).unwrap().root);
    world.update(1 / 60).unwrap();
    const first = Array.from(world.get(config.root, Transform).unwrap().quat);
    for (let i = 0; i < 60; i++) world.update(1 / 60).unwrap();
    expect(Array.from(world.get(config.root, Transform).unwrap().quat)).toEqual(first);
    world.set(controllers[0] as EntityHandle, SplineIK, { weight: 0 }).unwrap();
    world.update(1 / 60).unwrap();
    expect(Array.from(world.get(config.root, Transform).unwrap().quat)).toEqual([0, 0, 0, 1]);
    world.set(config.path, Path, { points: [0, 0, 0, 0, 0, 8] }).unwrap();
    world.set(controllers[0] as EntityHandle, SplineIK, { weight: 1 }).unwrap();
    world.update(1 / 60).unwrap();
    expect(Array.from(world.get(config.root, Transform).unwrap().quat)).toEqual([0, 0, 0, 1]);
    world.set(controllers[0] as EntityHandle, SplineIK, { enabled: false }).unwrap();
    world.update(1 / 60).unwrap();
    world.set(config.root, Transform, { pos: [2, 0, 0] }).unwrap();
    for (let i = 0; i < 60; i++) world.update(1 / 60).unwrap();
    expect(Array.from(world.get(config.root, Transform).unwrap().pos)).toEqual([2, 0, 0]);
    world.set(controllers[0] as EntityHandle, SplineIK, { enabled: true }).unwrap();
    world.update(1 / 60).unwrap();
    expect(Array.from(world.get(config.root, Transform).unwrap().pos)).toEqual([0, 0, 0]);
    expect(failures).toEqual([]);
    await context.fiber.dispose();
    instanceLease.dispose();
  });

  it('releases a removed Scene chain without attempting stale pose restoration', async () => {
    const { world, context, joints } = await rig(4);
    const failures: string[] = [];
    const installed = (
      await startNativePlugin(
        context,
        splineIKPlugin({ onError: (_entity, failure) => failures.push(failure.code) }),
      )
    ).unwrap();
    const curve = world.spawn({ component: Path, data: { points: [0, 0, 0, 1, 0, 4] } }).unwrap();
    const controller = world
      .spawn({
        component: SplineIK,
        data: { path: curve, root: joints[0] as EntityHandle, tip: joints[3] as EntityHandle },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    // A native PluginAsset can despawn its Scene before the child spline contribution detaches.
    world.despawn(controller).unwrap();
    for (const joint of [...joints].reverse()) world.despawn(joint).unwrap();
    world.despawn(curve).unwrap();
    await installed.dispose();
    expect(failures).toEqual([]);
    await context.fiber.dispose();
  });
});
