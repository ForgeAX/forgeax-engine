import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import type { Renderer } from '@forgeax/engine-render';
import { GlobalTransform, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { testPlatform } from './platform-fixture';

it('publishes the source pose before scene admission and draw', () => {
  const world = new World();
  registerPropagateTransforms(world);
  const entity = world.spawn({ component: Transform, data: { pos: [5, -3, 7] } }).unwrap();
  const observed: number[][] = [];
  const pose = () => Array.from(world.get(entity, GlobalTransform).unwrap().world).slice(12, 15);
  expect(pose()).toEqual([0, 0, 0]);
  const renderer = {
    state: () => 'alive',
    attach: () => ({ ok: true, value: createRenderReadLease(world) }),
    draw: () => {
      observed.push(pose());
      return { ok: true, value: undefined };
    },
  } as unknown as Renderer;
  let tick: (() => void) | undefined;
  let time = 0;
  const loop = createFrameLoop({
    world,
    renderer,
    platform: testPlatform({
      now: () => (time += 16),
      raf: (callback) => {
        tick = () => callback(time);
        return 1;
      },
      caf: () => {
        tick = undefined;
      },
    }),
    sceneAdmission: () => {
      observed.push(pose());
      return 'scene';
    },
  });
  loop.start().unwrap();
  tick?.();
  world.set(entity, Transform, { pos: [9, 1, 2] }).unwrap();
  tick?.();
  expect(observed).toEqual([
    [5, -3, 7],
    [5, -3, 7],
    [9, 1, 2],
    [9, 1, 2],
  ]);
  loop.stop().unwrap();
});
