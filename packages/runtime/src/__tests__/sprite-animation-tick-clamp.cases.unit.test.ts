// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { worldInternal } from '../../../ecs/src/world-internal';
import {
  SPRITE_PLAYBACK_MODE_CLAMP,
  SpriteAnimation,
  SpriteRegionOverride,
} from '../../../render/src/components';
import { spriteAnimationTickSystem } from '../systems/sprite-animation-tick';

afterEach(() => vi.restoreAllMocks());
{
  // --- from sprite-animation-tick-clamp.test.ts ---

  function setDt(world: World, dt: number): void {
    world[worldInternal].getClockWriter().time.delta = dt;
  }

  function makeRegions(): Float32Array {
    // 3 frames x 4 floats. Each frame's slice is byte-distinguishable so
    // the per-step region assertion can pin which frame fired without
    // ambiguity.
    return new Float32Array([
      0.0,
      0,
      0.33,
      1, // frame 0
      0.33,
      0,
      0.34,
      1, // frame 1
      0.67,
      0,
      0.33,
      1, // frame 2 (last frame, CLAMP target)
    ]);
  }

  function expectRegion(
    world: World,
    entity: EntityHandle,
    expected: readonly [number, number, number, number],
  ): void {
    const sro = world.get(entity, SpriteRegionOverride).unwrap();
    expect(sro.region.length).toBe(4);
    expect(sro.region[0]).toBeCloseTo(expected[0], 6);
    expect(sro.region[1]).toBeCloseTo(expected[1], 6);
    expect(sro.region[2]).toBeCloseTo(expected[2], 6);
    expect(sro.region[3]).toBeCloseTo(expected[3], 6);
  }

  describe('spriteAnimationTickSystem - AC-05 clamp end-frame (M4 T-18)', () => {
    it('dt=0.5 with frameCount=3 / frameDuration=0.1 stops at frameCount-1 (last frame)', () => {
      const world = new World();
      const regions = makeRegions();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 3,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_CLAMP,
          },
        })
        .unwrap();

      setDt(world, 0.5);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(2);
      expect(snap.accumDt).toBeGreaterThanOrEqual(0);
      expectRegion(world, entity, [0.67, 0, 0.33, 1]);
    });

    it('continued dt=0.5 keeps currentFrame at last frame (no wrap)', () => {
      const world = new World();
      const regions = makeRegions();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 3,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_CLAMP,
          },
        })
        .unwrap();

      setDt(world, 0.5);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
      }

      setDt(world, 0.5);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        // CLAMP must not wrap; if loop arithmetic leaked into the clamp
        // branch the index would land at (2 + 5) % 3 = 1.
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeGreaterThanOrEqual(0);
      }
      expectRegion(world, entity, [0.67, 0, 0.33, 1]);
    });
  });
}
