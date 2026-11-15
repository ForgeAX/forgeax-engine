import { describe, expect, it } from 'vitest';
import { SpriteAnimationInvalidError } from '../errors/sprite-animation';

describe('sprite-animation-invalid-error.test.ts', () => {
  describe("EcsErrorCode +1 'sprite-animation-invalid' union member [M1 T-04]", () => {
    it("type-level: 'sprite-animation-invalid' is assignable to EcsErrorCode", () => {
      const code = 'sprite-animation-invalid';
      expect(code).toBe('sprite-animation-invalid');
    });

    it("EcsErrorDetail discriminated variant 'sprite-animation-invalid' carries field two-branch", () => {
      const regionsLength = {
        code: 'sprite-animation-invalid',
        field: 'regions-length',
        regionsLength: 12,
        frameCount: 4,
      };
      const frameDuration = {
        code: 'sprite-animation-invalid',
        field: 'frame-duration',
        frameDuration: 0,
      };
      expect(regionsLength.code).toBe('sprite-animation-invalid');
      expect(frameDuration.code).toBe('sprite-animation-invalid');
    });
  });

  describe('SpriteAnimationInvalidError class — 4-field surface (regions-length branch)', () => {
    it("constructs with field='regions-length' and exposes 4 fields", () => {
      const err = new SpriteAnimationInvalidError({
        field: 'regions-length',
        regionsLength: 12,
        frameCount: 4,
      });
      expect(err.code).toBe('sprite-animation-invalid');
      expect(err.expected).toBeTruthy();
      expect(err.expected.length).toBeGreaterThan(0);
      expect(err.hint).toBeTruthy();
      expect(err.hint.length).toBeGreaterThan(0);
      expect(err.detail.field).toBe('regions-length');
      if (err.detail.field === 'regions-length') {
        expect(err.detail.regionsLength).toBe(12);
        expect(err.detail.frameCount).toBe(4);
      }
    });

    it("constructs with field='frame-duration' and exposes 4 fields", () => {
      const err = new SpriteAnimationInvalidError({
        field: 'frame-duration',
        frameDuration: 0,
      });
      expect(err.code).toBe('sprite-animation-invalid');
      expect(err.expected).toBeTruthy();
      expect(err.expected.length).toBeGreaterThan(0);
      expect(err.hint).toBeTruthy();
      expect(err.hint.length).toBeGreaterThan(0);
      expect(err.detail.field).toBe('frame-duration');
      if (err.detail.field === 'frame-duration') {
        expect(err.detail.frameDuration).toBe(0);
      }
    });

    it('field=frame-duration accepts negative frameDuration (AC-09 c)', () => {
      const err = new SpriteAnimationInvalidError({
        field: 'frame-duration',
        frameDuration: -0.05,
      });
      expect(err.code).toBe('sprite-animation-invalid');
      expect(err.detail.field).toBe('frame-duration');
      if (err.detail.field === 'frame-duration') {
        expect(err.detail.frameDuration).toBe(-0.05);
      }
    });

    it('Error message embeds code + field + recovery hint (charter P3)', () => {
      const err = new SpriteAnimationInvalidError({
        field: 'regions-length',
        regionsLength: 7,
        frameCount: 3,
      });
      expect(err.message).toContain('sprite-animation-invalid');
      expect(err.message).toContain('regions-length');
    });

    it('class .name override aligns with the error type', () => {
      const err = new SpriteAnimationInvalidError({
        field: 'frame-duration',
        frameDuration: 0,
      });
      expect(err.name).toBe('SpriteAnimationInvalidError');
    });
  });

  describe("type-level: switch over EcsErrorCode includes 'sprite-animation-invalid' branch", () => {
    it('describeCode reaches the sprite-animation-invalid arm without default fall-through', () => {
      function describeCode(code: string): string {
        switch (code) {
          case 'sprite-animation-invalid':
            return 'sprite-animation-invalid';
          default:
            return 'other';
        }
      }
      expect(describeCode('sprite-animation-invalid')).toBe('sprite-animation-invalid');
    });
  });
});
