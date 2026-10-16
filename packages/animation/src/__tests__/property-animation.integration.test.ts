import { createWorldContext, defineComponent, World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  AnimationPlayer,
  animationPlugin,
  bindComponentProperty,
  bindObjectProperty,
  deriveAnimationTargetId,
} from '../index';

const id = deriveAnimationTargetId(['Object']);
const Controls = defineComponent('PropertyAnimationControls', {
  amount: 'f32',
  enabled: 'bool',
  label: 'string',
  color: 'array<f32, 3>',
});

describe('property animation through the player clock', () => {
  it('animates component scalars, arrays, booleans and strings without Transform', async () => {
    const world = new World();
    const context = await createWorldContext(world, [animationPlugin()]);
    const target = world.spawn({ component: Controls, data: { color: [0, 0, 0] } }).unwrap();
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [
        {
          targetId: id,
          property: 'property',
          binding: 'amount',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 8]),
            interpolation: 'LINEAR',
          },
        },
        {
          targetId: id,
          property: 'property',
          binding: 'color',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 0, 1, 0.5, 0.25]),
            interpolation: 'LINEAR',
          },
        },
        {
          targetId: id,
          property: 'property',
          binding: 'enabled',
          sampler: {
            input: new Float32Array([0, 1]),
            output: [false, true],
            interpolation: 'STEP',
          },
        },
        {
          targetId: id,
          property: 'property',
          binding: 'label',
          sampler: {
            input: new Float32Array([0, 1]),
            output: ['idle', 'done'],
            interpolation: 'STEP',
          },
        },
      ],
    };
    const player = world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [world.allocSharedRef('AnimationClip', clip)],
          times: [0],
          weights: [1],
          speeds: [1],
          looping: false,
        },
      })
      .unwrap();
    for (const field of ['amount', 'color', 'enabled', 'label'] as const) {
      bindComponentProperty(world, player, id, field, {
        entity: target,
        component: Controls,
        field,
      }).unwrap();
    }
    for (let i = 0; i < 5; i++) world.update(0.1).unwrap();
    expect(world.get(target, Controls).unwrap().amount).toBeCloseTo(4);
    expect([...world.get(target, Controls).unwrap().color]).toEqual([0.5, 0.25, 0.125]);
    expect(world.get(target, Controls).unwrap().label).toBe('idle');
    world.set(player, AnimationPlayer, { paused: true }).unwrap();
    for (let i = 0; i < 5; i++) world.update(0.1).unwrap();
    expect(world.get(target, Controls).unwrap().amount).toBeCloseTo(4);
    world.set(player, AnimationPlayer, { paused: false }).unwrap();
    for (let i = 0; i < 5; i++) world.update(0.1).unwrap();
    expect(world.get(target, Controls).unwrap().enabled).toBe(true);
    expect(world.get(target, Controls).unwrap().label).toBe('done');
    await context.fiber.restart();
  });

  it('binds nested native objects once, blends, and disposes without affecting another World', async () => {
    const world = new World();
    await createWorldContext(world, [animationPlugin()]);
    const object = { material: { opacity: 0 } };
    const clip = (value: number): AnimationClip => ({
      kind: 'animation-clip',
      duration: 1,
      channels: [
        {
          targetId: id,
          property: 'property',
          binding: 'opacity',
          sampler: {
            input: new Float32Array([0]),
            output: new Float32Array([value]),
            interpolation: 'LINEAR',
          },
        },
      ],
    });
    const player = world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [
            world.allocSharedRef('AnimationClip', clip(2)),
            world.allocSharedRef('AnimationClip', clip(6)),
          ],
          times: [0, 0],
          weights: [1, 3],
          speeds: [0, 0],
        },
      })
      .unwrap();
    const dispose = bindObjectProperty(world, player, id, 'opacity', {
      object,
      path: ['material', 'opacity'],
    }).unwrap();
    world.update(0).unwrap();
    expect(object.material.opacity).toBe(5);
    dispose();
    object.material.opacity = 7;
    world.update(0).unwrap();
    expect(object.material.opacity).toBe(7);
  });
});
