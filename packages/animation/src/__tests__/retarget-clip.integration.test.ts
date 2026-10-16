import { createWorldContext, type EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTargetIdValue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  AnimationPlayer,
  AnimationTargetId,
  animationPlugin,
  bindAnimationTargets,
  createSkeletonRetargeter,
  deriveAnimationTargetId,
  retargetAnimationClip,
} from '../index';

async function fixture() {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin(), animationPlugin()]);
  const chain = (prefix: string, length: number, x: number) => {
    const joints: EntityHandle[] = [];
    for (let i = 0; i < 3; i++) {
      const rotation = quat.fromEuler(
        quat.create(),
        0.15 * i,
        prefix === 'Target' ? 0.3 : -0.2,
        0.1,
        'XYZ',
      );
      joints.push(
        world
          .spawn(
            {
              component: Transform,
              data: { pos: i === 0 ? [x, 0, 0] : [length, 0, 0], quat: rotation },
            },
            {
              component: AnimationTargetId,
              data: { value: deriveAnimationTargetId([prefix, String(i)]) },
            },
            ...(i === 0
              ? []
              : [{ component: ChildOf, data: { parent: joints[i - 1] as EntityHandle } }]),
          )
          .unwrap(),
      );
    }
    return joints;
  };
  const source = chain('Source', 1, -3) as [EntityHandle, EntityHandle, EntityHandle];
  const target = chain('Target', 1.7, 4) as [EntityHandle, EntityHandle, EntityHandle];
  const pairs = source.map((joint, i) => ({ source: joint, target: target[i] as EntityHandle }));
  const sourceIds = [0, 1, 2].map((i) => deriveAnimationTargetId(['Source', String(i)]));
  const targetIds = [0, 1, 2].map((i) => deriveAnimationTargetId(['Target', String(i)]));
  const rootRest = world.get(source[0] as EntityHandle, Transform).unwrap();
  const middleRest = world.get(source[1] as EntityHandle, Transform).unwrap();
  const endRotation = quat.fromEuler(quat.create(), 0.7, 0.35, -0.6, 'XYZ');
  const clip = {
    kind: 'animation-clip',
    duration: 1.13,
    channels: [
      {
        targetId: sourceIds[0] as AnimationTargetIdValue,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 0.37, 1.13]),
          output: new Float32Array([-3, 0, 0, -2.6, 0.2, 0.1, -2.1, 0.1, 0.4]),
          interpolation: 'LINEAR',
        },
      },
      {
        targetId: sourceIds[1] as AnimationTargetIdValue,
        property: 'rotation',
        sampler: {
          input: new Float32Array([0, 1.13]),
          output: new Float32Array([...middleRest.quat, ...endRotation]),
          interpolation: 'LINEAR',
        },
      },
    ] as const,
  } satisfies AnimationClip;
  const player = source[0] as EntityHandle;
  world
    .addComponent(player, {
      component: AnimationPlayer,
      data: {
        clips: [world.allocSharedRef('AnimationClip', clip)],
        times: [0],
        weights: [1],
        speeds: [0],
        paused: true,
        looping: false,
      },
    })
    .unwrap();
  bindAnimationTargets(world, player, source).unwrap();
  return { world, context, source, target, pairs, clip, player, sourceIds, targetIds, rootRest };
}

