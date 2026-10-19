import { describe, expect, it } from 'vitest';
import {
  LightProbe,
  PointLight,
  RectAreaLight,
  SpotLight,
  validateLightProbeData,
  validateRectAreaLightData,
} from '../index';

describe('lighting authoring contracts', () => {
  it('exposes the declared local-light modifiers and Probe fields', () => {
    expect(Object.keys(RectAreaLight.fields)).toEqual([
      'lightingChannels',
      'color',
      'intensity',
      'width',
      'height',
      'range',
      'sourceTexture',
      'iesProfile',
    ]);
    expect(Object.keys(LightProbe.fields)).toEqual(['irradiance', 'radius']);
    expect(SpotLight.fields.iesProfile.type).toBe('shared<IesProfileAsset>');
    expect(PointLight.fields.iesProfile.type).toBe('shared<IesProfileAsset>');
    expect(RectAreaLight.fields.iesProfile.type).toBe('shared<IesProfileAsset>');
    expect(SpotLight.fields.cookie.type).toBe('shared<TextureAsset>');
    expect(SpotLight.fields.rollDeg.default).toBe(0);
  });

  it('keeps defaults and rejects invalid Rect/Probe facts before rendering', () => {
    expect(RectAreaLight.fields.width.default).toBe(10);
    expect(RectAreaLight.fields.height.default).toBe(10);
    expect(LightProbe.fields.irradiance.type).toBe('array<f32, 27>');
    expect(LightProbe.fields.radius.default).toBe(1e-4);

    expect(validateRectAreaLightData({}).ok).toBe(true);
    expect(validateRectAreaLightData({ range: Infinity }).ok).toBe(true);
    expect(validateRectAreaLightData({ width: Infinity }).ok).toBe(false);
    expect(validateRectAreaLightData({ range: NaN }).ok).toBe(false);
    expect(validateRectAreaLightData({ width: 0 }).ok).toBe(false);
    expect(validateRectAreaLightData({ intensity: Number.NaN }).ok).toBe(false);
    expect(validateLightProbeData({ irradiance: new Float32Array(26), radius: 1 }).ok).toBe(false);
    expect(validateLightProbeData({ irradiance: new Float32Array(27), radius: 1e-5 }).ok).toBe(
      false,
    );
  });
});
