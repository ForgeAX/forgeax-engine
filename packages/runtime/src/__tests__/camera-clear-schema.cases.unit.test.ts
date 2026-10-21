// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { Camera } from '@forgeax/engine-render';
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
  // --- from camera-clear-schema.test.ts ---

  describe('Camera clear-color schema (feat-20260709 M3: array<f32,4>)', () => {
    it('Camera schema includes clearColor: array<f32,4> field', () => {
      expect(componentFieldType(Camera, 'clearColor')).toBe('array<f32, 4>');
    });

    it('per-axis clear scalars are gone (collapsed into clearColor)', () => {
      expect('clearR' in Camera.fields).toBe(false);
      expect('clearG' in Camera.fields).toBe(false);
      expect('clearB' in Camera.fields).toBe(false);
      expect('clearA' in Camera.fields).toBe(false);
    });

    it('Camera defaults clearColor to transparent black [0,0,0,0]', () => {
      expect(Array.from(componentFieldDefault(Camera, 'clearColor') as Float32Array)).toEqual([
        0, 0, 0, 0,
      ]);
    });
  });

  describe('Camera clear-color reflection (fields plumbing)', () => {
    it('Camera.fields includes clearColor entry with explicit layer-2 default', () => {
      const fields = Camera.fields as Record<string, { type: string; default?: unknown }>;
      expect(fields.clearColor).toBeDefined();
      expect(fields.clearColor?.type).toBe('array<f32, 4>');
      expect(Array.from(fields.clearColor?.default as Float32Array)).toEqual([0, 0, 0, 0]);
    });

    it('clear color is one inline array column (not four per-axis scalar keys)', () => {
      // feat-20260709 M3 / D-3: the 4 x f32 scalar clear quartet collapsed into
      // a single array<f32,4> column, mirroring the Transform / light SoA idiom.
      const keys = Object.keys(Camera.fields);
      expect(keys).toContain('clearColor');
      expect(keys).not.toContain('clearR');
      expect(keys).not.toContain('clearG');
      expect(keys).not.toContain('clearB');
      expect(keys).not.toContain('clearA');
    });
  });
}
