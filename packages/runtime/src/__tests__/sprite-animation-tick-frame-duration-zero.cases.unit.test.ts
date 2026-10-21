// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { World } from '@forgeax/engine-ecs';
import { SpriteAnimationInvalidError } from '@forgeax/engine-ecs/projection';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPRITE_PLAYBACK_MODE_LOOP, SpriteAnimation } from '../../../render/src/components';
import { spriteAnimationTickSystem } from '../systems/sprite-animation-tick';

afterEach(() => vi.restoreAllMocks());
{
  // --- from sprite-animation-tick-frame-duration-zero.test.ts ---

  describe('spriteAnimationTickSystem - AC-09(b) frameDuration=0 fail-fast (M4 T-20)', () => {
    it('returns Result.err with detail.field=frame-duration when frameDuration === 0', () => {
      const world = new World();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: 0,
            currentFrame: 0,
            accumDt: 0,
            regions: new Float32Array(4 * 4),
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      world.update(0.1).unwrap();
      const r = spriteAnimationTickSystem(world);

      expect(r.ok).toBe(false);
      if (r.ok) {
        throw new Error('expected Result.err but got ok');
      }
      expect(r.error).toBeInstanceOf(SpriteAnimationInvalidError);
      expect(r.error.code).toBe('sprite-animation-invalid');
      expect(r.error.expected).toBeTruthy();
      expect(r.error.expected.length).toBeGreaterThan(0);
      expect(r.error.hint).toBeTruthy();
      expect(r.error.hint.length).toBeGreaterThan(0);
      expect(r.error.detail.field).toBe('frame-duration');
      if (r.error.detail.field !== 'frame-duration') {
        throw new Error('expected detail.field=frame-duration narrowing');
      }
      expect(r.error.detail.frameDuration).toBe(0);

      // The bad entity does NOT advance.
      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
    });
  });
}
