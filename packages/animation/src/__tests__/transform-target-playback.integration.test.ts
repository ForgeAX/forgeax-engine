import type { EntityHandle } from '@forgeax/engine-ecs';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  ChildOf,
  GlobalTransform,
  MorphWeights,
  Name,
  scenePlugin,
  Transform,
} from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTargetIdValue, Handle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { AnimationTargetId, bindAnimationTargets } from '../animation-target';
import { defineAnimationGraph } from '../graph/define-animation-graph';
import { animationPlugin } from '../plugin';

const TARGET_ID = 'a95da0ec669189f98273e8f86d8ad9f2' as AnimationTargetIdValue;

function transformClip(interpolation: 'LINEAR' | 'STEP' = 'LINEAR'): AnimationClip {
  return {
    kind: 'animation-clip',
    duration: 1,
    channels: [
      {
        targetId: TARGET_ID,
        property: 'translation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([0, 0, 0, 4, 8, 12]),
          interpolation,
        },
      },
      {
        targetId: TARGET_ID,
        property: 'rotation',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0]),
          interpolation,
        },
      },
      {
        targetId: TARGET_ID,
        property: 'scale',
        sampler: {
          input: new Float32Array([0, 1]),
          output: new Float32Array([1, 1, 1, 3, 5, 7]),
          interpolation,
        },
      },
    ],
  };
}

async function setupPlayer(
  clip: AnimationClip,
  graph: boolean,
): Promise<{ world: World; player: EntityHandle; target: EntityHandle }> {
  const world = new World();
  await createWorldContext(world, [scenePlugin()]);
  await createWorldContext(world, [animationPlugin(graph ? () => clip : undefined)]);
  const clipHandle = world.allocSharedRef('AnimationClip', clip);
  const player = world
    .spawn({ component: Transform, data: { pos: [10, 0, 0] } })
    .unwrap() as EntityHandle;
  world.addComponent(player, { component: Name, data: { value: 'Root' } }).unwrap();
  if (graph) {
    const built = defineAnimationGraph((builder) => builder.clip('test/animation-clip-target'));
    expect(built.ok).toBe(true);
    if (!built.ok) throw built.error;
    const graphHandle = world.allocSharedRef('AnimationGraph', built.value);
    world
      .addComponent(player, {
        component: AnimationPlayer,
        data: {
          graph: graphHandle,
          nodeTimes: [0],
          nodeWeights: [1],
          nodeSpeeds: [0],
          paused: true,
          looping: false,
        },
      })
      .unwrap();
  } else {
    world
      .addComponent(player, {
        component: AnimationPlayer,
        data: {
          clips: [clipHandle],
          times: [0],
          weights: [1],
          speeds: [0],
          paused: true,
          looping: false,
        },
      })
      .unwrap();
  }
  const target = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
  world.addComponent(target, { component: Name, data: { value: 'Hip' } }).unwrap();
  world.addComponent(target, { component: ChildOf, data: { parent: player } }).unwrap();
  world
    .addComponent(target, {
      component: AnimationTargetId,
      data: { value: TARGET_ID },
    })
    .unwrap();
  expect(bindAnimationTargets(world, player, [target]).ok).toBe(true);
  return { world, player, target };
}

function expectTrsAt(
  world: World,
  target: EntityHandle,
  time: number,
  interpolation: 'LINEAR' | 'STEP',
) {
  const transform = world.get(target, Transform).unwrap();
  const alpha = interpolation === 'STEP' && time < 1 ? 0 : time;
  expect([...transform.pos]).toEqual([
    expect.closeTo(4 * alpha),
    expect.closeTo(8 * alpha),
    expect.closeTo(12 * alpha),
  ]);
  expect([...transform.scale]).toEqual([
    expect.closeTo(1 + 2 * alpha),
    expect.closeTo(1 + 4 * alpha),
    expect.closeTo(1 + 6 * alpha),
  ]);
  expect(transform.quat[2]).toBeCloseTo(Math.sin((Math.PI / 2) * alpha), 4);
  expect(transform.quat[3]).toBeCloseTo(Math.cos((Math.PI / 2) * alpha), 4);
  expect(world.get(target, GlobalTransform).unwrap().world[12]).toBeCloseTo(10 + 4 * alpha, 4);
}

