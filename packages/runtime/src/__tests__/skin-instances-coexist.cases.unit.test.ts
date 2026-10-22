// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { SkinInstancesCoexistForbiddenError } from '@forgeax/engine-skinning';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
{
  // --- from skin-instances-coexist.test.ts ---

  describe('skin instances coexistence', () => {
    it('SkinInstancesCoexistForbiddenError has correct code and detail', () => {
      const entity = 42;
      const e = new SkinInstancesCoexistForbiddenError(entity);
      expect(e.code).toBe('skin-instances-coexist-forbidden');
      expect(e.detail.entity).toBe(entity);
      expect(e.expected).toContain('Skin');
      expect(e.expected).toContain('Instances');
      expect(e.hint).toContain('OOS-skin-instances-coexist');
    });
  });
}
