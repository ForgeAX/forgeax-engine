// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { worldInternal } from '../../../ecs/src/world-internal';
import {
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  SpriteAnimation,
  SpriteRegionOverride,
} from '../../../render/src/components';
import { spriteAnimationTickSystem } from '../systems/sprite-animation-tick';

afterEach(() => vi.restoreAllMocks());
{
  // --- from sprite-animation-tick-boundary.test.ts ---

  function setDt(world: World, dt: number): void {
    world[worldInternal].getClockWriter().time.delta = dt;
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

  describe('spriteAnimationTickSystem - boundaries (M4 T-22)', () => {
    it('(1) dt=30s does NOT second-clamp (R-TIME-1) and produces a finite advance', () => {
      // frameDuration = 0.5 is exactly representable in IEEE 754 f32
      // (the SpriteAnimation.frameDuration column storage type) so
      // 30 / 0.5 = 60 advances has no rounding-error tail. With
      // frameCount=4 the loop wraps to (60 mod 4) = 0; accumDt residue
      // is 0 exactly. Picking f32-exact constants keeps the assertion
      // deterministic without weakening the "no second-clamp" detector
      // — a regression that second-clamps Time.delta to e.g. 0.25 would
      // advance only floor(0.25 / 0.5) = 0 frames (currentFrame stays
      // at 0 but accumDt would be 0.25, not 0); a clamp to 0.5 would
      // advance 1 frame -> currentFrame === 1; either way the
      // assertions below diverge from the no-clamp branch.
      const world = new World();
      const regions = new Float32Array([
        0.0, 0, 0.25, 1, 0.25, 0, 0.25, 1, 0.5, 0, 0.25, 1, 0.75, 0, 0.25, 1,
      ]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: 0.5,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      setDt(world, 30);
      const r = spriteAnimationTickSystem(world);
      expect(r.ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(Number.isFinite(snap.currentFrame)).toBe(true);
      expect(Number.isFinite(snap.accumDt)).toBe(true);
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
      expectRegion(world, entity, [0.0, 0, 0.25, 1]);
    });

    it('(2) frameCount=1 static sprite stays at currentFrame=0 (LOOP)', () => {
      const world = new World();
      const regions = new Float32Array([0.0, 0.0, 1.0, 1.0]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 1,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      // Three ticks with dt large enough to drain frameDuration each time.
      // frameCount=1 means there is only one frame; both LOOP and CLAMP
      // collapse to "stay at 0" (LOOP wraps `(0 + 1) % 1 = 0`, CLAMP
      // narrows to `min(0+1, 0) = 0`).
      for (let i = 0; i < 3; i++) {
        setDt(world, 0.5);
        expect(spriteAnimationTickSystem(world).ok).toBe(true);
      }

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expectRegion(world, entity, [0.0, 0.0, 1.0, 1.0]);
    });

    it('(2b) frameCount=1 static sprite stays at currentFrame=0 (CLAMP)', () => {
      const world = new World();
      const regions = new Float32Array([0.0, 0.0, 1.0, 1.0]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 1,
            frameDuration: 0.1,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_CLAMP,
          },
        })
        .unwrap();

      setDt(world, 0.5);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expectRegion(world, entity, [0.0, 0.0, 1.0, 1.0]);
    });

    it('(3) manual setFrame: world.set(SpriteAnimation, { currentFrame: 2, accumDt: 0 }) is honoured next tick', () => {
      const world = new World();
      const regions = new Float32Array([
        0.0, 0, 0.25, 1, 0.25, 0, 0.25, 1, 0.5, 0, 0.25, 1, 0.75, 0, 0.25, 1,
      ]);
      const entity = world
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

      // Manual seek to frame 2.
      world.set(entity, SpriteAnimation, { currentFrame: 2, accumDt: 0 }).unwrap();
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeCloseTo(0, 6);
      }

      // Next tick: dt=0.05 < frameDuration so currentFrame STAYS at 2 and
      // accumDt becomes 0.05. A regression that re-initialised
      // currentFrame to 0 on a missing-SpriteRegionOverride observation
      // would flip the value back; the assertion catches that.
      setDt(world, 0.05);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeCloseTo(0.05, 6);
      }
      // The override slot is also written from currentFrame=2 (not 0) so
      // the rendered region is regions[8..12] = [0.5, 0, 0.25, 1].
      expectRegion(world, entity, [0.5, 0, 0.25, 1]);

      // Then dt=0.06 -> accumDt=0.11 -> advance once -> currentFrame=3,
      // accumDt=0.01.
      setDt(world, 0.06);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(3);
        expect(snap.accumDt).toBeCloseTo(0.01, 6);
      }
      expectRegion(world, entity, [0.75, 0, 0.25, 1]);
    });
  });
}
