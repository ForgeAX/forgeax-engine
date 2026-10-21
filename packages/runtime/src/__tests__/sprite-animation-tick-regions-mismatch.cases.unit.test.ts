// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { SpriteAnimationInvalidError } from '@forgeax/engine-ecs/projection';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { worldInternal } from '../../../ecs/src/world-internal';
import {
  SPRITE_PLAYBACK_MODE_LOOP,
  SpriteAnimation,
  SpriteRegionOverride,
} from '../../../render/src/components';
import { spriteAnimationTickSystem } from '../systems/sprite-animation-tick';

afterEach(() => vi.restoreAllMocks());
{
  // --- from sprite-animation-tick-regions-mismatch.test.ts ---

  function setDt(world: World, dt: number): void {
    world[worldInternal].getClockWriter().time.delta = dt;
  }

  function spawnBadRegionsLength(world: World): EntityHandle {
    // frameCount=4 but regions.length=12 (should be 16). The first row is
    // distinguishable from row 0 of any regions buffer that the tick system
    // could plausibly synthesise so a regression that wrote a stale slice
    // would NOT match this initial state.
    return world
      .spawn({
        component: SpriteAnimation,
        data: {
          frameCount: 4,
          frameDuration: 0.1,
          currentFrame: 0,
          accumDt: 0,
          regions: new Float32Array([0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4, 0.5, 0.5, 0.6, 0.6]),
          playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
        },
      })
      .unwrap();
  }

  function spawnHealthy(world: World): EntityHandle {
    // 4 frames x 4 floats = 16. Distinguishable per-frame so the per-step
    // region assertion can pin which frame fired without ambiguity.
    const regions = new Float32Array([
      0.0, 0, 0.25, 1, 0.25, 0, 0.25, 1, 0.5, 0, 0.25, 1, 0.75, 0, 0.25, 1,
    ]);
    return world
      .spawn({
        component: SpriteAnimation,
        data: {
          frameCount: 4,
          frameDuration: 0.1,
          currentFrame: 0,
          accumDt: 0,
          regions,
          playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
        },
      })
      .unwrap();
  }

  describe('spriteAnimationTickSystem - AC-09(a) regions.length fail-fast (M4 T-19)', () => {
    it('returns Result.err with 4 structured fields when regions.length !== frameCount * 4', () => {
      const world = new World();
      const entity = spawnBadRegionsLength(world);

      setDt(world, 0.1);
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
      expect(r.error.detail.field).toBe('regions-length');
      if (r.error.detail.field !== 'regions-length') {
        throw new Error('expected detail.field=regions-length narrowing');
      }
      expect(r.error.detail.regionsLength).toBe(12);
      expect(r.error.detail.frameCount).toBe(4);

      // The bad entity does NOT advance: currentFrame stays at 0,
      // accumDt stays at 0. A regression that mutated state before the
      // invariant check would surface as accumDt > 0 here.
      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
    });

    it('healthy entity advances normally beside a bad-regions-length entity', () => {
      const world = new World();
      const bad = spawnBadRegionsLength(world);
      const good = spawnHealthy(world);

      // dt=0.15 -> good.accumDt=0.15 -> one advance: good.currentFrame=1,
      // good.accumDt=0.05. The bad entity stays put.
      setDt(world, 0.15);
      const r = spriteAnimationTickSystem(world);

      expect(r.ok).toBe(false);
      if (r.ok) {
        throw new Error('expected Result.err but got ok');
      }
      expect(r.error.code).toBe('sprite-animation-invalid');
      expect(r.error.detail.field).toBe('regions-length');

      const badSnap = world.get(bad, SpriteAnimation).unwrap();
      expect(badSnap.currentFrame).toBe(0);
      expect(badSnap.accumDt).toBeCloseTo(0, 6);

      const goodSnap = world.get(good, SpriteAnimation).unwrap();
      expect(goodSnap.currentFrame).toBe(1);
      expect(goodSnap.accumDt).toBeCloseTo(0.05, 6);

      // Healthy entity also got its SpriteRegionOverride written to the
      // currentFrame=1 slice (regions[4..8]).
      const sro = world.get(good, SpriteRegionOverride).unwrap();
      expect(sro.region.length).toBe(4);
      expect(sro.region[0]).toBeCloseTo(0.25, 6);
      expect(sro.region[1]).toBeCloseTo(0, 6);
      expect(sro.region[2]).toBeCloseTo(0.25, 6);
      expect(sro.region[3]).toBeCloseTo(1, 6);
    });
  });
}
