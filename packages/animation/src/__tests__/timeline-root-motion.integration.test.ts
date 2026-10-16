import { animationClipLoader } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import type { AnimationClip, AnimationTimelineKey, LoadContext } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { defineAnimationMask } from '../animation-mask';
import { AnimationPlayer } from '../animation-player';
import { AnimationTargetId, bindAnimationTargets } from '../animation-target';
import { defineAnimationGraph } from '../graph/define-animation-graph';
import { playbackInterval } from '../playback-interval';
import { animationPlugin } from '../plugin';
import { AnimationRootMotion, extractRootMotion } from '../root-motion';
import { advanceAnimationPlayer } from '../systems/advance-animation-player';
import { evaluateAnimationGraph } from '../systems/evaluate-animation-graph';
import { deriveAnimationTargetId } from '../target-id';
import { collectTimelineEvents, drainAnimationEvents } from '../timeline';

const targetId = deriveAnimationTargetId(['Root']);
const keys = [0, 0.25, 0.75, 1].map(
  (time) =>
    ({
      time,
      targetId,
      action: { kind: 'method', name: `key:${time}`, args: [] },
    }) satisfies AnimationTimelineKey,
);
function keyAt(index: number): AnimationTimelineKey {
  const key = keys[index];
  if (key === undefined) throw new Error('fixture key missing');
  return key;
}
const clip: AnimationClip = {
  kind: 'animation-clip',
  duration: 1,
  events: keys,
  channels: [
    {
      targetId,
      property: 'translation',
      sampler: {
        input: new Float32Array([0, 1]),
        output: new Float32Array([5, 0, 0, 7, 0, 0]),
        interpolation: 'LINEAR',
      },
    },
  ],
};

async function fixture(graph = false, source = clip) {
  const world = new World({ time: { maxDeltaSeconds: 20000 } });
  const context = await createWorldContext(world, [
    animationPlugin((guid) => (guid === 'clip' ? source : undefined)),
  ]);
  const handle = world.allocSharedRef('AnimationClip', source);
  const graphHandle = graph
    ? world.allocSharedRef('AnimationGraph', defineAnimationGraph((b) => b.clip('clip')).unwrap())
    : undefined;
  const player = world
    .spawn(
      {
        component: AnimationPlayer,
        data: graph
          ? {
              graph: toShared<'AnimationGraph'>(graphHandle ?? 0),
              nodeTimes: [0.75],
              nodeSpeeds: [1],
            }
          : { clips: [handle], times: [0.75], weights: [1], speeds: [1] },
      },
      { component: AnimationRootMotion, data: { targetId } },
      { component: Transform, data: {} },
      { component: Name, data: { value: 'Player' } },
    )
    .unwrap();
  const target = world
    .spawn(
      { component: Transform, data: {} },
      { component: ChildOf, data: { parent: player } },
      { component: AnimationTargetId, data: { value: targetId } },
    )
    .unwrap();
  bindAnimationTargets(world, player, [target]).unwrap();
  return { world, player, target, context };
}

