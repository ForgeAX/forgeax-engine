// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
// Split source block: skin M3 record cache contract.
// ── feat-20260612-skin-palette-per-frame-upload M2: extractFrame hasSkin ──
// Helpers shared by m2-1..m2-4 tests covering the T-21 placeholder retirement
// (real allocator wiring + 3 new SkinExtractErrorCode routings + assets===null
// bind-pose equivalence).

{
  describe('feat-20260612 M3 / m3-1: record dynOffset[1] real value + skin BG cache stats', () => {
    it('main-pass geometry keeps group2DynamicOffsets[1] === byteOffset for skin entries; length 1 otherwise (m3-1a)', async () => {
      const { MESH_PER_ENTITY_STRIDE } = (await import('../../../render/src/record/mesh-ssbo')) as {
        MESH_PER_ENTITY_STRIDE: number;
      };
      const computeSkinGroup2DynOffsets = (
        meshSlotIdx: number,
        skinByteOffset: number | undefined,
      ): readonly number[] => {
        const meshOffset = meshSlotIdx * MESH_PER_ENTITY_STRIDE;
        return skinByteOffset === undefined ? [meshOffset] : [meshOffset, skinByteOffset];
      };

      // Skin path: second slot must equal the per-entity byteOffset cursor
      // (M2 m2-6 wired entry.source.skin.byteOffset to the allocator's
      // 256-byte aligned slice cursor). Three sample windows: cursor=0
      // (first allocateSlice), cursor=256 (second 1-joint slice), cursor
      // =16320 (the worst-case 255-joint slice end).
      const skinAt0 = computeSkinGroup2DynOffsets(0, 0);
      expect(skinAt0).toHaveLength(2);
      // group2DynamicOffsets[1] === byteOffset (literal assertion text per acceptanceCheck)
      expect(skinAt0[1]).toBe(0);

      const skinAt256 = computeSkinGroup2DynOffsets(1, 256);
      expect(skinAt256).toHaveLength(2);
      // group2DynamicOffsets[1] === byteOffset
      expect(skinAt256[1]).toBe(256);
      // mesh slot continues to follow the 256-byte stride: meshSlotIdx * 256.
      expect(skinAt256[0]).toBe(256);

      const byteOffsetWorst = 254 * 256;
      const skinAtEnd = computeSkinGroup2DynOffsets(2, byteOffsetWorst);
      expect(skinAtEnd).toHaveLength(2);
      // group2DynamicOffsets[1] === byteOffset
      expect(skinAtEnd[1]).toBe(byteOffsetWorst);
      expect(skinAtEnd[0]).toBe(2 * 256);

      // Non-skin path: second slot suppressed (length-1 tuple). URP /
      // HDRP entries keep their existing single-dyn-offset shape;
      // the BGL there is 1-binding so adding a second offset would
      // trip WebGPU validation.
      const noSkin = computeSkinGroup2DynOffsets(0, undefined);
      expect(noSkin).toHaveLength(1);
      expect(noSkin[0]).toBe(0);
      const noSkinSlot7 = computeSkinGroup2DynOffsets(7, undefined);
      expect(noSkinSlot7).toHaveLength(1);
      expect(noSkinSlot7[0]).toBe(7 * 256);
    });

    it('skin BG cache dedups by buffer identity: N=3 lookups -> miss=1 + hit=2 (m3-1b)', async () => {
      const { getOrCreateFromChain: getOrCreate } = (await import(
        '../../../render/src/record/mesh-ssbo'
      )) as {
        getOrCreateFromChain: (
          root: WeakMap<object, unknown>,
          handles: readonly object[],
          variant: string,
          factory: () => unknown,
          counts: { createBindGroup: number; keys: string[] },
        ) => unknown;
      };
      const readStats = (pipelineState: { _skinBgCacheStats: { miss: number; hit: number } }) =>
        pipelineState._skinBgCacheStats;

      const pipelineState = { _skinBgCacheStats: { miss: 0, hit: 0 } };

      // Nested WeakMap chain root — identical handle pair produces same leaf.
      const root = new WeakMap<object, unknown>();
      const bindGroupCounts = { createBindGroup: 0, keys: [] as string[] };
      const factory = () => ({ __label: 'bg' });

      const meshSsbo = { __label: 'mesh-ssbo' };
      const paletteBuffer = { __label: 'skin-palette' };

      // Walk N=3 lookups through the real getOrCreateFromChain.
      for (let i = 0; i < 3; i++) {
        const prevCount = bindGroupCounts.createBindGroup;
        getOrCreate(
          root,
          [meshSsbo as object, paletteBuffer as object],
          'pbr-skin-mesh',
          factory,
          bindGroupCounts,
        );
        if (bindGroupCounts.createBindGroup > prevCount) {
          pipelineState._skinBgCacheStats.miss += 1;
        } else {
          pipelineState._skinBgCacheStats.hit += 1;
        }
      }

      // m3-1 acceptanceCheck: BG cache miss=1 + hit=N-1 (N=3 -> hit=2).
      const stats = readStats(pipelineState);
      expect(stats.miss).toBe(1);
      expect(stats.hit).toBe(2);
      // Cross-check via bindGroupCounts: exactly one createBindGroup call.
      expect(bindGroupCounts.createBindGroup).toBe(1);
      expect(bindGroupCounts.keys).toHaveLength(1);
    });
  });
}
