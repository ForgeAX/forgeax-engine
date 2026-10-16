import { World } from '@forgeax/engine-ecs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DynamicResolution,
  type DynamicResolutionData,
  validateDynamicResolutionParameters,
} from '../dynamic-resolution';

describe('DynamicResolution authoring schema', () => {
  it('provides deterministic defaults through the real World component path', () => {
    const world = new World();
    const entity = world.spawn({ component: DynamicResolution, data: {} }).unwrap();

    expect(DynamicResolution.name).toBe('DynamicResolution');
    const defaults = world.get(entity, DynamicResolution).unwrap();
    expect(defaults).toMatchObject({ maxScale: 1 });
    // World stores f32 fields, so the authored decimal is represented by its
    // nearest f32 value rather than the exact JS number.
    expect(defaults.targetGpuMs).toBeCloseTo(16.67);
    expect(defaults.minScale).toBeCloseTo(0.67);
    expect(DynamicResolution.fields).toMatchObject({
      targetGpuMs: { type: 'f32', default: 16.67 },
      minScale: { type: 'f32', default: 0.67 },
      maxScale: { type: 'f32', default: 1 },
    });
  });

  it.each([
    { targetGpuMs: 0, minScale: 0.67, maxScale: 1, field: 'targetGpuMs' },
    { targetGpuMs: Number.NaN, minScale: 0.67, maxScale: 1, field: 'targetGpuMs' },
    { targetGpuMs: 16.67, minScale: 0.49, maxScale: 1, field: 'minScale' },
    { targetGpuMs: 16.67, minScale: 0.8, maxScale: 1.01, field: 'maxScale' },
    { targetGpuMs: 16.67, minScale: 0.9, maxScale: 0.8, field: 'minScale' },
  ])('rejects invalid $field before graph construction', (input) => {
    const result = validateDynamicResolutionParameters(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('dynamic-resolution-invalid-parameter');
      expect(result.error.expected).toContain(input.field);
      expect(result.error.hint).toContain(input.field);
      expect(result.error.detail.field).toBe(input.field);
    }
  });

  it.each([
    { targetGpuMs: 1, minScale: 0.5, maxScale: 0.5 },
    { targetGpuMs: 16.67, minScale: 0.67, maxScale: 1 },
    { targetGpuMs: 100, minScale: 0.5, maxScale: 1 },
  ])('accepts boundary values $minScale..$maxScale', (input) => {
    const result = validateDynamicResolutionParameters(input);
    expect(result).toEqual({ ok: true, value: input });
  });

  it('keeps the detached authoring POD limited to the three resolution fields', () => {
    expectTypeOf<DynamicResolutionData>().toEqualTypeOf<{
      readonly targetGpuMs: number;
      readonly minScale: number;
      readonly maxScale: number;
    }>();
    expectTypeOf<keyof DynamicResolutionData>().toEqualTypeOf<
      'targetGpuMs' | 'minScale' | 'maxScale'
    >();
  });
});
