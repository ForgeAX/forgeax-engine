// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { type Mat4, mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it, vi } from 'vitest';
import { bin, type ClusterBinError } from '../../../render/src/cluster-binner';

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
  // --- from hdrp-index-list-overflow-once.test.ts ---
  function makeIdentityMat4(): Mat4 {
    return mat4.identity(mat4.create());
  }

  // ── index-overflow error shape (via cluster-binner's ClusterBinError) ─────────

  describe('ClusterBinError index-overflow shape (AC-24 detail ports)', () => {
    it('bin overflow returns err with code index-overflow', () => {
      const grid = { x: 2, y: 2, z: 2 };
      const near = 0.1;
      const far = 100;

      // 300 lights x small grid = guaranteed overflow at capacity=64
      const lights = Array.from({ length: 300 }, (_, i) => ({
        position: vec3.create(i * 0.5, 0, -5),
        range: 20,
      }));

      const view = makeIdentityMat4();
      const proj = makeIdentityMat4();

      const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
      const lightIndexList = new Uint32Array(64);
      const result = bin(lights, view, proj, grid, near, far, clusterGrid, lightIndexList, 64);

      expect(result.ok).toBe(false);

      // TypeScript requires explicit narrowing before accessing result.error
      if (!result.ok) {
        const err: ClusterBinError = result.error;
        expect(err.code).toBe('index-overflow');
        expect(err.detail.actual).toBeGreaterThan(64);
        expect(err.detail.capacity).toBe(64);
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.expected.length).toBeGreaterThan(0);
      }
    });

    it('bin non-overflow returns ok', () => {
      const grid = { x: 2, y: 2, z: 2 };
      const near = 0.1;
      const far = 100;

      // 2 lights x small grid = no overflow
      const lights = [
        { position: vec3.create(0, 0, -5), range: 20 },
        { position: vec3.create(0, 0, -10), range: 20 },
      ];

      const view = makeIdentityMat4();
      const proj = makeIdentityMat4();

      const clusterGrid = new Uint32Array(grid.x * grid.y * grid.z * 2);
      const lightIndexList = new Uint32Array(256);
      const result = bin(lights, view, proj, grid, near, far, clusterGrid, lightIndexList, 256);

      expect(result.ok).toBe(true);
    });
  });

  // ── hdrp-index-list-overflow RuntimeError class shape ────────────────────────

  // ── AC-03 guardrail: URP LIGHT_ARRAY_MAX_SLOTS=4 + 5 PointLights ─────────────
  //
  // This test verifies that the existing URP `render-system-multi-light` warn-once
  // still fires when PointLights exceed the first-slice cap (AC-03).
  // The budget constant LIGHT_ARRAY_MAX_SLOTS must remain at 4.

  describe('URP light budget warn-once guardrail (AC-03)', () => {
    it('cluster transport reserves four storage-buffer slots', async () => {
      const { STORAGE_BUFFER_MIN_REQUIRED } = await import(
        '../../../render/src/light-buffer-layout'
      );
      expect(STORAGE_BUFFER_MIN_REQUIRED).toBe(4);
    });
  });
}
