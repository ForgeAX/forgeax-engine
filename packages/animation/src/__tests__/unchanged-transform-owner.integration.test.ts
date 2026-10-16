import { World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { AnimationTargetId, bindAnimationTargets } from '../animation-target';
import { advanceAnimationPlayer } from '../systems/advance-animation-player';
import { deriveAnimationTargetId } from '../target-id';
import { drainAnimationEvents } from '../timeline';

function fixture(values = [0.1, 0.2, 0.3]) {
  const world = new World();
  const targetId = deriveAnimationTargetId(['Root', 'Joint']);
  const clip: AnimationClip = {
    kind: 'animation-clip',
    duration: 1,
    events: [{ time: 0.5, targetId, action: { kind: 'method', name: 'cue', args: [] } }],
    channels: [
      {
        targetId,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([...values, ...values]),
          interpolation: 'LINEAR',
        },
      },
    ],
  };
  const handle = world.allocSharedRef('AnimationClip', clip);
  const player = world
    .spawn({
      component: AnimationPlayer,
      data: {
        clips: [handle],
        times: [0],
        speeds: [1],
        weights: [1],
        looping: false,
      },
    })
    .unwrap();
  const target = world
    .spawn(
      { component: Transform, data: {} },
      { component: AnimationTargetId, data: { value: targetId } },
      { component: ChildOf, data: { parent: player } },
    )
    .unwrap();
  bindAnimationTargets(world, player, [target]).unwrap();
  const writes = vi.spyOn(world, 'set');
  const targetWrites = () =>
    writes.mock.calls.filter(([entity, component]) => entity === target && component === Transform);
  return { world, player, target, writes, targetWrites, clip, handle };
}

describe('animation owns only changed f32 Transform submissions', () => {
  it('keeps clocks and timeline events advancing while a constant pose publishes no repeated writes', () => {
    const { world, player, target, writes, targetWrites } = fixture();
    advanceAnimationPlayer(world, 0.25);
    expect(targetWrites()).toHaveLength(1);
    const changes = world.query({ changed: [Transform] }).unwrap();
    Array.from(changes);
    writes.mockClear();
    advanceAnimationPlayer(world, 0.5);
    expect(targetWrites()).toHaveLength(0);
    expect(Array.from(changes)).toHaveLength(0);
    expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBe(0.75);
    expect(drainAnimationEvents(world, player)).toHaveLength(1);
    expect(Array.from(world.get(target, Transform).unwrap().pos)).toEqual(
      [0.1, 0.2, 0.3].map(Math.fround),
    );
  });

  it('compares current destination columns and restores external writes without touching unauthored fields', () => {
    const { world, player, target, writes, targetWrites } = fixture();
    advanceAnimationPlayer(world, 0.25);
    world.set(player, AnimationPlayer, { paused: true }).unwrap();
    world.set(target, Transform, { pos: [9, 8, 7], scale: [2, 3, 4] }).unwrap();
    writes.mockClear();
    advanceAnimationPlayer(world, 0.5);
    expect(targetWrites()).toHaveLength(1);
    expect(Object.keys(targetWrites()[0]?.[2] ?? {})).toEqual(['pos']);
    const pose = world.get(target, Transform).unwrap();
    expect(Array.from(pose.pos)).toEqual([0.1, 0.2, 0.3].map(Math.fround));
    expect(Array.from(pose.scale)).toEqual([2, 3, 4]);
    expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBe(0.25);
  });

  it('suppresses unchanged blended results after destination f32 rounding', () => {
    const { world, player, clip, handle, targetWrites, writes } = fixture();
    const second = world.allocSharedRef('AnimationClip', {
      ...clip,
      channels: clip.channels.map((channel) => ({
        ...channel,
        sampler: {
          ...channel.sampler,
          output: new Float32Array([0.3, 0.4, 0.5, 0.3, 0.4, 0.5]),
        },
      })),
    });
    world
      .set(player, AnimationPlayer, {
        clips: [handle, second],
        times: [0, 0],
        speeds: [0, 0],
        weights: [1, 1],
      })
      .unwrap();
    advanceAnimationPlayer(world, 0);
    expect(targetWrites()).toHaveLength(1);
    writes.mockClear();
    advanceAnimationPlayer(world, 0);
    expect(targetWrites()).toHaveLength(0);
  });

  it('preserves the signed zero destination', () => {
    const { world, target, writes, targetWrites } = fixture([0, 0, 0]);
    world.set(target, Transform, { pos: [-0, 0, 0] }).unwrap();
    writes.mockClear();
    advanceAnimationPlayer(world, 0.25);
    expect(targetWrites()).toHaveLength(1);
    expect(Object.is(world.get(target, Transform).unwrap().pos[0], 0)).toBe(true);
    writes.mockClear();
    advanceAnimationPlayer(world, 0.25);
    expect(targetWrites()).toHaveLength(0);
  });

  it('retains explicit writes for non-finite samples instead of treating NaN as an unchanged pose', () => {
    const { world, targetWrites } = fixture([NaN, 0, 0]);
    advanceAnimationPlayer(world, 0.25);
    advanceAnimationPlayer(world, 0.25);
    expect(targetWrites()).toHaveLength(2);
  });
});
