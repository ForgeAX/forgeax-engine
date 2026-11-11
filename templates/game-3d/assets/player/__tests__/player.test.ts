import {
  AnimatedBy,
  AnimationPlayer,
  AnimationTargetId,
  AnimationTargets,
} from '@forgeax/engine/animation';
import { Transform } from '@forgeax/engine/scene';
import { describe, expect, it, vi } from 'vitest';
import { pluginFixture } from '../../__tests__/plugin-fixture.ts';
import playerPlugin, { ThirdPersonRig } from '../player.ts';
import { PLAYER_JOINT_NAMES } from '../../shared/player-rig.ts';

const config = { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: '019fb7ce-1000-7000-8000-000000000001', transform: '019fb7ce-1000-7000-8000-000000000002', wheels: '019fb7ce-1000-7000-8000-000000000003' };

describe('game-3d player lifecycle', () => {
  it('releases the body mask when allocating the wheel mask fails', async () => {
    const { world, ctx, entity } = await pluginFixture();
    const before = world.sharedRefs._liveCount();
    const allocate = world.allocSharedRef.bind(world);
    let calls = 0;
    const spy = vi.spyOn(world, 'allocSharedRef').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('wheel mask unavailable');
      return allocate(...args);
    });
    try {
      await expect(ctx.plugin(playerPlugin, config)).rejects.toThrow('wheel mask unavailable');
      expect(world.sharedRefs._liveCount()).toBe(before);
      expect(world.get(entity('player'), AnimationPlayer).ok).toBe(false);
    } finally {
      spy.mockRestore();
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
