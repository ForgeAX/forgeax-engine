// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { warnMultiLightDirectional } from '../../../render/src/record/helpers';

afterEach(() => vi.restoreAllMocks());
{
  // --- from render-system-record-warn-once.test.ts ---

  function makeFrameState() {
    return {
      warnedMultiLightDirectional: false,
    };
  }

  describe('warnMultiLightDirectional (M3 / AC-04 / AC-05 (c))', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('first hit fires console.warn and sets the latch', () => {
      const fs = makeFrameState();
      warnMultiLightDirectional(fs, 2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(fs.warnedMultiLightDirectional).toBe(true);
      const call = warnSpy.mock.calls[0];
      expect(call[0]).toBeTypeOf('string');
      expect(
        (call[0] as string).startsWith('[forgeax] render-system-multi-light directional:'),
      ).toBe(true);
      expect(call[1]).toMatchObject({
        code: 'render-system-multi-light',
        expected: 'at most 1 directional',
        detail: { type: 'directional', got: 2 },
      });
    });

    it('subsequent frames stay silent (warn-once)', () => {
      const fs = makeFrameState();
      warnMultiLightDirectional(fs, 2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) {
        warnMultiLightDirectional(fs, 2);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(fs.warnedMultiLightDirectional).toBe(true);
    });

    it('no-op when directionalCount <= 1 (no fire, latch stays false)', () => {
      const fs = makeFrameState();
      warnMultiLightDirectional(fs, 1);
      warnMultiLightDirectional(fs, 0);
      expect(warnSpy).toHaveBeenCalledTimes(0);
      expect(fs.warnedMultiLightDirectional).toBe(false);
    });

    it('production gate suppresses output but still flips latch', () => {
      const savedEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
        ?.NODE_ENV;
      try {
        const fs = makeFrameState();
        warnMultiLightDirectional(fs, 2, { env: { NODE_ENV: 'production' } });
        expect(warnSpy).toHaveBeenCalledTimes(0);
        expect(fs.warnedMultiLightDirectional).toBe(true);
      } finally {
        if (savedEnv !== undefined) {
          const g = globalThis as unknown as { process?: { env?: { NODE_ENV?: string } } };
          if (!g.process) g.process = {};
          if (!g.process.env) g.process.env = {};
          g.process.env.NODE_ENV = savedEnv;
        }
      }
    });
  });
}
