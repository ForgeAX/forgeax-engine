import { createInputSnapshot, INPUT_SNAPSHOT_RESOURCE_KEY } from '@forgeax/engine/input';
import { Transform } from '@forgeax/engine/scene';
import { describe, expect, it, vi } from 'vitest';
import playerPlugin from '../../player/player.ts';
import { pluginFixture } from '../../shared/__tests__/plugin-fixture.ts';
import { camera as cameraPlugin } from '../camera.pack.ts';

describe('game-3d camera lifecycle', () => {
  it('keeps the live size reader without resolving its method on every frame', async () => {
    const { world, ctx } = await pluginFixture();
    world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, createInputSnapshot());
    let width = 800;
    const readSize = vi.fn(() => ({ width, height: 600 }));
    let methodReads = 0;
    Object.defineProperty(ctx.gameHost, 'drawingBufferSize', {
      configurable: true,
      get() { methodReads += 1; return readSize; },
    });
    try {
      await ctx.plugin(playerPlugin, { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: '019fb7ce-1000-7000-8000-000000000001' });
      const installedReads = methodReads;
      world.update(1 / 60).unwrap();
      width = 1024;
      world.update(1 / 60).unwrap();
      expect(methodReads).toBe(installedReads);
      expect(readSize.mock.results.map((result) => result.value.width)).toEqual([800, 1024]);
    } finally { await ctx.fiber.dispose(); }
  });

  it('avoids identical camera pose publications and repairs an external edit', async () => {
    const { world, ctx, entity } = await pluginFixture();
    world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, createInputSnapshot());
    try {
      await ctx.plugin(playerPlugin, { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: '019fb7ce-1000-7000-8000-000000000001' });
      await ctx.plugin(cameraPlugin);
      const camera = entity('camera');
      const set = vi.spyOn(world, 'set');
      world.update(1 / 60).unwrap();
      const pose = world.get(camera, Transform).unwrap();
      world.update(1 / 60).unwrap();
      expect(set.mock.calls.filter(([target, component]) => target === camera && component === Transform)).toHaveLength(1);
      world.set(camera, Transform, { pos: [99, 99, 99] }).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(camera, Transform).unwrap().pos).toEqual(pose.pos);
    } finally { await ctx.fiber.dispose(); }
  });

  it('runs player and camera frames without resolving plugin services again', async () => {
    const { world, ctx } = await pluginFixture();
    world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, createInputSnapshot());
    try {
      await ctx.plugin(playerPlugin, { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: '019fb7ce-1000-7000-8000-000000000001' });
      await ctx.plugin(cameraPlugin);
      let worldResolutions = 0;
      ctx.on('internal/get', (_context, name, _error, next) => {
        if (name === 'world') worldResolutions += 1;
        return next();
      });
      for (let frame = 0; frame < 3; frame += 1) world.update(1 / 60).unwrap();
      expect(worldResolutions).toBe(0);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('releases pointer lock and its system while preserving the borrowed camera', async () => {
    const { world, ctx, entity, pointerLock } = await pluginFixture();
    try {
      await ctx.plugin(playerPlugin, { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: '019fb7ce-1000-7000-8000-000000000001' });
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const fiber = await ctx.plugin(cameraPlugin);
        expect(pointerLock).toHaveBeenLastCalledWith(true);
        await fiber.dispose();
        expect(pointerLock).toHaveBeenLastCalledWith(false);
        expect(world.get(entity('camera'), Transform).ok).toBe(true);
        expect(world.inspect().systems.some((system) => system.name === 'game-3d-camera')).toBe(
          false,
        );
      }
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('releases pointer lock if system installation fails ', async () => {
    const { world, ctx, pointerLock } = await pluginFixture();
    try {
      await ctx.plugin(playerPlugin, { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: '019fb7ce-1000-7000-8000-000000000001' });
      vi.spyOn(world, 'addSystem').mockImplementationOnce(() => {
        throw new Error('system unavailable');
      });
      await expect(ctx.plugin(cameraPlugin)).rejects.toThrow('system unavailable');
      expect(pointerLock).toHaveBeenLastCalledWith(false);
      expect(world.inspect().systems.some((system) => system.name === 'game-3d-camera')).toBe(
        false,
      );
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
