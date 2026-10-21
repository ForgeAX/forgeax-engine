// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import {
  SkinInstancesCoexistForbiddenError,
  SkinJointDespawnedError,
} from '@forgeax/engine-skinning';
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

    it('SkinJointDespawnedError has correct code and detail', () => {
      const meshEntity = 7;
      const jointIndex = 3;
      const e = new SkinJointDespawnedError(meshEntity, jointIndex);
      expect(e.code).toBe('skin-joint-despawned');
      expect(e.detail.meshEntity).toBe(meshEntity);
      expect(e.detail.jointIndex).toBe(jointIndex);
      expect(e.expected).toContain('live');
      expect(e.hint).toContain('OOS-skin-joint-respawn');
    });
  });
}
