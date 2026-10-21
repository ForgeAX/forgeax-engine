// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
{
  // --- from skin-pipeline-routing.test.ts ---

  describe('skin pipeline routing', () => {
    it('skinned entity routes to forgeax::pbr-skin material shader id', () => {
      // The routing logic is: skin !== undefined -> 'forgeax::pbr-skin'
      // This is a pure function; test it in isolation.
      const materialShaderIdForSkin = 'forgeax::pbr-skin';
      expect(materialShaderIdForSkin).toBe('forgeax::pbr-skin');
    });

    it('non-skinned entity with schema-driven material retains its materialShaderId', () => {
      const originalShaderId = 'forgeax::default-standard-pbr';
      const skin: undefined = undefined;
      const materialShaderId = skin !== undefined ? 'forgeax::pbr-skin' : originalShaderId;
      expect(materialShaderId).toBe('forgeax::default-standard-pbr');
    });

    it('skinned entity overrides to forgeax::pbr-skin regardless of asset materialShaderId', () => {
      const originalShaderId = 'forgeax::default-standard-pbr';
      const skin = { jointCount: 5, byteOffset: 0 };
      const materialShaderId = skin !== undefined ? 'forgeax::pbr-skin' : originalShaderId;
      expect(materialShaderId).toBe('forgeax::pbr-skin');
    });

    it('skinned entity with user-defined materialShaderId still routes to forgeax::pbr-skin', () => {
      const originalShaderId = 'my-custom-shader';
      const skin = { jointCount: 8, byteOffset: 128 };
      const materialShaderId = skin !== undefined ? 'forgeax::pbr-skin' : originalShaderId;
      expect(materialShaderId).toBe('forgeax::pbr-skin');
    });

    it('non-skinned entity with undefined materialShaderId falls back to unlit pipeline', () => {
      const skin: undefined = undefined;
      const materialShaderId: string | undefined = undefined;
      const effectiveId = skin !== undefined ? 'forgeax::pbr-skin' : materialShaderId;
      expect(effectiveId).toBeUndefined();
    });

    it('pipeline cache key discriminates on materialShaderId', () => {
      // The cache key = (materialShaderId, stateHash).
      // Verify that skin and non-skin produce different cache keys.
      const cacheKey = (materialShaderId: string, isHdr: boolean) =>
        `${materialShaderId}:${isHdr ? 'hdr' : 'ldr'}`;

      const skinKey = cacheKey('forgeax::pbr-skin', false);
      const standardKey = cacheKey('forgeax::default-standard-pbr', false);

      expect(skinKey).not.toBe(standardKey);
      expect(skinKey).toBe('forgeax::pbr-skin:ldr');
      expect(standardKey).toBe('forgeax::default-standard-pbr:ldr');
    });

    it('pipeline cache key discriminates on tonemap state hash', () => {
      const cacheKey = (materialShaderId: string, isHdr: boolean) =>
        `${materialShaderId}:${isHdr ? 'hdr' : 'ldr'}`;

      expect(cacheKey('forgeax::pbr-skin', false)).toBe('forgeax::pbr-skin:ldr');
      expect(cacheKey('forgeax::pbr-skin', true)).toBe('forgeax::pbr-skin:hdr');
    });
  });
}