// Compare independently evaluated live AnimationPlayer+retarget against baked AnimationPlayer.
// Tolerances precede implementation measurements: 0.002 radians, 1e-5 translation.
describe('ordinary retargeted clips', () => {
  it('bakes cubic tangents through the shared sampler without changing the live pose', async () => {
    const { world, target, source, pairs, clip, player } = await fixture();
    const cubic = {
      kind: 'animation-clip',
      duration: 2,
      channels: [
        {
          ...clip.channels[0],
          sampler: {
            input: new Float32Array([0, 2]),
            output: new Float32Array([0, 0, 0, -3, 0, 0, 0.3, 0, 0, -0.3, 0, 0, -3, 0, 0, 0, 0, 0]),
            interpolation: 'CUBICSPLINE',
          },
        },
        {
          ...clip.channels[1],
          sampler: {
            input: new Float32Array([0, 2]),
            output: new Float32Array([
              0,
              0,
              0,
              0,
              ...clip.channels[1].sampler.output.subarray(0, 4),
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              ...clip.channels[1].sampler.output.subarray(4, 8),
              0,
              0,
              0,
              0,
            ]),
            interpolation: 'CUBICSPLINE',
          },
        },
      ] as const,
    } satisfies AnimationClip;
    const sourceBefore = [...world.get(source[0], Transform).unwrap().pos];
    const read = () =>
      target.map((joint) => {
        const pose = world.get(joint, Transform).unwrap();
        return { pos: [...pose.pos], quat: [...pose.quat], scale: [...pose.scale] };
      });
    const before = read();
    const runtime = createSkeletonRetargeter(world, { pairs, rootTranslationScale: 1.7 }).unwrap();
    // Keep the existing 1e-5 translation / 0.002 radian comparison bounds.
    // A 120 Hz requested bake bounds this fixture's linearized cubic segment.
    const baked = retargetAnimationClip(world, {
      pairs,
      clip: cubic,
      fps: 120,
      rootTranslationScale: 1.7,
    }).unwrap();
    expect(read()).toEqual(before);
    expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([0]);
    expect([...world.get(source[0], Transform).unwrap().pos]).toEqual(sourceBefore);
    expect(baked.channels.every((channel) => channel.sampler.interpolation === 'LINEAR')).toBe(
      true,
    );
    const targetPlayer = target[0];
    world
      .addComponent(targetPlayer, {
        component: AnimationPlayer,
        data: {
          clips: [world.allocSharedRef('AnimationClip', baked)],
          times: [0],
          weights: [0],
          speeds: [0],
          paused: true,
          looping: false,
        },
      })
      .unwrap();
    bindAnimationTargets(world, targetPlayer, target).unwrap();
    world
      .set(player, AnimationPlayer, { clips: [world.allocSharedRef('AnimationClip', cubic)] })
      .unwrap();
    for (const time of [0, 0.009, 0.139, 0.371, 0.593, 0.999, 1.731, 2]) {
      world.set(player, AnimationPlayer, { times: [time] }).unwrap();
      world.set(targetPlayer, AnimationPlayer, { weights: [0] }).unwrap();
      world.update(0).unwrap();
      const u = time / 2;
      expect(world.get(source[0], Transform).unwrap().pos[0]).toBeCloseTo(
        -3 + 0.6 * u * (1 - u),
        6,
      );
      runtime.retarget().unwrap();
      const expected = read();
      world.set(targetPlayer, AnimationPlayer, { weights: [1], times: [time] }).unwrap();
      world.update(0).unwrap();
      for (const [i, actual] of read().entries()) {
        const reference = expected[i] as (typeof expected)[number];
        for (let axis = 0; axis < 3; axis++)
          expect(actual.pos[axis]).toBeCloseTo(reference.pos[axis] as number, 5);
        const dot = Math.abs(
          actual.quat.reduce((sum, value, j) => sum + value * (reference.quat[j] as number), 0),
        );
        expect(2 * Math.acos(Math.min(1, dot))).toBeLessThan(0.002);
      }
    }
    const nonfinite = cubic.channels[0].sampler.output.slice();
    nonfinite[0] = Number.NaN;
    const malformed: AnimationClip = {
      ...cubic,
      channels: [
        { ...cubic.channels[0], sampler: { ...cubic.channels[0].sampler, output: nonfinite } },
      ],
    };
    expect(retargetAnimationClip(world, { pairs, clip: malformed, fps: 120 }).ok).toBe(false);
    const smooth: AnimationClip = {
      ...cubic,
      channels: [cubic.channels[0], clip.channels[1]],
    };
    expect(
      retargetAnimationClip(world, { pairs, clip: smooth, fps: 120 })
        .unwrap()
        .channels.every((channel) => channel.sampler.interpolation === 'LINEAR'),
    ).toBe(true);
    const mixed: AnimationClip = {
      ...cubic,
      channels: [
        cubic.channels[0],
        { ...clip.channels[1], sampler: { ...clip.channels[1].sampler, interpolation: 'STEP' } },
      ],
    };
    expect(retargetAnimationClip(world, { pairs, clip: mixed, fps: 120 }).ok).toBe(false);
  });

  it('matches runtime on grid and non-key times, includes exact end, and preserves live state', async () => {
    const { world, target, source, pairs, clip, player } = await fixture();
    const read = (joints: EntityHandle[]) =>
      joints.map((joint) => {
        const t = world.get(joint, Transform).unwrap();
        return { pos: [...t.pos], quat: [...t.quat], scale: [...t.scale] };
      });
    const before = read([...source, ...target]);
    const runtime = createSkeletonRetargeter(world, { pairs, rootTranslationScale: 1.7 }).unwrap();
    const baked = retargetAnimationClip(world, {
      pairs,
      clip,
      fps: 60,
      rootTranslationScale: 1.7,
    }).unwrap();
    expect(read([...source, ...target])).toEqual(before);
    expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([0]);
    expect(baked.channels).toHaveLength(9);
    expect(baked.duration).toBe(clip.duration);
    expect(baked.channels[0]?.sampler.input.at(-1)).toBeCloseTo(clip.duration, 6);
    const targetPlayer = target[0] as EntityHandle;
    world
      .addComponent(targetPlayer, {
        component: AnimationPlayer,
        data: {
          clips: [world.allocSharedRef('AnimationClip', baked)],
          times: [0],
          weights: [1],
          speeds: [0],
          paused: true,
          looping: false,
        },
      })
      .unwrap();
    bindAnimationTargets(world, targetPlayer, target).unwrap();
    for (const time of [0, 0.009, 0.139, 0.371, 0.593, 0.999, 1.13]) {
      world.set(player, AnimationPlayer, { times: [time] }).unwrap();
      world.set(targetPlayer, AnimationPlayer, { weights: [0] }).unwrap();
      world.update(0).unwrap();
      runtime.retarget().unwrap();
      const expected = read(target);
      // Repeat proves root motion is assigned, not added to last frame.
      runtime.retarget().unwrap();
      expect(read(target)).toEqual(expected);
      world.set(targetPlayer, AnimationPlayer, { weights: [1], times: [time] }).unwrap();
      world.update(0).unwrap();
      const actual = read(target);
      for (let i = 0; i < target.length; i++) {
        const a = actual[i] as (typeof actual)[number];
        const b = expected[i] as (typeof expected)[number];
        const dot = Math.abs(a.quat.reduce((sum, v, j) => sum + v * (b.quat[j] as number), 0));
        expect(2 * Math.acos(Math.min(1, dot))).toBeLessThan(0.002);
        for (let axis = 0; axis < 3; axis++)
          expect(a.pos[axis]).toBeCloseTo(b.pos[axis] as number, 5);
        expect(a.scale).toEqual(b.scale);
      }
    }
  });

  it('preserves target translation without root transfer; supports zero duration and STEP seams', async () => {
    const { world, target, pairs, clip } = await fixture();
    const baked = retargetAnimationClip(world, { pairs, clip, fps: 24 }).unwrap();
    const root = baked.channels[0]?.sampler.output as Float32Array;
    for (let i = 0; i < root.length; i += 3) expect(root[i]).toBe(4);
    const step: AnimationClip = {
      ...clip,
      channels: clip.channels.map((channel) => ({
        ...channel,
        sampler: { ...channel.sampler, interpolation: 'STEP' },
      })),
    };
    const result = retargetAnimationClip(world, { pairs, clip: step, fps: 30 }).unwrap();
    expect(result.channels.every((channel) => channel.sampler.interpolation === 'STEP')).toBe(true);
    expect([...(result.channels[0]?.sampler.input as Float32Array)]).toContain(
      step.channels[0]?.sampler.input[1],
    );
    const still: AnimationClip = { kind: 'animation-clip', duration: 0, channels: [] };
    expect(
      retargetAnimationClip(world, { pairs, clip: still, fps: 30 }).unwrap().channels[0]?.sampler
        .input.length,
    ).toBe(1);
    expect(world.get(target[0] as EntityHandle, Transform).unwrap().pos[0]).toBe(4);
  });

  it('rejects malformed/mixed channels, bounds memory, and allows corrected retries without writes', async () => {
    const { world, source, pairs, clip } = await fixture();
    const before = [...world.get(source[1] as EntityHandle, Transform).unwrap().quat];
    for (const fps of [0, Number.NaN, 1001])
      expect(retargetAnimationClip(world, { pairs, clip, fps }).ok).toBe(false);
    expect(
      retargetAnimationClip(world, { pairs, clip: { ...clip, duration: 10000 }, fps: 60 }).ok,
    ).toBe(false);
    const invalid: AnimationClip = { ...clip, channels: [clip.channels[0], clip.channels[0]] };
    expect(retargetAnimationClip(world, { pairs, clip: invalid, fps: 60 }).ok).toBe(false);
    const mixed: AnimationClip = {
      ...clip,
      channels: clip.channels.map((c, i) => ({
        ...c,
        sampler: {
          ...c.sampler,
          interpolation: i === 0 ? 'STEP' : 'LINEAR',
        },
      })),
    };
    expect(retargetAnimationClip(world, { pairs, clip: mixed, fps: 60 }).ok).toBe(false);
    const bad: AnimationClip = {
      ...clip,
      channels: [
        {
          ...clip.channels[0],
          sampler: {
            ...clip.channels[0].sampler,
            input: new Float32Array([0, 0]),
          },
        },
      ],
    };
    expect(retargetAnimationClip(world, { pairs, clip: bad, fps: 60 }).ok).toBe(false);
    expect([...world.get(source[1] as EntityHandle, Transform).unwrap().quat]).toEqual(before);
    expect(retargetAnimationClip(world, { pairs, clip, fps: 60 }).ok).toBe(true);
  });
});

