// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { describe, expect, it, vi } from 'vitest';
import { assertStorageBufferCap } from '../../../render/src/light-buffer-layout';

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
  // --- from storage-buffer-caps.test.ts ---
  describe('assertStorageBufferCap (M3 w18)', () => {
    it('returns Result.ok when maxStorageBuffersPerShaderStage >= 4', () => {
      const result = assertStorageBufferCap(8);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toBe(true);
    });

    it('returns Result.ok at the exact threshold of 4', () => {
      const result = assertStorageBufferCap(4);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toBe(true);
    });

    it("returns Result.err with code 'limit-exceeded' when cap < 4", () => {
      const result = assertStorageBufferCap(3);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('limit-exceeded');
      // Hint guides the AI user toward the underlying device limit name.
      expect(result.error.hint).toContain('maxStorageBuffersPerShaderStage');
      expect(result.error.expected).toContain('4');
    });

    it('cap = 0 returns ok(false) — uniform-fallback signal (M3 w8)', () => {
      const result = assertStorageBufferCap(0);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toBe(false);
    });

    it('detail carries maxStorageBufferBindingSize / requestedBytes shape', () => {
      const result = assertStorageBufferCap(2);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.detail).toBeDefined();
      if (
        result.error.detail !== undefined &&
        'maxStorageBufferBindingSize' in result.error.detail
      ) {
        // Reuses LimitExceededDetail shape for AI-user property access parity
        // with the per-Instances limit-exceeded emit point in render-system-record.
        expect(typeof result.error.detail.maxStorageBufferBindingSize).toBe('number');
        expect(typeof result.error.detail.requestedBytes).toBe('number');
        expect(result.error.detail.maxStorageBufferBindingSize).toBe(2);
        expect(result.error.detail.requestedBytes).toBe(4);
      } else {
        throw new Error('expected LimitExceededDetail-shaped detail');
      }
    });
  });
}
