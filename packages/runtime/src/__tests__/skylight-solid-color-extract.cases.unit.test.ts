// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { World } from '@forgeax/engine-ecs';
import { Skylight } from '@forgeax/engine-render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

afterEach(() => vi.restoreAllMocks());
// Split source block: skylight solid-color ambient extract.
// ── feat-20260612-skin-palette-per-frame-upload M2: extractFrame hasSkin ──
// Helpers shared by m2-1..m2-4 tests covering the T-21 placeholder retirement
// (real allocator wiring + 3 new SkinExtractErrorCode routings + assets===null
// bind-pose equivalence).

{
  describe('Skylight solid-color ambient extract (downstream #4)', () => {
    it('Skylight with no equirect still yields a snapshot (handle 0) with white default color', () => {
      const world = new World();
      world.spawn({ component: Skylight, data: {} });

      const frame = extractFrame(
        world,
        prepareExtractContext(world, { assets: null }),
      ) as unknown as {
        skylight?: { equirectHandle: number; color: readonly number[]; intensity: number };
        skylightCount: number;
      };

      expect(frame.skylightCount).toBe(1);
      expect(frame.skylight).toBeDefined();
      expect(frame.skylight?.equirectHandle).toBe(0);
      expect(frame.skylight?.intensity).toBe(1);
      expect(Array.from(frame.skylight?.color ?? [])).toEqual([1, 1, 1]);
    });

    it('Skylight color + intensity flow through to the snapshot verbatim', () => {
      const world = new World();
      world.spawn({
        component: Skylight,
        data: { color: [0.2, 0.4, 0.8], intensity: 0.5 },
      });

      const frame = extractFrame(
        world,
        prepareExtractContext(world, { assets: null }),
      ) as unknown as {
        skylight?: { equirectHandle: number; color: readonly number[]; intensity: number };
      };

      expect(frame.skylight?.equirectHandle).toBe(0);
      expect(frame.skylight?.intensity).toBeCloseTo(0.5, 5);
      const c = Array.from(frame.skylight?.color ?? []);
      expect(c[0]).toBeCloseTo(0.2, 5);
      expect(c[1]).toBeCloseTo(0.4, 5);
      expect(c[2]).toBeCloseTo(0.8, 5);
    });
  });
}
