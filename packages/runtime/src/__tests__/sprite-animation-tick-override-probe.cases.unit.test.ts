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
  // --- from sprite-animation-tick-override-probe.test.ts ---

  function setDt(world: World, dt: number): void {
    world[worldInternal].getClockWriter().time.delta = dt;
  }

  function makeRegions(): Float32Array {
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

  function spawnAnim(world: World): EntityHandle {
    return world
      .spawn({
        component: SpriteAnimation,
        data: {
          frameCount: 4,
          frameDuration: 0.1,
          currentFrame: 0,
          accumDt: 0,
          regions: makeRegions(),
          playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
        },
      })
      .unwrap();
  }

  describe('spriteAnimationTickSystem override probe (M3 AC-14)', () => {
    it('first tick on a World that never used SpriteRegionOverride auto-adds the column without crashing', () => {
      const world = new World();
      const entity = spawnAnim(world);
      // SpriteRegionOverride is never spawned / registered into this World;
      // the old gate existed precisely because world.get on it would throw.
      expect(() => {
        const r = spriteAnimationTickSystem(world);
        expect(r.ok).toBe(true);
      }).not.toThrow();

      // The override column was materialised by the auto-add path.
      const sro = world.get(entity, SpriteRegionOverride);
      expect(sro.ok).toBe(true);
      if (sro.ok) expect(sro.value.region.length).toBe(4);
    });

    it('subsequent ticks set the region in place (steady-state already-present path)', () => {
      const world = new World();
      const entity = spawnAnim(world);

      // Tick 1: dt=0.12 > frameDuration=0.1 advances exactly one frame
      // (0->1, residue 0.02) and auto-adds the override column. 0.12 sits
      // clear of the 0.1 representability boundary so the advance is
      // unambiguous and drains only once.
      setDt(world, 0.12);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const sro = world.get(entity, SpriteRegionOverride).unwrap();
        // frame 1 slice: [0.25, 0, 0.25, 1].
        expect(sro.region[0]).toBeCloseTo(0.25, 6);
      }

      // Tick 2: another 0.12 (residue 0.02 + 0.12 = 0.14) drains exactly
      // once more (1->2); the column already exists, so the already-present
      // path runs `set` (no crash, region updated in place).
      setDt(world, 0.12);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const sro = world.get(entity, SpriteRegionOverride).unwrap();
        // frame 2 slice: [0.5, 0, 0.25, 1].
        expect(sro.region[0]).toBeCloseTo(0.5, 6);
      }
    });
  });
}