it('preserves root motion through changing blend slots, loop wrap and retarget-before-IK scheduling', async () => {
  const { defineSystem, Update } = await import('@forgeax/engine-ecs');
  const { AnimationSet, createIKSolver } = await import('../index');
  const { GlobalTransform } = await import('@forgeax/engine-scene');
  const { world, source, target, pairs, clip, player } = await fixture();
  const retarget = createSkeletonRetargeter(world, { pairs, rootTranslationScale: 1.7 }).unwrap();
  const ik = createIKSolver(world, {
    joints: target,
    maxIterations: 128,
    tolerance: 1e-3,
  }).unwrap();
  const neutral = {
    ...clip,
    channels: [clip.channels[0]].map((channel) => ({
      ...channel,
      sampler: { ...channel.sampler, output: new Float32Array([-3, 0, 0, -3, 0, 0, -3, 0, 0]) },
    })),
  };
  const movingHandle = world.allocSharedRef('AnimationClip', clip);
  const neutralHandle = world.allocSharedRef('AnimationClip', neutral);
  let expectedX = 4;
  let residual = 0;
  let goal = [0, 0, 0];
  world
    .addSystems(Update, AnimationSet, [
      defineSystem({
        name: 'retargetThenIK',
        queries: [],
        after: ['advanceAnimationPlayer'],
        before: ['propagateTransforms'],
        fn() {
          const sourceX = world.get(source[0], Transform).unwrap().pos[0] as number;
          expectedX = 4 + (sourceX + 3) * 1.7;
          retarget.retarget().unwrap();
          goal = [expectedX + 1, 1, 0.3];
          residual = ik.solve(goal).unwrap().error;
        },
      }),
    ])
    .unwrap();
  for (const weight of [0, 0.25, 0.5, 1, 0.5, 0]) {
    world
      .set(player, AnimationPlayer, {
        clips: [movingHandle, neutralHandle],
        times: [0.37, 0.37],
        weights: [weight, 1 - weight],
        speeds: [1, 1],
        looping: true,
        paused: false,
      })
      .unwrap();
    world.update(0).unwrap();
    expect(world.get(target[0], Transform).unwrap().pos[0]).toBeCloseTo(expectedX, 5);
    expect(residual).toBeLessThan(1e-3);
    const tip = world.get(target[2], GlobalTransform).unwrap().world;
    expect(
      Math.hypot(
        (tip[12] as number) - (goal[0] as number),
        (tip[13] as number) - (goal[1] as number),
        (tip[14] as number) - (goal[2] as number),
      ),
    ).toBeLessThan(1e-3);
  }
  world.set(player, AnimationPlayer, { times: [1.12, 1.12], weights: [1, 0] }).unwrap();
  world.update(0.02).unwrap();
  expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBeCloseTo(0.01, 5);
  expect(world.get(target[0], Transform).unwrap().pos[0]).toBeCloseTo(expectedX, 5);
});

it('rejects derived root-motion overflow before changing any target joint', async () => {
  const { world, source, target, pairs } = await fixture();
  const retarget = createSkeletonRetargeter(world, { pairs, rootTranslationScale: 1e308 }).unwrap();
  const before = target.map((joint) => {
    const value = world.get(joint, Transform).unwrap();
    return { pos: [...value.pos], quat: [...value.quat] };
  });
  world
    .set(source[0], Transform, { pos: [1, 0, 0], quat: [0, 0, Math.SQRT1_2, Math.SQRT1_2] })
    .unwrap();
  expect(retarget.retarget().ok).toBe(false);
  expect(
    target.map((joint) => {
      const value = world.get(joint, Transform).unwrap();
      return { pos: [...value.pos], quat: [...value.quat] };
    }),
  ).toEqual(before);
});
