import { createWorldContext, type EntityHandle, FixedTime, World } from '@forgeax/engine-ecs';
import { ChildOf, Name, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { AnimationTargetIdValue } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  AnimationPlayer,
  AnimationTargetId,
  animationPlugin,
  bindAnimationTargets,
} from '../index';
import {
  bindSkeletalMotion,
  type SkeletalMotionBinding,
  skeletalMotionPlugin,
  skeletalMotionWriterEntities,
} from '../skeletal-motion';
import { SkeletonPose } from '../skeleton-pose';

const scenarios = [
  'static',
  'moving-root',
  'teleport-reset',
  'weight-switch',
  'zero-delta',
  'scaled-rotated-parent',
  'parented-contact',
  'sibling-subtree-contact',
] as const;
type Scenario = (typeof scenarios)[number] | 'root-contact' | 'descendant-contact';

async function sample(length: number, scenario: Scenario, translation: number) {
  const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 } });
  const context = await createWorldContext(world, [
    scenePlugin(),
    animationPlugin({ cadence: 'fixed' }),
    skeletalMotionPlugin({ physics: false }),
  ]);
  let binding: SkeletalMotionBinding | undefined;
  try {
    const parent = world
      .spawn({
        component: Transform,
        data: {
          pos: [translation, 4, 0],
          quat:
            scenario === 'scaled-rotated-parent'
              ? [0, Math.SQRT1_2, 0, Math.SQRT1_2]
              : [0, 0, 0, 1],
          scale: scenario === 'scaled-rotated-parent' ? [1.5, 1.5, 1.5] : [1, 1, 1],
        },
      })
      .unwrap();
    const player = world
      .spawn(
        { component: Transform, data: {} },
        { component: Name, data: { value: 'translated-character' } },
        { component: AnimationPlayer, data: {} },
        { component: ChildOf, data: { parent } },
      )
      .unwrap();
    const joints: EntityHandle[] = [];
    for (let i = 0; i <= length; i++)
      joints.push(
        world
          .spawn(
            { component: Transform, data: { pos: [i === 0 ? 0 : 0.25, 0, 0] } },
            { component: Name, data: { value: `joint${i}` } },
            {
              component: ChildOf,
              data: { parent: i === 0 ? player : (joints[i - 1] as EntityHandle) },
            },
          )
          .unwrap(),
      );
    const contactParent =
      scenario === 'sibling-subtree-contact'
        ? world
            .spawn(
              { component: Transform, data: { pos: [0.125, 0, 0] } },
              { component: Name, data: { value: 'contact-branch' } },
              { component: ChildOf, data: { parent: player } },
            )
            .unwrap()
        : scenario === 'descendant-contact'
          ? (joints[Math.floor(length / 2)] as EntityHandle)
          : player;
    const contact =
      scenario === 'root-contact'
        ? joints[0]
        : scenario.endsWith('contact')
          ? world
              .spawn(
                { component: Transform, data: {} },
                { component: Name, data: { value: 'contact' } },
                { component: ChildOf, data: { parent: contactParent } },
              )
              .unwrap()
          : undefined;
    bindAnimationTargets(world, player, [
      ...joints,
      ...(contact === undefined || joints.includes(contact) ? [] : [contact]),
    ]).unwrap();
    binding = bindSkeletalMotion(world, player, {
      springs: [
        {
          targets: joints.map(
            (joint) => world.get(joint, AnimationTargetId).unwrap().value as AnimationTargetIdValue,
          ),
          stiffness: 30,
          damping: 6,
          gravity: [0, -9.81, 0],
          radius: 0.02,
          maxAngle: 1.8,
          ...(contact === undefined
            ? {}
            : {
                collisions: [
                  {
                    target: world.get(contact, AnimationTargetId).unwrap()
                      .value as AnimationTargetIdValue,
                    center: [0.2, 0, 0] as const,
                    radius: 0.1,
                  },
                ],
                iterations: 12,
              }),
        },
      ],
    }).unwrap();
    const trace: number[][][] = [];
    for (let tick = 0; tick < 100; tick++) {
      const moving = scenario === 'moving-root' || scenario === 'sibling-subtree-contact';
      const offset = moving
        ? ((Math.floor(tick / 5) % 9) - 4) * 0.25
        : scenario === 'teleport-reset' && tick >= 50
          ? 64
          : 0;
      world.set(parent, Transform, { pos: [translation + offset, 4, 0] }).unwrap();
      if (scenario === 'sibling-subtree-contact' && contact !== undefined)
        world
          .set(contact, Transform, { pos: [((Math.floor(tick / 10) % 3) - 1) * 0.25, 0, 0] })
          .unwrap();
      if (scenario === 'teleport-reset' && tick === 50) binding.reset();
      const weight =
        scenario === 'weight-switch' ? (tick < 30 ? 1 : tick < 50 ? 0 : tick < 70 ? 0.5 : 1) : 1;
      binding.setSpringWeight(0, weight).unwrap();
      world.update(1 / 60).unwrap();
      expect(binding.failure).toBeUndefined();
      expect(binding.springEvidence[0]?.lengthError).toBeLessThanOrEqual(1e-4);
      const rotations = joints.map((joint) => [...world.get(joint, Transform).unwrap().quat]);
      trace.push(rotations);
      if (scenario === 'zero-delta' && tick === 50) {
        const fixedTick = world.getResource(FixedTime).tick;
        world.update(0).unwrap();
        expect(world.getResource(FixedTime).tick).toBe(fixedTick);
        expect(joints.map((joint) => [...world.get(joint, Transform).unwrap().quat])).toEqual(
          rotations,
        );
      }
    }
    expect(world.getResource(FixedTime).tick).toBe(100);
    expect(binding.fixedSteps).toBe(100);
    return trace;
  } finally {
    binding?.dispose();
    await context.fiber.dispose();
    expect(skeletalMotionWriterEntities(world)).toEqual([]);
  }
}

describe.each([4, 32])('spring translation invariance with %i segments', (length) => {
  it.each(
    scenarios,
  )('keeps local rotations under constant world translation: %s', async (scenario) => {
    const near = await sample(length, scenario, 0);
    const translated = await sample(length, scenario, 2997);
    for (let tick = 0; tick < near.length; tick++) {
      const nearTick = near[tick] as number[][];
      const translatedTick = translated[tick] as number[][];
      for (let joint = 0; joint < nearTick.length; joint++) {
        const a = nearTick[joint] as number[];
        const b = translatedTick[joint] as number[];
        const dot = Math.abs(a.reduce((value, q, i) => value + q * (b[i] as number), 0));
        const norm = Math.hypot(...a) * Math.hypot(...b);
        expect(2 * Math.acos(Math.min(1, dot / norm))).toBeLessThanOrEqual(1e-4);
      }
    }
  });
});

describe.each([4, 32])('contact pose projection with %i segments', (length) => {
  it.each([
    'root-contact',
    'parented-contact',
    'sibling-subtree-contact',
    'descendant-contact',
  ] as const)('matches complete pose recomputation for %s', async (scenario) => {
    const bounded = await sample(length, scenario, 2997);
    const update = SkeletonPose.prototype.update;
    const reference = vi.spyOn(SkeletonPose.prototype, 'update').mockImplementation(function (
      this: SkeletonPose,
      start: number,
      _end?: number,
      origin?: Parameters<SkeletonPose['update']>[2],
    ) {
      update.call(this, start, undefined, origin);
    });
    try {
      expect(bounded).toEqual(await sample(length, scenario, 2997));
    } finally {
      reference.mockRestore();
    }
  });
});
