import { describe, expect, it } from 'vitest';
import {
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
} from '../component-validation';

describe('sprite-instances-error-codes.test.ts', () => {
  describe('EcsErrorCode +3 — sprite-instances-* family (M1 w1)', () => {
    it('type-level: 3 new literals are assignable to EcsErrorCode', () => {
      const a = 'sprite-instances-count-mismatch';
      const b = 'sprite-instances-requires-sprite-shader';
      const c = 'sprite-instances-mutually-exclusive-with-instances';
      expect(a).toBe('sprite-instances-count-mismatch');
      expect(b).toBe('sprite-instances-requires-sprite-shader');
      expect(c).toBe('sprite-instances-mutually-exclusive-with-instances');
    });

    it('EcsErrorDetail discriminated variants narrow per `.code`', () => {
      const countDetail = {
        code: 'sprite-instances-count-mismatch',
        transformsLength: 320,
        regionsLength: 40,
        expectedStride: { transforms: 16, regions: 4 },
      };
      const shadingDetail = {
        code: 'sprite-instances-requires-sprite-shader',
        entityId: 42,
        observedMaterialShaderId: 'forgeax::default-standard-pbr',
      };
      const mutexDetail = {
        code: 'sprite-instances-mutually-exclusive-with-instances',
        entityId: 17,
      };
      expect(countDetail.code).toBe('sprite-instances-count-mismatch');
      expect(shadingDetail.code).toBe('sprite-instances-requires-sprite-shader');
      expect(mutexDetail.code).toBe('sprite-instances-mutually-exclusive-with-instances');
    });
  });

  describe('SpriteInstancesCountMismatchError class — w2 surface', () => {
    it('constructs with stride mismatch and exposes .code + .detail + .hint', () => {
      const err = new SpriteInstancesCountMismatchError(320, 40);
      expect(err.code).toBe('sprite-instances-count-mismatch');
      expect(err.detail).toEqual({
        code: 'sprite-instances-count-mismatch',
        transformsLength: 320,
        regionsLength: 40,
        expectedStride: { transforms: 16, regions: 4 },
      });
      expect(err.hint.length).toBeGreaterThan(0);
      expect(err.hint).toContain('transforms.length / 16');
      expect(err.hint).toContain('regions.length / 4');
    });

    it('.name is the class name and .message embeds .code', () => {
      const err = new SpriteInstancesCountMismatchError(320, 40);
      expect(err.name).toBe('SpriteInstancesCountMismatchError');
      expect(err.message).toContain('sprite-instances-count-mismatch');
    });
  });

  describe('SpriteInstancesRequiresSpriteShaderError class — w2 surface', () => {
    it('constructs with entity + observed materialShaderId and exposes .code + .detail + .hint', () => {
      const err = new SpriteInstancesRequiresSpriteShaderError(42, 'forgeax::default-standard-pbr');
      expect(err.code).toBe('sprite-instances-requires-sprite-shader');
      expect(err.detail).toEqual({
        code: 'sprite-instances-requires-sprite-shader',
        entityId: 42,
        observedMaterialShaderId: 'forgeax::default-standard-pbr',
      });
      expect(err.hint.length).toBeGreaterThan(0);
      expect(err.hint).toContain("'forgeax::sprite'");
      expect(err.hint).toContain('MaterialAsset');
    });

    it('.name is the class name and .message embeds .code', () => {
      const err = new SpriteInstancesRequiresSpriteShaderError(42, 'forgeax::default-unlit');
      expect(err.name).toBe('SpriteInstancesRequiresSpriteShaderError');
      expect(err.message).toContain('sprite-instances-requires-sprite-shader');
    });
  });

  describe('SpriteInstancesMutuallyExclusiveWithInstancesError class — w2 surface', () => {
    it('constructs with entity and exposes .code + .detail + .hint', () => {
      const err = new SpriteInstancesMutuallyExclusiveWithInstancesError(17);
      expect(err.code).toBe('sprite-instances-mutually-exclusive-with-instances');
      expect(err.detail).toEqual({
        code: 'sprite-instances-mutually-exclusive-with-instances',
        entityId: 17,
      });
      expect(err.hint.length).toBeGreaterThan(0);
      expect(err.hint).toContain('remove Instances');
      expect(err.hint).toContain('SpriteInstances supersedes Instances');
    });

    it('.name is the class name and .message embeds .code', () => {
      const err = new SpriteInstancesMutuallyExclusiveWithInstancesError(17);
      expect(err.name).toBe('SpriteInstancesMutuallyExclusiveWithInstancesError');
      expect(err.message).toContain('sprite-instances-mutually-exclusive-with-instances');
    });
  });

  describe('exhaustive switch over the 3 new codes (no default)', () => {
    it('compile-time narrows all 3 branches; runtime hits each arm exactly once', () => {
      const codes: string[] = [
        'sprite-instances-count-mismatch',
        'sprite-instances-requires-sprite-shader',
        'sprite-instances-mutually-exclusive-with-instances',
      ];
      let count = 0;
      let shading = 0;
      let mutex = 0;
      for (const code of codes) {
        switch (code) {
          case 'sprite-instances-count-mismatch':
            count += 1;
            break;
          case 'sprite-instances-requires-sprite-shader':
            shading += 1;
            break;
          case 'sprite-instances-mutually-exclusive-with-instances':
            mutex += 1;
            break;
          default:
            void code;
        }
      }
      expect(count).toBe(1);
      expect(shading).toBe(1);
      expect(mutex).toBe(1);
    });
  });
});
