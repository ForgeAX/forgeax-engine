import type { EntityHandle } from '@forgeax/engine-ecs';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import type {
  AnimationClip,
  AnimationTargetIdValue,
  AnimationTransformChannel,
  Handle,
} from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeAnimationDiagnostics } from '../animation-diagnostic';
import { AnimationPlayer } from '../animation-player';
import { AnimatedBy, AnimationTargetId, AnimationTargets } from '../animation-target';
import { animationPlugin } from '../plugin';
import { _resetAnimationWarnsForTests } from '../systems/advance-animation-player';

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
          output: new Float32Array([0, 0, 0, 1, 1, 1]),
          interpolation: 'LINEAR',
        },
      },
    ],
  };
}

async function playerWithClip(world: World, animationClip = clip()): Promise<EntityHandle> {
  await createWorldContext(world, [animationPlugin()]);
  const handle = world.allocSharedRef('AnimationClip', animationClip);
  return world
    .spawn({
      component: AnimationPlayer,
      data: { clips: [handle], times: [0], weights: [1], speeds: [1] },
    })
    .unwrap() as EntityHandle;
}

function diagnostics(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map((call: unknown[]) => call[0]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('animation runtime diagnostics', () => {
  it('projects unique channels to subscribers while preserving per-channel console facts', async () => {
    const world = new World();
    const singleChannel = clip();
    const firstChannel = singleChannel.channels[0];
    if (firstChannel === undefined) throw new Error('fixture requires one animation channel');
    const twoChannels: AnimationClip = {
      ...singleChannel,
      channels: [
        ...singleChannel.channels,
        { ...(firstChannel as AnimationTransformChannel), property: 'rotation' },
      ],
    };
    const player = await playerWithClip(world, twoChannels);
    const observed: unknown[] = [];
    const unsubscribe = subscribeAnimationDiagnostics((source, diagnostic) => {
      if (source === world) observed.push(diagnostic);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    world.update(0.25);
    world.update(0.25);
    unsubscribe();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(observed).toHaveLength(2);
    expect(observed).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({
          player: player as number,
          channel: 0,
          targetId: TARGET_ID,
        }),
      }),
      expect.objectContaining({
        detail: expect.objectContaining({
          player: player as number,
          channel: 1,
          targetId: TARGET_ID,
        }),
      }),
    ]);
  });

  it('emits a readonly structured missing-target diagnostic once per full tuple and World', async () => {
    const first = new World();
    const second = new World();
    const firstPlayer = await playerWithClip(first);
    await playerWithClip(second);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    first.update(0.25);
    first.update(0.25);
    second.update(0.25);

    expect(diagnostics(warn)).toHaveLength(2);
    expect(diagnostics(warn)[0]).toEqual({
      code: 'animation-target-missing',
      hint: expect.any(String),
      detail: {
        player: firstPlayer as number,
        clip: expect.any(Number),
        channel: 0,
        targetId: TARGET_ID,
        reason: 'target-missing',
      },
    });
    expect(Object.isFrozen(diagnostics(warn)[0])).toBe(true);

    _resetAnimationWarnsForTests(first);
    first.update(0.25);
    expect(diagnostics(warn)).toHaveLength(3);
  });

  it('reuses stable target bindings until relationship inputs change', async () => {
    const world = new World();
    const player = await playerWithClip(world);
    const target = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
    world
      .addComponent(target, { component: AnimationTargetId, data: { value: TARGET_ID } })
      .unwrap();
    world.addComponent(target, { component: AnimatedBy, data: { player } }).unwrap();
    const get = vi.spyOn(world, 'get');

    world.update(0.25);
    const bindingReadsAfterFirstUpdate = get.mock.calls.filter(
      ([, component]) => component === AnimationTargets || component === AnimationTargetId,
    ).length;
    world.update(0.25);
    const bindingReadsAfterStableUpdate = get.mock.calls.filter(
      ([, component]) => component === AnimationTargets || component === AnimationTargetId,
    ).length;

    expect(bindingReadsAfterFirstUpdate).toBeGreaterThan(0);
    expect(bindingReadsAfterStableUpdate).toBe(bindingReadsAfterFirstUpdate);

    world.removeComponent(target, Transform).unwrap();
    world.update(0.25);
    const bindingReadsAfterStructuralChange = get.mock.calls.filter(
      ([, component]) => component === AnimationTargets || component === AnimationTargetId,
    ).length;
    expect(bindingReadsAfterStructuralChange).toBeGreaterThan(bindingReadsAfterStableUpdate);

    world.addComponent(target, { component: Transform, data: {} }).unwrap();
    world.set(target, AnimationTargetId, { value: 'b'.repeat(32) }).unwrap();
    world.update(0.25);
    const bindingReadsAfterIdChange = get.mock.calls.filter(
      ([, component]) => component === AnimationTargets || component === AnimationTargetId,
    ).length;
    expect(bindingReadsAfterIdChange).toBeGreaterThan(bindingReadsAfterStructuralChange);
  });

  it('emits structured diagnostics for missing Transform, duplicate IDs, and missing channels', async () => {
    const world = new World();
    const player = await playerWithClip(world);
    const target = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
    world
      .addComponent(target, { component: AnimationTargetId, data: { value: TARGET_ID } })
      .unwrap();
    world.addComponent(target, { component: AnimatedBy, data: { player } }).unwrap();
    world.removeComponent(target, Transform).unwrap();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    world.update(0.25);

    expect(diagnostics(warn)).toContainEqual(
      expect.objectContaining({
        code: 'animation-target-transform-missing',
        detail: expect.objectContaining({ reason: 'transform-missing', targetId: TARGET_ID }),
      }),
    );

    world.addComponent(target, { component: Transform, data: {} }).unwrap();
    const duplicate = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
    world
      .addComponent(duplicate, { component: AnimationTargetId, data: { value: TARGET_ID } })
      .unwrap();
    world.addComponent(duplicate, { component: AnimatedBy, data: { player } }).unwrap();
    world.update(0.25);
    expect(diagnostics(warn)).toContainEqual(
      expect.objectContaining({
        code: 'animation-target-id-duplicate',
        detail: expect.objectContaining({ reason: 'target-id-duplicate', targetId: TARGET_ID }),
      }),
    );

    world.despawn(duplicate).unwrap();
    world.update(0.25);

    const secondClip: AnimationClip = { kind: 'animation-clip', duration: 1, channels: [] };
    const secondHandle = world.allocSharedRef('AnimationClip', secondClip);
    world.set(player, AnimationPlayer, {
      clips: [
        world.get(player, AnimationPlayer).unwrap().clips[0] as unknown as Handle<
          'AnimationClip',
          'shared'
        >,
        secondHandle,
      ],
      times: [0, 0],
      weights: [1, 1],
      speeds: [1, 1],
    });
    world.update(0.25);
    expect(diagnostics(warn)).toContainEqual(
      expect.objectContaining({
        code: 'animation-channel-missing',
        detail: expect.objectContaining({ reason: 'channel-missing', targetId: TARGET_ID }),
      }),
    );
  });

  it('preserves missing-slot diagnostic order and the first covering channel across three clips', async () => {
    const world = new World();
    const translation = clip();
    const player = await playerWithClip(world, translation);
    const rotation: AnimationClip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [
        {
          targetId: TARGET_ID,
          property: 'rotation',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
            interpolation: 'LINEAR',
          },
        },
      ],
    };
    const rotationHandle = world.allocSharedRef('AnimationClip', rotation);
    const emptyHandle = world.allocSharedRef('AnimationClip', {
      kind: 'animation-clip',
      duration: 1,
      channels: [],
    } satisfies AnimationClip);
    world
      .set(player, AnimationPlayer, {
        clips: [world.allocSharedRef('AnimationClip', translation), rotationHandle, emptyHandle],
        times: [0, 0, 0],
        weights: [1, 1, 1],
        speeds: [1, 1, 1],
      })
      .unwrap();
    const target = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
    world
      .addComponent(target, { component: AnimationTargetId, data: { value: TARGET_ID } })
      .unwrap();
    world.addComponent(target, { component: AnimatedBy, data: { player } }).unwrap();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    world.update(0.25);
    world.update(0.25);

    expect(diagnostics(warn)).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({
          reason: 'channel-missing',
          property: 'rotation',
          clip: rotationHandle as number,
          channel: 0,
        }),
      }),
      expect.objectContaining({
        detail: expect.objectContaining({
          reason: 'channel-missing',
          property: 'translation',
          channel: 0,
        }),
      }),
    ]);
  });

  it('emits no diagnostic in production', async () => {
    const proc = globalThis as { process?: { env: { NODE_ENV?: string } } };
    const saved = proc.process?.env.NODE_ENV;
    if (proc.process !== undefined) proc.process.env.NODE_ENV = 'production';
    try {
      const world = new World();
      await playerWithClip(world);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      world.update(0.25);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (proc.process !== undefined) {
        if (saved === undefined) delete proc.process.env.NODE_ENV;
        else proc.process.env.NODE_ENV = saved;
      }
    }
  });
});
