// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { ANTIALIAS_FXAA, ANTIALIAS_NONE, Camera } from '@forgeax/engine-render';
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
  // --- from camera-antialias.test.ts ---

  describe('Camera antialias schema', () => {
    it('Camera schema includes antialias: f32 field', () => {
      expect(componentFieldType(Camera, 'antialias')).toBe('f32');
    });

    it('Camera defaults antialias to 0 (ANTIALIAS_NONE)', () => {
      expect(componentFieldDefault(Camera, 'antialias')).toBe(0);
    });
  });

  describe('ANTIALIAS constants', () => {
    it('ANTIALIAS_NONE = 0', () => {
      expect(ANTIALIAS_NONE).toBe(0);
    });

    it('ANTIALIAS_FXAA = 1', () => {
      expect(ANTIALIAS_FXAA).toBe(1);
    });
  });
}