describe('timeline and root motion use the real default World schedule', () => {
  it.each([
    { graph: false, key: 0.05, step: 0.0499999999999, first: 0, second: 1 },
    { graph: true, key: 0.05, step: 0.0499999999999, first: 0, second: 1 },
    { graph: false, key: 0.050000001, step: 0.050000002, first: 1, second: 0 },
    { graph: true, key: 0.050000001, step: 0.050000002, first: 1, second: 0 },
  ])('keeps one clock across nearby cue boundaries (%j)', async ({
    graph,
    key,
    step,
    first,
    second,
  }) => {
    const { world, player } = await fixture(graph, {
      ...clip,
      events: [{ time: key, targetId, action: { kind: 'method', name: 'cue', args: [] } }],
    });
    world.set(player, AnimationPlayer, graph ? { nodeTimes: [0] } : { times: [0] }).unwrap();
    world.update(step).unwrap();
    expect(drainAnimationEvents(world, player)).toHaveLength(first);
    world.update(0.01).unwrap();
    expect(drainAnimationEvents(world, player)).toHaveLength(second);
  });
  it.each([
    false,
    true,
  ])('publishes loop crossings and extracts before modulo (graph=%s)', async (graph) => {
    const { world, player, target } = await fixture(graph);
    world.update(0.5).unwrap();
    expect(drainAnimationEvents(world, player).map((event) => event.time)).toEqual([1, 0, 0.25]);
    expect(drainAnimationEvents(world, player)).toEqual([]);
    expect(world.get(player, AnimationRootMotion).unwrap().position[0]).toBeCloseTo(1, 5);
    expect(world.get(target, Transform).unwrap().pos[0]).toBeCloseTo(5, 5);
    world.update(0.5).unwrap();
    expect(world.get(player, AnimationRootMotion).unwrap().accumulatedPosition[0]).toBeCloseTo(
      2,
      5,
    );
  });
  it.each([
    false,
    true,
  ])('reverse, multi-loop, pause, seek and nonloop clamp (graph=%s)', async (graph) => {
    const { world, player } = await fixture(graph);
    world
      .set(
        player,
        AnimationPlayer,
        graph ? { nodeTimes: [0.25], nodeSpeeds: [-1] } : { times: [0.25], speeds: [-1] },
      )
      .unwrap();
    world.update(2.5).unwrap();
    const events = drainAnimationEvents(world, player);
    expect(events).toHaveLength(11);
    expect(events.every((e) => e.direction === -1)).toBe(true);
    expect(world.get(player, AnimationRootMotion).unwrap().position[0]).toBeCloseTo(-5, 5);
    world.set(player, AnimationPlayer, { paused: true }).unwrap();
    world.update(0.7).unwrap();
    expect(drainAnimationEvents(world, player)).toHaveLength(0);
    expect(world.get(player, AnimationRootMotion).unwrap().position[0]).toBe(0);
    world.set(player, AnimationPlayer, graph ? { nodeTimes: [0.6] } : { times: [0.6] }).unwrap();
    world.update(0).unwrap();
    expect(drainAnimationEvents(world, player)).toHaveLength(0);
    world.set(player, AnimationPlayer, { paused: false, looping: false }).unwrap();
    world.update(2).unwrap();
    expect(world.get(player, AnimationRootMotion).unwrap().position[0]).toBeCloseTo(-1.2, 5);
    world.update(2).unwrap();
    expect(drainAnimationEvents(world, player)).toHaveLength(0);
    expect(world.get(player, AnimationRootMotion).unwrap().position[0]).toBe(0);
  });
  it('consumes a graph interval once without repeating effects or movement', async () => {
    const { world, player } = await fixture(true);
    world.update(0.5).unwrap();
    expect(drainAnimationEvents(world, player).length).toBe(3);
    advanceAnimationPlayer(world, 0.5);
    expect(drainAnimationEvents(world, player)).toHaveLength(0);
    expect(world.get(player, AnimationRootMotion).unwrap().position[0]).toBe(0);
  });
  it('preserves every effect through JSON Pack restoration and isolates two players', async () => {
    const events: AnimationTimelineKey[] = [
      {
        time: 0.1,
        targetId,
        action: { kind: 'method', name: 'hit', args: [1, 'left', true, null] },
      },
      {
        time: 0.2,
        targetId,
        action: { kind: 'audio', clip: '019e2cc6-0c86-79da-aa76-b0984c86d45c', fromPosition: 0.3 },
      },
      {
        time: 0.3,
        targetId,
        action: {
          kind: 'animation',
          clip: '019e2cc6-0c86-79da-aa76-b0984c86d45d',
          fromPosition: 0.4,
        },
      },
      { time: 0.4, targetId, action: { kind: 'audio', clip: null, fromPosition: 0 } },
      { time: 0.5, targetId, action: { kind: 'animation', clip: null, fromPosition: 0 } },
    ];
    const restored = animationClipLoader.load(
      JSON.parse(JSON.stringify({ kind: 'animation-clip', duration: 1, channels: [], events })),
      [],
      {} as LoadContext,
    ) as AnimationClip;
    expect(restored.events).toEqual(events);
    const { world, player } = await fixture(false, restored);
    const child = world.spawn({ component: AnimationPlayer, data: {} }).unwrap();
    world.set(player, AnimationPlayer, { times: [0] }).unwrap();
    world.update(0.5).unwrap();
    const output = drainAnimationEvents(world, player);
    expect(output.map((e) => e.action.kind)).toEqual([
      'method',
      'audio',
      'animation',
      'audio',
      'animation',
    ]);
    expect(drainAnimationEvents(world, child)).toHaveLength(0);
    // Deferred consumption can safely create entities/change another player after all poses.
    for (const event of output) {
      if (event.action.kind === 'method')
        world.spawn({ component: Name, data: { value: event.action.name } }).unwrap();
      if (event.action.kind === 'animation')
        world
          .set(child, AnimationPlayer, {
            paused: event.action.clip === null,
            times: [event.action.fromPosition],
          })
          .unwrap();
    }
    expect(world.get(child, AnimationPlayer).unwrap().paused).toBe(true);
  });
  it('replaces unread events, clears on plugin disposal and resets root delta on empty slots', async () => {
    const { world, player, context } = await fixture();
    world.update(0.5).unwrap();
    world.set(player, AnimationPlayer, { clips: [], times: [], weights: [], speeds: [] }).unwrap();
    world.update(0).unwrap();
    expect(drainAnimationEvents(world, player)).toHaveLength(0);
    expect(world.get(player, AnimationRootMotion).unwrap().position[0]).toBe(0);
    await context.fiber.restart();
    expect(drainAnimationEvents(world, player)).toHaveLength(0);
  });
  it.each([
    false,
    true,
  ])('rejects overflow before clock/pose commitment (graph=%s)', async (graph) => {
    const { world, player, target } = await fixture(graph);
    const before = Array.from(world.get(target, Transform).unwrap().pos);
    expect(() =>
      graph
        ? evaluateAnimationGraph(world, 10000, (guid) => (guid === 'clip' ? clip : undefined))
        : advanceAnimationPlayer(world, 10000),
    ).toThrow(expect.objectContaining({ code: 'animation-timeline-overflow' }));
    expect(Array.from(world.get(target, Transform).unwrap().pos)).toEqual(before);
    const state = world.get(player, AnimationPlayer).unwrap();
    expect((graph ? state.nodeTimes : state.times)[0]).toBe(0.75);
    const failure = world.update(10000);
    expect(failure).toMatchObject({
      ok: false,
      error: { code: 'system-failed', detail: { cause: { code: 'animation-timeline-overflow' } } },
    });
  });
  it('weights motion including a stationary slot, and honors root masks', async () => {
    const { world, player } = await fixture(false, { ...clip, events: [] });
    const moving = world.get(player, AnimationPlayer).unwrap().clips[0] ?? 0;
    const still = world.allocSharedRef('AnimationClip', { ...clip, channels: [], events: [] });
    world
      .set(player, AnimationPlayer, {
        clips: [moving, still],
        times: [0, 0],
        weights: [1, 3],
        speeds: [1, 1],
      })
      .unwrap();
    world.update(0.5).unwrap();
    expect(world.get(player, AnimationRootMotion).unwrap().position[0]).toBeCloseTo(0.25, 5);
    const mask = world.allocSharedRef(
      'AnimationMask',
      defineAnimationMask([{ targetId, weight: 0 }], 1).unwrap(),
    );
    world.set(player, AnimationPlayer, { masks: [mask, 0] }).unwrap();
    world.update(0.5).unwrap();
    expect(world.get(player, AnimationRootMotion).unwrap().position[0]).toBe(0);
  });
  it.each([
    { delta: 4, accumulated: 0 },
    { delta: 1, accumulated: 3e38 },
  ])('rejects nonfinite f32 motion before commit (%j)', async ({ delta, accumulated }) => {
    const huge: AnimationClip = {
      ...clip,
      events: [],
      channels: [
        {
          targetId,
          property: 'translation',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 0, 1e38, 0, 0]),
            interpolation: 'LINEAR',
          },
        },
      ],
    };
    const { world, player, target } = await fixture(false, huge);
    world.set(player, AnimationRootMotion, { accumulatedPosition: [accumulated, 0, 0] }).unwrap();
    const before = Array.from(world.get(player, AnimationRootMotion).unwrap().accumulatedPosition);
    expect(() => advanceAnimationPlayer(world, delta)).toThrow(
      expect.objectContaining({ code: 'animation-root-motion-invalid' }),
    );
    expect(world.get(player, AnimationPlayer).unwrap().times[0]).toBe(0.75);
    expect(Array.from(world.get(target, Transform).unwrap().pos)).toEqual([0, 0, 0]);
    expect(Array.from(world.get(player, AnimationRootMotion).unwrap().position)).toEqual([0, 0, 0]);
    expect(Array.from(world.get(player, AnimationRootMotion).unwrap().accumulatedPosition)).toEqual(
      before,
    );
  });
});

