import type { EntityHandle } from '@forgeax/engine-ecs';
import { createWorldContext, Entity, World } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTargetIdValue, Handle } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import {
  AnimatedBy,
  AnimationTargetId,
  AnimationTargets,
  bindAnimationTargets,
} from '../animation-target';
import { animationPlugin } from '../plugin';

const TARGET_ID = 'a95da0ec669189f98273e8f86d8ad9f2' as AnimationTargetIdValue;

function clip(targetId = TARGET_ID): AnimationClip {
  return {
    kind: 'animation-clip',
    duration: 1,
    channels: [
      {
        targetId,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([0, 0, 0, 10, 0, 0]),
          interpolation: 'LINEAR',
        },
      },
    ],
  };
}

async function spawnPair(world: World, clipHandle: Handle<'AnimationClip', 'shared'>) {
  const player = world
    .spawn({
      component: Transform,
      data: {},
    })
    .unwrap() as EntityHandle;
  world
    .addComponent(player, {
      component: AnimationPlayer,
      data: { clips: [clipHandle], times: [0], weights: [1], speeds: [1], looping: false },
    })
    .unwrap();
  const target = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
  world.addComponent(target, { component: ChildOf, data: { parent: player } }).unwrap();
  world.addComponent(target, { component: AnimationTargetId, data: { value: TARGET_ID } }).unwrap();
  expect(bindAnimationTargets(world, player, [target]).ok).toBe(true);
  return { player, target };
}

describe('animation target isolation and lifecycle', () => {
  it('skips five malformed targets or channels while a valid sibling player continues', async () => {
    const world = new World();
    await createWorldContext(world, [animationPlugin()]);
    const clipHandle = world.allocSharedRef('AnimationClip', clip());
    const valid = await spawnPair(world, clipHandle);

    await spawnPair(
      world,
      world.allocSharedRef('AnimationClip', clip('00000000000000000000000000000000' as never)),
    );

    const noTransform = await spawnPair(world, clipHandle);
    world.removeComponent(noTransform.target, Transform).unwrap();

    const duplicate = await spawnPair(world, clipHandle);
    const duplicateTarget = world
      .spawn({ component: Transform, data: {} })
      .unwrap() as EntityHandle;
    world
      .addComponent(duplicateTarget, { component: AnimationTargetId, data: { value: TARGET_ID } })
      .unwrap();
    world
      .addComponent(duplicateTarget, { component: AnimatedBy, data: { player: duplicate.player } })
      .unwrap();

    const stale = await spawnPair(world, clipHandle);
    const staleRaw = stale.target;
    world.despawn(staleRaw).unwrap();

    const emptyClip = world.allocSharedRef('AnimationClip', {
      kind: 'animation-clip',
      duration: 1,
      channels: [],
    } satisfies AnimationClip);
    const missingChannel = await spawnPair(world, clipHandle);
    world.set(missingChannel.player, AnimationPlayer, {
      clips: [clipHandle, emptyClip],
      times: [0, 0],
      weights: [1, 1],
      speeds: [1, 1],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    world.update(0.1);

    expect(world.get(valid.target, Transform).unwrap().pos[0]).toBeCloseTo(1);
    expect(new Set(warn.mock.calls.map(([value]) => (value as { code?: string }).code))).toEqual(
      new Set([
        'animation-target-missing',
        'animation-target-transform-missing',
        'animation-target-id-duplicate',
        'animation-channel-missing',
      ]),
    );
  });

  it('isolates two players sharing one Clip and TargetId while pause ownership swaps', async () => {
    const world = new World();
    await createWorldContext(world, [scenePlugin()]);
    await createWorldContext(world, [animationPlugin()]);
    const clipHandle = world.allocSharedRef('AnimationClip', clip());
    const a = await spawnPair(world, clipHandle);
    const b = await spawnPair(world, clipHandle);
    world.set(a.player, AnimationPlayer, { paused: true }).unwrap();

    world.update(0.1);
    expect(world.get(a.target, Transform).unwrap().pos[0]).toBe(0);
    expect(world.get(b.target, Transform).unwrap().pos[0]).toBeCloseTo(1);

    world.set(a.player, AnimationPlayer, { paused: false }).unwrap();
    world.set(b.player, AnimationPlayer, { paused: true }).unwrap();
    world.update(0.1);
    expect(world.get(a.target, Transform).unwrap().pos[0]).toBeCloseTo(1);
    expect(world.get(b.target, Transform).unwrap().pos[0]).toBeCloseTo(1);
  });

  it('performs at most one final Transform set per target per update', async () => {
    const world = new World();
    await createWorldContext(world, [animationPlugin()]);
    const clipHandle = world.allocSharedRef('AnimationClip', clip());
    const { target } = await spawnPair(world, clipHandle);
    const set = vi.spyOn(world, 'set');

    world.update(0.1);

    const targetSets = set.mock.calls.filter(
      ([entity, component]) => entity === target && component === Transform,
    );
    expect(targetSets).toHaveLength(1);
  });

  it('keeps targets alive after player despawn and permits stale-owner recovery', async () => {
    const world = new World();
    await createWorldContext(world, [animationPlugin()]);
    const clipHandle = world.allocSharedRef('AnimationClip', clip());
    const first = await spawnPair(world, clipHandle);
    world.removeComponent(first.target, ChildOf).unwrap();
    world.despawn(first.player).unwrap();
    expect(world.get(first.target, Entity).ok).toBe(true);
    expect(world.get(first.target, AnimatedBy).unwrap().player).toBe(first.player);

    const replacement = world
      .spawn({
        component: AnimationPlayer,
        data: { clips: [clipHandle], times: [0], weights: [1], speeds: [1] },
      })
      .unwrap() as EntityHandle;
    world
      .addComponent(first.target, { component: ChildOf, data: { parent: replacement } })
      .unwrap();
    expect(bindAnimationTargets(world, replacement, [first.target]).ok).toBe(true);
    expect(world.get(first.target, AnimatedBy).unwrap().player).toBe(replacement);
    expect([...world.get(replacement, AnimationTargets).unwrap().targets]).toEqual([first.target]);
  });

  it.each([30, 60, 120])('reaches the same target pose after one second at %iHz', async (hz) => {
    const world = new World();
    await createWorldContext(world, [animationPlugin()]);
    const clipHandle = world.allocSharedRef('AnimationClip', clip());
    const { target } = await spawnPair(world, clipHandle);
    for (let frame = 0; frame < hz; frame++) world.update(1 / hz);
    expect(world.get(target, Transform).unwrap().pos[0]).toBeCloseTo(10, 4);
  });
});
