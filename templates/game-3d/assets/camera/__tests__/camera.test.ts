import { Transform } from '@forgeax/engine/scene';
import { describe, expect, it, vi } from 'vitest';
import playerPlugin from '../../player/player.ts';
import { pluginFixture } from '../../shared/__tests__/plugin-fixture.ts';
import { camera as cameraPlugin } from '../camera.pack.ts';

describe('game-3d camera lifecycle', () => {
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
