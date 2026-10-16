// pick-errors.test.ts — PickErrorCode closed union + PickError structured surface.
//
// Extracted from packages/runtime/src/__tests__/errors.unit.test.ts (the
// "from pick-errors.test.ts" block) in feat-20260705 M2 / w25 when the pick
// cluster moved to @forgeax/engine-picking. Runtime can no longer import the
// picking package (AC-203: no runtime -> picking edge), so these unit tests
// live alongside the code they exercise.

import { describe, expect, it } from 'vitest';
import { PickError, type PickErrorCode } from '../pick-errors';

describe('pick-errors', () => {
  const KEBAB_REGEX = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;

  describe('w8 — PickErrorCode closed union (AC-13)', () => {
    it('camera-component-missing is a valid PickErrorCode literal', () => {
      const code: PickErrorCode = 'camera-component-missing';
      expect(code).toBe('camera-component-missing');
    });

    it('camera-component-missing is valid kebab-case', () => {
      const code: PickErrorCode = 'camera-component-missing';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('exhaustive switch over PickErrorCode compiles without default', () => {
      function exhaustive(code: PickErrorCode): string {
        switch (code) {
          case 'camera-component-missing':
            return 'camera missing';
        }
      }
      expect(exhaustive('camera-component-missing')).toBe('camera missing');
    });
  });

  describe('w8 — PickError structured 3-field surface (AC-11)', () => {
    it('PickError has .code === camera-component-missing', () => {
      const e = new PickError(7);
      expect(e.code).toBe('camera-component-missing');
    });

    it('PickError .expected is a non-empty string', () => {
      const e = new PickError(7);
      expect(typeof e.expected).toBe('string');
      expect(e.expected.length).toBeGreaterThan(0);
    });

    it('PickError .hint contains a world.set recovery directive', () => {
      const e = new PickError(7);
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.hint).toContain('world.set');
    });

    it('PickError super message (Error.message) is non-empty', () => {
      const e = new PickError(7);
      expect(e.message.length).toBeGreaterThan(0);
    });

    it('PickError is an instanceof Error and carries .name', () => {
      const e = new PickError(7);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('PickError');
    });

    it('PickError .detail records the offending camera entity', () => {
      const e = new PickError(42);
      expect(e.detail).toEqual({ cameraEntity: 42 });
    });
  });
});