describe('interval falsifiers and mathematical root-motion oracles', () => {
  it.each([
    false,
    true,
  ])('ends the departing cycle before restarting at its seam (graph=%s)', async (graph) => {
    const source: AnimationClip = {
      ...clip,
      events: [
        { time: 0, targetId, action: { kind: 'audio', clip: 'sound', fromPosition: 0 } },
        { time: 1, targetId, action: { kind: 'audio', clip: null, fromPosition: 0 } },
      ],
    };
    const { world, player } = await fixture(graph, source);
    world.update(0.5).unwrap();
    const forward = drainAnimationEvents(world, player);
    world
      .set(
        player,
        AnimationPlayer,
        graph ? { nodeTimes: [0.25], nodeSpeeds: [-1] } : { times: [0.25], speeds: [-1] },
      )
      .unwrap();
    world.update(0.5).unwrap();
    const reverse = drainAnimationEvents(world, player);
    expect(forward.map((event) => event.action)).toEqual([
      source.events?.[1]?.action,
      source.events?.[0]?.action,
    ]);
    expect(reverse.map((event) => event.action)).toEqual([
      source.events?.[0]?.action,
      source.events?.[1]?.action,
    ]);
  });
  it('exact endpoints fire once and a zero-duration clip never loops', () => {
    expect(
      collectTimelineEvents(1, [playbackInterval(clip, 1, 0, 0, 0.25, true)]).map((e) => e.time),
    ).toEqual([0.25]);
    expect(
      collectTimelineEvents(1, [playbackInterval(clip, 1, 0, 0.25, 0.5, true)]).map((e) => e.time),
    ).toEqual([0.75]);
    expect(
      collectTimelineEvents(1, [
        playbackInterval({ ...clip, duration: 0, events: [keyAt(0)] }, 1, 0, 0, 1e9, true),
      ]),
    ).toHaveLength(0);
  });
  it.each([NaN, Infinity, -Infinity])('rejects malformed clocks %s', (time) => {
    expect(() => playbackInterval(clip, 1, 0, time, 1, true)).toThrow(
      expect.objectContaining({ code: 'animation-playback-invalid' }),
    );
  });
  it('rejects unsorted/out-of-range keys and invalid actions', () => {
    for (const events of [
      [keyAt(2), keyAt(1)],
      [{ ...keyAt(1), time: 2 }],
      [{ ...keyAt(1), action: { kind: 'audio', clip: 'a', fromPosition: -1 } }],
    ]) {
      expect(() =>
        collectTimelineEvents(1, [
          playbackInterval({ ...clip, events: events as AnimationTimelineKey[] }, 1, 0, 0, 1, true),
        ]),
      ).toThrow(expect.objectContaining({ code: 'animation-timeline-invalid' }));
    }
  });
  it('turning cycles compose translation in the rotated basis and reverse is the inverse', () => {
    const turning: AnimationClip = {
      ...clip,
      events: [],
      channels: [
        {
          targetId,
          property: 'translation',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 0, 2, 0, 0]),
            interpolation: 'LINEAR',
          },
        },
        {
          targetId,
          property: 'rotation',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]),
            interpolation: 'LINEAR',
          },
        },
      ],
    };
    const forward = extractRootMotion(playbackInterval(turning, 1, 0, 0, 2, true), targetId);
    expect(forward.p[0]).toBeCloseTo(2, 5);
    expect(forward.p[1]).toBeCloseTo(2, 5);
    expect(Math.abs(forward.q[2] ?? 0)).toBeCloseTo(1, 5);
    const reverse = extractRootMotion(playbackInterval(turning, 1, 0, 0, -2, true), targetId);
    expect(reverse.p[0]).toBeCloseTo(2, 5);
    expect(reverse.p[1]).toBeCloseTo(2, 5);
    const nonzero = {
      ...turning,
      channels: [
        clip.channels[0] as AnimationClip['channels'][number],
        turning.channels[1] as AnimationClip['channels'][number],
      ],
    };
    const offset = extractRootMotion(playbackInterval(nonzero, 1, 0, 0, 2, true), targetId);
    // Applying actor delta to the locked [5,0,0] root gives [7,2,0], not [-3,2,0].
    expect((offset.p[0] ?? 0) - 5).toBeCloseTo(7, 5);
    expect(offset.p[1]).toBeCloseTo(2, 5);
    const million = extractRootMotion(
      playbackInterval({ ...clip, events: [] }, 1, 0, 0, 1000000, true),
      targetId,
    );
    expect(million.p[0]).toBeCloseTo(2000000, 4);
  });
});
