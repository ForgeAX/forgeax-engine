import { describe, expect, it } from 'vitest';
import {
  getSsaoParameters,
  resolveSsaoParameters,
  SSAO_DEFAULT_BIAS,
  SSAO_DEFAULT_INTENSITY,
  SSAO_DEFAULT_RADIUS,
} from '../ssao-config';

describe('SSAO parameter authority', () => {
  it('keeps the documented defaults in one resolver', () => {
    expect(getSsaoParameters(undefined)).toEqual({
      radius: SSAO_DEFAULT_RADIUS,
      bias: SSAO_DEFAULT_BIAS,
      intensity: SSAO_DEFAULT_INTENSITY,
      quality: 'high',
      algorithm: 'ssao',
      directLightingStrength: 0,
    });
  });

  it('preserves configured radius, bias, and intensity', () => {
    expect(getSsaoParameters({ radius: 0.65, bias: 0.025, intensity: 1.4 })).toEqual({
      radius: 0.65,
      bias: 0.025,
      intensity: 1.4,
      quality: 'high',
      algorithm: 'ssao',
      directLightingStrength: 0,
    });
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite parameters (%s)', (value) => {
    for (const field of ['radius', 'bias', 'intensity'])
      expect(resolveSsaoParameters({ [field]: value }).ok).toBe(false);
  });

  it('returns structured failures for invalid radius and bias', () => {
    const invalidRadius = resolveSsaoParameters({ radius: 0 });
    const invalidBias = resolveSsaoParameters({ bias: -0.1 });
    expect(invalidRadius.ok).toBe(false);
    expect(invalidBias.ok).toBe(false);
    if (invalidRadius.ok || invalidBias.ok) throw new Error('expected structured SSAO failures');
    expect(invalidRadius.error.code).toBe('ssao-radius-non-positive');
    expect(invalidBias.error.code).toBe('ssao-bias-negative');
  });
});

it('selects GTAO and rejects unknown AO algorithms', () => {
  expect(resolveSsaoParameters({ algorithm: 'gtao' })).toMatchObject({
    ok: true,
    value: { algorithm: 'gtao' },
  });
  const invalid = resolveSsaoParameters({ algorithm: 'unknown' as 'gtao' });
  expect(invalid).toMatchObject({
    ok: false,
    error: { code: 'ssao-parameter-invalid', detail: { paramName: 'algorithm' } },
  });
});

it.each([
  -0.01,
  1.01,
  NaN,
  Infinity,
  -Infinity,
])('rejects direct AO strength outside [0, 1] (%s)', (value) => {
  expect(resolveSsaoParameters({ directLightingStrength: value })).toMatchObject({
    ok: false,
    error: { code: 'ssao-parameter-invalid', detail: { paramName: 'directLightingStrength' } },
  });
});

it.each([0, 0.5, 1])('preserves valid direct AO strength (%s)', (directLightingStrength) => {
  expect(resolveSsaoParameters({ directLightingStrength })).toMatchObject({
    ok: true,
    value: { directLightingStrength },
  });
});
