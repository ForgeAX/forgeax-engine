import {
  AnimatedBy,
  AnimationPlayer,
  AnimationTargetId,
  AnimationTargets,
} from '@forgeax/engine/animation';
import { Transform } from '@forgeax/engine/scene';
import { describe, expect, it } from 'vitest';
import { pluginFixture } from '../../shared/__tests__/plugin-fixture.ts';
import playerPlugin, { ThirdPersonRig } from '../player.ts';
import { PLAYER_JOINT_NAMES } from '../player-rig.ts';

const config = { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: '019fb7ce-1000-7000-8000-000000000001' };

describe('game-3d player lifecycle', () => {
  it('cleans contributions when animation loading fails', async () => {
    const { world, ctx, entity, loadByGuid } = await pluginFixture();
    loadByGuid.mockRejectedValueOnce(new Error('animation unavailable'));
    try {
      await expect(ctx.plugin(playerPlugin, config)).rejects.toThrow('animation unavailable');
      expect(world.get(entity('player'), ThirdPersonRig).ok).toBe(false);
      expect(world.components.resolve(ThirdPersonRig.name)).toBeUndefined();
      expect(world.get(entity('player'), Transform).ok).toBe(true);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('cleans a late activation failure while retaining authored target IDs', async () => {
    const { world, ctx, entity, registerRead } = await pluginFixture();
    const joint = entity(`player/joint/${PLAYER_JOINT_NAMES[0]}`);
    const id = 'a95da0ec669189f98273e8f86d8ad9f2';
    world.addComponent(joint, { component: AnimationTargetId, data: { value: id } }).unwrap();
    const refsBefore = world.sharedRefs._liveCount();
    registerRead.mockImplementationOnce(() => {
      throw new Error('projection unavailable');
    });
    try {
      await expect(ctx.plugin(playerPlugin, config)).rejects.toThrow('projection unavailable');
      expect(world.get(entity('player'), ThirdPersonRig).ok).toBe(false);
      expect(world.get(entity('player'), AnimationPlayer).ok).toBe(false);
      expect(world.get(joint, AnimationTargetId).unwrap().value).toBe(id);
      expect(world.get(joint, AnimatedBy).ok).toBe(false);
      expect(world.sharedRefs._liveCount()).toBe(refsBefore);
      const recovered = await ctx.plugin(playerPlugin, config);
      await recovered.dispose();
      expect(world.get(joint, AnimationTargetId).unwrap().value).toBe(id);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('unloads and reinstalls without retaining animation or deleting scene entities', async () => {
    const { world, ctx, entity, unregisterRead } = await pluginFixture();
    const player = entity('player');
    const refsBefore = world.sharedRefs._liveCount();
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const fiber = await ctx.plugin(playerPlugin, config);
        expect(world.get(player, ThirdPersonRig).ok).toBe(true);
        expect(world.get(player, AnimationPlayer).ok).toBe(true);
        await fiber.dispose();
        expect(world.get(player, Transform).ok).toBe(true);
        expect(world.get(player, ThirdPersonRig).ok).toBe(false);
        expect(world.components.resolve(ThirdPersonRig.name)).toBeUndefined();
        expect(world.get(player, AnimationPlayer).ok).toBe(false);
        expect([...world.get(player, AnimationTargets).unwrap().targets]).toEqual([]);
        expect(world.inspect().systems).not.toContainEqual(
          expect.objectContaining({ name: 'game-3d-player-movement' }),
        );
        for (const name of PLAYER_JOINT_NAMES) {
          const joint = entity(`player/joint/${name}`);
          expect(world.get(joint, Transform).ok).toBe(true);
          expect(world.get(joint, AnimatedBy).ok).toBe(false);
          expect(world.get(joint, AnimationTargetId).ok).toBe(false);
        }
        expect(world.sharedRefs._liveCount()).toBe(refsBefore);
        expect(unregisterRead).toHaveBeenCalledTimes(cycle + 1);
      }
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
