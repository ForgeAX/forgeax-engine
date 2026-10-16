import { createWorldContext, defineSystem, Update, World } from '@forgeax/engine-ecs';
import { ChildOf, MorphWeights, Transform } from '@forgeax/engine-scene';
import { type AnimationClip, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  AnimationPlayer,
  AnimationSet,
  AnimationTargetId,
  animationPlugin,
  bindAnimationTargets,
  bindObjectProperty,
  createBlendSpace1D,
  defineAnimationGraph,
  defineAnimationMask,
  deriveAnimationTargetId,
  subscribeAnimationDiagnostics,
} from '../index';

const lowerId = deriveAnimationTargetId(['Rig', 'Lower']);
const upperId = deriveAnimationTargetId(['Rig', 'Upper']);
function clip(lower: number, upper: number): AnimationClip {
  return {
    kind: 'animation-clip',
    duration: 2,
    channels: [
      {
        targetId: lowerId,
        property: 'translation',
        sampler: {
          input: new Float32Array([0]),
          output: new Float32Array([lower, 0, 0]),
          interpolation: 'STEP',
        },
      },
      {
        targetId: upperId,
        property: 'translation',
        sampler: {
          input: new Float32Array([0]),
          output: new Float32Array([upper, 0, 0]),
          interpolation: 'STEP',
        },
      },
    ],
  };
}

async function fixture() {
  const world = new World();
  const clips = new Map([
    ['base', clip(0, 0)],
    ['overlay', clip(10, 10)],
  ]);
  const context = await createWorldContext(world, [animationPlugin((guid) => clips.get(guid))]);
  const upper = defineAnimationMask([{ targetId: upperId, weight: 1 }]).unwrap();
  const mask = world.allocSharedRef('AnimationMask', upper);
  const player = world
    .spawn({
      component: AnimationPlayer,
      data: {
        clips: [
          world.allocSharedRef('AnimationClip', clips.get('base')),
          world.allocSharedRef('AnimationClip', clips.get('overlay')),
        ],
        times: [0, 0],
        speeds: [1, 1],
        weights: [0.25, 0.75],
        masks: [toShared<'AnimationMask'>(0), mask],
      },
    })
    .unwrap();
  const lower = world
    .spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent: player } },
      { component: AnimationTargetId, data: { value: lowerId } },
    )
    .unwrap();
  const target = world
    .spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent: player } },
      { component: AnimationTargetId, data: { value: upperId } },
    )
    .unwrap();
  bindAnimationTargets(world, player, [lower, target]).unwrap();
  return { world, context, player, lower, target, mask };
}

