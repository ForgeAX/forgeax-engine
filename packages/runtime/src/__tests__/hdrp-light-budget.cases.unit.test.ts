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
  // --- from hdrp-light-budget.test.ts ---

  // ── Budget gate unit logic (the pure gate w23 will embed) ─────────────────────

  const HDRP_BUDGET = 256;

  function enforceLightBudget(
    totalLightCount: number,
    oncePerFrameFired: Set<string>,
    fire: (code: string, errors: unknown[]) => void,
  ): number {
    if (totalLightCount <= HDRP_BUDGET) {
      return totalLightCount;
    }
    // Truncate to budget.
    const truncated = HDRP_BUDGET;
    if (!oncePerFrameFired.has('hdrp-light-budget-exceeded')) {
      oncePerFrameFired.add('hdrp-light-budget-exceeded');
      fire('hdrp-light-budget-exceeded', [totalLightCount, HDRP_BUDGET]);
    }
    return truncated;
  }

  describe('HDRP light budget enforcement gate (AC-06/AC-07)', () => {
    it('256 lights: no fire, returns 256 (AC-06 boundary)', () => {
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(256, fired, fireFn);
      expect(result).toBe(256);
      expect(fired.size).toBe(0);
      expect(errors.length).toBe(0);
    });

    it('257 lights: fires once, returns 256 (AC-07 truncation)', () => {
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(257, fired, fireFn);
      expect(result).toBe(256);
      expect(fired.size).toBe(1);
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(true);
      expect(errors.length).toBe(1);
      expect(errors[0]?.actual).toBe(257);
      expect(errors[0]?.budget).toBe(256);
    });

    it('same-frame subsequent overflow suppressed (warn-once-per-frame-bucket)', () => {
      // Simulate frame already having fired the budget error.
      const fired = new Set<string>(['hdrp-light-budget-exceeded']);
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      // Even with 300 lights on the same frame, it should not fire again.
      const result = enforceLightBudget(300, fired, fireFn);
      expect(result).toBe(256);
      expect(errors.length).toBe(0);
    });

    it('second frame fires again (fresh bucket)', () => {
      // New frame: empty Set.
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(258, fired, fireFn);
      expect(result).toBe(256);
      expect(errors.length).toBe(1);
      expect(errors[0]?.actual).toBe(258);
      expect(errors[0]?.budget).toBe(256);
    });

    it('second frame with exactly 256 does not fire (fresh bucket, under budget)', () => {
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(256, fired, fireFn);
      expect(result).toBe(256);
      expect(errors.length).toBe(0);
    });

    it('0 lights returns 0 (empty scene, no fire)', () => {
      const fired = new Set<string>();
      const errors: Array<{ code: string; actual: number; budget: number }> = [];
      const fireFn = (_code: string, args: unknown[]) => {
        errors.push({
          code: 'hdrp-light-budget-exceeded',
          actual: args[0] as number,
          budget: args[1] as number,
        });
      };

      const result = enforceLightBudget(0, fired, fireFn);
      expect(result).toBe(0);
      expect(errors.length).toBe(0);
    });

    it('HDRP_BUDGET constant must be 256 (D-scope anchor)', () => {
      expect(HDRP_BUDGET).toBe(256);
    });
  });

  // ── Integration pattern: once-per-frame Set complements existing hdrpOncePerFrameFired ──

  describe('hdrpOncePerFrameFired Set dedup semantics', () => {
    it('empty set allows first fire', () => {
      const fired = new Set<string>();
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(false);
    });

    it('set with entry suppresses subsequent fires on the same code', () => {
      const fired = new Set<string>(['hdrp-light-budget-exceeded']);
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(true);
    });

    it('hdrp-light-budget-exceeded is independent from hdrp-index-list-overflow', () => {
      const fired = new Set<string>(['hdrp-index-list-overflow']);
      // Budget-exceeded should still fire even if index-list-overflow already fired this frame.
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(false);
      expect(fired.has('hdrp-index-list-overflow')).toBe(true);
    });

    it('clearing the set (new frame) allows re-fire', () => {
      const fired = new Set<string>(['hdrp-light-budget-exceeded']);
      fired.clear();
      expect(fired.has('hdrp-light-budget-exceeded')).toBe(false);
      // The recordFrame entry clears hdrpOncePerFrameFired when frameNumber increments.
      // This test verifies the clear() semantics match the expected new-frame behaviour.
    });
  });
}
