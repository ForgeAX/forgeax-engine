// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { describe, expect, it, vi } from 'vitest';
import { validateClusterGrid } from '../../../render/src/pipeline/standard-pipeline';

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
  // --- from hdrp-grid-invalid.test.ts ---
  describe('hdrp-grid-invalid', () => {
    describe('validateClusterGrid', () => {
      // AC-23 scenario (a): x === 0
      it('rejects x=0 with code hdrp-grid-invalid and hint contains "positive integer"', () => {
        const result = validateClusterGrid({ x: 0, y: 9, z: 24 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('standard-profile-invalid');
          expect(result.error.hint).toContain('positive integer');
          expect(result.error.expected).toContain('[1, 64]');
          expect(result.error.detail).toEqual({
            field: 'clusterGrid',
            actual: { x: 0, y: 9, z: 24 },
          });
        }
      });

      // AC-23 scenario (b): non-integer x=1.5
      it('rejects x=1.5 (non-integer) with code hdrp-grid-invalid', () => {
        const result = validateClusterGrid({ x: 1.5, y: 9, z: 24 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('standard-profile-invalid');
          expect(result.error.hint).toContain('positive integer');
          expect(result.error.detail).toEqual({
            field: 'clusterGrid',
            actual: { x: 1.5, y: 9, z: 24 },
          });
        }
      });

      // AC-23 scenario (c): y === -1
      it('rejects y=-1 with code hdrp-grid-invalid', () => {
        const result = validateClusterGrid({ x: 16, y: -1, z: 24 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('standard-profile-invalid');
          expect(result.error.hint).toContain('positive integer');
          expect(result.error.detail).toEqual({
            field: 'clusterGrid',
            actual: { x: 16, y: -1, z: 24 },
          });
        }
      });

      // AC-23 scenario (d): z=65 (>64)
      it('rejects z=65 (>64) with hint containing "[1, 64]"', () => {
        const result = validateClusterGrid({ x: 16, y: 9, z: 65 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('standard-profile-invalid');
          expect(result.error.hint).toContain('[1, 64]');
          expect(result.error.expected).toContain('[1, 64]');
          expect(result.error.detail).toEqual({
            field: 'clusterGrid',
            actual: { x: 16, y: 9, z: 65 },
          });
        }
      });

      // Happy path: valid grid
      it('accepts valid grid {16,9,24}', () => {
        const result = validateClusterGrid({ x: 16, y: 9, z: 24 });
        expect(result.ok).toBe(true);
      });

      // Boundary valid: grid at edges
      it('accepts boundary grid {1,1,1}', () => {
        const result = validateClusterGrid({ x: 1, y: 1, z: 1 });
        expect(result.ok).toBe(true);
      });

      it('accepts boundary grid {64,64,64}', () => {
        const result = validateClusterGrid({ x: 64, y: 64, z: 64 });
        expect(result.ok).toBe(true);
      });
    });

    describe('StandardProfileInvalidError shape', () => {
      // AC-23: charter P3 triple-set .code / .hint / .expected + .detail.{x,y,z}
      it('carries charter P3 triple-set with detail', () => {
        const err = validateClusterGrid({ x: 0, y: 9, z: 24 });
        expect(err.ok).toBe(false);
        if (err.ok) return;
        expect(err.error.code).toBe('standard-profile-invalid');
        expect(err.error.hint).toContain('positive integer');
        expect(err.error.expected).toContain('[1, 64]');
        expect(err.error.detail).toEqual({ field: 'clusterGrid', actual: { x: 0, y: 9, z: 24 } });
      });
    });
  });
}