describe('generic Transform target playback', () => {
  it.each([
    'LINEAR',
    'STEP',
  ] as const)('samples direct translation, rotation, scale, and propagated world values with %s', async (interpolation) => {
    const { world, player, target } = await setupPlayer(transformClip(interpolation), false);
    for (const time of [0, 0.25, 0.5, 1]) {
      world.set(player, AnimationPlayer, { times: [time] }).unwrap();
      world.update(0);
      expectTrsAt(world, target, time, interpolation);
    }
  });

  it('evaluates cubic tangents at non-key times through the player and graph', async () => {
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 2,
      channels: [
        {
          targetId: TARGET_ID,
          property: 'translation',
          sampler: {
            input: new Float32Array([0, 2]),
            output: new Float32Array([0, 0, 0, 0, 0, 0, 3, 0, 0, -3, 0, 0, 0, 0, 0, 0, 0, 0]),
            interpolation: 'CUBICSPLINE',
          },
        },
      ],
    };
    for (const graph of [false, true]) {
      const { world, player, target } = await setupPlayer(clip, graph);
      for (const time of [0, 0.25, 0.7, 1, 1.8, 2]) {
        world
          .set(player, AnimationPlayer, graph ? { nodeTimes: [time] } : { times: [time] })
          .unwrap();
        world.update(0);
        const pose = world.get(target, Transform).unwrap();
        const u = time / 2;
        expect(pose.pos[0]).toBeCloseTo(6 * u * (1 - u), 5);
        expect(world.get(target, GlobalTransform).unwrap().world[12]).toBeCloseTo(
          10 + 6 * u * (1 - u),
          5,
        );
      }
    }
  });

  it('normalizes cubic quaternion components and keeps four morph values independent', async () => {
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 2,
      channels: [
        {
          targetId: TARGET_ID,
          property: 'rotation',
          sampler: {
            input: new Float32Array([0, 2]),
            output: new Float32Array([
              0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 0, 0, -0.5, 0, 0, 0, 1, 0, 0, 0, 0, 0,
            ]),
            interpolation: 'CUBICSPLINE',
          },
        },
        {
          targetId: TARGET_ID,
          property: 'weights',
          sampler: {
            input: new Float32Array([0, 2]),
            output: new Float32Array([
              0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, -1, -2, -3, -4, 0, 0, 0, 0, 0, 0, 0, 0,
            ]),
            interpolation: 'CUBICSPLINE',
          },
        },
      ],
    };
    for (const graph of [false, true]) {
      const { world, player, target } = await setupPlayer(clip, graph);
      world
        .addComponent(target, { component: MorphWeights, data: { weights: [0, 0, 0, 0] } })
        .unwrap();
      for (const time of [0, 0.27, 0.71, 1, 1.86, 2]) {
        world
          .set(player, AnimationPlayer, graph ? { nodeTimes: [time] } : { times: [time] })
          .unwrap();
        world.update(0);
        const u = time / 2,
          z = -2 * u ** 3 + 3 * u * u + u * (1 - u),
          w = 2 * u ** 3 - 3 * u * u + 1,
          length = Math.hypot(z, w);
        const pose = world.get(target, Transform).unwrap();
        expect(pose.quat[2]).toBeCloseTo(z / length, 5);
        expect(pose.quat[3]).toBeCloseTo(w / length, 5);
        expect(Math.hypot(...pose.quat)).toBeCloseTo(1, 5);
        expect([...world.get(target, MorphWeights).unwrap().weights].slice(0, 4)).toEqual(
          [1, 2, 3, 4].map((v) => expect.closeTo(2 * v * u * (1 - u), 5)),
        );
      }
    }
  });

  it('drives the same Transform path from an AnimationGraph', async () => {
    const { world, player, target } = await setupPlayer(transformClip(), true);
    for (const time of [0, 0.25, 0.5, 1]) {
      world.set(player, AnimationPlayer, { nodeTimes: [time] }).unwrap();
      world.update(0);
      expectTrsAt(world, target, time, 'LINEAR');
    }
  });

  it('preserves pause, loop, replay, speed, blend, and non-positive weight semantics', async () => {
    const { world, player, target } = await setupPlayer(transformClip(), false);
    const clipHandle = world.get(player, AnimationPlayer).unwrap().clips[0] as unknown as Handle<
      'AnimationClip',
      'shared'
    >;
    world.set(player, AnimationPlayer, { paused: false, speeds: [2], times: [0] }).unwrap();
    world.update(0.125);
    expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBeCloseTo(0.2);

    world.set(player, AnimationPlayer, { looping: true, times: [0.95], speeds: [1] }).unwrap();
    world.update(0.1);
    expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBeCloseTo(0.05);

    world.set(player, AnimationPlayer, {
      looping: false,
      paused: true,
      clips: [clipHandle, clipHandle],
      times: [0, 1],
      weights: [1, 1],
      speeds: [0, 0],
    });
    world.update(0);
    expect([...world.get(target, Transform).unwrap().pos]).toEqual([
      expect.closeTo(2),
      expect.closeTo(4),
      expect.closeTo(6),
    ]);

    world.set(player, AnimationPlayer, { times: [1, 1], weights: [0, -1] }).unwrap();
    world.update(0);
    expect([...world.get(target, Transform).unwrap().pos]).toEqual([
      expect.closeTo(2),
      expect.closeTo(4),
      expect.closeTo(6),
    ]);

    world.set(player, AnimationPlayer, {
      clips: [clipHandle],
      times: [0],
      weights: [1],
      speeds: [0],
    });
    world.update(0);
    expect([...world.get(target, Transform).unwrap().pos]).toEqual([0, 0, 0]);
  });
});