describe('reusable target masks on the ordinary AnimationPlayer path', () => {
  it('keeps lower-body motion separate from an upper-body overlay without splitting clips', async () => {
    const { world, context, player, lower, target, mask } = await fixture();
    const diagnostics: string[] = [];
    const stop = subscribeAnimationDiagnostics((owner, diagnostic) => {
      if (owner === world) diagnostics.push(diagnostic.code);
    });
    try {
      world.sharedRefs.release(toShared<'AnimationMask'>(mask)).unwrap();
      world.update(0.1).unwrap();
      expect(world.get(lower, Transform).unwrap().pos[0]).toBe(0);
      expect(world.get(target, Transform).unwrap().pos[0]).toBeCloseTo(7.5);
      expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual(
        expect.arrayContaining([expect.closeTo(0.1)]),
      );
      expect(diagnostics).not.toContain('animation-channel-missing');
      world.set(player, AnimationPlayer, { masks: [] }).unwrap();
      world.update(0).unwrap();
      expect(world.get(lower, Transform).unwrap().pos[0]).toBeCloseTo(7.5);
      expect(world.sharedRefs.resolve(mask).ok).toBe(false);
    } finally {
      stop();
      await context.fiber.dispose();
    }
  });

  it('multiplies target influence before the existing per-channel normalization', async () => {
    const { world, context, player, lower, target } = await fixture();
    try {
      const mask = world.allocSharedRef(
        'AnimationMask',
        defineAnimationMask([{ targetId: upperId, weight: 0.5 }]).unwrap(),
      );
      world.set(player, AnimationPlayer, { masks: [toShared<'AnimationMask'>(0), mask] }).unwrap();
      world.update(0).unwrap();
      expect(world.get(lower, Transform).unwrap().pos[0]).toBe(0);
      expect(world.get(target, Transform).unwrap().pos[0]).toBeCloseTo(6);
    } finally {
      await context.fiber.dispose();
    }
  });

  it('uses node masks in graph mode and preserves mask identity across repeated updates', async () => {
    const { world, context, player, lower, target, mask } = await fixture();
    try {
      const graph = defineAnimationGraph((b) =>
        b.blend([b.clip('base'), b.clip('overlay')]),
      ).unwrap();
      world
        .set(player, AnimationPlayer, {
          graph: world.allocSharedRef('AnimationGraph', graph),
          nodeWeights: [0.25, 0.75, 1],
          nodeSpeeds: [1, 1, 0],
          nodeMasks: [0, mask],
        })
        .unwrap();
      for (let i = 0; i < 60; i++) world.update(1 / 60).unwrap();
      expect(world.get(lower, Transform).unwrap().pos[0]).toBe(0);
      expect(world.get(target, Transform).unwrap().pos[0]).toBeCloseTo(7.5);
      expect([...world.get(player, AnimationPlayer).unwrap().masks]).toEqual([0, mask]);
      world.set(player, AnimationPlayer, { nodeMasks: [] }).unwrap();
      world.update(0).unwrap();
      expect(world.get(player, AnimationPlayer).unwrap().masks).toHaveLength(0);
      expect(world.get(lower, Transform).unwrap().pos[0]).toBeCloseTo(7.5);
    } finally {
      await context.fiber.dispose();
    }
  });

  it('rejects malformed masks and column lengths before changing clocks or pose', async () => {
    for (const weights of [
      [{ targetId: upperId, weight: Number.NaN }],
      [{ targetId: upperId, weight: -1 }],
      [{ targetId: upperId, weight: 2 }],
      [
        { targetId: upperId, weight: 1 },
        { targetId: upperId, weight: 0 },
      ],
    ]) {
      expect(defineAnimationMask(weights).ok).toBe(false);
    }
    const { world, context, player, target } = await fixture();
    try {
      world.set(player, AnimationPlayer, { masks: [0] }).unwrap();
      const failed = world.update(0.1);
      expect(failed.ok).toBe(false);
      expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([0, 0]);
      expect(world.get(target, Transform).unwrap().pos[0]).toBe(0);
      expect(world.set(player, AnimationPlayer, { masks: [] }).ok).toBe(false);
    } finally {
      await context.fiber.dispose();
    }
  });

  it('lets ordinary TypeScript control weights and normalized phase for different clip lengths', async () => {
    const { world, context, player, target } = await fixture();
    try {
      const movingClip = (duration: number, end: number): AnimationClip => ({
        kind: 'animation-clip',
        duration,
        channels: [
          {
            targetId: upperId,
            property: 'translation',
            sampler: {
              input: new Float32Array([0, duration]),
              output: new Float32Array([0, 0, 0, end, 0, 0]),
              interpolation: 'LINEAR',
            },
          },
        ],
      });
      const short = movingClip(2, 10);
      const long = movingClip(4, 20);
      world
        .set(player, AnimationPlayer, {
          clips: [
            world.allocSharedRef('AnimationClip', short),
            world.allocSharedRef('AnimationClip', long),
          ],
          masks: [],
          speeds: [0, 0],
          looping: false,
        })
        .unwrap();
      const space = createBlendSpace1D([0, 1]).unwrap();
      const weights = new Float32Array(2);
      let speed = 0.25;
      let phase = 0.5;
      world
        .addSystems(Update, AnimationSet, [
          defineSystem({
            name: 'testCodeAnimationControl',
            queries: [],
            before: ['advanceAnimationPlayer'],
            fn() {
              space.sample(weights, speed).unwrap();
              world
                .set(player, AnimationPlayer, {
                  weights,
                  times: [phase * short.duration, phase * long.duration],
                })
                .unwrap();
            },
          }),
        ])
        .unwrap();
      world.update(0).unwrap();
      expect(world.get(target, Transform).unwrap().pos[0]).toBeCloseTo(6.25);
      speed = 0.75;
      phase = 0.25;
      world.update(0).unwrap();
      expect(world.get(target, Transform).unwrap().pos[0]).toBeCloseTo(4.375);
      expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([0.5, 1]);
    } finally {
      await context.fiber.dispose();
    }
  });
  it('applies the same mask influence to morph and native object property channels', async () => {
    const { world, context, player, target } = await fixture();
    try {
      world.addComponent(target, { component: MorphWeights, data: { weights: [0, 0] } }).unwrap();
      const object = { amount: 0 };
      bindObjectProperty(world, player, upperId, 'amount', { object, path: ['amount'] }).unwrap();
      const curves = (value: number): AnimationClip => ({
        kind: 'animation-clip',
        duration: 2,
        channels: [
          {
            targetId: upperId,
            property: 'weights',
            sampler: {
              input: new Float32Array([0]),
              output: new Float32Array([value, value * 2]),
              interpolation: 'STEP',
            },
          },
          {
            targetId: upperId,
            property: 'property',
            binding: 'amount',
            sampler: {
              input: new Float32Array([0]),
              output: new Float32Array([value]),
              interpolation: 'STEP',
            },
          },
        ],
      });
      const half = world.allocSharedRef(
        'AnimationMask',
        defineAnimationMask([{ targetId: upperId, weight: 0.5 }]).unwrap(),
      );
      world
        .set(player, AnimationPlayer, {
          clips: [
            world.allocSharedRef('AnimationClip', curves(0)),
            world.allocSharedRef('AnimationClip', curves(10)),
          ],
          masks: [0, half],
        })
        .unwrap();
      world.update(0).unwrap();
      expect([...world.get(target, MorphWeights).unwrap().weights]).toEqual([6, 12]);
      expect(object.amount).toBeCloseTo(6);
      const empty = world.allocSharedRef('AnimationMask', defineAnimationMask([]).unwrap());
      world.set(player, AnimationPlayer, { masks: [empty, empty] }).unwrap();
      world.update(0.1).unwrap();
      world.update(0.1).unwrap();
      expect(object.amount).toBeCloseTo(6);
      expect([...world.get(target, MorphWeights).unwrap().weights]).toEqual([6, 12]);
      expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([
        expect.closeTo(0.2),
        expect.closeTo(0.2),
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });

  it('rejects a mask attached to a composition node before graph clocks or derived slots change', async () => {
    const { world, context, player, target, mask } = await fixture();
    try {
      const graph = defineAnimationGraph((b) =>
        b.blend([b.clip('base'), b.clip('overlay')]),
      ).unwrap();
      world
        .set(player, AnimationPlayer, {
          graph: world.allocSharedRef('AnimationGraph', graph),
          nodeTimes: [0, 0, 0],
          nodeSpeeds: [1, 1, 0],
          nodeMasks: [0, 0, mask],
        })
        .unwrap();
      expect(world.update(0.2).ok).toBe(false);
      expect([...world.get(player, AnimationPlayer).unwrap().nodeTimes]).toEqual([0, 0, 0]);
      expect([...world.get(player, AnimationPlayer).unwrap().times]).toEqual([0, 0]);
      expect(world.get(target, Transform).unwrap().pos[0]).toBe(0);
    } finally {
      await context.fiber.dispose();
    }
  });
});
