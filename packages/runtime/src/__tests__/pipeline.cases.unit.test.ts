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
  // ── Light budget error class shape ─────────────────────────────────────────────

  // ── Index list overflow error class shape ─────────────────────────────────────

  // ── Caps gate 5 scenarios (AC-17) ─────────────────────────────────────────────
  // Note: the caps router lives in hdrp-pipeline.ts. These tests verify
  // the installPipeline behaviour by mocking device.caps.

  describe('HDRP caps gate 5 scenarios (AC-17)', () => {
    it('caps=0 (uniform fallback) yields ok(false)', async () => {
      const { assertStorageBufferCap } = await import('../../../render/src/light-buffer-layout');
      const result = assertStorageBufferCap(0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    it('caps=1 (insufficient, partial storage) yields err', async () => {
      const { assertStorageBufferCap } = await import('../../../render/src/light-buffer-layout');
      const result = assertStorageBufferCap(1);
      expect(result.ok).toBe(false);
    });

    it('caps=3 (insufficient, below 4) yields err', async () => {
      const { assertStorageBufferCap } = await import('../../../render/src/light-buffer-layout');
      const result = assertStorageBufferCap(3);
      expect(result.ok).toBe(false);
    });

    it('caps=4 (sufficient) yields ok(true)', async () => {
      const { assertStorageBufferCap } = await import('../../../render/src/light-buffer-layout');
      const result = assertStorageBufferCap(4);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('caps=8 (sufficient, above minimum) yields ok(true)', async () => {
      const { assertStorageBufferCap } = await import('../../../render/src/light-buffer-layout');
      const result = assertStorageBufferCap(8);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });
  });

  // ── RuntimeErrorCode union member count (12 -> 15) ───────────────────────────
}
