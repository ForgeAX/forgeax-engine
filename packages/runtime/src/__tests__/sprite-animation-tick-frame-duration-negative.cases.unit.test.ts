// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { World } from '@forgeax/engine-ecs';
import { SpriteAnimationInvalidError } from '@forgeax/engine-ecs/projection';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPRITE_PLAYBACK_MODE_LOOP, SpriteAnimation } from '../../../render/src/components';
import { spriteAnimationTickSystem } from '../systems/sprite-animation-tick';

afterEach(() => vi.restoreAllMocks());
{
  // --- from sprite-animation-tick-frame-duration-negative.test.ts ---

  describe('spriteAnimationTickSystem - AC-09(c) frameDuration<0 fail-fast (M4 T-21)', () => {
    it('returns Result.err with detail.field=frame-duration when frameDuration < 0', () => {
      const world = new World();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: -0.05,
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
      expect(r.error.detail.field).toBe('frame-duration');
      if (r.error.detail.field !== 'frame-duration') {
        throw new Error('expected detail.field=frame-duration narrowing');
      }
      // SpriteAnimation.frameDuration is an `f32` column so the stored
      // value is the f32 round-trip of -0.05 (= -0.05000000074505806 in
      // f64 readback). The closeTo tolerance covers the f32 unit-of-
      // last-place; the exact bit pattern is invariant across platforms
      // (IEEE 754 single-precision) so the assertion stays deterministic.
      expect(r.error.detail.frameDuration).toBeCloseTo(-0.05, 6);
      expect(r.error.detail.frameDuration).toBeLessThan(0);

      // Same fail-fast arm as T-20 (frameDuration === 0): the system
      // narrows on `frameDuration <= 0` so the negative path SHARES the
      // detail.field='frame-duration' branch (charter P4 consistent
      // abstraction). A regression that strict-equals on 0 would fall
      // through and compute `accumDt += dt` against a negative
      // frameDuration, producing Infinity / NaN advances; the bad-entity
      // state assertion below catches that.
      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
    });

    it('frameDuration negative returns the same .code as frameDuration zero', () => {
      // Twin spawn: one entity with frameDuration=0, one with -0.05. Both
      // surface the SAME .code + .detail.field arm. The first-error-wins
      // semantics return one of the two; either way the `.code` matches
      // and the `.detail.field` matches, locking the consistent-abstraction
      // claim from plan-strategy section 2 D-1.
      const world = new World();
      world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 2,
            frameDuration: 0,
            regions: new Float32Array(2 * 4),
          },
        })
        .unwrap();

      world.update(0.1).unwrap();
      const rZero = spriteAnimationTickSystem(world);
      expect(rZero.ok).toBe(false);
      if (rZero.ok) throw new Error('zero arm: expected Result.err');

      const world2 = new World();
      world2
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 2,
            frameDuration: -0.05,
            regions: new Float32Array(2 * 4),
          },
        })
        .unwrap();

      world2.update(0.1).unwrap();
      const rNeg = spriteAnimationTickSystem(world2);
      expect(rNeg.ok).toBe(false);
      if (rNeg.ok) throw new Error('negative arm: expected Result.err');

      expect(rZero.error.code).toBe(rNeg.error.code);
      expect(rZero.error.detail.field).toBe(rNeg.error.detail.field);
    });
  });
}
