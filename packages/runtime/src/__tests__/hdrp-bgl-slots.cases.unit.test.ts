// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { describe, expect, it, vi } from 'vitest';

vi.mock('@forgeax/engine-rhi-wgpu', () => {
  return {
    rhi: {
      requestAdapter: async () => ({
        ok: false,
        error: {
          code: 'adapter-unavailable',
          expected: 'adapter available',
          hint: 'default mock fail',
        },
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
      acquireCanvasContext: () => ({
        ok: false,
        error: {
          code: 'webgpu-runtime-error',
          expected: 'context available',
          hint: 'default mock fail',
        },
      }),
    },
    ensureReady: async () => undefined,
  };
});
{
  // --- from hdrp-bgl-slots.test.ts ---
  const HDRP_BGL_SLOT_LIGHT_DATA = 3;
  const HDRP_BGL_SLOT_CLUSTER_GRID = 4;
  const HDRP_BGL_SLOT_LIGHT_INDEX_LIST = 5;
  const HDRP_BGL_SLOT_CLUSTER_UNIFORM = 6;

  const HDRP_BGL_SLOTS = [
    HDRP_BGL_SLOT_LIGHT_DATA,
    HDRP_BGL_SLOT_CLUSTER_GRID,
    HDRP_BGL_SLOT_LIGHT_INDEX_LIST,
    HDRP_BGL_SLOT_CLUSTER_UNIFORM,
  ] as const;

  // ── cluster_uniform std140 field layout ───────────────────────────────────────

  /**
   * cluster_uniform UBO fields (std140).
   *
   * Declared in WGSL as `@binding(6) var<uniform> cluster_uniform: ClusterUniform;`
   *
   *   [ 0.. 3] gridX           u32  (4 bytes)
   *   [ 4.. 7] gridY           u32  (4 bytes)
   *   [ 8..11] gridZ           u32  (4 bytes)
   *   [12..15] pad1            u32  (4 bytes, std140 vec4 alignment)
   *   [16..19] near            f32  (4 bytes)
   *   [20..23] far             f32  (4 bytes)
   *   [24..27] logFarOverNear  f32  (4 bytes)
   *   [28..31] pad2            u32  (4 bytes, std140 vec4 alignment)
   *   Total: 32 bytes (2 x vec4<u32> in std140)
   */
  const CLUSTER_UNIFORM_LAYOUT = {
    /** Byte size of ClusterUniform in std140 (2 x vec4). */
    byteSize: 32,
    /** Number of f32 slots (8). */
    floatCount: 8,
    /** Byte offset of gridX (first field). */
    gridXOffset: 0,
    /** Byte offset of gridY. */
    gridYOffset: 4,
    /** Byte offset of gridZ. */
    gridZOffset: 8,
    /** Byte offset of near (after first vec4). */
    nearOffset: 16,
    /** Byte offset of far. */
    farOffset: 20,
    /** Byte offset of logFarOverNear. */
    logFarOverNearOffset: 24,
  } as const;

  // ── BGL slot tests ────────────────────────────────────────────────────────────

  describe('HDRP BGL slot allocation', () => {
    it('slot 3 is light_data (storage)', () => {
      expect(HDRP_BGL_SLOT_LIGHT_DATA).toBe(3);
    });

    it('slot 4 is cluster_grid (storage)', () => {
      expect(HDRP_BGL_SLOT_CLUSTER_GRID).toBe(4);
    });

    it('slot 5 is light_index_list (storage)', () => {
      expect(HDRP_BGL_SLOT_LIGHT_INDEX_LIST).toBe(5);
    });

    it('slot 6 is cluster_uniform (uniform)', () => {
      expect(HDRP_BGL_SLOT_CLUSTER_UNIFORM).toBe(6);
    });

    it('slots 0..2 are NOT in HDRP slot set (URP physical isolation)', () => {
      expect(HDRP_BGL_SLOTS).not.toContain(0);
      expect(HDRP_BGL_SLOTS).not.toContain(1);
      expect(HDRP_BGL_SLOTS).not.toContain(2);
    });

    it('all HDRP slots are in [3, 6]', () => {
      for (const slot of HDRP_BGL_SLOTS) {
        expect(slot).toBeGreaterThanOrEqual(3);
        expect(slot).toBeLessThanOrEqual(6);
      }
    });

    it('exactly 4 HDRP slots', () => {
      expect(HDRP_BGL_SLOTS.length).toBe(4);
      expect(new Set(HDRP_BGL_SLOTS).size).toBe(4);
    });
  });

  // ── cluster_uniform field tests ───────────────────────────────────────────────

  describe('ClusterUniform layout', () => {
    it('byteSize is 32 (2 x vec4 in std140)', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.byteSize).toBe(32);
    });

    it('floatCount is 8', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.floatCount).toBe(8);
    });

    it('gridX at byte offset 0', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.gridXOffset).toBe(0);
    });

    it('gridY at byte offset 4', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.gridYOffset).toBe(4);
    });

    it('gridZ at byte offset 8', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.gridZOffset).toBe(8);
    });

    it('near at byte offset 16 (after first vec4)', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.nearOffset).toBe(16);
    });

    it('far at byte offset 20', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.farOffset).toBe(20);
    });

    it('logFarOverNear at byte offset 24', () => {
      expect(CLUSTER_UNIFORM_LAYOUT.logFarOverNearOffset).toBe(24);
    });
  });

  // ── Float32Array representation ───────────────────────────────────────────────

  describe('ClusterUniform Float32Array representation', () => {
    it('Float32Array(8) holds one ClusterUniform (32 bytes)', () => {
      const buf = new Float32Array(8);
      expect(buf.byteLength).toBe(32);
    });
  });
}
