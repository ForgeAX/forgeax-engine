// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { describe, expect, it, vi } from 'vitest';
import { createEngineMetrics } from '../../../render/src/engine-metrics';

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
  // --- from engine-metrics.test.ts ---
  describe('EngineMetrics public API (feat-20260527-sprite-nineslice M4 / w16)', () => {
    it('(1) increment(name) lands as snapshot()[name] === 1', () => {
      const m = createEngineMetrics();
      m.increment('nineslice.scale-too-small');
      expect(m.snapshot()['nineslice.scale-too-small']).toBe(1);
    });

    it('(2) repeat increment(name) accumulates (N calls -> snapshot()[name] === N)', () => {
      const m = createEngineMetrics();
      for (let i = 0; i < 5; i++) m.increment('nineslice.tile-needs-repeat-sampler');
      expect(m.snapshot()['nineslice.tile-needs-repeat-sampler']).toBe(5);
    });

    it('(3) reset() drops every counter back to an empty snapshot', () => {
      const m = createEngineMetrics();
      m.increment('nineslice.scale-too-small');
      m.increment('nineslice.tile-needs-repeat-sampler');
      m.reset();
      expect(m.snapshot()).toEqual({});
    });

    it('(4) snapshot() returns a frozen object decoupled from later increments', () => {
      const m = createEngineMetrics();
      m.increment('nineslice.scale-too-small');
      const snap = m.snapshot();
      expect(Object.isFrozen(snap)).toBe(true);
      // External mutation is ignored (strict-mode throw is also acceptable;
      // the assertion is "the registry is not affected").
      try {
        (snap as Record<string, number>)['nineslice.scale-too-small'] = 99;
      } catch {
        // strict-mode TypeError is fine.
      }
      expect(m.snapshot()['nineslice.scale-too-small']).toBe(1);
      // A later increment does NOT retroactively alter the earlier snapshot.
      m.increment('nineslice.scale-too-small');
      expect(snap['nineslice.scale-too-small']).toBe(1);
      expect(m.snapshot()['nineslice.scale-too-small']).toBe(2);
    });

    it('(5) two EngineMetrics instances are isolated (D-5 candidate 1)', () => {
      const a = createEngineMetrics();
      const b = createEngineMetrics();
      a.increment('nineslice.scale-too-small');
      a.increment('nineslice.scale-too-small');
      b.increment('nineslice.scale-too-small');
      expect(a.snapshot()['nineslice.scale-too-small']).toBe(2);
      expect(b.snapshot()['nineslice.scale-too-small']).toBe(1);
    });
  });
}
