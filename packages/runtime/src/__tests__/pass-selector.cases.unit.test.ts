// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { PassSelector } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { matchPass } from '../../../render/src/systems/pass-selector';

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
  // --- from pass-selector.test.ts ---
  describe('matchPass', () => {
    it('empty selector matches all pass tags', () => {
      const selector: PassSelector = {};
      expect(matchPass({ LightMode: 'Forward' }, selector)).toBe(true);
      expect(matchPass({}, selector)).toBe(true);
      expect(matchPass({ Queue: 'Background', RenderType: 'Opaque' }, selector)).toBe(true);
    });

    it('single key match — pass tags contain key and value is in selector list', () => {
      const selector: PassSelector = { LightMode: ['Forward', 'ShadowCaster'] };
      expect(matchPass({ LightMode: 'Forward' }, selector)).toBe(true);
      expect(matchPass({ LightMode: 'ShadowCaster' }, selector)).toBe(true);
    });

    it('single key no match — pass tags do not contain the key', () => {
      const selector: PassSelector = { LightMode: ['Forward'] };
      expect(matchPass({ Queue: 'Geometry' }, selector)).toBe(false);
    });

    it('single key no match — key exists but value not in selector list', () => {
      const selector: PassSelector = { LightMode: ['Forward'] };
      expect(matchPass({ LightMode: 'ShadowCaster' }, selector)).toBe(false);
    });

    it('multi-key all match', () => {
      const selector: PassSelector = {
        LightMode: ['Forward'],
        RenderType: ['Opaque', 'AlphaTest'],
      };
      expect(matchPass({ LightMode: 'Forward', RenderType: 'Opaque' }, selector)).toBe(true);
      expect(matchPass({ LightMode: 'Forward', RenderType: 'AlphaTest' }, selector)).toBe(true);
    });

    it('multi-key partial match — overall no match when any key fails', () => {
      const selector: PassSelector = {
        LightMode: ['Forward'],
        RenderType: ['Opaque'],
      };
      // RenderType key missing
      expect(matchPass({ LightMode: 'Forward' }, selector)).toBe(false);
      // RenderType value not in list
      expect(matchPass({ LightMode: 'Forward', RenderType: 'Transparent' }, selector)).toBe(false);
    });

    it('selector value is empty array — no match', () => {
      const selector: PassSelector = { LightMode: [] };
      expect(matchPass({ LightMode: 'Forward' }, selector)).toBe(false);
      expect(matchPass({}, selector)).toBe(false);
    });

    it('pass has extra tags beyond selector — still matches', () => {
      const selector: PassSelector = { LightMode: ['Forward'] };
      expect(matchPass({ LightMode: 'Forward', ExtraTag: 'whatever' }, selector)).toBe(true);
    });
  });
}
