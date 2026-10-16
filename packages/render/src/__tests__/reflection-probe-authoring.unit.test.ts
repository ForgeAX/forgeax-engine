import { describe, expect, it } from 'vitest';
import {
  REFLECTION_PROBE_UPDATE_ON_CHANGE,
  ReflectionProbe,
  reflectionProbeUpdateIntentFromF32,
} from '../components/reflection-probe';
import { RenderIntentInvalidError } from '../errors/render';
import {
  admitReflectionProbe,
  DEFAULT_REFLECTION_PROBE_LIMITS,
  estimateReflectionProbeBytes,
  type ReflectionProbeInput,
  validateReflectionProbeInput,
} from '../reflection/projection';

const invalidInputs: readonly ReflectionProbeInput[] = [
  { halfExtents: [0, 1, 1], priority: 0, intensity: 1, resolution: 256 },
  { halfExtents: [1, 1, 1], priority: Number.NaN, intensity: 1, resolution: 256 },
  { halfExtents: [1, 1, 1], priority: 0, intensity: -1, resolution: 256 },
  { halfExtents: [1, 1, 1], priority: 0, intensity: 1, resolution: 0 },
];

describe('ReflectionProbe authoring and admission', () => {
  it('exposes bounded axis-aligned probe vocabulary', () => {
    expect(ReflectionProbe.fields.halfExtents.type).toBe('array<f32, 3>');
    expect(ReflectionProbe.fields.priority.type).toBe('f32');
    expect(ReflectionProbe.fields.intensity.type).toBe('f32');
    expect(ReflectionProbe.fields.resolution.type).toBe('u32');
    expect(ReflectionProbe.fields.updateIntent.type).toBe('f32');
    expect(ReflectionProbe.fields.invalidationVersion.type).toBe('u32');
    expect(reflectionProbeUpdateIntentFromF32(REFLECTION_PROBE_UPDATE_ON_CHANGE)).toBe('on-change');
  });

  it('reports invalid update intent through the structured render error contract', () => {
    expect(() => reflectionProbeUpdateIntentFromF32(99)).toThrowError(RenderIntentInvalidError);
    try {
      reflectionProbeUpdateIntentFromF32(99);
    } catch (error) {
      expect(error).toBeInstanceOf(RenderIntentInvalidError);
      if (!(error instanceof RenderIntentInvalidError)) return;
      expect(error.code).toBe('render-intent-invalid');
      expect(error.expected).toBe('ReflectionProbe.updateIntent is one of 0, 1, or 2');
      expect(error.hint).toBe('set ReflectionProbe.updateIntent to 0, 1, or 2');
      expect(error.detail).toEqual({
        component: 'ReflectionProbe',
        field: 'updateIntent',
        value: 99,
        allowed: [0, 1, 2],
      });
    }
  });

  it.each(invalidInputs)('rejects invalid authoring input %#', (input) => {
    expect(validateReflectionProbeInput(input).ok).toBe(false);
  });

  it('admits the profile boundary and rejects the first over-budget probe', () => {
    const probe = { halfExtents: [1, 1, 1] as const, priority: 0, intensity: 1, resolution: 256 };
    const bytes = estimateReflectionProbeBytes(probe.resolution);
    const count = Math.floor(DEFAULT_REFLECTION_PROBE_LIMITS.maxBytes / bytes);
    expect(count).toBe(5);
    expect(
      admitReflectionProbe(probe, { acceptedCount: count - 1, acceptedBytes: bytes * (count - 1) }),
    ).toEqual({ ok: true, acceptedBytes: bytes * count });
    expect(
      admitReflectionProbe(probe, { acceptedCount: count, acceptedBytes: bytes * count }).ok,
    ).toBe(false);
    expect(
      admitReflectionProbe({ ...probe, resolution: 16 }, { acceptedCount: 16, acceptedBytes: 0 })
        .ok,
    ).toBe(false);
  });
});
