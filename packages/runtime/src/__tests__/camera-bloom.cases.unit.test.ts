// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { BLOOM_DISABLED, BLOOM_ENABLED, Camera, validateCameraBloom } from '@forgeax/engine-render';
import { afterEach, describe, expect, it, vi } from 'vitest';

function componentFieldType(component: { fields: Record<string, { type: string }> }, name: string) {
  return component.fields[name]?.type;
}
function componentFieldDefault(
  component: { fields: Record<string, { default?: unknown }> },
  name: string,
) {
  return component.fields[name]?.default;
}
afterEach(() => vi.restoreAllMocks());
{
  // --- from camera-bloom.test.ts ---

  describe('Camera bloom schema', () => {
    it('Camera schema includes bloom: f32 field', () => {
      expect(componentFieldType(Camera, 'bloom')).toBe('f32');
    });

    it('Camera schema includes bloomThreshold: f32 field', () => {
      expect(componentFieldType(Camera, 'bloomThreshold')).toBe('f32');
    });

    it('Camera schema includes bloomIntensity: f32 field', () => {
      expect(componentFieldType(Camera, 'bloomIntensity')).toBe('f32');
    });

    it('Camera schema includes bloomSmoothWidth: f32 field', () => {
      expect(componentFieldType(Camera, 'bloomSmoothWidth')).toBe('f32');
    });

    it('Camera schema includes bloomRadius: f32 field', () => {
      expect(componentFieldType(Camera, 'bloomRadius')).toBe('f32');
    });

    it('Camera defaults bloom to 0 (BLOOM_DISABLED)', () => {
      expect(componentFieldDefault(Camera, 'bloom')).toBe(0);
    });

    it('Camera defaults bloomThreshold to 1 (highlights only)', () => {
      expect(componentFieldDefault(Camera, 'bloomThreshold')).toBe(1);
    });

    it('Camera defaults bloomIntensity to 0.5', () => {
      expect(componentFieldDefault(Camera, 'bloomIntensity')).toBe(0.5);
    });

    it('Camera defaults bloomSmoothWidth to 0.01', () => {
      expect(componentFieldDefault(Camera, 'bloomSmoothWidth')).toBe(0.01);
    });

    it('Camera defaults bloomRadius to 0', () => {
      expect(componentFieldDefault(Camera, 'bloomRadius')).toBe(0);
    });

    it('validates the complete Bloom range at the shared extract boundary', () => {
      expect(validateCameraBloom(1, 0, 0, 0, 0)).toBe('on');
      expect(validateCameraBloom(1, 65504, 8, 1, 0.95)).toBe('on');
    });

    it.each([
      ['bloom', [2, 1, 1, 0.5, 0.7]],
      ['bloomThreshold', [1, -0.001, 1, 0.5, 0.7]],
      ['bloomThreshold', [1, Number.NaN, 1, 0.5, 0.7]],
      ['bloomIntensity', [1, 1, 8.001, 0.5, 0.7]],
      ['bloomSmoothWidth', [1, 1, 1, -0.001, 0.7]],
      ['bloomRadius', [1, 1, 1, 0.5, 1.001]],
    ] as const)('rejects invalid %s with the closed Camera error', (field, values) => {
      let thrown: unknown;
      try {
        validateCameraBloom(...values);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: 'camera-bloom-invalid',
        detail: { field, actual: expect.anything(), expected: expect.any(String) },
        expected: expect.any(String),
        hint: expect.any(String),
      });
    });
  });

  describe('BLOOM constants', () => {
    it('BLOOM_DISABLED = 0', () => {
      expect(BLOOM_DISABLED).toBe(0);
    });

    it('BLOOM_ENABLED = 1', () => {
      expect(BLOOM_ENABLED).toBe(1);
    });
  });
}
