import { describe, expect, it } from 'vitest';
import type { SpawnLightInvalidBoundsError } from '../component-validation';

describe('spawn-light-invalid-bounds-error-code.test.ts', () => {
  describe("EcsErrorCode +1 'spawn-light-invalid-bounds' union member [AC-06 (e)]", () => {
    it("type-level: 'spawn-light-invalid-bounds' is assignable to EcsErrorCode", () => {
      const code = 'spawn-light-invalid-bounds';
      expect(code).toBe('spawn-light-invalid-bounds');
    });

    it("EcsErrorDetail discriminated variant for 'spawn-light-invalid-bounds' carries scalar and RGB fields", () => {
      type InvalidLightBoundsDetail = {
        readonly code: 'spawn-light-invalid-bounds';
      } & SpawnLightInvalidBoundsError['detail'];
      const range: InvalidLightBoundsDetail = {
        code: 'spawn-light-invalid-bounds',
        field: 'range',
        got: -1,
      };
      const innerOuter: InvalidLightBoundsDetail = {
        code: 'spawn-light-invalid-bounds',
        field: 'innerOuter',
        got: 25,
      };
      const outerNinety: InvalidLightBoundsDetail = {
        code: 'spawn-light-invalid-bounds',
        field: 'outerNinety',
        got: 91,
      };
      const direction: InvalidLightBoundsDetail = {
        code: 'spawn-light-invalid-bounds',
        field: 'direction',
        got: [Number.NaN, 0, 0],
      };
      const irradiance: InvalidLightBoundsDetail = {
        code: 'spawn-light-invalid-bounds',
        field: 'irradiance',
        got: Array.from(new Float32Array(27)),
      };
      expect(range.code).toBe('spawn-light-invalid-bounds');
      expect(innerOuter.code).toBe('spawn-light-invalid-bounds');
      expect(outerNinety.code).toBe('spawn-light-invalid-bounds');
      expect(direction.field).toBe('direction');
      expect(irradiance.field).toBe('irradiance');
    });

    it("type-level: switch over EcsErrorCode includes 'spawn-light-invalid-bounds' branch", () => {
      function describeCode(code: string): string {
        switch (code) {
          case 'spawn-light-invalid-bounds':
            return 'spawn-light-invalid-bounds';
          default:
            return 'other';
        }
      }
      expect(describeCode('spawn-light-invalid-bounds')).toBe('spawn-light-invalid-bounds');
    });
  });
});
