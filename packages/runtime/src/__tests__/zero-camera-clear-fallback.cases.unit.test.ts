// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZERO_CAMERA_CLEAR_FALLBACK } from '../../../render/src/record/frame-snapshot';

afterEach(() => vi.restoreAllMocks());
{
  // --- from zero-camera-clear-fallback.test.ts ---

  describe('zero-Camera fallback clear color (TASK-003 / AC-05)', () => {
    it('ZERO_CAMERA_CLEAR_FALLBACK equals [0, 0, 0, 1] (opaque black)', () => {
      expect(Array.from(ZERO_CAMERA_CLEAR_FALLBACK)).toEqual([0, 0, 0, 1]);
    });

    it('alpha component is 1 (opaque), not 0 (transparent)', () => {
      expect(ZERO_CAMERA_CLEAR_FALLBACK[3]).toBe(1);
    });

    it('does not match the retired dark-slate sentinel [0.06, 0.06, 0.08, 1.0]', () => {
      expect(ZERO_CAMERA_CLEAR_FALLBACK[0]).not.toBeCloseTo(0.06, 3);
      expect(ZERO_CAMERA_CLEAR_FALLBACK[1]).not.toBeCloseTo(0.06, 3);
      expect(ZERO_CAMERA_CLEAR_FALLBACK[2]).not.toBeCloseTo(0.08, 3);
    });

    it('all three RGB channels are exactly 0 (pure black)', () => {
      expect(ZERO_CAMERA_CLEAR_FALLBACK[0]).toBe(0);
      expect(ZERO_CAMERA_CLEAR_FALLBACK[1]).toBe(0);
      expect(ZERO_CAMERA_CLEAR_FALLBACK[2]).toBe(0);
    });
  });
}
