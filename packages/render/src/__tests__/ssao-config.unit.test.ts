import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  AMBIENT_OCCLUSION_QUALITY_HIGH,
  AMBIENT_OCCLUSION_QUALITY_LOW,
  AMBIENT_OCCLUSION_QUALITY_MEDIUM,
  AmbientOcclusion,
  ambientOcclusionParameters,
} from '../components/ambient-occlusion';
import {
  getSsaoParameters,
  resolveSsaoParameters,
  resolveSsaoQuality,
  SSAO_DEFAULT_BIAS,
  SSAO_DEFAULT_INTENSITY,
  SSAO_DEFAULT_RADIUS,
} from '../ssao-config';

describe('SSAO parameter authority', () => {
  it('keeps the documented defaults in one resolver', () => {
    expect(getSsaoParameters(undefined)).toMatchObject({
      radius: SSAO_DEFAULT_RADIUS,
      bias: SSAO_DEFAULT_BIAS,
      intensity: SSAO_DEFAULT_INTENSITY,
      method: 'ssao',
      quality: 50,
      power: 2,
      fadeDistance: 80,
      fadeRadius: 50,
      radiusInWorldSpace: false,
      mipBlend: 0.6,
      mipScale: 1.7,
      mipThreshold: 0.01,
      gtao: { downsample: false, temporalFilter: true, numAngles: 2, temporalBlendWeight: 0.1 },
    });
    expect(resolveSsaoQuality(undefined)).toEqual({ levels: 2, permutation: 2 });
  });

  it('preserves configured radius, bias, and intensity', () => {
    expect(getSsaoParameters({ radius: 0.65, bias: 3.5, intensity: 0.4 })).toMatchObject({
      radius: 0.65,
      bias: 3.5,
      intensity: 0.4,
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
  expect(resolveSsaoParameters({ method: 'gtao' })).toMatchObject({
    ok: true,
    value: { method: 'gtao' },
  });
  const invalid = resolveSsaoParameters({ method: 'unknown' as 'gtao' });
  expect(invalid).toMatchObject({
    ok: false,
    error: { code: 'ssao-parameter-invalid', detail: { paramName: 'method' } },
  });
});

it.each([0, 1, 2, 3])('preserves explicit SSAO level count %s', (levels) => {
  expect(resolveSsaoQuality({ levels: levels as 0 | 1 | 2 | 3 }).levels).toBe(levels);
});

it('resolves component and profile authoring to the same AO defaults', () => {
  const world = new World();
  const entity = world.spawn({ component: AmbientOcclusion, data: {} }).unwrap();
  const data = world.get(entity, AmbientOcclusion).unwrap();
  expect(getSsaoParameters(ambientOcclusionParameters(data).unwrap())).toEqual(
    getSsaoParameters(undefined),
  );
  expect(data.enabled).toBe(true);
  expect(ambientOcclusionParameters(data).unwrap()).not.toHaveProperty('method');
});

it.each([
  ['thickness', -1],
  ['distanceExponent', NaN],
  ['distanceFallOff', 1.01],
  ['resolutionScale', 0],
])('rejects invalid %s before GPU projection', (name, value) => {
  expect(resolveSsaoParameters({ [name]: value })).toMatchObject({
    ok: false,
    error: { code: 'ssao-parameter-invalid', detail: { paramName: name } },
  });
});

describe('AmbientOcclusion public encodings', () => {
  it('names each closed quality encoding used by the f32 component field', () => {
    expect({
      low: AMBIENT_OCCLUSION_QUALITY_LOW,
      medium: AMBIENT_OCCLUSION_QUALITY_MEDIUM,
      high: AMBIENT_OCCLUSION_QUALITY_HIGH,
    }).toEqual({ low: 25, medium: 50, high: 100 });
  });
});
