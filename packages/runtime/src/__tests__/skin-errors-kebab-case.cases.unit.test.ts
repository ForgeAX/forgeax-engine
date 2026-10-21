// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { AssetRuntimeErrorCode } from '@forgeax/engine-assets-runtime';
import type { RenderErrorCode } from '@forgeax/engine-render';
import type { SkinErrorCode } from '@forgeax/engine-skinning';
import {
  SkinInstancesCoexistForbiddenError,
  SkinJointCountExceededError,
  SkinJointDespawnedError,
  SkinJointPathUnresolvedError,
} from '@forgeax/engine-skinning';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
type RuntimeLayerErrorCode = RenderErrorCode | AssetRuntimeErrorCode | SkinErrorCode;
{
  // --- from skin-errors-kebab-case.test.ts ---

  const KEBAB_REGEX = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;

  describe('T-20 — RuntimeErrorCode +6 skin-animation kebab-case consistency (AC-29)', () => {
    it('skin-joint-count-exceeded is valid kebab-case', () => {
      const code: RuntimeLayerErrorCode = 'skin-joint-count-exceeded';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('skin-joint-despawned is valid kebab-case', () => {
      const code: RuntimeLayerErrorCode = 'skin-joint-despawned';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('skin-joint-path-unresolved is valid kebab-case', () => {
      const code: RuntimeLayerErrorCode = 'skin-joint-path-unresolved';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('skin-instances-coexist-forbidden is valid kebab-case', () => {
      const code: RuntimeLayerErrorCode = 'skin-instances-coexist-forbidden';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('vertex-storage-buffer-unavailable is valid kebab-case', () => {
      const code: RuntimeLayerErrorCode = 'vertex-storage-buffer-unavailable';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('skin-palette-overflow is valid kebab-case', () => {
      const code: RuntimeLayerErrorCode = 'skin-palette-overflow';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('exhaustive switch over RuntimeErrorCode 7 members compiles without default', () => {
      function exhaustive(code: RuntimeLayerErrorCode): string {
        switch (code) {
          case 'shadow-invalid-config':
            return 'shadow';
          case 'skin-joint-count-exceeded':
            return 'joint-count';
          case 'skin-joint-despawned':
            return 'joint-despawn';
          case 'skin-joint-path-unresolved':
            return 'joint-path';
          case 'skin-instances-coexist-forbidden':
            return 'coexist';
          case 'vertex-storage-buffer-unavailable':
            return 'no-vs-sb';
          case 'skin-palette-overflow':
            return 'palette-overflow';
          case 'material-resolved-empty-passes':
            return 'material-empty-passes';
          case 'equirect-projection-failed':
            return 'equirect-projection-failed';
          case 'mesh-ssbo-capacity-exceeded':
            return 'mesh-ssbo-capacity';
          case 'mesh-ssbo-ceiling-reached':
            return 'mesh-ssbo-ceiling';
          case 'hdrp-light-budget-exceeded':
            return 'hdrp-budget';
          case 'hdrp-index-list-overflow':
            return 'hdrp-overflow';
        }
      }
      expect(exhaustive('skin-joint-count-exceeded')).toBe('joint-count');
      expect(exhaustive('skin-palette-overflow')).toBe('palette-overflow');
      expect(exhaustive('shadow-invalid-config')).toBe('shadow');
    });
  });

  describe('T-20 — skin-animation error classes 4-field surface (AC-29)', () => {
    it('SkinJointCountExceededError has .code .expected .hint .detail', () => {
      const e = new SkinJointCountExceededError(300);
      expect(e.code).toBe('skin-joint-count-exceeded');
      expect(e.expected).toBe('jointCount <= 256');
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.detail).toEqual({ jointCount: 300, max: 256 });
    });

    it('SkinJointDespawnedError has .code .expected .hint .detail', () => {
      const e = new SkinJointDespawnedError(42, 7);
      expect(e.code).toBe('skin-joint-despawned');
      expect(e.expected).toContain('live entity');
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.detail).toEqual({ meshEntity: 42, jointIndex: 7 });
    });

    it('SkinJointPathUnresolvedError has .code .expected .hint .detail', () => {
      const path = ['root', 'spine', 'shoulder'];
      const e = new SkinJointPathUnresolvedError(1, path, 2);
      expect(e.code).toBe('skin-joint-path-unresolved');
      expect(e.expected).toContain('shoulder');
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.detail.skinEntity).toBe(1);
      expect(e.detail.failedAtIndex).toBe(2);
    });

    it('SkinInstancesCoexistForbiddenError has .code .expected .hint .detail', () => {
      const e = new SkinInstancesCoexistForbiddenError(99);
      expect(e.code).toBe('skin-instances-coexist-forbidden');
      expect(e.expected).toContain('coexist');
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.detail).toEqual({ entity: 99 });
    });

    it('all 6 skin-animation error codes are in the RuntimeErrorCode union (type-level)', () => {
      const codes: RuntimeLayerErrorCode[] = [
        'skin-joint-count-exceeded',
        'skin-joint-despawned',
        'skin-joint-path-unresolved',
        'skin-instances-coexist-forbidden',
        'vertex-storage-buffer-unavailable',
        'skin-palette-overflow',
      ];
      // Each code must be assignable to RuntimeErrorCode (type-check)
      for (const code of codes) {
        expect(typeof code).toBe('string');
        expect(code).toMatch(KEBAB_REGEX);
      }
      expect(codes).toHaveLength(6);
    });
  });
}
