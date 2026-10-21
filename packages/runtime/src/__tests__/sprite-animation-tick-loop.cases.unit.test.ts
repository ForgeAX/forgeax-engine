// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
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
  // --- from sprite-animation-tick-loop.test.ts ---

  function setDt(world: World, dt: number): void {
    world[worldInternal].getClockWriter().time.delta = dt;
  }

  function makeRegions(): Float32Array {
    // 4 frames x [uMin, vMin, uW, vH] = 16 floats. Each frame's slice
    // is byte-distinguishable so the per-step region assertion can pin
    // which frame fired without ambiguity.
    return new Float32Array([
      0.0,
      0,
      0.25,
      1, // frame 0
      0.25,
      0,
      0.25,
      1, // frame 1
      0.5,
      0,
      0.25,
      1, // frame 2
      0.75,
      0,
      0.25,
      1, // frame 3
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

  describe('spriteAnimationTickSystem - AC-04 loop dt sequence (M4 T-17)', () => {
    it('five canonical dt steps drive currentFrame 0 -> 1 -> 1 -> 2 -> 0 with accumDt residue 0.06', () => {
      const world = new World();
      const regions = makeRegions();
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

      // Step 1: dt=0.05 -> accumDt=0.05; no advance (0.05 < 0.1).
      setDt(world, 0.05);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(0);
        expect(snap.accumDt).toBeCloseTo(0.05, 6);
      }
      expectRegion(world, entity, [0.0, 0, 0.25, 1]);

      // Step 2: dt=0.06 -> accumDt=0.11; advance once; currentFrame=1, accumDt=0.01.
      setDt(world, 0.06);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(1);
        expect(snap.accumDt).toBeCloseTo(0.01, 6);
      }
      expectRegion(world, entity, [0.25, 0, 0.25, 1]);

      // Step 3: dt=0.04 -> accumDt=0.05; no advance (0.05 < 0.1).
      setDt(world, 0.04);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(1);
        expect(snap.accumDt).toBeCloseTo(0.05, 6);
      }
      expectRegion(world, entity, [0.25, 0, 0.25, 1]);

      // Step 4: dt=0.11 -> accumDt=0.16; advance once; currentFrame=2, accumDt=0.06.
      setDt(world, 0.11);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeCloseTo(0.06, 6);
      }
      expectRegion(world, entity, [0.5, 0, 0.25, 1]);

      // Step 5: dt=0.20 -> accumDt=0.26; advance twice; currentFrame=3 -> 0 (loop wrap), accumDt=0.06.
      setDt(world, 0.2);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(0);
        expect(snap.accumDt).toBeCloseTo(0.06, 6);
      }
      expectRegion(world, entity, [0.0, 0, 0.25, 1]);
    });

    it('multi-frame advance in a single tick when dt covers more than one frameDuration', () => {
      // Single tick with dt=0.35 / frameDuration=0.1 -> drains three full
      // frames in one call (currentFrame 0 -> 1 -> 2 -> 3) leaving
      // accumDt=0.05. Establishes that the inner advance loop fires more
      // than once per spriteAnimationTickSystem invocation; AC-04 +
      // section 2.5 q6 (while loop semantics).
      const world = new World();
      const regions = makeRegions();
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

      setDt(world, 0.35);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(3);
      expect(snap.accumDt).toBeCloseTo(0.05, 6);
      expectRegion(world, entity, [0.75, 0, 0.25, 1]);
    });
  });
}
